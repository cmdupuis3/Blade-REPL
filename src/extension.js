// Blade language support: diagnostics via `Blade check`, type hovers and
// signature help via `Blade ide check --json` (auto-detected; falls back to
// text diagnostics against compilers without the JSON subcommand), and an
// interpreter-backed REPL with inline results (src/repl.js).
//
// Plain CommonJS on purpose — no build step, no dependencies. VS Code's own
// Node runtime executes this directly.

const vscode = require("vscode");
const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const builtins = require("./builtins");
const types = require("./types");
const keywords = require("./keywords");
const repl = require("./repl");

/** @type {vscode.DiagnosticCollection} */
let diagnostics;
/** @type {vscode.OutputChannel} */
let output;

// "unknown" until first probe, then "json" or "text".
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
// Warn about a missing compiler only once per session.
let warnedNoCompiler = false;

const CANDIDATE_COMPILERS = [
  "Blade", // PATH
  // Canonical compiler repo (standard .NET layout). findCompiler() picks the
  // most-recently-built of these, so Release/Debug both work.
  "C:\\Users\\cdupu\\Documents\\GitHub\\Blade\\bin\\Release\\net7.0\\Blade.exe",
  "C:\\Users\\cdupu\\Documents\\GitHub\\Blade\\bin\\Debug\\net7.0\\Blade.exe",
];

function findCompiler() {
  const configured = vscode.workspace.getConfiguration("blade").get("compilerPath", "");
  if (configured) return configured;
  // Prefer the most recently built binary — a stale Release build next to a
  // fresh Debug build would otherwise report errors the compiler no longer
  // produces (e.g. ML statics before their elaboration pass landed).
  let best;
  for (const c of CANDIDATE_COMPILERS) {
    if (c === "Blade") continue; // tried last, via spawn failure
    try {
      const mtime = fs.statSync(c).mtimeMs;
      if (!best || mtime > best.mtime) best = { path: c, mtime };
    } catch {
      // candidate doesn't exist
    }
  }
  return best ? best.path : "Blade";
}

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
      d.code = h[2];
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
    if (d.code) diag.code = d.code;
    result.push(diag);
  }
  return result;
}

/** @param {vscode.TextDocument} doc */
async function checkDocument(doc) {
  if (doc.languageId !== "blade" || doc.uri.scheme !== "file") return;
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
      bindingsByDoc.set(doc.uri.toString(), payload.bindings || []);
      cacheProviders(doc, payload.providers || []);
      callsByDoc.set(doc.uri.toString(), payload.calls || []);
      kernelsByDoc.set(doc.uri.toString(), payload.kernels || []);
      diagnostics.set(doc.uri, jsonToDiagnostics(doc, payload));
      // Concise telemetry so a "no tooltips" report can be pinpointed: empty
      // bindings ⇒ the file didn't type-check; providers=0 on a provider file
      // ⇒ its data path didn't resolve from the run directory.
      output.appendLine(
        `[blade] ${path.basename(doc.fileName)}: bindings=${(payload.bindings || []).length}` +
          ` providers=${(payload.providers || []).length} diagnostics=${(payload.diagnostics || []).length}`
      );
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
 * name -> { name, parent, indexLike, doc }; units maps name -> { name, rhs,
 * doc } (rhs undefined for base units); statics maps name -> rhs (the key
 * lists a `SparseIdx<K>` names). Cached per document version.
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
      });
      continue;
    }
    const u = /^\s*Unit\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*=\s*(.+?))?\s*$/.exec(text);
    if (u) {
      const rhs = u[2] && u[2].replace(/\s*\/\/.*$/, "").trim();
      units.set(u[1], { name: u[1], rhs: rhs || undefined, doc: docCommentAbove(doc, l) });
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
  // class is `Idx<n>` and a single survivor is the exact Sym/Antisym record.
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
  // Unit of measure from a source `Unit name [= expr]` declaration.
  const unit = scanDecls(doc).units.get(word);
  if (unit) {
    const declLine = unit.rhs ? `Unit ${unit.name} = ${unit.rhs}` : `Unit ${unit.name}`;
    return new vscode.Hover(
      typeMarkdown([declLine, "Unit of Measure"], unit.doc, true),
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
      // Source bindings win over the builtin table (shadowing).
      const b = lookupBinding(doc, word, position.line);
      if (b) {
        // Functions (anything with structured params/ret) render as a full
        // callable signature; plain values keep the `kind name : type` form.
        const callable = Array.isArray(b.params) && b.ret !== undefined;
        const sig = callable
          ? renderCallable(b.kind || "function", b.name, b.params, b.ret, b.where)
          : signatureText(b.kind || "", b.name, b.type);
        const md = new vscode.MarkdownString();
        md.appendCodeblock(sig, "blade");
        // A top-level provider read carries its source member as a badge.
        if (b.providerRead) {
          md.appendMarkdown(`\n*from ${b.providerRead.store}.${b.providerRead.member}*\n`);
        }
        // A wreath class is almost always DEDUCED rather than written (the tie
        // rule appends a level to a repeated compact argument), so the binding
        // is where the user first meets it — spell out what it stores.
        if (!callable) appendClassDetail(md, doc, b.type || "");
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
  let deduced = [];
  let declared = [];
  const rankByParam = new Map();
  if (ctx.kind === "function") {
    if (!ctx.name) return [];
    const b = (bindingsByDoc.get(doc.uri.toString()) || []).find(
      (x) => x.name === ctx.name && Array.isArray(x.params) && x.ret !== undefined
    );
    if (!b || !Array.isArray(b.deducedComm)) return [];
    deduced = b.deducedComm;
    declared = commClauses(b.where);
    for (const r of bindingMinRanks(b)) rankByParam.set(r.param, r.rank);
  } else {
    // Inline lambda: the kernels[] entry whose span starts on the header line.
    const k = (kernelsByDoc.get(doc.uri.toString()) || []).find(
      (e) => (e.line || 1) - 1 === ctx.line
    );
    if (!k) return [];
    deduced = k.deducedComm || [];
    declared = commClauses(k.declaredWhere);
    for (const r of kernelMinRanks(k)) rankByParam.set(r.param, r.rank);
  }
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
    for (const clause of deduced.filter((c) => !declared.includes(c))) {
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
        b.type,
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
      push(name, vscode.CompletionItemKind.Unit, u.rhs ? `Unit ${name} = ${u.rhs}` : `Unit ${name}`, u.doc ? new vscode.MarkdownString().appendText(u.doc) : undefined);
    }

    return items;
  },
};

// --- Activation ---------------------------------------------------------------

function activate(context) {
  diagnostics = vscode.languages.createDiagnosticCollection("blade");
  output = vscode.window.createOutputChannel("Blade");
  context.subscriptions.push(diagnostics, output);
  repl.init(context, { findCompiler, reportNoCompiler });

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

    vscode.commands.registerCommand("blade.check", () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (doc) checkDocument(doc);
    }),

    vscode.commands.registerCommand("blade.runFile", commandRunFile),
    vscode.commands.registerCommand("blade.emitFile", commandEmitFile),
    vscode.commands.registerCommand("blade.startRepl", commandStartRepl),
    vscode.commands.registerCommand("blade.runSelection", commandSendSelectionToRepl),
    vscode.commands.registerCommand("blade.sendFileToRepl", commandSendFileToRepl),
    vscode.commands.registerCommand("blade.replReset", () => repl.resetRepl()),

    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (cfg().get("checkOnSave", true)) checkDocument(doc);
    }),

    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (cfg().get("checkOnOpen", true)) checkDocument(doc);
    }),

    vscode.workspace.onDidCloseTextDocument((doc) => {
      diagnostics.delete(doc.uri);
      bindingsByDoc.delete(doc.uri.toString());
      providersByDoc.delete(doc.uri.toString());
      callsByDoc.delete(doc.uri.toString());
      kernelsByDoc.delete(doc.uri.toString());
      typeDeclCache.delete(doc.uri.toString());
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
  setOutput: (o) => {
    output = o;
  },
  setDiagnostics: (d) => {
    diagnostics = d;
  },
};
