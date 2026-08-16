// Blade language support: diagnostics via `Blade check`, type hovers and
// signature help via `Blade ide check --json` (auto-detected; falls back to
// text diagnostics against compilers without the JSON subcommand), an
// interpreter-backed REPL with inline results (src/repl.js), and — when the
// compiler supports it — as-you-type checking through a persistent `blade
// ide serve` process (src/serve.js) with a fast clock (parse + typecheck +
// deduce, debounced while typing) and a slow clock (+ monomorphization, on
// save/open/idle). Compilers without `ide serve` fall back to the original
// one-shot `ide check --json` / text pipeline unchanged — see checkDocument.
//
// Plain CommonJS on purpose — no build step, no dependencies. VS Code's own
// Node runtime executes this directly.

const vscode = require("vscode");
const cp = require("child_process");
const path = require("path");
const pkg = require("@blade-lang/ide-protocol");
const builtins = require("./builtins");
const types = require("./types");
const keywords = require("./keywords");
const repl = require("./repl");
const serve = require("./serve");
const notebook = require("./notebook");
const plots = require("./plots");
const gr = require("./gr");

/** @type {vscode.DiagnosticCollection} */
let diagnostics;
/** @type {vscode.OutputChannel} */
let output;

// "unknown" until first probe, then "serve" (persistent `ide serve` process
// — see src/serve.js), "json" (one-shot `ide check --json`), or "text" (no
// JSON subcommand at all). Once latched to "json"/"text" for a session,
// serve is not retried (mirrors serve.available()'s own latch) — see
// checkDocument.
let ideMode = "unknown";
// uri.toString() -> bindings array from the last successful JSON check.
const bindingsByDoc = new Map();
// uri.toString() -> type-provider store structure (providers[] from the JSON
// check), each entry tagged with `_loadText` (the source text of its `.load`
// line). Cached so tooltips survive an edit that breaks the check elsewhere,
// and a store is only re-validated when its own `.load` expression changes.
const providersByDoc = new Map();
// uri.toString() -> calls array from the last successful JSON check: one
// entry per builtin call site with the compiler's monomorphized (concrete)
// argument/result types. Rendered under the abstract signature in hovers.
const callsByDoc = new Map();
// uri.toString() -> kernels array from the last successful JSON check: one
// entry per lambda-kernel span with the deduction snapshot (param names,
// deduced comm/anticomm clauses, declared where conjuncts, per-param cell
// ranks). Span-keyed — hover/completion resolve kernels by position.
const kernelsByDoc = new Map();
// uri.toString() -> references array from the last successful JSON check:
// one entry per BINDER (a function/value/param/local/type name — two
// shadowing `x`s are two entries), `{name, kind, def, uses}` with 1-based
// {line,col,endLine,endCol} spans (def nullable when the compiler couldn't
// recover a name span). Backs go-to-definition, find-references, rename,
// the hierarchical outline, and the hover shadowing fix below. Absent from
// today's compiler payload (defaults to [] — see applyCheckPayload), so
// every consumer degrades gracefully rather than assuming it's populated.
const referencesByDoc = new Map();
// Warn about a missing compiler only once per session.
let warnedNoCompiler = false;

/** Resolution precedence (delegated to the package, shared with every other
 *  Blade tool that needs to find a compiler): the `blade.compilerPath`
 *  setting, then the `BLADE_EXE` environment variable (NEW — previously only
 *  the standalone test scripts honored this; see the README), then the
 *  newest-built of the package's default candidate locations, then `Blade`
 *  on PATH. */
function findCompiler() {
  const configured = vscode.workspace.getConfiguration("blade").get("compilerPath", "");
  return pkg.resolveCompiler({ explicitPath: configured || undefined, env: process.env }).exe;
}

/** Resolve the GR installation for the plot panel's static backend:
 *  `blade.grPath`, then vendor/gr beside the workspace, then vendor/gr beside
 *  the extension (populated by `npm run fetch-vendor`). Validation up front is
 *  deliberate — a bad GR environment fails silently at spawn time (src/gr.js),
 *  so the answer must be known before anything GR-shaped is launched. */
function findGr() {
  const folders = vscode.workspace.workspaceFolders;
  return gr.resolveGr({
    configuredPath: vscode.workspace.getConfiguration("blade").get("grPath", ""),
    workspaceRoot: folders && folders.length > 0 ? folders[0].uri.fsPath : undefined,
    extensionRoot: extensionRootPath,
  });
}
// Set in activate(); module-level so findGr stays callable from anywhere.
let extensionRootPath;

function run(exe, args, timeoutMs, cwd) {
  return new Promise((resolve) => {
    cp.execFile(
      exe,
      args,
      { timeout: timeoutMs || 30000, maxBuffer: 16 * 1024 * 1024, cwd: cwd || undefined },
      (err, stdout, stderr) => {
        resolve({
          // err.code is the exit code (number) or a spawn error string like "ENOENT"
          failedToSpawn: !!(err && (err.code === "ENOENT" || err.errno)),
          exitCode: err && typeof err.code === "number" ? err.code : err ? 1 : 0,
          stdout: stdout || "",
          stderr: stderr || "",
        });
      }
    );
  });
}

// --- Diagnostics ------------------------------------------------------------

// Text formats produced today:
//   error[BL0000]: message          (rustc-style header, Diagnostics.Render)
//     --> file:line:col             (location line following a header)
//   line:col: message               (legacy renderShort / formatCompileError)
//   file:line:col: message
//   Parse error at line:col: message  (pre-diagnostics-arc builds)
const DIAG_RE = /^(?:Parse error at )?(?:(.+?):)?(\d+):(\d+):\s*(.+)$/;
const HEADER_RE = /^(error|warning|note)\[(BL\d{4})\]:\s*(.+)$/;
const ARROW_RE = /^-->\s*(?:(.+?):)?(\d+):(\d+)\s*$/;

// A small, fixed table of BL-codes get a clickable doc link into the
// compiler's docs (whole file — precise anchors can come later); every other
// code stays a plain string so a future BL-code can't silently claim a
// broken link. Deduction/pin codes only today (BL4010 comm, BL4011
// anticomm, BL4014 rank) — the codes the new code actions/lenses act on.
const DIAG_DOC_CODES = new Set(["BL4010", "BL4011", "BL4014"]);

// Resolved lazily and cached: repo discovery needs findCompiler()'s result,
// which is only meaningful once the extension has activated. `undefined` =
// not yet resolved; `null` = resolved, no repo found (cached so a missing
// repo isn't re-walked on every diagnostic) — the blade.compilerPath change
// handler in activate() resets this to `undefined` since a new compiler may
// live in a different checkout.
let diagDocTargetCache;

function diagDocTarget() {
  if (diagDocTargetCache === undefined) {
    const root = pkg.resolveRepoRoot({ exe: findCompiler(), env: process.env });
    diagDocTargetCache = root ? vscode.Uri.file(path.join(root, "docs", "features.md")) : null;
  }
  return diagDocTargetCache;
}

/** A diagnostic `code` value: `{value, target}` (VS Code renders this as a
 *  clickable link) for the known deduction/pin codes WHEN a Blade checkout
 *  resolves (see diagDocTarget) — the plain string otherwise, so a compiler
 *  with no discoverable repo root (standalone install, or `Blade` on PATH
 *  with no checkout nearby) degrades to an inert code instead of a broken
 *  link. */
function diagnosticCode(code) {
  if (!code || !DIAG_DOC_CODES.has(code)) return code;
  const target = diagDocTarget();
  return target ? { value: code, target } : code;
}

/** The plain string form of a diagnostic's `code`, whether it's still a bare
 *  string or has been upgraded to `{value, target}` by diagnosticCode. */
function diagnosticCodeValue(d) {
  if (!d || d.code === undefined || d.code === null) return undefined;
  return typeof d.code === "object" ? d.code.value : d.code;
}

/** @param {vscode.TextDocument} doc */
function textToDiagnostics(doc, text) {
  const result = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const h = HEADER_RE.exec(line);
    if (h) {
      // rustc-style block: the location follows on a "--> file:line:col"
      // line; snippet/gutter/note lines after it are display-only.
      let lineNo = 0;
      let colNo = 0;
      const a = ARROW_RE.exec((lines[i + 1] || "").trim());
      if (a) {
        lineNo = Math.max(0, parseInt(a[2], 10) - 1);
        colNo = Math.max(0, parseInt(a[3], 10) - 1);
        i++;
      }
      const start = new vscode.Position(lineNo, colNo);
      const end = doc.lineCount > lineNo ? doc.lineAt(lineNo).range.end : start;
      const severity =
        h[1] === "warning"
          ? vscode.DiagnosticSeverity.Warning
          : h[1] === "note"
            ? vscode.DiagnosticSeverity.Information
            : vscode.DiagnosticSeverity.Error;
      const d = new vscode.Diagnostic(new vscode.Range(start, end), h[3], severity);
      d.source = "blade";
      d.code = diagnosticCode(h[2]);
      result.push(d);
      continue;
    }
    const m = DIAG_RE.exec(line);
    if (!m) continue;
    const lineNo = Math.max(0, parseInt(m[2], 10) - 1);
    const colNo = Math.max(0, parseInt(m[3], 10) - 1);
    const start = new vscode.Position(lineNo, colNo);
    // Statement-level spans only in this legacy format: highlight from the
    // reported column to the end of that line so the squiggle is visible.
    const end = doc.lineCount > lineNo ? doc.lineAt(lineNo).range.end : start;
    const severity = /^warning/i.test(m[4])
      ? vscode.DiagnosticSeverity.Warning
      : vscode.DiagnosticSeverity.Error;
    const d = new vscode.Diagnostic(new vscode.Range(start, end), m[4], severity);
    d.source = "blade";
    result.push(d);
  }
  return result;
}

/** @param {vscode.TextDocument} doc */
function jsonToDiagnostics(doc, payload) {
  const result = [];
  for (const d of payload.diagnostics || []) {
    const line = Math.max(0, (d.line || 1) - 1);
    const col = Math.max(0, (d.col || 1) - 1);
    const endLine = d.endLine ? d.endLine - 1 : line;
    const endCol = d.endCol
      ? d.endCol - 1
      : doc.lineCount > line
        ? doc.lineAt(line).range.end.character
        : col;
    const severity =
      d.severity === "warning"
        ? vscode.DiagnosticSeverity.Warning
        : vscode.DiagnosticSeverity.Error;
    const diag = new vscode.Diagnostic(
      new vscode.Range(line, col, endLine, endCol),
      d.message || "unknown error",
      severity
    );
    diag.source = "blade";
    // BLxxxx diagnostic code (additive field, compilers >= diagnostics arc).
    if (d.code) diag.code = diagnosticCode(d.code);
    result.push(diag);
  }
  return result;
}

/**
 * True when a payload carries NO bindings but DOES report a problem — the
 * shape the compiler answers with when the file failed to PARSE (a file that
 * parses but fails to type-check still reports every binding it recovered,
 * so this is specific to the parse lane). Nothing semantic survives a parse
 * failure: bindings, references, calls and kernels all come back empty
 * together, which — applied verbatim — silently strips every hover, lens and
 * completion from the file until the next character makes it parse again.
 * Since mid-edit buffers are unparseable most of the time, that reads to the
 * user as "tooltips randomly stop working".
 *
 * `_parseFailure` lets a caller assert the condition when its own view of the
 * payload can't: src/notebook.js fans ONE assembled `checkCells` response out
 * to N cell documents, and a cell whose window contains none of the
 * diagnostics would otherwise look like an ordinary empty cell.
 */
function isParseFailurePayload(payload) {
  if (payload._parseFailure) return true;
  return (payload.bindings || []).length === 0 && (payload.diagnostics || []).length > 0;
}

/**
 * Apply a check response — serve or one-shot `ide check --json`, same
 * payload shape — to the per-document caches, the diagnostics collection,
 * and the telemetry line. The one place that does this, so the fast/slow
 * serve clocks and the one-shot fallback can never drift apart.
 *
 * Diagnostics are applied unconditionally — the squiggle is the whole point,
 * and suppressing it would hide the very error that caused the blackout. The
 * SEMANTIC caches are what a parse failure leaves untouched (see
 * isParseFailurePayload): keeping the last-good ones means hovers/lenses go
 * momentarily stale rather than vanishing, matching the "kept last-good
 * hovers" policy checkDocument already applies to transient serve failures.
 * Stale-by-a-few-lines is the accepted cost, and it is bounded: the next
 * payload that parses replaces the caches wholesale.
 * @param {vscode.TextDocument} doc
 */
function applyCheckPayload(doc, payload) {
  const key = doc.uri.toString();
  const parseFailure = isParseFailurePayload(payload);
  if (!parseFailure) {
    bindingsByDoc.set(key, payload.bindings || []);
    // Skipped rather than called with [] on a parse failure: cacheProviders
    // also PRUNES (any cached store whose `.load` line text moved is dropped),
    // so passing an empty incoming list would still discard stores.
    cacheProviders(doc, payload.providers || []);
    callsByDoc.set(key, payload.calls || []);
    kernelsByDoc.set(key, payload.kernels || []);
    referencesByDoc.set(key, payload.references || []);
  }
  diagnostics.set(doc.uri, jsonToDiagnostics(doc, payload));
  // Concise telemetry so a "no tooltips" report can be pinpointed: empty
  // bindings ⇒ the file didn't type-check; providers=0 on a provider file ⇒
  // its data path didn't resolve from the run directory. `tier` is present
  // on serve responses only (fast/full); absent from the one-shot pipeline.
  output.appendLine(
    `[blade] ${path.basename(doc.fileName)}: bindings=${(payload.bindings || []).length}` +
      ` providers=${(payload.providers || []).length} diagnostics=${(payload.diagnostics || []).length}` +
      (payload.tier ? ` tier=${payload.tier}` : "") +
      (parseFailure ? " (parse failure — kept last-good hovers)" : "")
  );
  // Lenses (signature/array/deduction, workstream 4) are computed from the
  // same caches just updated above — tell VS Code to re-ask so they track
  // the fast/slow clocks the way diagnostics and hovers already do.
  codeLensEmitter.fire();
}

/**
 * Run a check and apply its results. `tier` picks the compiler pass: "fast"
 * (parse + typecheck + deduce — the as-you-type clock) or "full" (fast +
 * monomorphization, upgrading value-binding hovers/lenses to concrete
 * types — save/open/idle). Serve-backed checks (src/serve.js) are preferred
 * whenever `blade ide serve` is available; once a session has fallen back to
 * the one-shot pipeline (ideMode "json"/"text" — old compiler, or serve gave
 * up after repeated failures) serve is not retried, matching
 * serve.available()'s own session-long latch.
 *
 * "fast" is a serve-only concept: spawning a fresh `ide check --json`
 * process on every keystroke would defeat the entire point of the fast
 * clock, so a fast-tier call is simply a no-op when serve isn't available —
 * save/open continue to work via the unchanged one-shot pipeline below.
 * @param {vscode.TextDocument} doc
 * @param {"fast"|"full"} [tier] defaults to "full"
 */
async function checkDocument(doc, tier) {
  if (doc.languageId !== "blade" || doc.uri.scheme !== "file") return;
  const t = tier === "fast" ? "fast" : "full";

  if (ideMode !== "json" && ideMode !== "text") {
    if (serve.available() !== "no") {
      const version = doc.version;
      const source = doc.getText();
      try {
        const payload = await serve.check(doc.fileName, source, t);
        // A newer edit landed while this request was in flight — the
        // response no longer describes the buffer; drop it (repl.js uses the
        // same anchor-version guard for stale REPL results).
        if (doc.version !== version) return;
        ideMode = "serve";
        applyCheckPayload(doc, payload);
        if (t === "fast") scheduleIdleFullCheck(doc);
        else clearIdleTimer(doc); // a full check answers what idle would have asked
        return;
      } catch (e) {
        if (serve.available() === "no") {
          output.appendLine(`[blade] ide serve unavailable — falling back to one-shot checks (${e.message})`);
          // Fall through to the one-shot pipeline below, for this call too.
        } else {
          // Transient (backing off / a request timed out): keep last-good
          // caches rather than spawning a one-shot check per keystroke.
          output.appendLine(`[blade] serve check skipped (kept last-good hovers): ${e.message}`);
          return;
        }
      }
    }
    // else: availability already latched "no" from an earlier call — fall
    // straight through to the one-shot pipeline, which will set ideMode.
  }

  // The fast clock only exists through serve — nothing to do on an older
  // compiler (save/open below still run the full one-shot pipeline).
  if (t === "fast") return;

  const exe = findCompiler();
  // Run from the file's own directory so a provider's relative data path
  // (`z.load("data/…")`) resolves the same way it does when the compiler is
  // invoked from that folder. Without this the load fails, which both drops
  // provider tooltips and — for unannotated reads — makes the file fail to
  // type-check, emptying `bindings` (so even ordinary/param hovers disappear).
  const cwd = path.dirname(doc.fileName);

  // Prefer the JSON IDE mode; probe once per session.
  if (ideMode !== "text") {
    const res = await run(exe, ["ide", "check", "--json", doc.fileName], undefined, cwd);
    if (res.failedToSpawn) {
      reportNoCompiler(exe);
      return;
    }
    let payload = null;
    try {
      payload = JSON.parse(res.stdout);
    } catch (_) {
      /* not JSON — old compiler */
    }
    if (payload && typeof payload === "object" && (payload.diagnostics || payload.bindings)) {
      ideMode = "json";
      applyCheckPayload(doc, payload);
      return;
    }
    // Non-JSON output. If JSON mode was never established this is an old
    // compiler → latch to text mode. But once JSON has worked, a later
    // non-JSON result is a transient failure (e.g. the compiler crashed on
    // this file); keep JSON mode and the last-good hovers rather than killing
    // tooltips for the rest of the session.
    if (ideMode === "json") {
      output.appendLine(
        `[blade] ide check produced no JSON for ${path.basename(doc.fileName)} (kept last-good hovers)`
      );
      if (res.stderr) output.appendLine(res.stderr.split(/\r?\n/).slice(0, 20).join("\n"));
      return;
    }
    ideMode = "text";
    output.appendLine(
      "[blade] compiler has no 'ide check --json' subcommand yet; using text diagnostics (no hover types)"
    );
  }

  const res = await run(exe, ["check", doc.fileName], undefined, cwd);
  if (res.failedToSpawn) {
    reportNoCompiler(exe);
    return;
  }
  if (res.exitCode === 0) {
    diagnostics.set(doc.uri, []);
    // Warnings carry no position in text mode ("[TypeCheck Warning] ...");
    // surface them in the output channel until JSON mode provides spans.
    for (const w of res.stdout.match(/^\[TypeCheck Warning\].*$/gm) || []) {
      output.appendLine(`[blade] ${path.basename(doc.fileName)}: ${w}`);
    }
    return;
  }
  const ds = textToDiagnostics(doc, res.stderr + "\n" + res.stdout);
  diagnostics.set(doc.uri, ds);
  if (ds.length === 0) {
    // Failed but nothing parseable — surface raw output so failures are not silent.
    output.appendLine("[blade] check failed with unparsed output:");
    output.appendLine(res.stderr || res.stdout);
  }
}

// --- Live checking clocks (fast/slow, serve-backed) --------------------------
//
// Two independent per-document timers layered on checkDocument's tier logic:
// `fastTimers` debounces the as-you-type ("fast") check after each edit;
// `idleTimers` fires a "full" check after a quiet spell that follows a
// SUCCESSFUL fast check (not the edit itself) — see checkDocument's
// `scheduleIdleFullCheck` call. Both are serve-only (see checkDocument's
// early "t === 'fast' return"); on an older compiler neither timer is ever
// armed, so save/open remain the only triggers, unchanged.

const fastTimers = new Map(); // uri.toString() -> Timeout
const idleTimers = new Map(); // uri.toString() -> Timeout

function clearFastTimer(doc) {
  const key = doc.uri.toString();
  const t = fastTimers.get(key);
  if (t) {
    clearTimeout(t);
    fastTimers.delete(key);
  }
}

function clearIdleTimer(doc) {
  const key = doc.uri.toString();
  const t = idleTimers.get(key);
  if (t) {
    clearTimeout(t);
    idleTimers.delete(key);
  }
}

function scheduleIdleFullCheck(doc) {
  clearIdleTimer(doc);
  const key = doc.uri.toString();
  const delay = vscode.workspace.getConfiguration("blade").get("fullCheckIdleMs", 2000);
  idleTimers.set(
    key,
    setTimeout(() => {
      idleTimers.delete(key);
      checkDocument(doc, "full");
    }, delay)
  );
}

/**
 * onDidChangeTextDocument handler: debounce a fast-tier check. Any edit
 * cancels a pending idle-triggered full check — we are no longer idle — so
 * an idle full check only ever follows a fast check that wasn't itself
 * immediately followed by more typing.
 */
function onDocumentChanged(doc) {
  if (doc.languageId !== "blade" || doc.uri.scheme !== "file") return;
  clearIdleTimer(doc);
  const cfg = vscode.workspace.getConfiguration("blade");
  if (!cfg.get("liveChecking", true)) return;
  if (serve.available() === "no") return; // old compiler: fast clock stays off
  clearFastTimer(doc);
  const key = doc.uri.toString();
  const delay = cfg.get("fastCheckDebounceMs", 300);
  fastTimers.set(
    key,
    setTimeout(() => {
      fastTimers.delete(key);
      checkDocument(doc, "fast");
    }, delay)
  );
}

function reportNoCompiler(exe) {
  if (warnedNoCompiler) return;
  warnedNoCompiler = true;
  vscode.window.showWarningMessage(
    `Blade: compiler not found ('${exe}'). Set "blade.compilerPath" in settings to enable diagnostics.`
  );
}

// --- Batch run (blade run) ---------------------------------------------------
//
// The ▶ Run path stays a full g++ compile+run of the saved file (`blade run`
// auto-prints every top-level binding) — no session, full codegen fidelity.
// Interactive evaluation goes through the interpreter-backed REPL below.

/** @type {vscode.OutputChannel} */
let replChannel;

function replOut() {
  if (!replChannel) replChannel = vscode.window.createOutputChannel("Blade REPL");
  return replChannel;
}

function runTimeoutMs() {
  return vscode.workspace.getConfiguration("blade").get("runTimeoutSeconds", 180) * 1000;
}

async function runBlade(fileToRun, header) {
  const exe = findCompiler();
  const ch = replOut();
  ch.show(true);
  ch.appendLine(header);
  const t0 = Date.now();
  const res = await run(exe, ["run", fileToRun], runTimeoutMs());
  if (res.failedToSpawn) {
    reportNoCompiler(exe);
    ch.appendLine("[error] compiler not found — set blade.compilerPath");
    return;
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  const emit = (text) => {
    if (text.trim()) ch.append(text.endsWith("\n") ? text : text + "\n");
  };
  emit(res.stdout);
  emit(res.stderr);
  ch.appendLine(res.exitCode === 0 ? `[done in ${secs}s]` : `[exit ${res.exitCode} after ${secs}s]`);
}

async function commandRunFile() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "blade") return;
  await editor.document.save();
  await runBlade(editor.document.fileName, `> run ${path.basename(editor.document.fileName)}`);
}

// --- Interactive REPL (`blade repl`, interpreter-backed) ---------------------
//
// The compiler's `blade repl` subcommand is an accumulating session, now
// evaluated by the tree-walking interpreter (<100 ms per input; per-input
// g++ fallback for what it can't cover yet). src/repl.js owns the process
// behind a pseudoterminal, which is what lets Alt+Enter results render
// INLINE next to the evaluated line as well as in the terminal transcript.
// The anchor ({ uri, line, version }) names the line the result decorates;
// version-stamping lets a late result detect that the document moved on.

function anchorAt(doc, line) {
  return { uri: doc.uri.toString(), line, version: doc.version };
}

function commandStartRepl() {
  const editor = vscode.window.activeTextEditor;
  const doc = editor && editor.document.languageId === "blade" ? editor.document : undefined;
  repl.startRepl(doc);
}

function commandSendSelectionToRepl() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "blade") return;
  const doc = editor.document;
  const sel = editor.selection;
  const code = sel.isEmpty ? doc.lineAt(sel.active.line).text : doc.getText(sel);
  if (!code.trim()) return;
  // The result decorates the submission's last line — where its value
  // "returns" (a full-line selection's end often sits at col 0 of the NEXT
  // line; step back so the anchor stays on the code).
  const anchorLine = sel.isEmpty
    ? sel.active.line
    : sel.end.character === 0 && sel.end.line > sel.start.line
      ? sel.end.line - 1
      : sel.end.line;
  repl.sendToRepl(doc, code, anchorAt(doc, anchorLine));
  // Python-style: with no selection, step the cursor to the next non-empty
  // line so repeated Alt+Enter walks the file.
  if (sel.isEmpty) {
    let next = sel.active.line + 1;
    while (next < doc.lineCount - 1 && doc.lineAt(next).text.trim() === "") next++;
    if (next < doc.lineCount) {
      const pos = new vscode.Position(next, 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos));
    }
  }
}

function commandSendFileToRepl() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "blade") return;
  const doc = editor.document;
  const code = doc.getText();
  if (!code.trim()) return;
  let last = doc.lineCount - 1;
  while (last > 0 && doc.lineAt(last).text.trim() === "") last--;
  repl.sendToRepl(doc, code, anchorAt(doc, last));
}

async function commandEmitFile() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "blade") return;
  await editor.document.save();
  const exe = findCompiler();
  const res = await run(exe, ["emit", editor.document.fileName], runTimeoutMs());
  if (res.failedToSpawn) {
    reportNoCompiler(exe);
    return;
  }
  if (res.exitCode !== 0) {
    const ch = replOut();
    ch.show(true);
    ch.appendLine(`> emit ${path.basename(editor.document.fileName)} failed:`);
    ch.appendLine(res.stderr || res.stdout);
    return;
  }
  const cppDoc = await vscode.workspace.openTextDocument({
    language: "cpp",
    content: res.stdout,
  });
  await vscode.window.showTextDocument(cppDoc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
}

// --- Types (primitives, index types, nominal aliases, arrays) ---------------
//
// Built-in primitives and index types come from the static `types` table.
// Nominal index types (user `type X = Idx<...>`) and `Array<...>` types are
// resolved from the source here, since the compiler emits no bindings for
// them. All four kinds render as a hover tooltip.

// Does a `type X = Rhs` right-hand side name an index type? Derived from the
// hover table rather than spelled out, so a family member added there cannot
// end up hovering as an index type while its aliases read as plain aliases.
// Longest-first so the alternation never depends on the table's key order.
const INDEX_KEYWORD_RE = new RegExp(
  `^(${Object.keys(types.indexTypes)
    .sort((a, b) => b.length - a.length)
    .join("|")})\\b`
);

// uri.toString() -> { version, decls, units, statics } cache of the scanned
// declarations (see scanDecls).
const typeDeclCache = new Map();

/**
 * The contiguous `//` doc-comment block directly above line `lineIndex`
 * (0-based), Ionide-style: a blank or non-comment line ends the block, and
 * corpus directives (// TEST:/EXPECT:/MODULE:) and `====` banners are dropped.
 */
function docCommentAbove(doc, lineIndex) {
  const out = [];
  for (let l = lineIndex - 1; l >= 0; l--) {
    const t = doc.lineAt(l).text.trim();
    if (!t.startsWith("//")) break; // blank or code line ends the block
    const body = t.replace(/^\/\/\s?/, "");
    if (/^(TEST|EXPECT|MODULE|EXPECT_OUTPUT|EXPECT_ERROR)\b/.test(body)) continue;
    if (/^=+$/.test(body)) continue;
    out.unshift(body);
  }
  const text = out.join("\n").trim();
  return text || undefined;
}

/**
 * Scan the document for `type Name = Rhs` aliases, `Unit name [= expr]`
 * unit-of-measure declarations, and single-line `let static Name = Rhs`
 * bindings. Returns { decls, units, statics }: decls maps
 * name -> { name, parent, indexLike, doc, line }; units maps
 * name -> { name, rhs, doc, line } (rhs undefined for base units); statics
 * maps name -> rhs (the key lists a `SparseIdx<K>` names). `line` is 0-based
 * (a plain doc.lineAt index — this is a local scan, not a compiler payload
 * span, so it skips that convention's 1-based numbering) and exists purely
 * for the outline provider (documentSymbols) to build a Range from; every
 * other consumer of decls/units predates it and ignores the field. Cached
 * per document version.
 */
function scanDecls(doc) {
  const key = doc.uri.toString();
  const cached = typeDeclCache.get(key);
  if (cached && cached.version === doc.version) return cached;

  const decls = new Map();
  const units = new Map();
  const statics = new Map();
  for (let l = 0; l < doc.lineCount; l++) {
    const text = doc.lineAt(l).text;
    const s = /^\s*let\s+static\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(text);
    if (s) statics.set(s[1], s[2].replace(/\s*\/\/.*$/, "").trim());
    const m = /^\s*type\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/.exec(text);
    if (m) {
      const parent = m[2].replace(/\s*\/\/.*$/, "").trim(); // drop trailing line comment
      decls.set(m[1], {
        name: m[1],
        parent,
        indexLike: INDEX_KEYWORD_RE.test(parent),
        doc: docCommentAbove(doc, l),
        line: l,
      });
      continue;
    }
    // '=' is a structural unit (rhs is a unit-algebra expression); ':' is a
    // Quantity — a nominal tag entailing the rhs unit's dims. Quantities are
    // terminal (never valid as another unit expression's rhs), but that's a
    // compiler-side check — here we just remember which form was written.
    const u = /^\s*Unit\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*([=:])\s*(.+?))?\s*$/.exec(text);
    if (u) {
      const rhs = u[3] && u[3].replace(/\s*\/\/.*$/, "").trim();
      const kind = u[2] === ":" ? "quantity" : "unit";
      units.set(u[1], { name: u[1], kind, rhs: rhs || undefined, doc: docCommentAbove(doc, l), line: l });
    }
  }
  const entry = { version: doc.version, decls, units, statics };
  typeDeclCache.set(key, entry);
  return entry;
}

/** The `type Name = Rhs` aliases of `doc` (see scanDecls). */
function scanTypeDecls(doc) {
  return scanDecls(doc).decls;
}

/** Split `s` on top-level occurrences of `sep`, ignoring `<> () []` nesting. */
function splitTopLevel(s, sep) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "<" || c === "(" || c === "[") depth++;
    else if (c === ">" || c === ")" || c === "]") depth--;
    else if (c === sep && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts.map((p) => p.trim()).filter((p) => p.length);
}

/** Split an Array's inner text on the top-level `like` keyword (or null). */
function splitOnLike(inner) {
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "<" || c === "(" || c === "[") depth++;
    else if (c === ">" || c === ")" || c === "]") depth--;
    else if (depth === 0 && /\s/.test(c) && /^like(?=\s|$)/.test(inner.slice(i + 1))) {
      return [inner.slice(0, i), inner.slice(i + 1 + 4)];
    }
  }
  return null;
}

/**
 * From `Array` at (startLine, startChar), collect the full `Array<...>` text
 * by tracking angle-bracket depth across up to 20 lines. Returns "" if no
 * balanced `<...>` follows.
 */
function collectAngleType(doc, startLine, startChar) {
  let result = "";
  let depth = 0;
  let opened = false;
  const maxLine = Math.min(doc.lineCount, startLine + 20);
  for (let l = startLine; l < maxLine; l++) {
    const text = l === startLine ? doc.lineAt(l).text.slice(startChar) : "\n" + doc.lineAt(l).text;
    for (const ch of text) {
      result += ch;
      if (ch === "<") {
        depth++;
        opened = true;
      } else if (ch === ">") {
        depth--;
        if (opened && depth === 0) return result;
      }
    }
  }
  return "";
}

/**
 * Parse the `Array<Elem like Idx1, Idx2>` type whose `Array` keyword sits at
 * `wordRange`, resolving each index arg's doc from its nominal declaration.
 * Returns { elem, indices: [{ text, doc }] } or null.
 */
function parseArrayTypeAt(doc, wordRange) {
  const full = collectAngleType(doc, wordRange.start.line, wordRange.start.character);
  const m = /^Array\s*<([\s\S]*)>\s*$/.exec(full);
  if (!m) return null;
  const inner = m[1];

  let elem;
  let idxText;
  const parts = splitOnLike(inner);
  if (parts) {
    elem = parts[0].trim();
    idxText = parts[1];
  } else {
    // Pretty-printer form `Array<Elem, Idx...>`: first arg is the element.
    const commaParts = splitTopLevel(inner, ",");
    elem = commaParts[0] || "";
    idxText = commaParts.slice(1).join(", ");
  }

  const decls = scanTypeDecls(doc);
  const indices = splitTopLevel(idxText, ",").map((text) => {
    const idm = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(text);
    const name = idm && idm[1];
    const nom = name && decls.get(name);
    if (nom) return { text, doc: nom.doc };
    const it = name && types.indexTypes[name];
    return { text, doc: it ? it.desc : undefined };
  });
  return { elem, indices };
}

// --- The concrete OrbIdx / SparseIdx class at a hover site --------------------
//
// Both types keep their whole identity in their arguments, so the static table
// can only describe the family. An OrbIdx's level list IS the class, and the
// written spelling need not be the class it lowers to (a rank-1 level is the
// trivial group and drops; what survives decides the record). A SparseIdx's
// rank is never written — it is the arity of its keys' tuples. Both are
// resolved from the source at hover time, exactly as `Array<...>` is.

/** `[(2,-), (2,+)]` -> [{rank, plus}, ...]; `[]` -> []; null if malformed. */
function parseOrbLevels(text) {
  const m = /^\[\s*([\s\S]*?)\s*\]$/.exec(text.trim());
  if (!m) return null;
  if (!m[1]) return [];
  const levels = [];
  for (const part of splitTopLevel(m[1], ",")) {
    const lm = /^\(\s*(\d+)\s*,\s*([+-])\s*\)$/.exec(part);
    if (!lm) return null;
    levels.push({ rank: Number(lm[1]), plus: lm[2] === "+" });
  }
  return levels;
}

/** Exact C(m, r) as a BigInt (0 when r > m). Each step is an exact division. */
function binom(m, r) {
  if (BigInt(r) > m) return 0n;
  let acc = 1n;
  for (let i = 1n; i <= BigInt(r); i++) acc = (acc * (m - BigInt(r) + i)) / i;
  return acc;
}

const INT64_MAX = 9223372036854775807n;

/** Render a level list the way the compiler prints it. */
function showOrbLevels(levels) {
  return "[" + levels.map((l) => `(${l.rank},${l.plus ? "+" : "-"})`).join(", ") + "]";
}

/**
 * The `this class:` block for a written `OrbIdx<[...], n>`: the record it
 * normalizes to when the spelling isn't already normal, the wreath group and
 * its raw-axis count, and the cardinality fold
 * (M0 = n; M = C(M+r-1, r) at `+`, C(M, r) at `-`) when the extent is a
 * literal. Returns undefined if `text` isn't a well-formed OrbIdx.
 */
function orbIdxDetail(text) {
  const m = /^OrbIdx\s*<([\s\S]*)>\s*$/.exec(text.trim());
  if (!m) return undefined;
  const parts = splitTopLevel(m[1], ",");
  if (parts.length !== 2) return undefined;
  const levels = parseOrbLevels(parts[0]);
  if (!levels || levels.some((l) => l.rank < 1)) return undefined;
  const extent = parts[1];

  // A rank-1 level is the trivial group and drops at either sign; the empty
  // class is `Idx<N>` and a single survivor is the exact Sym/Antisym record.
  const kept = levels.filter((l) => l.rank !== 1);
  const lines = [];
  if (kept.length === 0) lines.push(`normalizes to  Idx<${extent}>`);
  else if (kept.length === 1)
    lines.push(
      `normalizes to  ${kept[0].plus ? "SymIdx" : "AntisymIdx"}<${kept[0].rank}, ${extent}>`
    );
  else {
    if (kept.length !== levels.length)
      lines.push(`normalizes to  OrbIdx<${showOrbLevels(kept)}, ${extent}>`);
    lines.push(
      `group          ${kept.map((l) => `S_${l.rank}`).join(" wr ")}` +
        `  (characters ${kept.map((l) => (l.plus ? "+" : "-")).join(", ")})`
    );
  }
  lines.push(`raw axes       ${kept.reduce((a, l) => a * l.rank, 1)}`);

  if (/^\d+$/.test(extent)) {
    let cells = BigInt(extent);
    const steps = [];
    let overflowed = false;
    for (const l of kept) {
      const top = l.plus ? cells + BigInt(l.rank) - 1n : cells;
      cells = binom(top, l.rank);
      steps.push(`C(${top},${l.rank}) = ${cells}`);
      // The compiler's fold is exactly-checked int64 and stops at the first
      // step that wraps; carrying on would print a number it never computes.
      if (cells > INT64_MAX) {
        overflowed = true;
        break;
      }
    }
    lines.push(`cells          ${[extent, ...steps].join(" -> ")}`);
    // The fold runs at allocation, not at the declaration — the class can be
    // named, but nothing can be stored in it.
    if (overflowed) lines.push(`               int64 overflow — refused at allocation`);
  }
  return lines.join("\n");
}

/**
 * The `this class:` block for a written `SparseIdx<keys>`: the entry count and
 * the rank the tuple arity implies, plus the subscript form that rank takes
 * (one joint tuple; a rank-1 key collapses to a bare scalar). Only a literal
 * key list or one named by a single-line `let static` resolves — a runtime
 * keys array has nothing to count, and returns undefined.
 */
function sparseIdxDetail(doc, text) {
  const m = /^SparseIdx\s*<([\s\S]*)>\s*$/.exec(text.trim());
  if (!m) return undefined;
  const keys = m[1].trim();
  let listText = keys;
  let origin = "";
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(keys)) {
    listText = scanDecls(doc).statics.get(keys);
    if (!listText) return undefined;
    origin = `  (let static ${keys})`;
  }
  const lm = /^\[\s*([\s\S]*?)\s*\]$/.exec(listText);
  if (!lm || !lm[1]) return undefined;
  const entries = splitTopLevel(lm[1], ",");
  const arities = entries.map((e) => {
    const t = /^\(\s*([\s\S]*?)\s*\)$/.exec(e);
    return t ? splitTopLevel(t[1], ",").length : 1;
  });
  const rank = arities[0];
  if (!arities.every((a) => a === rank)) return undefined; // ragged: not a key set
  const subscript =
    rank === 1
      ? "S(c0)"
      : `S((${Array.from({ length: rank }, (_, i) => `c${i}`).join(", ")}))`;
  return [`keys           ${entries.length}${origin}`, `rank           ${rank} — index as ${subscript}`].join(
    "\n"
  );
}

/**
 * `name` + `kind` in a code block, with an optional description below a rule.
 * `descIsPlain` renders user-authored text verbatim (no markdown); otherwise
 * `desc` is treated as markdown (used for our built-in `sig` + prose).
 */
function typeMarkdown(codeLines, desc, descIsPlain) {
  const md = new vscode.MarkdownString();
  md.appendCodeblock(codeLines.join("\n"), "blade");
  if (desc) {
    md.appendMarkdown("\n---\n\n");
    if (descIsPlain) md.appendText(desc);
    else md.appendMarkdown(desc);
  }
  return md;
}

/**
 * The hover/completion body for a built-in index type: its signature and
 * description, then — for the compact classes — the shape an array literal
 * over that class takes. The literal line is deliberately NOT part of `desc`:
 * `desc` doubles as the one-line comment beside each index in the `Array<...>`
 * tooltip (arrayMarkdown collapses it to a single line), where an example
 * would swamp its neighbours.
 */
function indexTypeDoc(it) {
  return "`" + it.sig + "` — " + it.desc + (it.lit ? "\n\n" + it.lit : "");
}

/** Multi-line Array tooltip: `Array: T like` then one index per line. */
function arrayMarkdown(arr) {
  const lines = [`Array: ${arr.elem} like`];
  const bodies = arr.indices.map(
    (ix, i) => `    ${ix.text}${i < arr.indices.length - 1 ? "," : ""}`
  );
  const width = bodies.length ? Math.max(...bodies.map((b) => b.length)) : 0;
  arr.indices.forEach((ix, i) => {
    // Keep each arg on one line: collapse any multi-line doc to a single line.
    const doc = ix.doc && ix.doc.replace(/\s*\n\s*/g, " ");
    lines.push(doc ? `${bodies[i].padEnd(width)}  // ${doc}` : bodies[i]);
  });
  const md = new vscode.MarkdownString();
  md.appendCodeblock(lines.join("\n"), "blade");
  return md;
}

/** The first balanced `Name<...>` occurrence inside `text`, or undefined. */
function firstAngleForm(text, name) {
  const at = text.indexOf(name + "<");
  if (at === -1) return undefined;
  let depth = 0;
  for (let i = at + name.length; i < text.length; i++) {
    if (text[i] === "<") depth++;
    else if (text[i] === ">" && --depth === 0) return text.slice(at, i + 1);
  }
  return undefined;
}

/**
 * Append the concrete class of the `OrbIdx<...>` / `SparseIdx<...>` inside
 * `text` to `md`. `text` is any type string — the spelling at a hover site, a
 * nominal alias's right-hand side, or a whole `Array<...>` the compiler
 * reported, which is the only place a DEDUCED wreath class is ever seen.
 * Silent when there is none or it doesn't resolve, so a half-typed or
 * runtime-keyed type still gets the family hover.
 */
function appendClassDetail(md, doc, text) {
  if (!text) return;
  const orb = firstAngleForm(text, "OrbIdx");
  const sparse = orb ? undefined : firstAngleForm(text, "SparseIdx");
  const detail = orb ? orbIdxDetail(orb) : sparse ? sparseIdxDetail(doc, sparse) : undefined;
  if (!detail) return;
  md.appendMarkdown("\n*this class:*\n");
  md.appendCodeblock(detail, "blade");
}

/** Hover for a type name under the cursor, or undefined if it isn't a type. */
function typeHoverFor(doc, word, wordRange) {
  // Array<...>: parse the element and index args at this location.
  if (word === "Array") {
    const arr = parseArrayTypeAt(doc, wordRange);
    if (arr) return new vscode.Hover(arrayMarkdown(arr), wordRange);
  }
  // Primitive: name + "Primitive Type", one-liner (alias facts) below.
  const prim = types.primitives[word];
  if (prim !== undefined) {
    return new vscode.Hover(typeMarkdown([word, "Primitive Type"], prim), wordRange);
  }
  // Index type: name + "Index Type", then a short description with its args,
  // and — for the two whose identity is entirely in their arguments — the
  // concrete class written here.
  const it = types.indexTypes[word];
  if (it) {
    const md = typeMarkdown([word, "Index Type"], indexTypeDoc(it));
    appendClassDetail(md, doc, collectAngleType(doc, wordRange.start.line, wordRange.start.character));
    return new vscode.Hover(md, wordRange);
  }
  // Other built-in constructor (Poly, ...).
  const ctor = types.constructors[word];
  if (ctor) {
    return new vscode.Hover(
      typeMarkdown([word, ctor.kind], "`" + ctor.sig + "` — " + ctor.desc),
      wordRange
    );
  }
  // Nominal index type / alias from a source `type X = ...` declaration.
  const decl = scanTypeDecls(doc).get(word);
  if (decl) {
    const kindLine = decl.indexLike
      ? `Nominal Index Type: ${decl.parent}`
      : `Type Alias: ${decl.parent}`;
    const md = typeMarkdown([`type ${decl.name} = ${decl.parent}`, kindLine], decl.doc, true);
    appendClassDetail(md, doc, decl.parent);
    return new vscode.Hover(md, wordRange);
  }
  // Unit of measure / Quantity from a source `Unit name [= expr]` or
  // `Unit name: expr` declaration.
  const unit = scanDecls(doc).units.get(word);
  if (unit) {
    const isQuantity = unit.kind === "quantity";
    const declLine = !unit.rhs
      ? `Unit ${unit.name}`
      : isQuantity
        ? `Unit ${unit.name}: ${unit.rhs}`
        : `Unit ${unit.name} = ${unit.rhs}`;
    const kindLine = isQuantity
      ? unit.rhs === "1" ? "Quantity (dimensionless)" : "Quantity"
      : "Unit of Measure";
    return new vscode.Hover(
      typeMarkdown([declLine, kindLine], unit.doc, true),
      wordRange
    );
  }
  return undefined;
}

// --- Hover ------------------------------------------------------------------

/** Find the best binding for `word` visible from `line` (0-based). */
function lookupBinding(doc, word, line) {
  const bindings = bindingsByDoc.get(doc.uri.toString());
  if (!bindings) return undefined;
  const matches = bindings.filter((b) => b.name === word && b.type);
  if (matches.length === 0) return undefined;
  // Nearest binding declared at or before the reference line approximates
  // lexical scope until the compiler emits expression spans.
  let best = matches[0];
  for (const b of matches) {
    const bLine = (b.line || 1) - 1;
    const bestLine = (best.line || 1) - 1;
    if (bLine <= line && (bestLine > line || bLine > bestLine)) best = b;
  }
  return best;
}

// --- References (definition, find-references, rename, outline) -------------
//
// Everything below reads the references[] payload (see referencesByDoc's own
// comment for the shape). A compiler that doesn't emit it yet leaves every
// document's entry at [] (applyCheckPayload's `payload.references || []`),
// so every function here degrades to "nothing resolves" / "no entries" —
// never throws — and documentSymbols falls back to a flat bindings[]-only
// outline explicitly (the one path this section can exercise against a live
// compiler today; see its own comment).

/** Does a 1-based reference span `span` contain 1-based position (line, ch)?
 *  Same before/after containment shape as lookupCall's span comparison
 *  above — before <=> span starts at or before the position, after <=> span
 *  ends at or after it. */
function referenceSpanContains(span, line, ch) {
  if (!span) return false;
  const before = span.line < line || (span.line === line && span.col <= ch);
  const after = span.endLine > line || (span.endLine === line && span.endCol >= ch);
  return before && after;
}

/**
 * The references[] entry covering `position`, plus WHICH of its spans
 * matched (def or a specific use) — rename's prepareRename needs the exact
 * span under the cursor for its placeholder range, while everything else
 * only needs the entry. Def is checked before uses across all entries so a
 * cursor sitting exactly on a def (defs and uses of DIFFERENT entries should
 * never overlap — they're distinct name tokens — but def-first is the
 * defensive tie-break if they ever did).
 */
function findReferenceSpanAt(doc, position) {
  const entries = referencesByDoc.get(doc.uri.toString());
  if (!entries || !entries.length) return undefined;
  const line = position.line + 1;
  const ch = position.character + 1;
  for (const entry of entries) {
    if (referenceSpanContains(entry.def, line, ch)) return { entry, span: entry.def };
  }
  for (const entry of entries) {
    for (const u of entry.uses || []) {
      if (referenceSpanContains(u, line, ch)) return { entry, span: u };
    }
  }
  return undefined;
}

/** The references[] entry covering `position` (def or any use), or
 *  undefined — the shared resolver behind go-to-definition, find-references,
 *  rename, and the hover shadowing fix below. */
function resolveReference(doc, position) {
  const hit = findReferenceSpanAt(doc, position);
  return hit && hit.entry;
}

/** A 1-based {line,col,endLine,endCol} span (references[]/calls[]
 *  convention) as a 0-based vscode.Range. */
function spanToRange(span) {
  return new vscode.Range(
    Math.max(0, (span.line || 1) - 1),
    Math.max(0, (span.col || 1) - 1),
    Math.max(0, (span.endLine || span.line || 1) - 1),
    Math.max(0, (span.endCol || span.col || 1) - 1)
  );
}

function spanToLocation(uri, span) {
  return new vscode.Location(uri, spanToRange(span));
}

/**
 * Resolve `word` at `position` through references[] first: the entry
 * covering this exact position names its def LINE precisely, so a binding
 * declared on that exact line resolves even when an outer binding of the
 * same name (declared earlier, and therefore also "at or before" the use
 * line) would otherwise win lookupBinding's nearest-line heuristic — e.g. a
 * function's own param shadowing an outer value of the same name, hovered
 * from a LATER, unrelated function where only the outer value is in scope.
 * Falls back to that heuristic unchanged when references[] has nothing for
 * this position (older compiler, or the word isn't a tracked binder — a
 * builtin, keyword, or type name).
 */
function lookupBindingPrecise(doc, word, position) {
  const entry = resolveReference(doc, position);
  if (entry && entry.name === word && entry.def) {
    const bindings = bindingsByDoc.get(doc.uri.toString()) || [];
    const exact = bindings.find((b) => b.name === word && (b.line || 1) === entry.def.line);
    if (exact) return exact;
  }
  return lookupBinding(doc, word, position.line);
}

const definitionProvider = {
  provideDefinition(doc, position) {
    const entry = resolveReference(doc, position);
    if (!entry || !entry.def) return undefined;
    return spanToLocation(doc.uri, entry.def);
  },
};

const referenceProvider = {
  provideReferences(doc, position, context) {
    const entry = resolveReference(doc, position);
    if (!entry) return undefined;
    const locations = (entry.uses || []).map((u) => spanToLocation(doc.uri, u));
    if (context && context.includeDeclaration && entry.def) {
      locations.push(spanToLocation(doc.uri, entry.def));
    }
    return locations;
  },
};

/** Is `name` already claimed by a keyword, builtin, or built-in type table —
 *  the collision check provideRenameEdits runs a new name against. */
function isReservedName(name) {
  return Boolean(
    keywords.keywords[name] ||
      builtins.identifiers[name] ||
      types.primitives[name] ||
      types.indexTypes[name] ||
      types.constructors[name]
  );
}

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const renameProvider = {
  prepareRename(doc, position) {
    const hit = findReferenceSpanAt(doc, position);
    if (!hit || !hit.entry.def) {
      // No tracked binder here, or the compiler couldn't recover a def span
      // for it (an old compiler, or a synthesized/phantom name) — VS Code
      // shows this as "You cannot rename this element."
      throw new Error("You cannot rename this element.");
    }
    return spanToRange(hit.span);
  },
  provideRenameEdits(doc, position, newName) {
    const hit = findReferenceSpanAt(doc, position);
    if (!hit || !hit.entry.def) return undefined;
    if (!IDENTIFIER_RE.test(newName)) {
      throw new Error(`"${newName}" is not a valid Blade identifier.`);
    }
    if (isReservedName(newName)) {
      throw new Error(`"${newName}" is a reserved Blade name and cannot be used here.`);
    }
    const entry = hit.entry;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, spanToRange(entry.def), newName);
    for (const u of entry.uses || []) edit.replace(doc.uri, spanToRange(u), newName);
    return edit;
  },
};

/** The 0-based selection range for a top-level binding `b`'s name: the
 *  matching references[] def when one lines up exactly (precise, multi-
 *  character span), else a synthesized point-ish range from b.line/b.col
 *  (bindings[] has no end span yet — see the plan's 2c). */
function topLevelDefRange(doc, b, references) {
  const entry = references.find(
    (e) => (e.kind === "function" || e.kind === "value") && e.name === b.name && e.def && e.def.line === b.line
  );
  if (entry) return spanToRange(entry.def);
  const line = Math.max(0, (b.line || 1) - 1);
  const col = Math.max(0, (b.col || 1) - 1);
  return new vscode.Range(line, col, line, col + (b.name ? b.name.length : 0));
}

/**
 * Document outline (Ctrl+Shift+O / breadcrumbs). Hierarchical when
 * references[] is populated: top-level functions (with their params and
 * locals nested by def-line containment inside the function's [def line,
 * next top-level def line) range — bindings[] carries no body-extent span at
 * all, so "until the next top-level binding starts" is the best available
 * proxy) and top-level values, plus `type` aliases and `Unit` declarations
 * from scanDecls. Degrades to a flat list from bindings[] + scanDecls (no
 * nesting — nothing here carries reliable scope info without references[])
 * when references[] is empty, which is the only path a compiler without the
 * references[] payload exercises today.
 */
function documentSymbols(doc) {
  const key = doc.uri.toString();
  // bindingsByDoc also carries a "param" entry per function parameter (pre-
  // existing, kept for direct-hover lookup) alongside real top-level "let"/
  // "function"/"static" entries — same array, discriminated only by kind.
  // Left in, a param's line collapses its OWN function's [start, end) window
  // to zero width (the param shares its function's line and becomes "the
  // next ordered binding"), which silently drops that function's nested
  // params/locals below. Params/locals are already sourced correctly from
  // references[] in the nesting loop below, so top-level ordering must
  // exclude them here.
  const bindings = (bindingsByDoc.get(key) || []).filter((b) => b.name && b.line && b.kind !== "param");
  const references = referencesByDoc.get(key) || [];
  const scanned = scanDecls(doc);
  const symbols = [];
  const isArrayType = (b) => /^Array\s*</.test(displayType(b) || "");

  if (references.length > 0) {
    const ordered = bindings.slice().sort((a, b) => (a.line || 0) - (b.line || 0));
    const funcEntries = []; // { startLine, endLine, symbol } — 0-based [start, end)
    ordered.forEach((b, i) => {
      const callable = Array.isArray(b.params) && b.ret !== undefined;
      const startLine = Math.max(0, (b.line || 1) - 1);
      const endLine =
        i + 1 < ordered.length ? Math.max(startLine, (ordered[i + 1].line || 1) - 1) : doc.lineCount;
      const nameRange = topLevelDefRange(doc, b, references);
      const fullRange = new vscode.Range(startLine, 0, Math.max(startLine, endLine - 1), 0);
      if (callable) {
        const sym = new vscode.DocumentSymbol(
          b.name,
          typeNormalizer()(b.ret) || "",
          vscode.SymbolKind.Function,
          fullRange,
          nameRange
        );
        symbols.push(sym);
        funcEntries.push({ startLine, endLine, symbol: sym });
      } else {
        const sym = new vscode.DocumentSymbol(
          b.name,
          displayType(b) || "",
          isArrayType(b) ? vscode.SymbolKind.Field : vscode.SymbolKind.Variable,
          fullRange,
          nameRange
        );
        symbols.push(sym);
      }
    });

    // Params (TypeParameter — visually distinct from locals) and locals
    // (Variable) nest under whichever top-level function's [start, end)
    // contains their def line.
    for (const e of references) {
      if ((e.kind !== "param" && e.kind !== "local") || !e.def) continue;
      const defLine = e.def.line - 1;
      const owner = funcEntries.find((f) => defLine >= f.startLine && defLine < f.endLine);
      if (!owner) continue;
      const r = spanToRange(e.def);
      owner.symbol.children.push(
        new vscode.DocumentSymbol(
          e.name,
          "",
          e.kind === "param" ? vscode.SymbolKind.TypeParameter : vscode.SymbolKind.Variable,
          r,
          r
        )
      );
    }
  } else {
    // Flat fallback: bindings[] only, no reliable scope info to nest with.
    for (const b of bindings) {
      const callable = Array.isArray(b.params) && b.ret !== undefined;
      const line = Math.max(0, (b.line || 1) - 1);
      const col = Math.max(0, (b.col || 1) - 1);
      const r = new vscode.Range(line, col, line, col + b.name.length);
      const kind = callable
        ? vscode.SymbolKind.Function
        : isArrayType(b)
          ? vscode.SymbolKind.Field
          : vscode.SymbolKind.Variable;
      symbols.push(new vscode.DocumentSymbol(b.name, displayType(b) || "", kind, r, r));
    }
  }

  // `type` aliases and `Unit` declarations always come from scanDecls,
  // regardless of tier — the compiler emits no bindings for either.
  for (const [name, d] of scanned.decls) {
    if (d.line === undefined) continue;
    const r = new vscode.Range(d.line, 0, d.line, doc.lineAt(d.line).text.length);
    symbols.push(new vscode.DocumentSymbol(name, `type ${name} = ${d.parent}`, vscode.SymbolKind.Class, r, r));
  }
  for (const [name, u] of scanned.units) {
    if (u.line === undefined) continue;
    const r = new vscode.Range(u.line, 0, u.line, doc.lineAt(u.line).text.length);
    // Quantities (`Unit speed: mps`) keep their `:` separator in the outline,
    // mirroring typeHoverFor/provideCompletionItems.
    const sep = u.kind === "quantity" ? ": " : " = ";
    symbols.push(
      new vscode.DocumentSymbol(name, u.rhs ? `Unit ${name}${sep}${u.rhs}` : `Unit ${name}`, vscode.SymbolKind.Struct, r, r)
    );
  }

  symbols.sort((a, b) => a.range.start.line - b.range.start.line);
  return symbols;
}

const documentSymbolProvider = {
  provideDocumentSymbols(doc) {
    return documentSymbols(doc);
  },
};

// --- Concrete call-site instantiations (calls[]) -----------------------------

/**
 * The innermost recorded builtin call named `word` whose span contains
 * `position`. Entries come from the compiler's calls[] payload (1-based
 * spans, concrete monomorphized types); nested same-name calls resolve to
 * the tightest enclosing span.
 */
function lookupCall(doc, word, position) {
  const calls = callsByDoc.get(doc.uri.toString());
  if (!calls) return undefined;
  const line = position.line + 1;
  const ch = position.character + 1;
  const before = (l, c) => l < line || (l === line && c <= ch);
  const after = (l, c) => l > line || (l === line && c >= ch);
  let best;
  for (const c of calls) {
    if (c.name !== word) continue;
    if (!before(c.line, c.col) || !after(c.endLine, c.endCol)) continue;
    if (!best) {
      best = c;
      continue;
    }
    const startsLater = c.line > best.line || (c.line === best.line && c.col >= best.col);
    const endsEarlier = c.endLine < best.endLine || (c.endLine === best.endLine && c.endCol <= best.endCol);
    if (startsLater && endsEarlier) best = c;
  }
  return best;
}

/**
 * The concrete instantiation block for a recorded call: the abstract
 * signature's shape with the compiler's monomorphized types substituted
 * (concrete notation — `Array<Elem like Idx...>`, curried arrows). Param
 * names are borrowed from the abstract entry when the arity lines up
 * (variadic/optional entries fall back to positional a1..aN).
 */
function renderConcreteCall(name, call, abstractParams) {
  const args = call.args || [];
  // Borrow abstract names when they cover the args (trailing params are
  // optional — reduce's init, sort's key); variadic entries ("a, ..." packs
  // more args than named params) fall back to positional labels.
  const names =
    abstractParams && abstractParams.length >= args.length
      ? abstractParams.map((p) => p.name)
      : args.map((_, i) => `a${i + 1}`);
  if (args.length === 0) return `${name}()${call.ret ? " -> " + call.ret : ""}`;
  const lines = [`${name}(`];
  args.forEach((t, i) => {
    lines.push(`    ${names[i]}: ${t}${i < args.length - 1 ? "," : ""}`);
  });
  lines.push(`)${call.ret ? " -> " + call.ret : ""}`);
  return lines.join("\n");
}

// --- Type-provider structure (providers[]) ----------------------------------

/** Trimmed source text of a 1-based line, or "" if out of range. */
function loadLineText(doc, line) {
  const idx = (line || 1) - 1;
  return idx >= 0 && idx < doc.lineCount ? doc.lineAt(idx).text.trim() : "";
}

/**
 * Merge a fresh providers[] payload into the per-document cache. Fresh entries
 * win; a previously-cached store is kept only when its `.load` line text is
 * unchanged in the current document — so tooltips persist across an edit that
 * breaks the check elsewhere, and refresh exactly when a `.load` changes.
 */
function cacheProviders(doc, incoming) {
  const key = doc.uri.toString();
  const prev = providersByDoc.get(key) || [];
  const byStore = new Map();
  for (const p of prev) {
    if (p._loadText && p._loadText === loadLineText(doc, p.line)) byStore.set(p.store, p);
  }
  for (const p of incoming) {
    p._loadText = loadLineText(doc, p.line);
    byStore.set(p.store, p);
  }
  providersByDoc.set(key, Array.from(byStore.values()));
}

/** The cached provider store named `name` in this document, or undefined. */
function lookupProviderStore(doc, name) {
  return (providersByDoc.get(doc.uri.toString()) || []).find((p) => p.store === name);
}

/** Hover for a provided member (`store.vars.x` / `store.dims.x`). */
function providerMemberMarkdown(prov, section, mem) {
  return typeMarkdown(
    [`${mem.name}: ${mem.type}`],
    `${prov.provider} \`${section}\` member of \`${prov.store}\` — \`${prov.path}\``,
    false
  );
}

/**
 * Hover for a provided axis (`store.index.y`): the index type the provider
 * derived from the file, with its extent when statically known. Annotating
 * against this instead of a hand-written `Idx<64>` keeps the program tied to
 * the store rather than to a copied number.
 */
function providerAxisMarkdown(prov, ix) {
  const sig = ix.extent === undefined ? `Idx<${ix.name}>` : `Idx<${ix.extent}>`;
  return typeMarkdown(
    [`${prov.store}.index.${ix.name}`, sig, "Provided Index Type"],
    `${prov.provider} dimension \`${ix.name}\` of \`${prov.store}\` — \`${prov.path}\``,
    false
  );
}

/** Hover for a store handle (`let store = z.load(...)`): the dims/vars it exposes. */
function providerStoreMarkdown(prov) {
  const md = new vscode.MarkdownString();
  md.appendCodeblock(`${prov.store} : ${prov.provider} store`, "blade");
  md.appendMarkdown(`\n*data provider (${prov.provider}) — \`${prov.path}\`*\n`);
  const fmt = (arr) => arr.map((m) => `${m.name}: ${m.type}`).join("\n");
  if (prov.dims && prov.dims.length) {
    md.appendMarkdown("\n---\n`dims`\n");
    md.appendCodeblock(fmt(prov.dims), "blade");
  }
  if (prov.vars && prov.vars.length) {
    md.appendMarkdown("\n`vars`\n");
    md.appendCodeblock(fmt(prov.vars), "blade");
  }
  // The axis types, spelled as they are written in an annotation.
  if (prov.indexTypes && prov.indexTypes.length) {
    md.appendMarkdown("\n`index`\n");
    md.appendCodeblock(
      prov.indexTypes
        .map((ix) =>
          `${prov.store}.index.${ix.name}` +
          (ix.extent === undefined ? "" : `  // Idx<${ix.extent}>`)
        )
        .join("\n"),
      "blade"
    );
  }
  return md;
}

/** Hover for a provider alias (`z`): the provider it names and stores it loads. */
function providerAliasMarkdown(alias, provs) {
  const provider = provs[0].provider;
  const md = new vscode.MarkdownString();
  md.appendCodeblock(`import ${provider} as ${alias}`, "blade");
  md.appendMarkdown(`\n*data provider (${provider})*\n`);
  if (provs.length) {
    md.appendMarkdown("\n---\nstores\n");
    md.appendCodeblock(
      provs.map((p) => `${p.store} = ${alias}.load("${p.path}")`).join("\n"),
      "blade"
    );
  }
  return md;
}

/**
 * Provider hover for the identifier at `position`: a provided member, a store
 * handle, or a provider alias. Returns undefined when none applies (so the
 * caller falls through to ordinary bindings/builtins/types).
 */
function providerHover(doc, position, word, wordRange) {
  // Provided member: the word follows `<store>.vars.` / `<store>.dims.`.
  const linePrefix = doc.lineAt(position.line).text.slice(0, wordRange.start.character);
  const m = /([A-Za-z_]\w*)\s*\.\s*(vars|dims)\s*\.\s*$/.exec(linePrefix);
  if (m) {
    const prov = lookupProviderStore(doc, m[1]);
    if (prov) {
      const members = (m[2] === "dims" ? prov.dims : prov.vars) || [];
      const mem = members.find((x) => x.name === word);
      if (mem) return new vscode.Hover(providerMemberMarkdown(prov, m[2], mem), wordRange);
    }
  }
  // Provided axis type: the word follows `<store>.index.` — the file-derived
  // index type, usable in annotations (`Array<Float64 like store.index.y>`).
  const ax = /([A-Za-z_]\w*)\s*\.\s*index\s*\.\s*$/.exec(linePrefix);
  if (ax) {
    const prov = lookupProviderStore(doc, ax[1]);
    const ix = prov && (prov.indexTypes || []).find((x) => x.name === word);
    if (ix) return new vscode.Hover(providerAxisMarkdown(prov, ix), wordRange);
  }
  // Store handle: the word is a loaded store's binding name.
  const store = lookupProviderStore(doc, word);
  if (store) return new vscode.Hover(providerStoreMarkdown(store), wordRange);
  // Provider alias: the word is an `import <p> as <word>` alias.
  const aliased = (providersByDoc.get(doc.uri.toString()) || []).filter((p) => p.alias === word);
  if (aliased.length) return new vscode.Hover(providerAliasMarkdown(word, aliased), wordRange);
  return undefined;
}

/**
 * Build a normalizer for type strings the compiler reports. It rewrites the
 * IR's function-type spelling (`Arrow`) to `function`, and renders templated
 * type variables as abstract types — OCaml/F#-style `'a`, `'b`, ... shown as
 * bare `T`, `U`, ... `Z` (OCaml-like, without the apostrophe). The returned
 * closure keeps a per-signature map so the same variable maps to the same
 * letter across a function's params and return type. Apply it only to type
 * strings — never to doc prose, whose apostrophes (`kernel's`) are not types.
 */
const TYPE_VAR_LETTERS = ["T", "U", "V", "W", "X", "Y", "Z"];
function typeNormalizer() {
  const seen = new Map();
  return (s) => {
    if (!s) return s;
    let out = s.replace(/\bArrow\b/g, "function");
    // Compiler-synthesized extent names from rank deduction (decl-close pins
    // mint `__<fn>_deduced_n<k>`, reduce's rank-1 demand mints `__inferred_n`)
    // are display noise — an unnamed dimension, not a name the user wrote.
    out = out.replace(/\b__\w+_deduced_n\d+\b|\b__inferred_n\d*\b/g, "_");
    out = out.replace(/'([A-Za-z]\w*)/g, (_, name) => {
      if (!seen.has(name)) {
        const i = seen.size;
        seen.set(name, TYPE_VAR_LETTERS[i] || `T${i - TYPE_VAR_LETTERS.length + 2}`);
      }
      return seen.get(name);
    });
    return out;
  };
}

/**
 * The type to display for a VALUE binding: the slow tier's `concreteType`
 * (a more concrete rendering produced by monomorphization, present on "full"
 * serve responses) when available, else the fast tier's `type`. Callable
 * bindings render from their structured params/ret instead and never carry
 * `concreteType` — this only ever applies to plain value bindings.
 */
function displayType(b) {
  return b.concreteType || b.type;
}

/** Signature header: multi-line function types go below the name. */
function signatureText(kind, name, type) {
  const norm = typeNormalizer();
  const k = norm(kind);
  const t = norm(type);
  return t.includes("\n")
    ? `${k} ${name} :\n${t}`
    : `${k} ${name} : ${t}`;
}

/**
 * Ionide-style callable signature: one typed argument per line with its doc
 * as an inline comment (doc column aligned), then the return type, then the
 * where-clause conjuncts:
 *
 *   function covariance(
 *       A: Array<Float64, Idx<n>>,  // left samples
 *       B: Array<Float64, Idx<n>>
 *   ) -> Array<Float64, Idx<n>, Idx<n>>
 *   where
 *       comm(A, B)
 */
function renderCallable(prefix, name, params, ret, where) {
  const norm = typeNormalizer();
  const nret = norm(ret);
  const head = prefix ? `${norm(prefix)} ${name}` : name;
  const lines = [];
  if (!params || params.length === 0) {
    lines.push(`${head}()${nret ? " -> " + nret : ""}`);
  } else {
    lines.push(`${head}(`);
    const bodies = params.map(
      (p, i) => `    ${p.name}: ${norm(p.type)}${i < params.length - 1 ? "," : ""}`
    );
    const width = Math.max(...bodies.map((b) => b.length));
    params.forEach((p, i) => {
      lines.push(p.doc ? `${bodies[i].padEnd(width)}  // ${p.doc}` : bodies[i]);
    });
    lines.push(`)${nret ? " -> " + nret : ""}`);
  }
  if (Array.isArray(where) && where.length > 0) {
    lines.push("where");
    for (const w of where) lines.push(`    ${w}`);
  }
  return lines.join("\n");
}

function hoverMarkdown(sig, doc, badge) {
  const md = new vscode.MarkdownString();
  md.appendCodeblock(sig, "blade");
  if (badge) md.appendMarkdown(`\n*${badge}*\n`);
  if (doc) {
    md.appendMarkdown("\n---\n\n");
    md.appendText(doc);
  }
  return md;
}

// --- Deduced commutativity & minimum ranks ------------------------------------

/** The comm/anticomm conjuncts of a where-clause list (drops omp/cuda/...). */
function commClauses(where) {
  return (where || []).filter((w) => /^(comm|anticomm)\(/.test(w));
}

/**
 * Append the deduction block to a hover — two same-width labels so the values
 * line up:
 *
 *   deduced comm: `comm(a, b)`
 *   deduced rank: a: T^1, b: T^1
 *
 * The comm line is declared ∪ deduced ("None" when the deduction ran and
 * proved nothing); under a "deduced" heading the already-pinned entries are
 * the ones worth marking, so those carry the tag. `deducedComm` not being an
 * array means an old compiler without the field — no block at all.
 */
function appendDeductionLines(md, declaredWhere, deducedComm, minRanks) {
  if (!Array.isArray(deducedComm)) return;
  const declared = commClauses(declaredWhere);
  const parts = declared
    .map((c) => "`" + c + "` (declared)")
    .concat(deducedComm.filter((c) => !declared.includes(c)).map((c) => "`" + c + "`"));
  md.appendMarkdown(parts.length ? `\n*deduced comm: ${parts.join(", ")}*\n` : "\n*deduced comm: None*\n");
  if (minRanks && minRanks.length) {
    const rendered = minRanks.map((r) => `${r.param}: T^${r.rank}`).join(", ");
    md.appendMarkdown(`\n*deduced rank: ${rendered}*\n`);
  }
}

/** minRanks list for a compiler function binding (params carrying minRank). */
function bindingMinRanks(b) {
  return (b.params || [])
    .filter((p) => typeof p.minRank === "number" && p.minRank > 0)
    .map((p) => ({ param: p.name, rank: p.minRank }));
}

/**
 * The kernels[] entry whose span STARTS inside the hovered word — the
 * `lambda` keyword of an inline kernel, or the variable reference of a
 * let-bound kernel at its use site. Start-anchored so identifiers deep in a
 * kernel body don't all light up with the kernel's deduction block.
 */
function kernelAt(doc, wordRange) {
  const entries = kernelsByDoc.get(doc.uri.toString()) || [];
  return entries.find((k) => {
    const kl = (k.line || 1) - 1;
    const kc = (k.col || 1) - 1;
    return (
      kl === wordRange.start.line &&
      kc >= wordRange.start.character &&
      kc <= wordRange.end.character
    );
  });
}

/** Kernel minRanks, dropping scalar (rank-0) cells — nothing to annotate. */
function kernelMinRanks(k) {
  return (k.minRanks || []).filter((r) => r.rank > 0);
}

// --- Deduced-pin computation & header scanning --------------------------------
//
// Shared by three surfaces that all need to agree on exactly what's "deduced
// but not yet pinned" and exactly where a pin would land in the source:
// deductionCompletions (header completions, below), the CodeActionProvider
// (workstream 3 — pin/rank quick fixes), and the CodeLensProvider (workstream
// 4 — the deduction lens's own "— pin" command). pinInfoFor{Function,Kernel}
// compute the "what"; scanHeaderPunctuation computes the "where" by scanning
// FORWARD from a known `function`/`lambda` anchor — the mirror image of
// declContextAt's backward scan from the cursor (declContextAt answers "is
// the cursor inside a header"; this answers "where exactly does this
// header's punctuation live", which a cursor position alone can't give when
// the caller only has a binding/kernel entry, not a cursor).

/** Deduced-but-not-declared comm/anticomm clauses and per-param minimum
 *  ranks for a function binding (bindings[] entry with params/ret) — the
 *  "what's worth pinning" computation. Returns undefined when the compiler
 *  reported no deduction data at all (old compiler / deducedComm absent). */
function pinInfoForFunction(b) {
  if (!Array.isArray(b.deducedComm)) return undefined;
  const declared = commClauses(b.where);
  return { pinClauses: b.deducedComm.filter((c) => !declared.includes(c)), minRanks: bindingMinRanks(b) };
}

/** Same as pinInfoForFunction, for a kernels[] entry. Always returns an
 *  object (kernels carry no "old compiler" absence signal the way a missing
 *  deducedComm array does for functions — deducedComm/minRanks just default
 *  to empty). */
function pinInfoForKernel(k) {
  const declared = commClauses(k.declaredWhere);
  const deduced = k.deducedComm || [];
  return { pinClauses: deduced.filter((c) => !declared.includes(c)), minRanks: kernelMinRanks(k) };
}

/** Concatenate document text from raw position `from` to `to` ({line,char},
 *  0-based, half-open at `to`), with a parallel array mapping each output
 *  character back to its {line,char} — the position-tracked twin of a plain
 *  doc.getText(range) slice, needed wherever an insertion point must be
 *  computed FROM a substring match (a where-clause's last conjunct, a
 *  header's param list). Raw {line,char} pairs throughout this section —
 *  not vscode.Position — so this scanning stays independent of exactly
 *  which vscode is running underneath (real or the headless mock). */
function extractSpan(doc, from, to) {
  let text = "";
  const positions = [];
  for (let l = from.line; l <= to.line; l++) {
    const line = doc.lineAt(l).text;
    const start = l === from.line ? from.char : 0;
    const end = l === to.line ? to.char : line.length;
    for (let i = start; i < end; i++) {
      text += line[i];
      positions.push({ line: l, char: i });
    }
  }
  return { text, positions };
}

/** Like splitTopLevel, but keeps a position (raw {line,char}) alongside each
 *  character so a sub-match can be mapped back into the document — used to
 *  locate individual parameter spans inside a header's param list. */
function splitTopLevelWithPositions(text, positions, sep) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "<" || c === "(" || c === "[") depth++;
    else if (c === ">" || c === ")" || c === "]") depth--;
    else if (c === sep && depth === 0) {
      parts.push({ text: text.slice(start, i), positions: positions.slice(start, i) });
      start = i + 1;
    }
  }
  parts.push({ text: text.slice(start), positions: positions.slice(start) });
  return parts;
}

/**
 * Forward-scanned header punctuation for a `function NAME(...)` or
 * `lambda(...)` declaration whose keyword sits at or after
 * (anchorLine, anchorChar): the parameter list's open/close parens, and —
 * past the close paren, up to the return-type/body arrow `->` (always
 * present: every function has an explicit `-> RetType`, every lambda an
 * explicit `-> body`) — whether a `where` clause already exists and, if so,
 * the position right after its last conjunct (the append point for a fresh
 * pin). Bounded to an 8-line window at each stage, matching declContextAt's
 * own window. Returns undefined when no balanced param list / arrow turns
 * up within the window (malformed or unusually long header — callers skip
 * rather than guess).
 */
function scanHeaderPunctuation(doc, anchorLine, anchorChar, kind, name) {
  const openRe = kind === "function" ? new RegExp(`\\bfunction\\s+${name}\\s*\\(`) : /\blambda\s*\(/;
  let openLine = -1;
  let openChar = -1;
  const maxOpenLine = Math.min(doc.lineCount, anchorLine + 8);
  for (let l = anchorLine; l < maxOpenLine && openLine === -1; l++) {
    const text = doc.lineAt(l).text;
    const from = l === anchorLine ? anchorChar : 0;
    const m = openRe.exec(text.slice(from));
    if (m) {
      openLine = l;
      openChar = from + m.index + m[0].length - 1; // the '(' itself
    }
  }
  if (openLine === -1) return undefined;

  let closeLine = -1;
  let closeChar = -1;
  let depth = 0;
  const maxCloseLine = Math.min(doc.lineCount, openLine + 8);
  outer: for (let l = openLine; l < maxCloseLine; l++) {
    const text = doc.lineAt(l).text;
    const from = l === openLine ? openChar : 0;
    for (let i = from; i < text.length; i++) {
      const c = text[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        depth--;
        if (depth === 0) {
          closeLine = l;
          closeChar = i;
          break outer;
        }
      }
    }
  }
  if (closeLine === -1) return undefined;

  let arrowLine = -1;
  let arrowChar = -1;
  const maxArrowLine = Math.min(doc.lineCount, closeLine + 8);
  for (let l = closeLine; l < maxArrowLine && arrowLine === -1; l++) {
    const text = doc.lineAt(l).text;
    const from = l === closeLine ? closeChar + 1 : 0;
    const idx = text.indexOf("->", from);
    if (idx !== -1) {
      arrowLine = l;
      arrowChar = idx;
    }
  }
  if (arrowLine === -1) return undefined;

  let whereLine = -1;
  let whereChar = -1;
  for (let l = closeLine; l <= arrowLine; l++) {
    const text = doc.lineAt(l).text;
    const from = l === closeLine ? closeChar + 1 : 0;
    const to = l === arrowLine ? arrowChar : text.length;
    const wm = /\bwhere\b/.exec(text.slice(from, to));
    if (wm) {
      whereLine = l;
      whereChar = from + wm.index;
      break;
    }
  }

  let lastConjunctEnd;
  if (whereLine !== -1) {
    const span = extractSpan(doc, { line: whereLine, char: whereChar + 5 }, { line: arrowLine, char: arrowChar });
    for (let i = span.text.length - 1; i >= 0; i--) {
      if (!/\s/.test(span.text[i])) {
        lastConjunctEnd = { line: span.positions[i].line, char: span.positions[i].char + 1 };
        break;
      }
    }
  }

  return {
    openParen: { line: openLine, char: openChar },
    closeParen: { line: closeLine, char: closeChar },
    arrow: { line: arrowLine, char: arrowChar },
    hasWhere: whereLine !== -1,
    lastConjunctEnd,
  };
}

/** True when `range` (the CodeActionProvider's query range, or a diagnostic
 *  range) overlaps the header scanned into `h`, from its anchor line through
 *  the return-type/body arrow. */
function headerOverlapsRange(h, anchorLine, range) {
  return range.start.line <= h.arrow.line && range.end.line >= anchorLine;
}

/** Do two vscode.Range values overlap (touching at a shared boundary point
 *  counts)? */
function rangesOverlap(a, b) {
  const beforeA = b.end.line < a.start.line || (b.end.line === a.start.line && b.end.character < a.start.character);
  const afterA = b.start.line > a.end.line || (b.start.line === a.end.line && b.start.character > a.end.character);
  return !beforeA && !afterA;
}

/**
 * The exact text edit for pinning `clause` (e.g. "comm(A, B)") into the
 * header `h` (from scanHeaderPunctuation): append " <clause>" after the
 * last existing where-conjunct, or open a fresh " where <clause>" right
 * after the parameter list's close paren (naturally lands before the
 * return-type arrow for a function, before the body arrow for a lambda —
 * both are the same "->" scanHeaderPunctuation already found).
 */
function pinEditFromHeader(h, clause) {
  if (h.hasWhere && h.lastConjunctEnd) {
    return { position: new vscode.Position(h.lastConjunctEnd.line, h.lastConjunctEnd.char), text: ` ${clause}` };
  }
  return { position: new vscode.Position(h.closeParen.line, h.closeParen.char + 1), text: ` where ${clause}` };
}

/** Number of names inside a "comm(a, b, c)" / "anticomm(...)" clause. */
function clauseArity(clause) {
  const m = /\(([^)]*)\)/.exec(clause);
  return m ? splitTopLevel(m[1], ",").length : 0;
}

/**
 * Compact-vs-dense cell counts for a deduced comm/anticomm group of arity
 * `groupSize` applied to `arrayTypeString` (a binding's declared return-array
 * type): find `groupSize` literal-extent `Idx<n>` occurrences sharing the
 * SAME extent n among the type's top-level index args (parseArrayTypeAt-
 * style parsing via splitOnLike/splitTopLevel), and fold binom's exact-int64
 * arithmetic the same way orbIdxDetail does — dense = n^groupSize, compact =
 * C(n+groupSize-1, groupSize) for a commuting (+) group, C(n, groupSize) for
 * an anticommuting (-) group. Reuses binom/INT64_MAX directly rather than
 * re-deriving or re-parsing orbIdxDetail's rendered text, so orbIdxDetail's
 * own hover output stays untouched. Returns undefined when the type isn't an
 * `Array<...>`, doesn't carry `groupSize` matching-extent literal `Idx<n>`
 * axes, or the fold overflows — callers omit the cells segment entirely
 * rather than guessing.
 */
function deducedClassCells(arrayTypeString, groupSize, plus) {
  if (!arrayTypeString || groupSize < 2) return undefined;
  const m = /^Array\s*<([\s\S]*)>\s*$/.exec(arrayTypeString.trim());
  if (!m) return undefined;
  const inner = m[1];
  const likeParts = splitOnLike(inner);
  const idxText = likeParts ? likeParts[1] : splitTopLevel(inner, ",").slice(1).join(", ");
  const indices = splitTopLevel(idxText, ",");
  const byExtent = new Map();
  for (const ix of indices) {
    const im = /^Idx\s*<\s*(\d+)\s*>$/.exec(ix.trim());
    if (!im) continue;
    byExtent.set(im[1], (byExtent.get(im[1]) || 0) + 1);
  }
  let extent;
  for (const [n, count] of byExtent) {
    if (count >= groupSize) {
      extent = n;
      break;
    }
  }
  if (extent === undefined) return undefined;
  const n = BigInt(extent);
  const dense = n ** BigInt(groupSize);
  const top = plus ? n + BigInt(groupSize) - 1n : n;
  const compact = binom(top, groupSize);
  if (dense > INT64_MAX || compact > INT64_MAX) return undefined;
  return { compact: compact.toString(), dense: dense.toString() };
}

/** Longest operator from the builtins table covering `character` in `lineText`. */
function operatorAt(lineText, character) {
  let best;
  for (const op of Object.keys(builtins.operators)) {
    let idx = lineText.indexOf(op);
    while (idx !== -1) {
      if (character >= idx && character <= idx + op.length) {
        if (!best || op.length > best.op.length) best = { op, idx };
        break;
      }
      idx = lineText.indexOf(op, idx + 1);
    }
  }
  return best;
}

const hoverProvider = {
  provideHover(doc, position) {
    const wordRange = doc.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    if (wordRange) {
      const word = doc.getText(wordRange);
      // Type-provider structure wins over ordinary bindings so a store name
      // shows its dims/vars (and members/aliases, which aren't bindings) rather
      // than the opaque `let store : store`. Guarded so a malformed payload
      // can never break ordinary hovers.
      let prov;
      try {
        prov = providerHover(doc, position, word, wordRange);
      } catch (_) {
        prov = undefined;
      }
      if (prov) return prov;
      // A lambda-kernel span starting under the cursor (the `lambda` keyword
      // of an inline kernel, or a let-bound kernel's use-site reference)
      // enriches whatever hover the word produces with its deduction block.
      const kernel = kernelAt(doc, wordRange);
      // Source bindings win over the builtin table (shadowing). Resolved
      // through references[] first when available (exact scope; see
      // lookupBindingPrecise), falling back to the nearest-line heuristic.
      const b = lookupBindingPrecise(doc, word, position);
      if (b) {
        // Functions (anything with structured params/ret) render as a full
        // callable signature; plain values keep the `kind name : type` form.
        const callable = Array.isArray(b.params) && b.ret !== undefined;
        const sig = callable
          ? renderCallable(b.kind || "function", b.name, b.params, b.ret, b.where)
          : signatureText(b.kind || "", b.name, displayType(b));
        const md = new vscode.MarkdownString();
        md.appendCodeblock(sig, "blade");
        // A top-level provider read carries its source member as a badge.
        if (b.providerRead) {
          md.appendMarkdown(`\n*from ${b.providerRead.store}.${b.providerRead.member}*\n`);
        }
        // A wreath class is almost always DEDUCED rather than written (the tie
        // rule appends a level to a repeated compact argument), so the binding
        // is where the user first meets it — spell out what it stores.
        if (!callable) appendClassDetail(md, doc, displayType(b) || "");
        if (callable) {
          appendDeductionLines(md, b.where, b.deducedComm, bindingMinRanks(b));
        } else if (kernel) {
          // A let-bound lambda hovered at its kernel use site: the binding is
          // a plain value (opaque function type) — the kernel entry carries
          // the deduction.
          appendDeductionLines(md, kernel.declaredWhere, kernel.deducedComm, kernelMinRanks(kernel));
        }
        if (b.doc) {
          md.appendMarkdown("\n---\n\n");
          md.appendText(b.doc);
        }
        return new vscode.Hover(md, wordRange);
      }
      // Inline lambda kernel: hover on the `lambda` keyword itself.
      if (word === "lambda" && kernel) {
        const md = new vscode.MarkdownString();
        md.appendCodeblock(`lambda(${(kernel.params || []).join(", ")}) -> ...`, "blade");
        appendDeductionLines(md, kernel.declaredWhere, kernel.deducedComm, kernelMinRanks(kernel));
        return new vscode.Hover(md, wordRange);
      }
      const builtin = builtins.identifiers[word];
      if (builtin) {
        const sig = builtin.params
          ? renderCallable("", word, builtin.params, builtin.ret, null)
          : builtin.sig;
        // Abstract signature first, then — when the compiler reported this
        // call site in calls[] — the concrete monomorphized instantiation,
        // so the two line up argument-for-argument.
        const md = new vscode.MarkdownString();
        md.appendCodeblock(sig, "blade");
        const call = builtin.params ? lookupCall(doc, word, position) : undefined;
        if (call) {
          md.appendMarkdown("\n*this call:*\n");
          md.appendCodeblock(renderConcreteCall(word, call, builtin.params), "blade");
        }
        const badge = builtins.categories[builtin.category];
        if (badge) md.appendMarkdown(`\n*${badge}*\n`);
        if (builtin.doc) {
          md.appendMarkdown("\n---\n\n");
          md.appendText(builtin.doc);
        }
        return new vscode.Hover(md, wordRange);
      }
      // Domain-specific keywords (comm/omp/mpi/like/where/...). After
      // builtins so callable keyword forms (pure, guard, reynolds) keep
      // their signature hovers; before types (case-disjoint, no shadowing).
      const kw = keywords.keywords[word];
      if (kw) {
        return new vscode.Hover(typeMarkdown([kw.usage, "Keyword"], kw.doc, true), wordRange);
      }
      // Types: primitives, index types, nominal aliases, units, Array<...>.
      return typeHoverFor(doc, word, wordRange);
    }
    // No identifier under the cursor — try combinator/operator hover.
    const lineText = doc.lineAt(position.line).text;
    const hit = operatorAt(lineText, position.character);
    if (hit) {
      const entry = builtins.operators[hit.op];
      const range = new vscode.Range(
        position.line, hit.idx,
        position.line, hit.idx + hit.op.length
      );
      return new vscode.Hover(hoverMarkdown(entry.sig, entry.doc), range);
    }
    return undefined;
  },
};

// --- Signature help (Ionide-style parameter hints) ---------------------------

/**
 * Scan backwards from the cursor (across up to 10 lines) for the innermost
 * unmatched '(', returning the callee identifier before it and the 0-based
 * index of the active (comma-separated) argument.
 */
function findCallContext(doc, position) {
  const startLine = Math.max(0, position.line - 9);
  let text = "";
  for (let l = startLine; l <= position.line; l++) {
    const lineText = doc.lineAt(l).text;
    text += (l === position.line ? lineText.slice(0, position.character) : lineText) + "\n";
  }
  let depth = 0;
  let commas = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    const c = text[i];
    if (c === ")" || c === "]" || c === "}") depth++;
    else if (c === "(" && depth === 0) {
      const before = text.slice(0, i);
      const m = /([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(before);
      if (!m) return undefined;
      return { name: m[1], activeParameter: commas };
    } else if (c === "(" || c === "[" || c === "{") depth--;
    else if (c === "," && depth === 0) commas++;
  }
  return undefined;
}

function buildSignature(label, params, doc) {
  const sig = new vscode.SignatureInformation(label);
  if (doc) sig.documentation = doc;
  for (const p of params) {
    const pLabel = `${p.name}: ${p.type}`;
    const start = label.indexOf(pLabel);
    const info =
      start >= 0
        ? new vscode.ParameterInformation([start, start + pLabel.length])
        : new vscode.ParameterInformation(pLabel);
    if (p.doc) info.documentation = p.doc;
    sig.parameters.push(info);
  }
  return sig;
}

const signatureHelpProvider = {
  provideSignatureHelp(doc, position) {
    const call = findCallContext(doc, position);
    if (!call) return undefined;

    let params, ret, docText;
    const b = lookupBinding(doc, call.name, position.line);
    if (b && Array.isArray(b.params) && b.ret !== undefined) {
      params = b.params.map((p) => ({ name: p.name, type: p.type, doc: p.doc }));
      ret = b.ret;
      docText = b.doc;
    } else {
      const builtin = builtins.identifiers[call.name];
      if (!builtin || !builtin.params || builtin.params.length === 0) return undefined;
      params = builtin.params;
      ret = builtin.ret || "";
      docText = builtin.doc;
    }

    // Normalize types once (Arrow -> function, 'a -> T) so the label and the
    // per-parameter offsets computed from them stay in sync.
    const norm = typeNormalizer();
    params = params.map((p) => ({ name: p.name, type: norm(p.type), doc: p.doc }));
    ret = norm(ret);

    const label =
      `${call.name}(` +
      params.map((p) => `${p.name}: ${p.type}`).join(", ") +
      `)${ret ? " -> " + ret : ""}`;

    const help = new vscode.SignatureHelp();
    help.signatures = [buildSignature(label, params, docText)];
    help.activeSignature = 0;
    help.activeParameter = Math.min(call.activeParameter, Math.max(0, params.length - 1));
    return help;
  },
};

// --- Completion ---------------------------------------------------------------

/**
 * Classify the cursor inside a `function name(...)` / `lambda(...)`
 * declaration header (bounded backward scan, 8 lines). Returns undefined when
 * the cursor is not in a header — including once the body has started (`=` for
 * functions, `->` for lambdas). Otherwise:
 *   { kind: "function"|"lambda", name?, line,        // header position
 *     inParams, currentParam?,                        // inside the param list
 *     afterParams, afterWhere, afterArrow }           // past the closing `)`
 */
function declContextAt(doc, position) {
  const startLine = Math.max(0, position.line - 8);
  let head = null; // nearest opener before the cursor: { line, paren, kind, name }
  for (let l = position.line; l >= startLine && !head; l--) {
    const text = doc.lineAt(l).text;
    const limit = l === position.line ? position.character : text.length;
    const re = /\b(?:function\s+([A-Za-z_]\w*)|lambda)\s*\(/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const paren = m.index + m[0].length - 1;
      if (paren >= limit) break;
      head = { line: l, paren, kind: m[1] ? "function" : "lambda", name: m[1] };
    }
  }
  if (!head) return undefined;
  // Concatenate from the opening paren to the cursor, then bracket-count.
  let tail = "";
  for (let l = head.line; l <= position.line; l++) {
    const text = doc.lineAt(l).text;
    const from = l === head.line ? head.paren : 0;
    const to = l === position.line ? position.character : text.length;
    tail += text.slice(from, to) + (l < position.line ? "\n" : "");
  }
  let depth = 0;
  let closeIdx = -1;
  for (let i = 0; i < tail.length; i++) {
    const c = tail[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx === -1) {
    // Inside the parameter list. The current param is the text after the last
    // top-level comma; `name:` (with at most a partial type word) means the
    // cursor sits in its annotation position.
    let last = 1; // tail[0] is the opening paren
    depth = 0;
    for (let i = 0; i < tail.length; i++) {
      const c = tail[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") depth--;
      else if (c === "," && depth === 1) last = i + 1;
    }
    const pm = /^\s*([A-Za-z_]\w*)\s*:\s*([A-Za-z_]\w*)?\s*$/.exec(tail.slice(last));
    return {
      kind: head.kind, name: head.name, line: head.line,
      inParams: true, currentParam: pm ? pm[1] : undefined,
      afterParams: false, afterWhere: false, afterArrow: false,
    };
  }
  const after = tail.slice(closeIdx + 1);
  // Body started: `=` opens a function body, `->` a lambda body.
  if (head.kind === "function" ? after.includes("=") : after.includes("->")) return undefined;
  return {
    kind: head.kind, name: head.name, line: head.line,
    inParams: false, currentParam: undefined,
    afterParams: true,
    afterWhere: /\bwhere\b/.test(after),
    afterArrow: after.includes("->"),
  };
}

/**
 * Deduction-aware completions inside a declaration header: the deduced
 * `where comm(...)` / `where anticomm(...)` pin after the param list, and the
 * deduced minimum rank (`T^k`) in a parameter's annotation position. Backed by
 * the last check's caches — same staleness contract as diagnostics (save to
 * refresh), which matches the confirm-and-pin workflow: write the kernel
 * unannotated, save, pin from the suggestion.
 */
function deductionCompletions(doc, position) {
  const ctx = declContextAt(doc, position);
  if (!ctx) return [];
  let info;
  if (ctx.kind === "function") {
    if (!ctx.name) return [];
    const b = (bindingsByDoc.get(doc.uri.toString()) || []).find(
      (x) => x.name === ctx.name && Array.isArray(x.params) && x.ret !== undefined
    );
    info = b && pinInfoForFunction(b);
  } else {
    // Inline lambda: the kernels[] entry whose span starts on the header line.
    const k = (kernelsByDoc.get(doc.uri.toString()) || []).find(
      (e) => (e.line || 1) - 1 === ctx.line
    );
    info = k && pinInfoForKernel(k);
  }
  if (!info) return [];
  const rankByParam = new Map(info.minRanks.map((r) => [r.param, r.rank]));
  const items = [];
  if (ctx.inParams) {
    const k = ctx.currentParam && rankByParam.get(ctx.currentParam);
    if (k) {
      const item = new vscode.CompletionItem(`T^${k}`, vscode.CompletionItemKind.TypeParameter);
      item.detail = `minimum deduced rank for '${ctx.currentParam}'`;
      item.documentation = new vscode.MarkdownString().appendText(
        `The body forces rank ${k} on '${ctx.currentParam}' — the deduced minimum. ` +
          "Annotating a higher rank is allowed; lower is a type error."
      );
      item.filterText = "T";
      item.sortText = "0";
      items.push(item);
    }
  } else if (ctx.afterParams && !(ctx.kind === "function" && ctx.afterArrow)) {
    for (const clause of info.pinClauses) {
      const label = ctx.afterWhere ? clause : `where ${clause}`;
      const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Snippet);
      item.detail = clause.startsWith("anticomm(")
        ? "deduced anticommutativity — pin to enable strict-triangular (zero-diagonal) storage"
        : "deduced commutativity — pin to enable compact symmetric (triangular) storage";
      item.filterText = ctx.afterWhere ? clause.slice(0, clause.indexOf("(")) : "where";
      item.sortText = "0";
      items.push(item);
    }
  }
  return items;
}

/**
 * Word completions from the same sources the hover uses, in shadowing order:
 * compiler bindings, builtins, domain keywords, built-in types, and
 * source-scanned type/unit declarations. Plain word inserts — no snippets,
 * no trigger characters (`(` already triggers signature help). Operators are
 * deliberately excluded (not word-completable). One position-aware exception:
 * deduction completions (the `where comm(...)` pin, `T^k` minimum ranks)
 * prepend when the cursor sits in a declaration header.
 */
const completionProvider = {
  provideCompletionItems(doc, position) {
    const items = [];
    const seen = new Set();
    // 0. Deduction-aware suggestions (guarded: never break word completion).
    try {
      for (const item of deductionCompletions(doc, position)) {
        seen.add(typeof item.label === "string" ? item.label : item.label.label);
        items.push(item);
      }
    } catch (_) {
      /* header parsing is best-effort */
    }
    const push = (label, kind, detail, docMd) => {
      if (seen.has(label)) return;
      seen.add(label);
      const item = new vscode.CompletionItem(label, kind);
      if (detail) item.detail = detail;
      if (docMd) item.documentation = docMd;
      items.push(item);
    };

    // 1. Compiler bindings for this document (shadow the static tables).
    for (const b of bindingsByDoc.get(doc.uri.toString()) || []) {
      if (!b.name) continue;
      const callable = Array.isArray(b.params) && b.ret !== undefined;
      push(
        b.name,
        callable ? vscode.CompletionItemKind.Function : vscode.CompletionItemKind.Variable,
        displayType(b),
        b.doc ? new vscode.MarkdownString().appendText(b.doc) : undefined
      );
    }

    // 2. Builtins (callable and sig-form), with the category badge as detail.
    for (const [name, e] of Object.entries(builtins.identifiers)) {
      const sig = e.params ? renderCallable("", name, e.params, e.ret, null) : e.sig;
      push(
        name,
        vscode.CompletionItemKind.Function,
        builtins.categories[e.category],
        hoverMarkdown(sig, e.doc, builtins.categories[e.category])
      );
    }

    // 3. Domain keywords.
    for (const [name, k] of Object.entries(keywords.keywords)) {
      push(name, vscode.CompletionItemKind.Keyword, "keyword", typeMarkdown([k.usage, "Keyword"], k.doc, true));
    }

    // 4. Built-in types: primitives, index types, constructors.
    for (const [name, d] of Object.entries(types.primitives)) {
      push(name, vscode.CompletionItemKind.Struct, "Primitive Type", typeMarkdown([name, "Primitive Type"], d));
    }
    for (const [name, t] of Object.entries(types.indexTypes)) {
      push(name, vscode.CompletionItemKind.Class, t.sig, typeMarkdown([name, "Index Type"], indexTypeDoc(t)));
    }
    for (const [name, c] of Object.entries(types.constructors)) {
      push(name, vscode.CompletionItemKind.Class, c.sig, typeMarkdown([name, c.kind], "`" + c.sig + "` — " + c.desc));
    }

    // 5. Source-scanned `type` aliases and `Unit` declarations.
    const scanned = scanDecls(doc);
    for (const [name, d] of scanned.decls) {
      push(name, vscode.CompletionItemKind.Class, `type ${name} = ${d.parent}`, d.doc ? new vscode.MarkdownString().appendText(d.doc) : undefined);
    }
    for (const [name, u] of scanned.units) {
      const isQuantity = u.kind === "quantity";
      const detail = !u.rhs ? `Unit ${name}` : isQuantity ? `Unit ${name}: ${u.rhs}` : `Unit ${name} = ${u.rhs}`;
      // Quantities get their own icon (EnumMember) — a nominal tag is a
      // different completion-time concept from a structural unit, even
      // though both land in the same `Float<...>` annotation position.
      const kind = isQuantity ? vscode.CompletionItemKind.EnumMember : vscode.CompletionItemKind.Unit;
      push(name, kind, detail, u.doc ? new vscode.MarkdownString().appendText(u.doc) : undefined);
    }

    return items;
  },
};

// --- Code actions (pin deduced comm/anticomm, annotate deduced rank) --------
//
// Both actions work against TODAY's payload (bindings[]/kernels[] deduction
// fields, already used by deductionCompletions/hover above) — no
// references[] needed, so this workstream is fully live-testable.

/**
 * "Pin deduced comm/anticomm" actions for one header: one CodeAction per
 * still-unpinned clause, inserting it via pinEditFromHeader. QuickFix when a
 * BL4010/BL4011 diagnostic already overlaps the query range (VS Code has
 * already filtered `context.diagnostics` to the range, so `hasPinDiagnostic`
 * is a single doc-wide check made once by the caller); RefactorRewrite
 * (lightbulb, no diagnostic required) otherwise.
 */
function pinActions(doc, h, clauses, hasPinDiagnostic, diagnostics) {
  const out = [];
  for (const clause of clauses) {
    const edit = pinEditFromHeader(h, clause);
    if (!edit) continue;
    const action = new vscode.CodeAction(
      `Pin deduced ${clause}`,
      hasPinDiagnostic ? vscode.CodeActionKind.QuickFix : vscode.CodeActionKind.RefactorRewrite
    );
    const we = new vscode.WorkspaceEdit();
    we.insert(doc.uri, edit.position, edit.text);
    action.edit = we;
    if (hasPinDiagnostic) action.diagnostics = diagnostics;
    out.push(action);
  }
  return out;
}

/**
 * "Annotate deduced rank: T^k" actions for one header: each unannotated
 * param whose deduced minimum rank is > 0 and whose NAME span overlaps
 * `range` gets an action inserting `: T^k` right after its name. Param
 * spans come from depth-aware comma-splitting the exact document text
 * between the header's parens (splitTopLevelWithPositions — not a
 * line-wide regex, so a name appearing inside a DIFFERENT param's type
 * can't be mistaken for the real one).
 */
function rankActions(doc, h, minRanks, range) {
  if (!minRanks.length) return [];
  const rankByParam = new Map(minRanks.map((r) => [r.param, r.rank]));
  const span = extractSpan(
    doc,
    { line: h.openParen.line, char: h.openParen.char + 1 },
    { line: h.closeParen.line, char: h.closeParen.char }
  );
  const parts = splitTopLevelWithPositions(span.text, span.positions, ",");
  const actions = [];
  for (const part of parts) {
    const m = /^(\s*)([A-Za-z_]\w*)/.exec(part.text);
    if (!m || part.positions.length === 0) continue;
    const name = m[2];
    const rank = rankByParam.get(name);
    if (!rank) continue;
    if (/^\s*[A-Za-z_]\w*\s*:/.test(part.text)) continue; // already annotated
    const nameStartIdx = m[1].length;
    const nameEndIdx = nameStartIdx + name.length - 1;
    if (nameEndIdx >= part.positions.length) continue;
    const startPos = part.positions[nameStartIdx];
    const endPos = part.positions[nameEndIdx];
    const nameRange = new vscode.Range(
      new vscode.Position(startPos.line, startPos.char),
      new vscode.Position(endPos.line, endPos.char + 1)
    );
    if (!rangesOverlap(nameRange, range)) continue;
    const insertPos = new vscode.Position(endPos.line, endPos.char + 1);
    const action = new vscode.CodeAction(`Annotate deduced rank: T^${rank}`, vscode.CodeActionKind.RefactorRewrite);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, insertPos, `: T^${rank}`);
    action.edit = edit;
    actions.push(action);
  }
  return actions;
}

const codeActionProvider = {
  provideCodeActions(doc, range, context) {
    const actions = [];
    const key = doc.uri.toString();
    const diags = (context && context.diagnostics) || [];
    const hasPinDiagnostic = diags.some((d) => {
      const code = diagnosticCodeValue(d);
      return code === "BL4010" || code === "BL4011";
    });

    for (const b of bindingsByDoc.get(key) || []) {
      if (!(Array.isArray(b.params) && b.ret !== undefined) || !b.line) continue;
      const anchorLine = Math.max(0, (b.line || 1) - 1);
      const h = scanHeaderPunctuation(doc, anchorLine, 0, "function", b.name);
      if (!h) continue;
      const info = pinInfoForFunction(b);
      if (info) {
        if (headerOverlapsRange(h, anchorLine, range)) {
          actions.push(...pinActions(doc, h, info.pinClauses, hasPinDiagnostic, diags));
        }
        actions.push(...rankActions(doc, h, info.minRanks, range));
      }
    }
    for (const k of kernelsByDoc.get(key) || []) {
      if (!k.line) continue;
      const anchorLine = Math.max(0, (k.line || 1) - 1);
      const anchorChar = Math.max(0, (k.col || 1) - 1);
      const h = scanHeaderPunctuation(doc, anchorLine, anchorChar, "lambda");
      if (!h) continue;
      const info = pinInfoForKernel(k);
      if (headerOverlapsRange(h, anchorLine, range)) {
        actions.push(...pinActions(doc, h, info.pinClauses, hasPinDiagnostic, diags));
      }
      actions.push(...rankActions(doc, h, info.minRanks, range));
    }
    return actions;
  },
};

// --- Type lenses (CodeLens: function/array signatures, deduction) -----------
//
// One resolve-free provider: every lens is returned fully formed (no
// resolveCodeLens), and applyCheckPayload fires codeLensEmitter so lenses
// stay in step with the fast/slow clocks (workstream 1) exactly like
// diagnostics and hovers already do.

const codeLensEmitter = new vscode.EventEmitter();

/**
 * Render an `Array<...>` type string in index-arrow notation:
 * `Array<Elem like I1, I2>` (or the pretty-printer form `Array<Elem, I1,
 * I2>`) becomes `I1 -> I2 -> Elem` — the Ionide-style "an array IS a
 * function from its indices" reading. Nested Array elements recurse (an
 * array of arrays becomes a longer arrow chain). Pure string work, no
 * document access — reuses splitTopLevel/splitOnLike, the same
 * top-level-nesting-aware helpers parseArrayTypeAt uses for hovers. Returns
 * null for a non-Array type, or one with no index args at all — the caller
 * skips the lens rather than showing something misleading.
 */
function arrowNotation(typeString) {
  if (!typeString) return null;
  const s = typeString.trim();
  const m = /^Array\s*<([\s\S]*)>\s*$/.exec(s);
  if (!m) return null;
  const inner = m[1];
  let elem;
  let idxText;
  const parts = splitOnLike(inner);
  if (parts) {
    elem = parts[0].trim();
    idxText = parts[1];
  } else {
    const commaParts = splitTopLevel(inner, ",");
    if (commaParts.length === 0) return null;
    elem = commaParts[0];
    idxText = commaParts.slice(1).join(", ");
  }
  const indices = splitTopLevel(idxText, ",");
  if (indices.length === 0) return null;
  const elemArrow = arrowNotation(elem);
  return indices.concat([elemArrow || elem]).join(" -> ");
}

/**
 * The deduction lenses for one function binding or kernel: one per
 * still-unpinned clause, `deduced <clause> · <storage> [: C vs D cells]
 * — pin`. Clicking runs blade.pinDeduction with the SAME edit ingredients
 * pinEditFromHeader would give the code action, so the two surfaces can
 * never disagree about where the pin lands. Cell counts only for function
 * bindings (kernels carry no return-type string to check) and only when the
 * return type's relevant axes have a literal extent (deducedClassCells).
 */
function deductionLenses(doc, source, info, kind, name) {
  if (!info || !info.pinClauses.length) return [];
  const anchorLine = Math.max(0, (source.line || 1) - 1);
  const anchorChar = kind === "lambda" ? Math.max(0, (source.col || 1) - 1) : 0;
  const h = scanHeaderPunctuation(doc, anchorLine, anchorChar, kind, name);
  if (!h) return [];
  const range = new vscode.Range(anchorLine, 0, anchorLine, 0);
  const lenses = [];
  for (const clause of info.pinClauses) {
    const edit = pinEditFromHeader(h, clause);
    if (!edit) continue;
    const plus = !clause.startsWith("anticomm(");
    const storage = plus ? "symmetric storage" : "strict-triangular storage";
    const cells = kind === "function" ? deducedClassCells(source.ret, clauseArity(clause), plus) : undefined;
    const cellsText = cells ? `: ${cells.compact} vs ${cells.dense} cells` : "";
    const lens = new vscode.CodeLens(range);
    lens.command = {
      title: `deduced ${clause} · ${storage}${cellsText} — pin`,
      command: "blade.pinDeduction",
      arguments: [doc.uri.toString(), { line: edit.position.line, character: edit.position.character }, edit.text],
    };
    lenses.push(lens);
  }
  return lenses;
}

const codeLensProvider = {
  onDidChangeCodeLenses: codeLensEmitter.event,
  provideCodeLenses(doc) {
    if (doc.languageId !== "blade") return [];
    const cfg = vscode.workspace.getConfiguration("blade");
    const showFn = cfg.get("signatureLens.functions", true);
    const showArr = cfg.get("signatureLens.arrays", true);
    const showDed = cfg.get("deductionLens", true);
    if (!showFn && !showArr && !showDed) return [];

    const lenses = [];
    const key = doc.uri.toString();
    for (const b of bindingsByDoc.get(key) || []) {
      // bindings[] also carries a "param" entry per function parameter (see
      // documentSymbols' identical exclusion): a param shares its function's
      // header line, so without this filter every array-typed param stacks
      // its own arrow lens on top of the function's signature lens.
      // `_foreign` (notebook.js's remapPayloadForCell, workstream 5 N3):
      // a binding pulled into a cell's cache from an EARLIER cell, clamped
      // to line 1 so hovers/completions still resolve it — without this
      // skip every later cell would stack a duplicate signature lens for
      // every earlier cell's binding on top of its own first line.
      if (!b.name || !b.line || b.kind === "param" || b._foreign) continue;
      const line = Math.max(0, (b.line || 1) - 1);
      const range = new vscode.Range(line, 0, line, 0);
      const callable = Array.isArray(b.params) && b.ret !== undefined;
      if (callable && showFn) {
        const norm = typeNormalizer();
        const sig = (b.params || []).map((p) => norm(p.type)).concat([norm(b.ret)]).join(" -> ");
        const lens = new vscode.CodeLens(range);
        lens.command = { title: `${b.name} : ${sig}`, command: "" };
        lenses.push(lens);
      } else if (!callable && showArr) {
        const arrow = arrowNotation(displayType(b) || "");
        if (arrow) {
          const lens = new vscode.CodeLens(range);
          lens.command = { title: `${b.name} : ${typeNormalizer()(arrow)}`, command: "" };
          lenses.push(lens);
        }
      }
      if (showDed) lenses.push(...deductionLenses(doc, b, pinInfoForFunction(b), "function", b.name));
    }
    if (showDed) {
      for (const k of kernelsByDoc.get(key) || []) {
        if (!k.line) continue;
        lenses.push(...deductionLenses(doc, k, pinInfoForKernel(k), "lambda"));
      }
    }
    return lenses;
  },
};

/** blade.pinDeduction command body: apply the {position, text} insertion a
 *  pin code action / deduction lens computed, to `uriString`'s document.
 *  Exported separately from its registration (see activate()) so tests can
 *  call it directly without going through vscode.commands. */
function pinDeductionCommand(uriString, position, text) {
  const uri = vscode.Uri.parse(uriString);
  const edit = new vscode.WorkspaceEdit();
  edit.insert(uri, new vscode.Position(position.line, position.character), text);
  return vscode.workspace.applyEdit(edit);
}

// --- Activation ---------------------------------------------------------------

function activate(context) {
  diagnostics = vscode.languages.createDiagnosticCollection("blade");
  output = vscode.window.createOutputChannel("Blade");
  context.subscriptions.push(diagnostics, output);
  // Absent from the test mock's context; resolveGr treats it as optional.
  extensionRootPath = context.extensionUri ? context.extensionUri.fsPath : undefined;
  // Preflight, log-only for now: the GR toggle (docs/gr-graphics-plan.md G2)
  // consumes findGr() when it lands; until then this line is the one place
  // that says why the static backend will or won't be available.
  const grState = findGr();
  output.appendLine(
    grState.ok
      ? `gr: ${grState.grdir} (via ${grState.source})`
      : `gr: unavailable — ${grState.reason}`
  );
  repl.init(context, { findCompiler, reportNoCompiler });
  serve.init(context, { findCompiler, output });
  // applyCheckPayload is passed through so notebook.js's own per-notebook
  // `checkCells` fast check (N3) can fan its remapped response out to each
  // cell's caches without notebook.js requiring this module back (that would
  // be a require cycle — extension.js already requires notebook.js).
  notebook.init(context, { findCompiler, output, applyCheckPayload });
  // Plots panel: subscribes to the display-frame hub (src/display.js) and
  // registers blade.plotDemo. No wiring beyond this — every frame reaches it
  // through the hub, never through this module.
  plots.init(context, { output });

  const cfg = () => vscode.workspace.getConfiguration("blade");

  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ language: "blade" }, hoverProvider),

    vscode.languages.registerSignatureHelpProvider(
      { language: "blade" },
      signatureHelpProvider,
      "(",
      ","
    ),

    vscode.languages.registerCompletionItemProvider({ language: "blade" }, completionProvider),

    // Navigation (workstream 2): definition/references/rename/outline all
    // degrade gracefully when references[] is absent (see their own
    // comments) — safe to register unconditionally, on every compiler.
    vscode.languages.registerDefinitionProvider({ language: "blade" }, definitionProvider),
    vscode.languages.registerReferenceProvider({ language: "blade" }, referenceProvider),
    vscode.languages.registerRenameProvider({ language: "blade" }, renameProvider),
    vscode.languages.registerDocumentSymbolProvider({ language: "blade" }, documentSymbolProvider),

    // Code actions (workstream 3): pin deduced comm/anticomm, annotate
    // deduced rank — works against today's payload, no references[] needed.
    vscode.languages.registerCodeActionsProvider({ language: "blade" }, codeActionProvider, {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.RefactorRewrite],
    }),

    // Type lenses (workstream 4): function/array signatures, deduction pin.
    vscode.languages.registerCodeLensProvider({ language: "blade" }, codeLensProvider),

    vscode.commands.registerCommand("blade.check", () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc) checkDocument(doc, "full");
    }),

    vscode.commands.registerCommand("blade.runFile", commandRunFile),
    vscode.commands.registerCommand("blade.emitFile", commandEmitFile),
    vscode.commands.registerCommand("blade.startRepl", commandStartRepl),
    vscode.commands.registerCommand("blade.runSelection", commandSendSelectionToRepl),
    vscode.commands.registerCommand("blade.sendFileToRepl", commandSendFileToRepl),
    vscode.commands.registerCommand("blade.replReset", () => repl.resetRepl()),
    // Internal (menus.commandPalette "when": false in package.json) — the
    // deduction lens's own command, sharing pinEditFromHeader's insertion
    // point with the "Pin deduced ..." code action.
    vscode.commands.registerCommand("blade.pinDeduction", pinDeductionCommand),

    // Fast clock: debounced as-you-type checks, serve-only (see
    // onDocumentChanged). checkOnSave/checkOnOpen below always run the full
    // tier regardless of blade.liveChecking — that setting only gates the
    // change-triggered clock.
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length > 0) onDocumentChanged(e.document);
    }),

    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (cfg().get("checkOnSave", true)) checkDocument(doc, "full");
    }),

    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (cfg().get("checkOnOpen", true)) checkDocument(doc, "full");
    }),

    vscode.workspace.onDidCloseTextDocument((doc) => {
      diagnostics.delete(doc.uri);
      bindingsByDoc.delete(doc.uri.toString());
      providersByDoc.delete(doc.uri.toString());
      callsByDoc.delete(doc.uri.toString());
      kernelsByDoc.delete(doc.uri.toString());
      referencesByDoc.delete(doc.uri.toString());
      typeDeclCache.delete(doc.uri.toString());
      clearFastTimer(doc);
      clearIdleTimer(doc);
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("blade.compilerPath")) {
        warnedNoCompiler = false;
        ideMode = "unknown"; // a new compiler may support serve or JSON mode
        diagDocTargetCache = undefined; // a new compiler may live in a different checkout
        serve.dispose(); // kill the old process; the next check() re-probes fresh
      }
    })
  );

  if (cfg().get("checkOnOpen", true)) {
    for (const doc of vscode.workspace.textDocuments) checkDocument(doc, "full");
  }
}

function deactivate() {
  serve.dispose();
  notebook.dispose();
  plots.dispose();
}

module.exports = { activate, deactivate };

// Headless test surface (scripts/, not used by VS Code): the providers, the
// checker, and the per-document caches they read. Everything here is the same
// object the activation wires up — no test-only forks.
module.exports._test = {
  checkDocument,
  hoverProvider,
  completionProvider,
  declContextAt,
  bindingsByDoc,
  kernelsByDoc,
  applyCheckPayload,
  isParseFailurePayload,
  callsByDoc,
  providersByDoc,
  displayType,
  // Navigation (workstream 2).
  referencesByDoc,
  resolveReference,
  lookupBinding,
  lookupBindingPrecise,
  definitionProvider,
  referenceProvider,
  renameProvider,
  documentSymbolProvider,
  documentSymbols,
  isReservedName,
  // Code actions (workstream 3).
  codeActionProvider,
  scanHeaderPunctuation,
  pinEditFromHeader,
  pinInfoForFunction,
  pinInfoForKernel,
  // Type lenses (workstream 4).
  codeLensProvider,
  arrowNotation,
  deducedClassCells,
  clauseArity,
  pinDeductionCommand,
  // Diagnostic doc links.
  diagnosticCode,
  diagnosticCodeValue,
  setOutput: (o) => {
    output = o;
  },
  setDiagnostics: (d) => {
    diagnostics = d;
  },
};
