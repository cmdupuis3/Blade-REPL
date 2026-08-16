// Blade notebooks (workstream 5): a NotebookSerializer for `.bladenb` files
// plus a NotebookController that executes cells through a persistent `blade
// ide serve` session — src/serve.js's `eval`/`resetSession` commands, over a
// DEDICATED client (src/serve.js's createClient(), not the extension-wide
// singleton extension.js uses for its check clocks) so a slow g++-fallback
// cell can't stall typing-time checks in some other file.
//
// On-disk format (D1 in the plan): a notebook file is a plain, VALID Blade
// program. `// %%` on its own line (optionally followed by a title) starts a
// new code cell; `// %% [markdown]` starts a markdown cell whose body is
// stored as `// `-prefixed comment lines so the file stays parseable even
// when opened as plain text. Text before the first marker is the first code
// cell (no markers at all = the whole file is one cell). This module's
// parsing is split into a PURE core (parseCells/serializeCells — plain
// strings in, plain strings out, no `vscode` dependency, trivially unit-
// testable) and a thin vscode-shaped adapter (textToNotebookData /
// notebookDataToText) that additionally strips/re-adds the markdown `// `
// comment prefix so a markdown cell's *value* is genuine markdown.
//
// Execution model mirrors the REPL (src/repl.js): out-of-order cell runs are
// allowed and rebind by top-level name, exactly like Alt+Enter today; the
// compiler does the splicing. What's new here is doing it over `ide serve`'s
// NDJSON channel instead of the REPL's pty, so cells get structured,
// typed, per-binding outputs instead of one formatted transcript blob.

"use strict";

const vscode = require("vscode");
const path = require("path");
const serve = require("./serve");
const display = require("@blade-lang/ide-protocol").display;

const NOTEBOOK_TYPE = "blade-notebook";

// Injected by init(): { findCompiler, output, applyCheckPayload } from
// extension.js. findCompiler/output are the same shape every other module's
// init() takes, forwarded straight to serve.createClient() for each
// notebook's dedicated process. applyCheckPayload is extension.js's own
// function (NOT re-implemented here — see the N3 section below) that fills
// the per-doc caches every hover/completion/diagnostic/lens provider reads;
// passed in rather than required directly to avoid a require cycle
// (extension.js already requires this module).
let deps;

// --- Pure marker-format core (no vscode) -------------------------------------

const MARKER_RE = /^\/\/ %%(.*)$/;

/** Split `text` into raw lines, normalizing away exactly one trailing
 *  newline (CRLF or LF) if present — interior blank lines are preserved
 *  as-is. An empty file yields `[""]` (one cell, empty content), never `[]`. */
function splitLinesNormalized(text) {
  const stripped = text.replace(/\r?\n$/, "");
  return stripped.split(/\r?\n/);
}

/**
 * Parse `text` into cell segments: `[{kind: "code"|"markdown", lines:
 * string[], title: string|undefined}]`. `lines` are the RAW file lines for
 * that cell (a markdown cell's lines still carry their `// ` prefix — see
 * markdownBodyFromLines/markdownLinesFromBody for that layer) — this keeps
 * parseCells/serializeCells a byte-level-lossless pair independent of what a
 * markdown cell's *content* means. Always returns at least one cell.
 */
function parseCells(text) {
  const lines = splitLinesNormalized(text);
  const cells = [];
  let i = 0;
  // Text before the first marker (or the whole file, if there is no marker
  // at all) is the implicit first code cell — but only when the file
  // doesn't literally START with a marker line (that would make this an
  // empty, unrepresented leading segment; see the module's serializeCells
  // for the matching write-side rule).
  if (!MARKER_RE.test(lines[0])) {
    const seg = [];
    while (i < lines.length && !MARKER_RE.test(lines[i])) {
      seg.push(lines[i]);
      i++;
    }
    cells.push({ kind: "code", lines: seg, title: undefined });
  }
  while (i < lines.length) {
    const m = MARKER_RE.exec(lines[i]);
    i++;
    const rest = m[1].trim();
    const mdMatch = /^\[markdown\]\s*(.*)$/.exec(rest);
    let kind, title;
    if (mdMatch) {
      kind = "markdown";
      title = mdMatch[1].trim() || undefined;
    } else {
      kind = "code";
      title = rest || undefined;
    }
    const seg = [];
    while (i < lines.length && !MARKER_RE.test(lines[i])) {
      seg.push(lines[i]);
      i++;
    }
    cells.push({ kind, lines: seg, title });
  }
  return cells;
}

/** Inverse of parseCells: `cells` (same shape parseCells produces — `.lines`
 *  are already the raw file lines for that cell) back into file text. The
 *  first cell gets NO marker line when it's a plain, untitled code cell
 *  (matching parseCells's implicit-leading-cell rule); every other cell, or
 *  a first cell that's markdown or titled, gets an explicit `// %%` marker.
 *  Always ends in exactly one trailing newline — see the module header:
 *  round-tripping is only lossless for CELL CONTENT, not the file's original
 *  trailing-newline count. */
function serializeCells(cells) {
  const out = [];
  cells.forEach((cell, idx) => {
    const isMd = cell.kind === "markdown";
    const needsMarker = idx > 0 || isMd || !!cell.title;
    if (needsMarker) {
      let marker = "// %%";
      if (isMd) marker += " [markdown]";
      if (cell.title) marker += " " + cell.title;
      out.push(marker);
    }
    out.push(...cell.lines);
  });
  return out.join("\n") + "\n";
}

/** A markdown cell's raw `// `-prefixed file lines -> its actual markdown
 *  text (one leading space after `//` stripped per line; a bare `//` line is
 *  an empty line; a line that somehow lacks the `//` prefix at all — a
 *  hand-edited file — passes through verbatim rather than losing content). */
function markdownBodyFromLines(lines) {
  return lines
    .map((l) => {
      if (l === "//") return "";
      if (l.startsWith("// ")) return l.slice(3);
      if (l.startsWith("//")) return l.slice(2);
      return l;
    })
    .join("\n");
}

/** Inverse of markdownBodyFromLines: markdown text -> `// `-prefixed file
 *  lines (an empty line becomes a bare `//`, never `// ` with trailing
 *  whitespace). */
function markdownLinesFromBody(value) {
  return value.split(/\r?\n/).map((l) => (l === "" ? "//" : "// " + l));
}

// --- vscode-shaped adapter ----------------------------------------------------

/** Parsed file text -> a vscode.NotebookData (the shape both the serializer
 *  and the "Open as Notebook" command need). */
function textToNotebookData(text) {
  const cellDatas = parseCells(text).map((c) => {
    const isMd = c.kind === "markdown";
    const value = isMd ? markdownBodyFromLines(c.lines) : c.lines.join("\n");
    const kind = isMd ? vscode.NotebookCellKind.Markup : vscode.NotebookCellKind.Code;
    const lang = isMd ? "markdown" : "blade";
    const cellData = new vscode.NotebookCellData(kind, value, lang);
    if (c.title) cellData.metadata = { title: c.title };
    return cellData;
  });
  return new vscode.NotebookData(cellDatas);
}

/** vscode.NotebookData -> file text (the inverse of textToNotebookData).
 *  Outputs are never consulted — the plan deliberately keeps them out of the
 *  on-disk format so diffs stay about code, not session-dependent results. */
function notebookDataToText(data) {
  const cells = (data.cells || []).map((c) => {
    const isMd = c.kind === vscode.NotebookCellKind.Markup;
    const title = c.metadata && c.metadata.title;
    const lines = isMd ? markdownLinesFromBody(c.value) : c.value.split(/\r?\n/);
    return { kind: isMd ? "markdown" : "code", lines, title };
  });
  return serializeCells(cells);
}

const serializer = {
  deserializeNotebook(content /*, token */) {
    return textToNotebookData(Buffer.from(content).toString("utf8"));
  },
  serializeNotebook(data /*, token */) {
    return Buffer.from(notebookDataToText(data), "utf8");
  },
};

// --- Output assembly (D4 in the plan) -----------------------------------------

/** `name = value : type` for a named binding; bare-expression echoes (name
 *  === "") drop the `name = ` prefix. A binding with NO value — a function
 *  declaration, whose signature is the whole story — drops the ` = ` instead,
 *  so `covariance` reads `covariance : (...) -> Float64` rather than the
 *  dangling `covariance =  : (...) -> Float64`. */
function formatBinding(b) {
  const head = b.name && b.value ? `${b.name} = ${b.value}` : b.name || b.value;
  return `${head} : ${b.type}`;
}

/** Cell-local `line:col message` — used for every diagnostic that ISN'T
 *  promoted to the cell's single error-output headline. */
function formatDiagnosticLine(d) {
  return `${d.line}:${d.col} ${d.message}`;
}

/**
 * One display frame (docs/display-frames.md) as a notebook output. The rich
 * item comes FIRST — VS Code renders the highest-priority mime it has a
 * renderer for — followed by a `text/plain` summary that shows instead when
 * nothing can render the rich one (no plotly notebook renderer is contributed
 * yet, so today a plotly frame reads as that summary in the cell while the
 * Blade Plots panel draws it for real).
 */
function displayOutput(frame) {
  const items = [];
  if (frame.encoding === "json") {
    items.push(vscode.NotebookCellOutputItem.json(frame.data, frame.mime));
  } else if (frame.encoding === "base64") {
    items.push(new vscode.NotebookCellOutputItem(Buffer.from(frame.data.replace(/\s+/g, ""), "base64"), frame.mime));
  } else {
    items.push(vscode.NotebookCellOutputItem.text(frame.data, frame.mime));
  }
  const title = frame.meta && frame.meta.title ? ` — ${frame.meta.title}` : "";
  items.push(vscode.NotebookCellOutputItem.text(`[${frame.mime}${title}]`, "text/plain"));
  return new vscode.NotebookCellOutput(items, frame.meta && Object.keys(frame.meta).length ? { blade: frame.meta } : undefined);
}

/**
 * Turn one `eval` response into the ordered NotebookCellOutput[] a
 * successful (or rejected) execution should show. Pure — no execution/client
 * involved — so hermetic tests can feed it canned responses directly; the
 * only state it touches is `seenFrameIds`, an optional Set the CALLER owns
 * (see sessionStateFor) — passing none simply disables replay suppression.
 *
 * kept:false (rejected, session unchanged): a single error output carrying
 * the FIRST diagnostic's bare message (the red VS Code error card), plus —
 * when there's more than one diagnostic — a text output listing the rest as
 * cell-local `line:col message` lines.
 *
 * kept:true: stdout (if any) — display frames (if any: one MIME-typed output
 * each, plus a text output naming any frame that failed to decode, so a
 * malformed frame degrades to text instead of vanishing) — warning-severity
 * diagnostics as a text output
 * (if any) — one output per binding (a text/plain echo PLUS a parallel
 * `application/x-blade-value+json` item carrying the raw {name,type,value},
 * the hook a future rich renderer attaches to) — stderr (if any) — and, when
 * the compiler fell back to g++ for this snippet, a small "[compiled via g++
 * fallback]" badge.
 *
 * Display frames get one more filter first: a Blade session re-runs every
 * accumulated snippet, so `resp.display` can carry an EARLIER cell's frame
 * replayed under the same stable `meta.id` (docs/display-frames.md §10). A
 * frame whose id is already in `seenFrameIds` belongs to that earlier cell
 * and is skipped here — it already reached the Blade Plots panel via the
 * unconditional route() call in applyEvalResult, whose merge-by-id absorbs
 * the replay. A frame with no `meta.id` can never be told apart from a fresh
 * one, so it is always attached.
 */
function assembleOutputs(resp, seenFrameIds) {
  const outputs = [];

  if (!resp.kept) {
    const diags = resp.diagnostics || [];
    const first = diags[0];
    const err = new Error(first ? first.message : "snippet rejected");
    outputs.push(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error(err)]));
    const rest = diags.slice(1);
    if (rest.length > 0) {
      outputs.push(
        new vscode.NotebookCellOutput([
          vscode.NotebookCellOutputItem.text(rest.map(formatDiagnosticLine).join("\n"), "text/plain"),
        ])
      );
    }
    return outputs;
  }

  if (resp.stdout) {
    outputs.push(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text(resp.stdout, "text/plain")]));
  }

  const shown = display.framesFromEval(resp);
  for (const frame of shown.frames) {
    const id = frame.meta && frame.meta.id;
    if (id !== undefined && seenFrameIds) {
      if (seenFrameIds.has(id)) continue; // replayed — already shown by an earlier cell
      seenFrameIds.add(id);
    }
    outputs.push(displayOutput(frame));
  }
  if (shown.errors.length > 0) {
    outputs.push(
      new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.text(shown.errors.join("\n"), "text/plain"),
      ])
    );
  }

  const warnings = (resp.diagnostics || []).filter((d) => d.severity === "warning");
  if (warnings.length > 0) {
    outputs.push(
      new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.text(warnings.map(formatDiagnosticLine).join("\n"), "text/plain"),
      ])
    );
  }

  for (const b of resp.bindings || []) {
    outputs.push(
      new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.text(formatBinding(b), "text/plain"),
        vscode.NotebookCellOutputItem.json(b, "application/x-blade-value+json"),
      ])
    );
  }

  if (resp.stderr) {
    outputs.push(new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.stderr(resp.stderr)]));
  }

  if (resp.lane === "gpp") {
    outputs.push(
      new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.text("[compiled via g++ fallback]", "text/plain"),
      ])
    );
  }

  return outputs;
}

function oldCompilerError() {
  return new Error(
    "This compiler predates notebook eval support ('ide serve' eval/resetSession) — " +
      "rebuild the compiler, or use Blade: Start REPL instead."
  );
}

function evalErrorOutputs(e) {
  return [new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error(e)])];
}

/**
 * Apply one eval response to an in-flight cell execution: assemble and
 * install its outputs, record the source in `state.keptSources` if it was
 * kept, and end the execution (success = kept && exitCode === 0). Split out
 * from executeCell() (which also owns the client call, replay, and
 * error-path branching) so hermetic tests can drive it directly against a
 * canned response and a real mock execution, without a live compiler.
 */
async function applyEvalResult(execution, resp, source, state) {
  // Cell outputs are the notebook's own rendering surface; the SAME frames
  // also go to the Blade Plots panel (src/plots.js) so a plot from a notebook
  // cell is navigable beside one from the REPL. Routed here rather than in
  // assembleOutputs, which stays a pure response -> outputs function. This
  // routing is UNCONDITIONAL — every frame, replayed or not — the panel
  // merges by meta.id itself (docs/display-frames.md §10); only the cell
  // output below is filtered against state.seenFrameIds.
  display.route(display.framesFromEval(resp), "notebook");
  await execution.replaceOutput(assembleOutputs(resp, state.seenFrameIds));
  if (resp.kept) state.keptSources.push(source);
  execution.end(!!resp.kept && resp.exitCode === 0, Date.now());
}

// --- Session / client bookkeeping ---------------------------------------------

// notebook URI string -> its dedicated serve client (one process per open
// notebook — see the module header for why this isn't the extension-wide
// singleton).
const clients = new Map();
// notebook URI string -> { keptSources: string[], needsReplay: boolean,
// seenFrameIds: Set<string> }.
// keptSources only ever grows by appending (never rewritten in place) — a
// rebind is just another entry with the same top-level name; the compiler's
// session splices by name on replay, this side doesn't need to track that.
// seenFrameIds is the cell-output replay filter of docs/display-frames.md
// §10: every `meta.id` already attached to some cell's output in this
// session, so a later eval's replay of that same frame is recognized and
// skipped (see assembleOutputs). It resets everywhere a session logically
// starts over: resetNotebookSession (kernel restart) below, and implicitly
// whenever this map's entry is dropped (cleanupNotebook on close, dispose()
// on deactivate) since the next sessionStateFor() call builds a fresh Set.
// It is deliberately NOT cleared on interrupt (interruptHandler) — that
// replays the SAME accumulated keptSources through a fresh process, and
// meta.id is stable across exactly that kind of replay, so the ids already
// shown are still valid to suppress.
const sessionStates = new Map();
// notebook URI strings whose serve client has already answered eval with a
// protocol error (old compiler) — don't retry per session; report once.
const unsupported = new Set();

let executionCounter = 0;

function clientFor(notebookDoc) {
  const key = notebookDoc.uri.toString();
  let client = clients.get(key);
  if (!client) {
    client = serve.createClient(deps, "blade notebook");
    clients.set(key, client);
  }
  return client;
}

function sessionStateFor(key) {
  let s = sessionStates.get(key);
  if (!s) sessionStates.set(key, (s = { keptSources: [], needsReplay: false, seenFrameIds: new Set() }));
  return s;
}

function notebookCwd(notebookDoc) {
  return notebookDoc.uri.scheme === "file" ? path.dirname(notebookDoc.uri.fsPath) : undefined;
}

/** eval's timeout mirrors "Blade: Run File"'s (blade.runTimeoutSeconds,
 *  default 180s) — a cell can fall back to g++ exactly like a full run can. */
function evalTimeoutMs() {
  return vscode.workspace.getConfiguration("blade").get("runTimeoutSeconds", 180) * 1000;
}

/** Replay `state.keptSources` through `client` in order, discarding their
 *  outputs — used to rebuild a session after its process was killed
 *  (interrupt) before running the cell that triggered the replay. Shows
 *  brief progress via the SAME execution the triggering cell is using, which
 *  the caller overwrites with the real result right after. Best-effort: a
 *  replay failure just stops early — the caller's own eval attempt right
 *  after will surface whatever's actually wrong. */
async function replaySession(client, key, state, execution, cwd) {
  await execution.replaceOutput([
    new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.text("restoring session…", "text/plain")]),
  ]);
  for (const src of state.keptSources) {
    try {
      await client.eval(key, src, cwd, evalTimeoutMs());
    } catch (_) {
      break;
    }
  }
}

async function executeCell(cell, notebookDoc, controller) {
  const key = notebookDoc.uri.toString();
  const execution = controller.createNotebookCellExecution(cell);
  execution.executionOrder = ++executionCounter;
  execution.start(Date.now());
  await execution.clearOutput();

  if (unsupported.has(key)) {
    await execution.replaceOutput(evalErrorOutputs(oldCompilerError()));
    execution.end(false, Date.now());
    return;
  }

  const client = clientFor(notebookDoc);
  const state = sessionStateFor(key);
  const cwd = notebookCwd(notebookDoc);

  if (state.needsReplay) {
    await replaySession(client, key, state, execution, cwd);
    state.needsReplay = false;
  }

  const source = cell.document.getText();
  let resp;
  try {
    resp = await client.eval(key, source, cwd, evalTimeoutMs());
  } catch (e) {
    if (e && e.protocolError) unsupported.add(key);
    await execution.replaceOutput(evalErrorOutputs(e && e.protocolError ? oldCompilerError() : e));
    execution.end(false, Date.now());
    return;
  }

  await applyEvalResult(execution, resp, source, state);
}

async function executeHandler(cells, notebookDoc, controller) {
  for (const cell of cells) {
    await executeCell(cell, notebookDoc, controller);
  }
}

/** Interrupt = hard-kill the notebook's dedicated process (the interpreter
 *  has no cancellation hook — see the plan's risk section). Sessions re-lower
 *  from scratch on every eval anyway, so the honest recovery is: mark this
 *  session for replay, and let the next execution rebuild it from
 *  keptSources before running the cell that was actually requested. */
function interruptHandler(notebookDoc) {
  const key = notebookDoc.uri.toString();
  const client = clients.get(key);
  if (client) client.dispose();
  const state = sessionStateFor(key);
  if (state.keptSources.length > 0) state.needsReplay = true;
}

/** Restart Kernel: unlike interrupt, this doesn't need to kill the process —
 *  resetSession is a lightweight NDJSON request that asks the compiler to
 *  forget the session's bindings. Also clears keptSources (there's nothing
 *  left to replay) and gives a previously "unsupported" session another
 *  chance (a successful reset proves the compiler understands the command
 *  family after all). Also clears seenFrameIds: a fresh compiler session
 *  means the next run's `<SessionTag><ordinal>` ids start over too, so the
 *  old seen-set would otherwise wrongly suppress what are, post-restart,
 *  first-time frames (docs/display-frames.md §10). */
async function resetNotebookSession(notebookDoc) {
  const key = notebookDoc.uri.toString();
  const client = clientFor(notebookDoc);
  const state = sessionStateFor(key);
  try {
    await client.resetSession(key);
    unsupported.delete(key);
  } catch (e) {
    if (e && e.protocolError) unsupported.add(key);
    // Transport failure: state still gets cleared locally below — the next
    // eval will lazily reconnect and start a fresh session either way.
  }
  state.keptSources = [];
  state.needsReplay = false;
  state.seenFrameIds = new Set();
}

// --- Session-aware IDE features (N3): compiler-assembled check + fan-out ---
//
// Hovers/completions/signature help/lenses already FIRE inside cells —
// every provider in extension.js is registered against `{language:"blade"}`,
// which matches a `vscode-notebook-cell` document exactly like a `file` one.
// What's missing is the per-doc caches those providers all read
// (bindingsByDoc/providersByDoc/callsByDoc/kernelsByDoc/referencesByDoc, the
// diagnostics collection — see extension.js's applyCheckPayload) actually
// being FILLED for a cell: checkDocument gates on `doc.uri.scheme !==
// "file"`, and that gate is left alone (see the module header) — this
// section drives cell checking itself instead.
//
// One `checkCells` request per notebook edit (runNotebookCheck below), fanned
// out per code cell (remapPayloadForCell below) through applyCheckPayload
// (injected via init()'s deps). Deliberately the DEFAULT serve singleton
// (serve.checkCells), NOT a notebook's own dedicated eval client (clientFor/
// clients above): checks are stateless per request — there is no session to
// keep separate — and routing them through the dedicated client would
// serialize typing-time checks behind whatever multi-second g++ eval that
// client happens to be running, exactly the stall the dedicated client
// exists to avoid (see the module header and the plan's risk section).

// ASSEMBLY IS THE COMPILER'S JOB. `checkCells` carries the ordered code-cell
// sources and the compiler splices them into one session source itself
// (ReplSession.assembleCells — the same rebind-in-place and bare-expression
// wrapping its eval path already performs), so a cell's hover shows the type
// running the notebook would actually produce. This module used to
// reimplement those rules textually over cell text; the copy drifted from the
// engine it was imitating and reported wrong types, so it is gone with no
// fallback — a compiler that doesn't know `checkCells` answers with the
// generic protocol error and its notebooks simply get no checking.
//
// The response is an ordinary check payload plus `windows`: one entry per
// INPUT cell, in input order, `{startLine, endLine}` (1-based, inclusive —
// the payload's own line convention) naming the region of the assembled
// source that cell's text landed in. `{wrapLine, wrapCol}` appear only when
// the compiler wrapped that cell in a synthetic binding (absolute line /
// prefix length, so shiftSpan can pull the wrapped line's columns back to
// cell-local). A cell mixing declarations with SEVERAL bare expressions takes
// one wrapper per expression but the pair names only the FIRST, so columns on
// a later wrapped line in that cell read un-shifted — a cosmetic offset, and
// the alternative it replaced was that cell not parsing at all, which made one
// BL1999 the whole notebook's payload. A cell whose definition a later cell superseded gets a
// one-line BLANK range — its own text is not in the assembly at all, so no
// span can land inside it and nothing fans out, while it still occupies a
// distinct line so no two cells' windows ever overlap. Everything below consumes
// only that array: pure coordinate arithmetic, no knowledge of how the
// compiler arrived at the layout.

/** The compiler's synthetic wrapper binding for a bare-expression cell
 *  (`let __cellK = `, k = the 0-based cell index) — an implementation detail
 *  of the assembly, never a hover/completion/lens candidate.
 *
 *  A cell that MIXES declarations with bare expressions takes one wrapper per
 *  expression, numbered `__cellK_j`; only the single-expression cell keeps the
 *  bare `__cellK` spelling. Both shapes are equally synthetic and both have to
 *  be filtered, or a mixed cell grows phantom hovers and completions. */
const SYNTHETIC_NAME_RE = /^__cell\d+(_\d+)?$/;

/** Shift a span's `line`/`endLine` (whichever are present) into `win`'s
 *  cell-local coordinate system — `win.startLine` (1-based, inclusive)
 *  becomes local line 1. Columns are untouched by cell splicing EXCEPT on a
 *  wrapped cell's `win.wrapLine` (the line the compiler prepended a synthetic
 *  `let __cellK = ` to — see the windows contract above), where they shift
 *  back by `win.wrapCol`. Every other field (severity/message/name/args/ret/params/
 *  deducedComm/...) passes through unchanged. */
function shiftSpan(span, win) {
  const out = Object.assign({}, span);
  if (win.wrapLine !== undefined) {
    if (out.line === win.wrapLine && out.col !== undefined) out.col = Math.max(1, out.col - win.wrapCol);
    if (out.endLine === win.wrapLine && out.endCol !== undefined) out.endCol = Math.max(1, out.endCol - win.wrapCol);
  }
  if (out.line !== undefined) out.line = out.line - win.startLine + 1;
  if (out.endLine !== undefined) out.endLine = out.endLine - win.startLine + 1;
  return out;
}

/** True when 1-based `line` falls inside window `[win.startLine, win.endLine]`. */
function lineInWindow(win, line) {
  return line >= win.startLine && line <= win.endLine;
}

/** True when a span (`{line, endLine}` — `endLine` defaults to `line` for a
 *  point span like a kernel's `{line, col}`) falls ENTIRELY inside `win` —
 *  the "no cross-cell entries" rule references[]/calls[] share. */
function spanFullyInWindow(win, span) {
  const start = span.line;
  const end = span.endLine !== undefined ? span.endLine : span.line;
  return start !== undefined && lineInWindow(win, start) && lineInWindow(win, end);
}

/**
 * Remap ONE `checkCells` response to `windows[cellIndex]`'s cell-local
 * coordinates — the fan-out step: `applyCheckPayload(cellDoc,
 * remapPayloadForCell(payload, windows, i))` is what actually lights up
 * hovers/completions/diagnostics/lenses in a cell, because every provider in
 * extension.js reads the per-doc caches that call fills.
 *
 * Per-field rules (the plan's frozen remap contract):
 *  - every shifted span: on a WRAPPED cell (the compiler's synthetic
 *    `let __cellK = ` prefix), columns on the wrapped line shift back by
 *    the prefix length (shiftSpan); `__cellK` bindings/references are
 *    filtered out entirely — the wrapper is an implementation detail.
 *  - diagnostics: kept only when FULLY inside the window, line/endLine shifted.
 *  - bindings: def line INSIDE the window -> kept, shifted. Def line from an
 *    EARLIER cell -> kept but CLAMPED to `{line:1, col:1}` and tagged
 *    `_foreign: true` (it's in scope reading top-to-bottom; clamping to line
 *    1 makes lookupBinding's nearest-line-at-or-before heuristic in
 *    extension.js treat it as declared before anything in this cell, so
 *    hovers/completions resolve it — but see the codeLensProvider's
 *    `_foreign` skip below for why it must NOT also grow a lens). Def line
 *    from a LATER cell -> dropped (not yet in scope, top-to-bottom). Every
 *    other field (params/ret/deducedComm/providerRead/doc/...) passes
 *    through untouched.
 *  - references/calls: kept only when FULLY inside the window (both a
 *    reference's def AND every one of its uses), shifted — an entry that
 *    straddles a cell boundary is dropped wholesale rather than partially
 *    remapped, so F12 across cells is a documented v1 limitation.
 *  - kernels: point span (`{line, col}`, no end) — kept when `line` is
 *    inside the window, shifted.
 *  - providers: passed through UNSHIFTED — provider lookups are name-keyed,
 *    not position-keyed (see cacheProviders' `_loadText` comment in
 *    extension.js for why its line-based cache-merging staying imperfect
 *    inside cells is an accepted v1 limitation).
 */
function remapPayloadForCell(payload, windows, cellIndex) {
  const win = windows[cellIndex];

  const diagnostics = (payload.diagnostics || [])
    .filter((d) => spanFullyInWindow(win, d))
    .map((d) => shiftSpan(d, win));

  const bindings = [];
  for (const b of payload.bindings || []) {
    // A synthetic `__cellK` wrapper binding (the compiler's bare-expression
    // wrap) is an implementation detail — never a hover/completion/lens
    // candidate in ANY cell.
    if (b.name && SYNTHETIC_NAME_RE.test(b.name)) continue;
    const line = b.line || 1;
    if (lineInWindow(win, line)) {
      bindings.push(shiftSpan(b, win));
    } else if (line < win.startLine) {
      bindings.push(Object.assign({}, b, { line: 1, col: 1, _foreign: true }));
    }
    // line > win.endLine (a later cell): not yet in scope top-to-bottom — dropped.
  }

  const notSynthetic = (e) => !(e.name && SYNTHETIC_NAME_RE.test(e.name));

  const referenceFullyInWindow = (e) =>
    e.def && spanFullyInWindow(win, e.def) && (e.uses || []).every((u) => spanFullyInWindow(win, u));
  const references = (payload.references || []).filter(notSynthetic).filter(referenceFullyInWindow).map((e) =>
    Object.assign({}, e, {
      def: shiftSpan(e.def, win),
      uses: (e.uses || []).map((u) => shiftSpan(u, win)),
    })
  );

  const calls = (payload.calls || []).filter((c) => spanFullyInWindow(win, c)).map((c) => shiftSpan(c, win));

  const kernels = (payload.kernels || [])
    .filter((k) => k.line !== undefined && lineInWindow(win, k.line))
    .map((k) => shiftSpan(k, win));

  return Object.assign({}, payload, {
    diagnostics,
    bindings,
    references,
    calls,
    kernels,
    providers: payload.providers || [],
    // A parse failure is a property of the ASSEMBLED source, not of any one
    // cell: the compiler answers zero bindings for the whole notebook and a
    // single diagnostic wherever the parse stopped. Every OTHER cell's
    // window therefore holds no diagnostic and no bindings — indistinguishable
    // from an empty cell — so the verdict has to be carried across the
    // remap rather than re-derived from the slice. extension.js's
    // applyCheckPayload reads this to keep that cell's last-good hovers
    // instead of blanking every cell in the notebook over one bad line.
    _parseFailure:
      (payload.bindings || []).length === 0 && (payload.diagnostics || []).length > 0,
  });
}

// notebook URI string -> debounce Timeout, mirroring extension.js's
// fastTimers (same setting: blade.fastCheckDebounceMs, same
// blade.liveChecking gate).
const checkTimers = new Map();

function clearCheckTimer(key) {
  const t = checkTimers.get(key);
  if (t) {
    clearTimeout(t);
    checkTimers.delete(key);
  }
}

/** The `file` argument a fast check needs — the compiler chdirs to its
 *  directory per request, so relative provider paths resolve the same way
 *  they do for the terminal REPL / "Blade: Run File" (see notebookCwd
 *  above). A saved notebook uses its own path; an untitled notebook has
 *  none, so it gets a synthetic `untitled.blade` under the first workspace
 *  folder — with no workspace open at all there's nowhere safe to chdir to,
 *  and the check is skipped entirely (see runNotebookCheck). */
function fileForCheckSource(notebookDoc) {
  if (notebookDoc.uri.scheme === "file") return notebookDoc.uri.fsPath;
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) return undefined;
  return path.join(folders[0].uri.fsPath, "untitled.blade");
}

/**
 * Run one fast `checkCells` for `notebookDoc` — every code cell's source, in
 * notebook order, assembled and checked compiler-side — and fan the response
 * out to those same cells via applyCheckPayload, using the `windows` it
 * answers with. Version-guarded like extension.js's checkDocument: if ANY
 * code cell's document changed while the request was in flight, the WHOLE
 * response is dropped (it no longer describes what's on screen) — the
 * debounce that triggered this call will fire again for whatever edit
 * invalidated it.
 */
async function runNotebookCheck(notebookDoc) {
  if (serve.available() === "no") return;
  const cells = notebookDoc.getCells();
  const codeCells = cells.filter((c) => c.kind === vscode.NotebookCellKind.Code);
  if (codeCells.length === 0) return;
  const file = fileForCheckSource(notebookDoc);
  if (!file) return; // untitled notebook, no workspace to anchor a synthetic path — skip

  const versions = codeCells.map((c) => c.document.version);
  const sources = codeCells.map((c) => c.document.getText());

  let payload;
  try {
    payload = await serve.checkCells(file, sources, "fast");
  } catch (_) {
    // Best-effort, and this is also where an old compiler lands: it answers
    // `{"error": "unknown cmd 'checkCells'"}`, serve.js rejects with
    // protocolError, and the notebook goes unchecked. extension.js's own
    // fast/full clocks already surface serve-availability problems in the
    // output channel; no need to repeat that here for every open notebook.
    return;
  }
  if (codeCells.some((c, i) => c.document.version !== versions[i])) return;
  // No windows = nothing says where any cell's text landed, so there is no
  // honest fan-out to do (a compiler answering `check`-shaped payloads to
  // `checkCells` would otherwise remap every span against garbage).
  const windows = payload && payload.windows;
  if (!Array.isArray(windows)) return;

  codeCells.forEach((cell, i) => {
    if (windows[i]) deps.applyCheckPayload(cell.document, remapPayloadForCell(payload, windows, i));
  });
}

function scheduleNotebookCheck(notebookDoc) {
  if (!vscode.workspace.getConfiguration("blade").get("liveChecking", true)) return;
  const key = notebookDoc.uri.toString();
  clearCheckTimer(key);
  const delay = vscode.workspace.getConfiguration("blade").get("fastCheckDebounceMs", 300);
  checkTimers.set(
    key,
    setTimeout(() => {
      checkTimers.delete(key);
      runNotebookCheck(notebookDoc).catch(() => {});
    }, delay)
  );
}

/** The open blade-notebook (and its cell) owning cell document `doc`, or
 *  undefined. Cell TextDocuments carry no back-pointer to their notebook, so
 *  this scans `vscode.workspace.notebookDocuments` — something none of
 *  extension.js's own providers ever need, since they only ever see `file`
 *  documents. */
function findOwningNotebookAndCell(doc) {
  const key = doc.uri.toString();
  for (const nb of vscode.workspace.notebookDocuments || []) {
    if (nb.notebookType !== NOTEBOOK_TYPE) continue;
    for (const cell of nb.getCells()) {
      if (cell.document.uri.toString() === key) return { notebookDoc: nb, cell };
    }
  }
  return undefined;
}

/** onDidChangeTextDocument handler for notebook CELL documents specifically
 *  — extension.js's own handler ignores these (checkDocument gates on
 *  `scheme !== "file"`). Markdown cells (languageId "markdown", never
 *  "blade") are excluded by the languageId check alone; the `checkCells`
 *  request wouldn't have carried their text anyway. */
function onCellDocumentChanged(doc) {
  if (doc.uri.scheme !== "vscode-notebook-cell" || doc.languageId !== "blade") return;
  const hit = findOwningNotebookAndCell(doc);
  if (hit) scheduleNotebookCheck(hit.notebookDoc);
}

function cleanupNotebook(notebookDoc) {
  const key = notebookDoc.uri.toString();
  const client = clients.get(key);
  if (client) client.dispose();
  clients.delete(key);
  sessionStates.delete(key);
  unsupported.delete(key);
  clearCheckTimer(key);
}

// --- Commands ------------------------------------------------------------------

async function commandNewNotebook() {
  const data = new vscode.NotebookData([new vscode.NotebookCellData(vscode.NotebookCellKind.Code, "", "blade")]);
  const doc = await vscode.workspace.openNotebookDocument(NOTEBOOK_TYPE, data);
  await vscode.window.showNotebookDocument(doc);
}

/** "Blade: Open as Notebook" — takes the ACTIVE `.blade` editor's text
 *  (unsaved edits included) and opens it as an untitled blade-notebook,
 *  split by the exact same marker rules the serializer uses (no markers =
 *  one cell). Does not touch the original text editor. */
async function commandOpenAsNotebook() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== "blade") return;
  const data = textToNotebookData(editor.document.getText());
  const doc = await vscode.workspace.openNotebookDocument(NOTEBOOK_TYPE, data);
  await vscode.window.showNotebookDocument(doc);
}

async function commandRestart() {
  const editor = vscode.window.activeNotebookEditor;
  if (!editor || editor.notebook.notebookType !== NOTEBOOK_TYPE) return;
  await resetNotebookSession(editor.notebook);
}

// --- Activation ---------------------------------------------------------------

function init(context, dependencies) {
  deps = dependencies;

  context.subscriptions.push(
    vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, serializer, { transientOutputs: true })
  );

  const controller = vscode.notebooks.createNotebookController(
    "blade-notebook-kernel",
    NOTEBOOK_TYPE,
    "Blade"
  );
  controller.supportedLanguages = ["blade"];
  controller.supportsExecutionOrder = true;
  controller.executeHandler = executeHandler;
  controller.interruptHandler = interruptHandler;

  context.subscriptions.push(
    controller,
    vscode.commands.registerCommand("blade.newNotebook", commandNewNotebook),
    vscode.commands.registerCommand("blade.openAsNotebook", commandOpenAsNotebook),
    vscode.commands.registerCommand("blade.notebookRestart", commandRestart),
    vscode.workspace.onDidCloseNotebookDocument(cleanupNotebook),
    // N3: session-aware IDE features. "once when a notebook opens" (see
    // runNotebookCheck) plus every subsequent code cell edit
    // (onCellDocumentChanged) — both funnel through the same debounced
    // scheduleNotebookCheck.
    vscode.workspace.onDidOpenNotebookDocument((nb) => {
      if (nb.notebookType === NOTEBOOK_TYPE) scheduleNotebookCheck(nb);
    }),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length > 0) onCellDocumentChanged(e.document);
    })
  );
}

/** Kill every dedicated notebook process and drop all session bookkeeping —
 *  extension deactivate(). */
function dispose() {
  for (const client of clients.values()) client.dispose();
  clients.clear();
  sessionStates.clear();
  unsupported.clear();
  for (const t of checkTimers.values()) clearTimeout(t);
  checkTimers.clear();
}

module.exports = { init, dispose };

// Headless test surface (scripts/notebook-test.js) — mirrors extension.js's
// own module.exports._test convention.
module.exports._test = {
  NOTEBOOK_TYPE,
  parseCells,
  serializeCells,
  markdownBodyFromLines,
  markdownLinesFromBody,
  textToNotebookData,
  notebookDataToText,
  serializer,
  formatBinding,
  formatDiagnosticLine,
  displayOutput,
  assembleOutputs,
  applyEvalResult,
  executeCell,
  executeHandler,
  interruptHandler,
  resetNotebookSession,
  cleanupNotebook,
  clientFor,
  sessionStateFor,
  clients,
  sessionStates,
  unsupported,
  commandNewNotebook,
  commandOpenAsNotebook,
  commandRestart,
  // Session-aware IDE features (N3).
  shiftSpan,
  lineInWindow,
  spanFullyInWindow,
  remapPayloadForCell,
  fileForCheckSource,
  runNotebookCheck,
  scheduleNotebookCheck,
  findOwningNotebookAndCell,
  onCellDocumentChanged,
  checkTimers,
  clearCheckTimer,
  setDeps: (d) => {
    deps = d;
  },
};
