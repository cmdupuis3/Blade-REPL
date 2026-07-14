// Blade language support: diagnostics via `Blade check`, type hovers and
// signature help via `Blade ide check --json` (auto-detected; falls back to
// text diagnostics against compilers without the JSON subcommand).
//
// Plain CommonJS on purpose — no build step, no dependencies. VS Code's own
// Node runtime executes this directly.

const vscode = require("vscode");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const builtins = require("./builtins");

/** @type {vscode.DiagnosticCollection} */
let diagnostics;
/** @type {vscode.OutputChannel} */
let output;

// "unknown" until first probe, then "json" or "text".
let ideMode = "unknown";
// uri.toString() -> bindings array from the last successful JSON check.
const bindingsByDoc = new Map();
// Warn about a missing compiler only once per session.
let warnedNoCompiler = false;

const CANDIDATE_COMPILERS = [
  "Blade", // PATH
  "C:\\Users\\cdupu\\Documents\\_blade-compiler\\bin\\Release\\net7.0\\Blade.exe",
  "C:\\Users\\cdupu\\Documents\\_blade-compiler\\bin\\Debug\\net7.0\\Blade.exe",
];

function findCompiler() {
  const configured = vscode.workspace.getConfiguration("blade").get("compilerPath", "");
  if (configured) return configured;
  for (const c of CANDIDATE_COMPILERS) {
    if (c === "Blade") continue; // tried last, via spawn failure
    if (fs.existsSync(c)) return c;
  }
  return "Blade";
}

function run(exe, args, timeoutMs) {
  return new Promise((resolve) => {
    cp.execFile(
      exe,
      args,
      { timeout: timeoutMs || 30000, maxBuffer: 16 * 1024 * 1024 },
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

// Text formats produced today (TypeEnv.formatCompileError / Cli.fs):
//   line:col: message
//   file:line:col: message          (File rarely populated in spans)
//   Parse error at line:col: message
const DIAG_RE = /^(?:Parse error at )?(?:(.+?):)?(\d+):(\d+):\s*(.+)$/;

/** @param {vscode.TextDocument} doc */
function textToDiagnostics(doc, text) {
  const result = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = DIAG_RE.exec(line);
    if (!m) continue;
    const lineNo = Math.max(0, parseInt(m[2], 10) - 1);
    const colNo = Math.max(0, parseInt(m[3], 10) - 1);
    const start = new vscode.Position(lineNo, colNo);
    // Statement-level spans only today: highlight from the reported column to
    // the end of that line so the squiggle is visible.
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
    result.push(diag);
  }
  return result;
}

/** @param {vscode.TextDocument} doc */
async function checkDocument(doc) {
  if (doc.languageId !== "blade" || doc.uri.scheme !== "file") return;
  const exe = findCompiler();

  // Prefer the JSON IDE mode; probe once per session.
  if (ideMode !== "text") {
    const res = await run(exe, ["ide", "check", "--json", doc.fileName]);
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
      bindingsByDoc.set(doc.uri.toString(), payload.bindings || []);
      diagnostics.set(doc.uri, jsonToDiagnostics(doc, payload));
      return;
    }
    ideMode = "text";
    output.appendLine(
      "[blade] compiler has no 'ide check --json' subcommand yet; using text diagnostics (no hover types)"
    );
  }

  const res = await run(exe, ["check", doc.fileName]);
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

function reportNoCompiler(exe) {
  if (warnedNoCompiler) return;
  warnedNoCompiler = true;
  vscode.window.showWarningMessage(
    `Blade: compiler not found ('${exe}'). Set "blade.compilerPath" in settings to enable diagnostics.`
  );
}

// --- REPL-style evaluation (blade run) ---------------------------------------
//
// Blade has no interactive session, but `blade run` auto-prints every
// top-level binding ("x = 7"), so compiling and running a snippet behaves
// like REPL evaluation. Alt+Enter sends the selection (or current line);
// Alt+Shift+Enter runs the whole file. Output lands in the "Blade REPL"
// channel.

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

// --- Interactive REPL terminal (`blade repl`) --------------------------------
//
// The compiler's `blade repl` subcommand is an accumulating session: each
// submitted snippet recompiles and re-runs the whole session, printing only
// new/changed values, with in-place rebinding. The extension hosts it in a
// real terminal (like Ionide's FSI / the Python REPL) and Alt+Enter sends
// code into its stdin via sendText.

/** @type {vscode.Terminal | undefined} */
let replTerminal;

function getReplTerminal(cwd) {
  if (replTerminal && replTerminal.exitStatus === undefined) return replTerminal;
  const exe = findCompiler();
  replTerminal = vscode.window.createTerminal({
    name: "Blade REPL",
    shellPath: exe,
    shellArgs: ["repl"],
    cwd,
  });
  return replTerminal;
}

function replCwdFor(doc) {
  // The REPL process's cwd is where the compiled session runs, so relative
  // data paths (NetCDF.load("sample.nc")) resolve next to the source file.
  if (doc && doc.uri.scheme === "file") return path.dirname(doc.fileName);
  const ws = vscode.workspace.workspaceFolders;
  return ws && ws.length > 0 ? ws[0].uri.fsPath : undefined;
}

function sendToRepl(doc, code) {
  const term = getReplTerminal(replCwdFor(doc));
  term.show(true);
  const lines = code.split(/\r?\n/);
  if (lines.length > 1) {
    // Batch multi-line input so the whole block evaluates as ONE snippet
    // (one recompile) instead of line-by-line.
    term.sendText(":paste");
    term.sendText(code);
    term.sendText(":end");
  } else {
    term.sendText(code);
  }
}

function commandStartRepl() {
  const editor = vscode.window.activeTextEditor;
  const doc = editor && editor.document.languageId === "blade" ? editor.document : undefined;
  getReplTerminal(replCwdFor(doc)).show(false);
}

function commandSendSelectionToRepl() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "blade") return;
  const doc = editor.document;
  const sel = editor.selection;
  const code = sel.isEmpty ? doc.lineAt(sel.active.line).text : doc.getText(sel);
  if (!code.trim()) return;
  sendToRepl(doc, code);
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
  const code = editor.document.getText();
  if (!code.trim()) return;
  sendToRepl(editor.document, code);
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

/** Signature header: multi-line function types go below the name. */
function signatureText(kind, name, type) {
  return type.includes("\n")
    ? `${kind} ${name} :\n${type}`
    : `${kind} ${name} : ${type}`;
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
  const head = prefix ? `${prefix} ${name}` : name;
  const lines = [];
  if (!params || params.length === 0) {
    lines.push(`${head}()${ret ? " -> " + ret : ""}`);
  } else {
    lines.push(`${head}(`);
    const bodies = params.map(
      (p, i) => `    ${p.name}: ${p.type}${i < params.length - 1 ? "," : ""}`
    );
    const width = Math.max(...bodies.map((b) => b.length));
    params.forEach((p, i) => {
      lines.push(p.doc ? `${bodies[i].padEnd(width)}  // ${p.doc}` : bodies[i]);
    });
    lines.push(`)${ret ? " -> " + ret : ""}`);
  }
  if (Array.isArray(where) && where.length > 0) {
    lines.push("where");
    for (const w of where) lines.push(`    ${w}`);
  }
  return lines.join("\n");
}

function hoverMarkdown(sig, doc) {
  const md = new vscode.MarkdownString();
  md.appendCodeblock(sig, "blade");
  if (doc) {
    md.appendMarkdown("\n---\n\n");
    md.appendText(doc);
  }
  return md;
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
      // Source bindings win over the builtin table (shadowing).
      const b = lookupBinding(doc, word, position.line);
      if (b) {
        // Functions (anything with structured params/ret) render as a full
        // callable signature; plain values keep the `kind name : type` form.
        const sig =
          Array.isArray(b.params) && b.ret !== undefined
            ? renderCallable(b.kind || "function", b.name, b.params, b.ret, b.where)
            : signatureText(b.kind || "", b.name, b.type);
        return new vscode.Hover(hoverMarkdown(sig, b.doc), wordRange);
      }
      const builtin = builtins.identifiers[word];
      if (builtin) {
        const sig = builtin.params
          ? renderCallable("", word, builtin.params, builtin.ret, null)
          : builtin.sig;
        return new vscode.Hover(hoverMarkdown(sig, builtin.doc), wordRange);
      }
      return undefined;
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

// --- Activation ---------------------------------------------------------------

function activate(context) {
  diagnostics = vscode.languages.createDiagnosticCollection("blade");
  output = vscode.window.createOutputChannel("Blade");
  context.subscriptions.push(diagnostics, output);

  const cfg = () => vscode.workspace.getConfiguration("blade");

  context.subscriptions.push(
    vscode.languages.registerHoverProvider({ language: "blade" }, hoverProvider),

    vscode.languages.registerSignatureHelpProvider(
      { language: "blade" },
      signatureHelpProvider,
      "(",
      ","
    ),

    vscode.commands.registerCommand("blade.check", () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc) checkDocument(doc);
    }),

    vscode.commands.registerCommand("blade.runFile", commandRunFile),
    vscode.commands.registerCommand("blade.emitFile", commandEmitFile),
    vscode.commands.registerCommand("blade.startRepl", commandStartRepl),
    vscode.commands.registerCommand("blade.runSelection", commandSendSelectionToRepl),
    vscode.commands.registerCommand("blade.sendFileToRepl", commandSendFileToRepl),

    vscode.window.onDidCloseTerminal((t) => {
      if (t === replTerminal) replTerminal = undefined;
    }),

    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (cfg().get("checkOnSave", true)) checkDocument(doc);
    }),

    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (cfg().get("checkOnOpen", true)) checkDocument(doc);
    }),

    vscode.workspace.onDidCloseTextDocument((doc) => {
      diagnostics.delete(doc.uri);
      bindingsByDoc.delete(doc.uri.toString());
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("blade.compilerPath")) {
        warnedNoCompiler = false;
        ideMode = "unknown"; // a new compiler may support JSON mode
      }
    })
  );

  if (cfg().get("checkOnOpen", true)) {
    for (const doc of vscode.workspace.textDocuments) checkDocument(doc);
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
