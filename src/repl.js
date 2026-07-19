// Interpreter-backed REPL client. The compiler's `blade repl` evaluates each
// submission under the tree-walking interpreter (Interp/Repl.fs) — typically
// <100 ms, with a per-input g++ fallback for the inputs it can't cover yet —
// which makes evaluation fast enough to live INSIDE the editing loop rather
// than beside it. So instead of hosting the process as an opaque terminal
// (the pre-interpreter design: shellPath + sendText, output invisible to the
// extension), this module OWNS the process:
//
//   spawn(blade repl) <- stdin: submissions (:paste-framed, serialized)
//        |
//        +- stdout -> prompt-sentinel framing (replProto) -> per-submission
//        |            result -> inline editor decoration + terminal transcript
//        +- stderr -> diagnostics / warnings / fallback notice -> terminal
//
// The "Blade REPL" terminal remains — now a vscode.Pseudoterminal fed by the
// same process, so typing at the `blade>` prompt still works (minimal line
// editing: printable chars, backspace, Enter, Ctrl+C, Ctrl+D) and editor
// sends echo into the transcript like hand-typed continuation lines. One
// process, two views of it.

"use strict";

const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const proto = require("./replProto");

// Injected by init(): { findCompiler, reportNoCompiler } from extension.js.
let deps;

// After the frame-terminating prompt appears on stdout, wait briefly before
// resolving so stderr written just before the prompt (diagnostics arrive on a
// separate pipe with no cross-pipe ordering guarantee) lands in THIS frame.
const STDERR_GRACE_MS = 30;

// --- Session state -----------------------------------------------------------

/** @type {cp.ChildProcess | undefined} */
let proc;
/** @type {vscode.Terminal | undefined} */
let term;
let writeEmitter; // pty output
let closeEmitter; // pty close
let ready = false; // saw the banner's top-level prompt; safe to submit
let inflight = null; // submission whose frame is open, or null
let queue = []; // submissions not yet written to stdin
let stdoutBuf = ""; // buffered stdout while a programmatic frame is open
let streamTail = ""; // rolling tail of streamed stdout (prompt detection)
let typed = ""; // interactive line being edited in the terminal

function termWrite(s) {
  if (writeEmitter) writeEmitter.fire(s.replace(/\r?\n/g, "\r\n"));
}

// stderr rendering: commentary (fallback notice, warnings) in yellow,
// real diagnostics in red. The child detects the redirected pipe and
// disables its own coloring, so painting per line here is safe.
function colorErr(chunk) {
  return chunk
    .split(/\r?\n/)
    .map((l) =>
      l.trim() === ""
        ? l
        : /^(-- falling back|\[TypeCheck Warning\])/.test(l.trim())
          ? `\x1b[33m${l}\x1b[0m`
          : `\x1b[31m${l}\x1b[0m`
    )
    .join("\n");
}

function replCwdFor(doc) {
  // The session's cwd is where evaluated code runs, so relative data paths
  // (NetCDF.load("sample.nc")) resolve next to the source file.
  if (doc && doc.uri.scheme === "file") return path.dirname(doc.fileName);
  const ws = vscode.workspace.workspaceFolders;
  return ws && ws.length > 0 ? ws[0].uri.fsPath : undefined;
}

// --- Child process -----------------------------------------------------------

function startProc(cwd) {
  const exe = deps.findCompiler();
  try {
    proc = cp.spawn(exe, ["repl"], { cwd: cwd || undefined, windowsHide: true });
  } catch (e) {
    failSession(`[error] could not start '${exe} repl': ${e.message}`);
    deps.reportNoCompiler(exe);
    return;
  }
  proc.stdout.setEncoding("utf8");
  proc.stderr.setEncoding("utf8");
  proc.stdout.on("data", onStdout);
  proc.stderr.on("data", onStderr);
  proc.on("error", (e) => {
    failSession(`[error] could not start '${exe} repl' — set blade.compilerPath`);
    deps.reportNoCompiler(exe);
  });
  proc.on("exit", (code) => {
    failSession(code ? `[blade repl exited with code ${code}]` : undefined);
  });
}

/** Tear the session down, cancelling anything pending. `message` (optional)
 *  is shown in the terminal before it closes. */
function failSession(message) {
  if (message) termWrite(`\r\n${message}\r\n`);
  if (inflight) {
    finishDecoration(inflight, "", (inflight.err || "") + "\n[repl session ended]", 0);
    inflight = null;
  }
  for (const sub of queue) {
    if (sub.anchor) dropDecoration(sub.anchor);
  }
  queue = [];
  stdoutBuf = "";
  streamTail = "";
  ready = false;
  const p = proc;
  proc = undefined;
  if (p && p.exitCode === null) {
    try {
      p.kill();
    } catch (_) {
      /* already gone */
    }
  }
  if (closeEmitter) closeEmitter.fire(0); // closes the terminal
  term = undefined;
}

function onStdout(chunk) {
  if (inflight) {
    stdoutBuf += chunk;
    if (proto.frameDone(stdoutBuf)) {
      const frame = proto.cleanFrame(stdoutBuf.slice(0, -proto.PROMPT.length));
      stdoutBuf = "";
      const sub = inflight; // keep the queue closed until the grace elapses
      setTimeout(() => finishFrame(sub, frame), STDERR_GRACE_MS);
    }
    return;
  }
  // Interactive / banner output streams straight through, prompts included.
  termWrite(chunk);
  streamTail = (streamTail + chunk).slice(-proto.PROMPT.length);
  if (proto.frameDone(streamTail)) {
    ready = true;
    pump();
  }
}

function onStderr(chunk) {
  if (inflight) inflight.err += chunk;
  termWrite(colorErr(chunk));
}

function finishFrame(sub, out) {
  // Output can arrive during the stderr grace window (a line typed into the
  // terminal mid-flight executes right after the frame) and re-trigger frame
  // detection for the same submission — finish at most once.
  if (sub.done) return;
  sub.done = true;
  const ms = Date.now() - sub.t0;
  termWrite(out);
  termWrite(proto.PROMPT);
  inflight = null;
  finishDecoration(sub, out, sub.err, ms);
  pump();
}

function pump() {
  if (!proc || !ready || inflight || queue.length === 0) return;
  inflight = queue.shift();
  inflight.t0 = Date.now();
  // Echo the code as if hand-typed (the :paste/:end framing stays hidden;
  // cleanFrame strips the child's matching continuation prompts).
  if (inflight.echo !== undefined) {
    const lines = inflight.echo.split(/\r?\n/);
    termWrite(lines[0] + "\n");
    for (const l of lines.slice(1)) termWrite(proto.CONT + l + "\n");
  }
  proc.stdin.write(inflight.wire);
}

// --- Pseudoterminal ----------------------------------------------------------

function handleInput(data) {
  // No history/arrow support: swallow CSI and other escape sequences
  // (including VS Code's bracketed-paste markers).
  const clean = data.replace(/\x1b\[[0-9;?]*[0-9A-Za-z~]/g, "").replace(/\x1b./g, "");
  for (const ch of clean) {
    if (ch === "\r" || ch === "\n") {
      termWrite("\r\n");
      if (proc && proc.stdin.writable) proc.stdin.write(typed + "\n");
      typed = "";
    } else if (ch === "\x7f" || ch === "\b") {
      if (typed) {
        typed = typed.slice(0, -1);
        termWrite("\b \b");
      }
    } else if (ch === "\x03") {
      // Ctrl+C: drop the line being edited (the child is line-buffered and
      // never saw it) and repaint the prompt.
      typed = "";
      termWrite("^C\r\n" + proto.PROMPT);
    } else if (ch === "\x04") {
      // Ctrl+D: EOF — the child's ReadLine returns null and it exits.
      if (proc && proc.stdin.writable) proc.stdin.end();
    } else if (ch >= " " || ch === "\t") {
      typed += ch;
      termWrite(ch);
    }
  }
}

function ensureTerminal(cwd) {
  if (term) return;
  writeEmitter = new vscode.EventEmitter();
  closeEmitter = new vscode.EventEmitter();
  const pty = {
    onDidWrite: writeEmitter.event,
    onDidClose: closeEmitter.event,
    open: () => startProc(cwd),
    close: () => {
      // User closed the terminal: kill the child; its 'exit' handler runs
      // failSession (closeEmitter is a no-op on an already-closing pty).
      if (proc && proc.exitCode === null) {
        try {
          proc.kill();
        } catch (_) {
          /* already gone */
        }
      }
    },
    handleInput,
  };
  term = vscode.window.createTerminal({ name: "Blade REPL", pty });
}

// --- Inline result decorations ------------------------------------------------

function decoType(colorId) {
  return vscode.window.createTextEditorDecorationType({
    after: {
      margin: "0 0 0 2em",
      color: new vscode.ThemeColor(colorId),
      fontStyle: "italic",
    },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
}
const okDeco = decoType("terminal.ansiGreen");
const errDeco = decoType("terminal.ansiRed");
const pendingDeco = decoType("descriptionForeground");

// uri.toString() -> Map<line, { kind: "ok"|"err"|"pending", text, hover }>.
// Results survive tab switches; any edit to the document clears them all
// (lines shift — an honest blank beats a stale value on the wrong line).
const resultsByDoc = new Map();

function inlineEnabled() {
  return vscode.workspace.getConfiguration("blade").get("inlineReplResults", true);
}

function render(uriString) {
  for (const editor of vscode.window.visibleTextEditors) {
    if (editor.document.uri.toString() !== uriString) continue;
    const entries = resultsByDoc.get(uriString);
    const buckets = { ok: [], err: [], pending: [] };
    if (entries) {
      for (const [line, e] of entries) {
        if (line >= editor.document.lineCount) continue;
        const end = editor.document.lineAt(line).range.end;
        buckets[e.kind].push({
          range: new vscode.Range(end, end),
          renderOptions: { after: { contentText: e.text } },
          hoverMessage: e.hover,
        });
      }
    }
    editor.setDecorations(okDeco, buckets.ok);
    editor.setDecorations(errDeco, buckets.err);
    editor.setDecorations(pendingDeco, buckets.pending);
  }
}

function setPending(anchor) {
  let entries = resultsByDoc.get(anchor.uri);
  if (!entries) resultsByDoc.set(anchor.uri, (entries = new Map()));
  entries.set(anchor.line, { kind: "pending", text: "…", hover: undefined });
  render(anchor.uri);
}

function dropDecoration(anchor) {
  const entries = resultsByDoc.get(anchor.uri);
  if (entries && entries.delete(anchor.line)) render(anchor.uri);
}

/** Replace a submission's pending mark with its result. */
function finishDecoration(sub, out, err, ms) {
  const anchor = sub.anchor;
  if (!anchor) return;
  if (!inlineEnabled()) {
    // Inline results were switched off after the send: retract the pending
    // mark instead of leaving "…" stranded until the next edit.
    dropDecoration(anchor);
    return;
  }
  // The document changed since the send: its decorations were already
  // cleared, and the anchor line may have shifted — stay silent.
  const doc = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === anchor.uri
  );
  if (!doc || doc.version !== anchor.version) {
    dropDecoration(anchor);
    return;
  }
  const isErr = proto.isErrorFrame(out, err);
  const text =
    (isErr ? "✗ " : "⇒ ") + proto.ellipsize(proto.summarize(out, err), 120);
  const hover = new vscode.MarkdownString();
  hover.appendCodeblock(out.trim() || "(no stdout)", "text");
  if (err.trim()) {
    hover.appendMarkdown("\n**stderr**\n");
    hover.appendCodeblock(err.trim(), "text");
  }
  hover.appendMarkdown(
    `\n_${ms} ms — ${proto.fellBack(err) ? "compiled fallback (interpreter does not cover this input yet)" : "interpreter"}_`
  );
  let entries = resultsByDoc.get(anchor.uri);
  if (!entries) resultsByDoc.set(anchor.uri, (entries = new Map()));
  entries.set(anchor.line, { kind: isErr ? "err" : "ok", text, hover });
  render(anchor.uri);
}

function clearAllDecorations() {
  const uris = [...resultsByDoc.keys()];
  resultsByDoc.clear();
  for (const uri of uris) render(uri);
}

// --- Public surface -----------------------------------------------------------

/**
 * Submit `code` to the session (starting it if needed), echo it in the
 * terminal, and — when `anchor` ({ uri, line, version }) is given and inline
 * results are enabled — decorate that line with the evaluation's result.
 */
function sendToRepl(doc, code, anchor) {
  ensureTerminal(replCwdFor(doc));
  term.show(true);
  if (anchor && inlineEnabled()) setPending(anchor);
  queue.push({ wire: proto.wireFor(code), echo: code, err: "", t0: 0, anchor: anchor || null });
  pump();
}

function startRepl(doc) {
  ensureTerminal(replCwdFor(doc));
  term.show(false);
}

/** Clear the compiler-side session (:reset) and all inline results. */
function resetRepl() {
  clearAllDecorations();
  if (!term || !proc) return;
  queue.push({ wire: ":reset\n", echo: ":reset", err: "", t0: 0, anchor: null });
  pump();
}

function init(context, dependencies) {
  deps = dependencies;
  context.subscriptions.push(
    okDeco,
    errDeco,
    pendingDeco,
    vscode.workspace.onDidChangeTextDocument((e) => {
      const uri = e.document.uri.toString();
      if (e.contentChanges.length > 0 && resultsByDoc.delete(uri)) render(uri);
    }),
    // Decorations are per-editor state in VS Code: re-apply when an editor
    // for a decorated document becomes visible again.
    vscode.window.onDidChangeVisibleTextEditors(() => {
      for (const uri of resultsByDoc.keys()) render(uri);
    }),
    { dispose: () => failSession(undefined) }
  );
}

module.exports = { init, sendToRepl, startRepl, resetRepl };
