// Hermetic tests for src/notebook.js (workstream 5): the marker-format
// serializer's round-trip (pure core, no vscode) and the vscode-shaped
// adapter, plus output assembly from CANNED eval responses driven through a
// real (mock) NotebookCellExecution — exactly like scripts/provider-test.js
// drives canned check payloads through the real providers. No compiler, no
// VS Code host: added to `npm test` (see package.json) right after
// provider-test.js.

"use strict";

const vscodeMock = require("./vscode-mock");
const mock = vscodeMock.install();
const nb = require("../src/notebook");
const _test = nb._test;
// Live plot streams: the frame bus a cell animates from, and the stream
// primitives src/notebook.js shares with the Blade Plots panel.
const display = require("@blade-lang/ide-protocol").display;
const plots = require("../src/plots");
// N3 (session-aware IDE features) fans a remapped check payload out through
// extension.js's OWN applyCheckPayload/hoverProvider/codeLensProvider — the
// same real providers scripts/provider-test.js drives with canned payloads —
// so the remap contract is exercised end-to-end, not just as isolated data
// transforms.
const ext = require("../src/extension");
const extTest = ext._test;
const diagCollectionForNb = mock.languages.createDiagnosticCollection("blade");
extTest.setOutput({ appendLine() {} });
extTest.setDiagnostics(diagCollectionForNb);

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.error(`FAIL ${name}`);
    if (detail !== undefined) console.error(`  ${JSON.stringify(detail)}`);
  }
}

function textOf(item) {
  return Buffer.from(item.data).toString("utf8");
}
function jsonOf(item) {
  return JSON.parse(textOf(item));
}

// --- 1. Pure parseCells/serializeCells round-trip ----------------------------

function testPureRoundTrip() {
  // Every case here already carries exactly one trailing newline, so
  // byte-identical round-trip is the right assertion (serializeCells always
  // normalizes to exactly one trailing "\n" — see testEmptyFile/
  // testNoTrailingNewline below for the cases where that normalization
  // deliberately changes the byte count while keeping cell CONTENT lossless).
  const cases = [
    "let x = 1\n",
    "let x = 1\nlet y = 2\n",
    "// %% [markdown] Notes\n// # Title\n// body line\n// %%\nlet b = 2\n",
    "// %% Intro\nlet x = 1\n",
  ];
  for (const text of cases) {
    const cells = _test.parseCells(text);
    const back = _test.serializeCells(cells);
    check(`pure round-trip: ${JSON.stringify(text.slice(0, 30))}`, back === text, { text, back });
  }
}

// --- 2. textToNotebookData / notebookDataToText (marker <-> cells) ----------

function testMarkersToCells() {
  const text = ["let xs = [1.0, 2.0, 3.0]", "// %%", "reduce(xs, (+))"].join("\n") + "\n";
  const data = _test.textToNotebookData(text);
  check("2 cells", data.cells.length === 2, data.cells);
  check("cell0 is Code", data.cells[0].kind === mock.NotebookCellKind.Code, data.cells[0].kind);
  check("cell0 value verbatim", data.cells[0].value === "let xs = [1.0, 2.0, 3.0]", data.cells[0].value);
  check("cell0 languageId blade", data.cells[0].languageId === "blade", data.cells[0].languageId);
  check("cell1 value verbatim", data.cells[1].value === "reduce(xs, (+))", data.cells[1].value);
  check("cell0 has no title metadata", !data.cells[0].metadata, data.cells[0].metadata);

  const back = _test.notebookDataToText(data);
  check("markers<->cells full round-trip", back === text, { text, back });
}

function testTitles() {
  const text = "// %% Intro\nlet x = 1\n// %% Second cell\nlet y = 2\n";
  const data = _test.textToNotebookData(text);
  check("titled cell0 metadata.title", data.cells[0].metadata && data.cells[0].metadata.title === "Intro", data.cells[0].metadata);
  check("titled cell1 metadata.title", data.cells[1].metadata && data.cells[1].metadata.title === "Second cell", data.cells[1].metadata);
  const back = _test.notebookDataToText(data);
  check("titles round-trip", back === text, { text, back });
}

function testMarkdownCells() {
  const text = ["let a = 1", "// %% [markdown] Notes", "// # Title", "//", "// body line", "// %%", "let b = 2"].join("\n") + "\n";
  const data = _test.textToNotebookData(text);
  check("3 cells", data.cells.length === 3, data.cells.length);
  check("cell1 is Markup", data.cells[1].kind === mock.NotebookCellKind.Markup, data.cells[1].kind);
  check(
    "markdown value has // stripped, blank line preserved",
    data.cells[1].value === "# Title\n\nbody line",
    data.cells[1].value
  );
  check("markdown languageId", data.cells[1].languageId === "markdown", data.cells[1].languageId);
  check("markdown title", data.cells[1].metadata && data.cells[1].metadata.title === "Notes", data.cells[1].metadata);

  const back = _test.notebookDataToText(data);
  check("markdown round-trip", back === text, { text, back });
}

function testNoLeadingMarker() {
  const text = "let x = 1\nlet y = 2\n";
  const data = _test.textToNotebookData(text);
  check("no markers = exactly one cell", data.cells.length === 1, data.cells.length);
  check("whole file is the cell's value", data.cells[0].value === "let x = 1\nlet y = 2", data.cells[0].value);
  check("no-marker round-trip", _test.notebookDataToText(data) === text, _test.notebookDataToText(data));
}

function testNoTrailingNewline() {
  const text = "let x = 1"; // no trailing \n at all
  const data = _test.textToNotebookData(text);
  check("no-trailing-newline: one cell", data.cells.length === 1, data.cells.length);
  check(
    "no-trailing-newline: cell CONTENT is lossless (only the file's trailing newline is normalized)",
    data.cells[0].value === "let x = 1",
    data.cells[0].value
  );
  check(
    "re-serializing normalizes to exactly one trailing newline",
    _test.notebookDataToText(data) === "let x = 1\n",
    _test.notebookDataToText(data)
  );
}

function testEmptyFile() {
  const data = _test.textToNotebookData("");
  check("empty file: exactly one cell", data.cells.length === 1, data.cells.length);
  check("empty file: cell value is empty string", data.cells[0].value === "", data.cells[0].value);
  check("empty file: kind is Code", data.cells[0].kind === mock.NotebookCellKind.Code, data.cells[0].kind);
}

// --- 3. Output assembly from canned eval responses ---------------------------

function makeExecution() {
  const controller = mock.notebooks.createNotebookController("t", "blade-notebook", "Test");
  const cell = { document: vscodeMock.makeDoc("let x = 1", "cell0.blade") };
  return controller.createNotebookCellExecution(cell);
}

async function testKeptWithBindingAndStdout() {
  const execution = makeExecution();
  const state = { keptSources: [] };
  const resp = {
    kept: true,
    exitCode: 0,
    lane: "interp",
    elapsedMs: 3,
    stdout: "hello\n",
    stderr: "",
    bindings: [{ name: "x", type: "Int64", value: "1" }],
    diagnostics: [],
  };
  await _test.applyEvalResult(execution, resp, "let x = 1", state);

  check("kept: source pushed to keptSources", state.keptSources.length === 1 && state.keptSources[0] === "let x = 1", state.keptSources);
  check("kept: execution ended successfully", execution._success === true, execution._success);
  check("kept: 2 outputs (stdout + binding)", execution._outputs.length === 2, execution._outputs.length);
  check("kept: stdout output text", textOf(execution._outputs[0].items[0]) === "hello\n", execution._outputs[0]);
  check("kept: binding text label", textOf(execution._outputs[1].items[0]) === "x = 1 : Int64", textOf(execution._outputs[1].items[0]));
  check(
    "kept: binding has parallel application/x-blade-value+json item",
    execution._outputs[1].items[1].mime === "application/x-blade-value+json",
    execution._outputs[1].items[1]
  );
  check(
    "kept: json item carries the raw binding object",
    JSON.stringify(jsonOf(execution._outputs[1].items[1])) === JSON.stringify(resp.bindings[0]),
    jsonOf(execution._outputs[1].items[1])
  );
}

async function testBareExpressionEcho() {
  const execution = makeExecution();
  const state = { keptSources: [] };
  const resp = {
    kept: true,
    exitCode: 0,
    lane: "interp",
    elapsedMs: 1,
    stdout: "",
    stderr: "",
    bindings: [{ name: "", type: "Int64", value: "2" }],
    diagnostics: [],
  };
  await _test.applyEvalResult(execution, resp, "1 + 1", state);
  check("bare expr: no stdout output emitted", execution._outputs.length === 1, execution._outputs.length);
  check("bare expr: label omits 'name ='", textOf(execution._outputs[0].items[0]) === "2 : Int64", textOf(execution._outputs[0].items[0]));
}

// A function declaration binds a NAME with a signature but no value. The echo
// must drop the ` = ` rather than render an empty one -- `covariance =  : (..)`
// was what a `function` cell actually showed in the notebook.
async function testFunctionDeclEcho() {
  const execution = makeExecution();
  const state = { keptSources: [] };
  const resp = {
    kept: true,
    exitCode: 0,
    lane: "interp",
    elapsedMs: 1,
    stdout: "",
    stderr: "",
    bindings: [{ name: "covariance", type: "(Array<Float64 like Idx<_>>) -> Float64", value: "" }],
    diagnostics: [],
  };
  await _test.applyEvalResult(execution, resp, "function covariance(x: U^1) = 0.0", state);
  check(
    "function decl: label omits the empty ' = '",
    textOf(execution._outputs[0].items[0]) === "covariance : (Array<Float64 like Idx<_>>) -> Float64",
    textOf(execution._outputs[0].items[0])
  );
}

async function testRejectedWithDiagnostics() {
  const execution = makeExecution();
  const state = { keptSources: [] };
  const resp = {
    kept: false,
    exitCode: 1,
    lane: "interp",
    elapsedMs: 1,
    stdout: "",
    stderr: "",
    bindings: [],
    diagnostics: [
      { line: 1, col: 5, endLine: 1, endCol: 8, severity: "error", message: "type mismatch", code: "BL2001" },
      { line: 1, col: 12, endLine: 1, endCol: 14, severity: "error", message: "second problem", code: "BL2002" },
    ],
  };
  await _test.applyEvalResult(execution, resp, 'let x: Int64 = "no"', state);

  check("rejected: session unchanged (nothing kept)", state.keptSources.length === 0, state.keptSources);
  check("rejected: execution ended unsuccessfully", execution._success === false, execution._success);
  check("rejected: 2 outputs (error + remaining diagnostics)", execution._outputs.length === 2, execution._outputs.length);
  check(
    "rejected: error output carries the FIRST diagnostic's bare message",
    jsonOf(execution._outputs[0].items[0]).message === "type mismatch",
    jsonOf(execution._outputs[0].items[0])
  );
  check(
    "rejected: error output item mime is the notebook error mime",
    execution._outputs[0].items[0].mime === "application/vnd.code.notebook.error",
    execution._outputs[0].items[0].mime
  );
  check(
    "rejected: remaining diagnostics formatted cell-local line:col message",
    textOf(execution._outputs[1].items[0]) === "1:12 second problem",
    textOf(execution._outputs[1].items[0])
  );
}

async function testRejectedSingleDiagnosticNoTrailingOutput() {
  const execution = makeExecution();
  const state = { keptSources: [] };
  const resp = { kept: false, exitCode: 1, diagnostics: [{ line: 2, col: 1, message: "oops" }] };
  await _test.applyEvalResult(execution, resp, "bad", state);
  check("single diagnostic: exactly one output (no empty remaining-list output)", execution._outputs.length === 1, execution._outputs.length);
}

async function testGppLaneBadge() {
  const execution = makeExecution();
  const state = { keptSources: [] };
  const resp = {
    kept: true,
    exitCode: 0,
    lane: "gpp",
    elapsedMs: 1200,
    stdout: "",
    stderr: "",
    bindings: [],
    diagnostics: [],
  };
  await _test.applyEvalResult(execution, resp, "compute(...)", state);
  check("gpp lane: exactly one output (the badge)", execution._outputs.length === 1, execution._outputs.length);
  check(
    "gpp lane: badge text",
    textOf(execution._outputs[0].items[0]) === "[compiled via g++ fallback]",
    textOf(execution._outputs[0].items[0])
  );
}

async function testWarningDiagnosticsOnKept() {
  const execution = makeExecution();
  const state = { keptSources: [] };
  const resp = {
    kept: true,
    exitCode: 0,
    lane: "interp",
    stdout: "",
    stderr: "",
    bindings: [{ name: "x", type: "Int64", value: "1" }],
    diagnostics: [{ line: 1, col: 1, severity: "warning", message: "unused binding" }],
  };
  await _test.applyEvalResult(execution, resp, "let x = 1", state);
  check("warning + binding: 2 outputs", execution._outputs.length === 2, execution._outputs.length);
  check(
    "warning output comes before the binding output",
    textOf(execution._outputs[0].items[0]) === "1:1 unused binding",
    textOf(execution._outputs[0].items[0])
  );
}

async function testStderrOutput() {
  const execution = makeExecution();
  const state = { keptSources: [] };
  const resp = { kept: true, exitCode: 0, lane: "interp", stdout: "", stderr: "warning: unused\n", bindings: [], diagnostics: [] };
  await _test.applyEvalResult(execution, resp, "let x = 1", state);
  check("stderr: one output", execution._outputs.length === 1, execution._outputs.length);
  check("stderr: item mime is the notebook stderr mime", execution._outputs[0].items[0].mime === "application/vnd.code.notebook.stderr", execution._outputs[0].items[0].mime);
  check("stderr: text preserved", textOf(execution._outputs[0].items[0]) === "warning: unused\n", textOf(execution._outputs[0].items[0]));
}

// --- 4. Interrupt/replay + restart bookkeeping (no live client needed) ------

function testInterruptMarksReplay() {
  const fakeUri = mock.Uri.parse("file:///nb.bladenb");
  const notebookDoc = { uri: fakeUri };
  const key = fakeUri.toString();
  const state = _test.sessionStateFor(key);
  state.keptSources.push("let x = 1");
  // No client ever created for this key — interruptHandler must be a no-op
  // on the "kill" side (nothing to kill) but still flip needsReplay.
  _test.interruptHandler(notebookDoc);
  check("interrupt with kept history sets needsReplay", state.needsReplay === true, state);

  _test.sessionStates.delete(key); // isolate from other tests reusing this uri
}

/** A transport-level eval rejection (timeout, spawn failure, process exit —
 *  any rejection WITHOUT the protocolError tag) means the protocol client
 *  tore the process down and the server-side session's bindings died with
 *  it. executeCell's catch must mark the session for replay exactly like
 *  interruptHandler does — otherwise the next cell runs against a fresh,
 *  EMPTY session and earlier cells' names come back unbound. Guarded the
 *  same way too: nothing kept yet = nothing to replay. */
async function testTransportFailureMarksReplay() {
  const fakeUri = mock.Uri.parse("file:///teardown.bladenb");
  const notebookDoc = { uri: fakeUri };
  const key = fakeUri.toString();
  const state = _test.sessionStateFor(key);
  const controller = mock.notebooks.createNotebookController("t-teardown", "blade-notebook", "Test");
  const cell = { document: vscodeMock.makeDoc("let y = x + 1", "cell1.blade") };
  // A canned dedicated client whose eval rejects the way the real one does
  // after sendRequest's timeout teardown: a plain Error, no protocolError.
  _test.clients.set(key, {
    eval: () => Promise.reject(new Error("blade ide serve: request 2 timed out after 5ms")),
    dispose() {},
  });

  await _test.executeCell(cell, notebookDoc, controller);
  check("transport failure with nothing kept: needsReplay stays false", state.needsReplay === false, state);

  state.keptSources.push("let x = 1");
  await _test.executeCell(cell, notebookDoc, controller);
  check("transport failure with kept history sets needsReplay", state.needsReplay === true, state);
  check("transport failure does not latch unsupported", !_test.unsupported.has(key), Array.from(_test.unsupported));
  const exec = controller._executions[1];
  check(
    "transport failure still fails the cell with an error output",
    exec._success === false && exec._outputs.length === 1,
    exec._outputs
  );

  _test.cleanupNotebook(notebookDoc);
}

/** The protocolError twin: a LIVE `{"error": ...}` answer (an old compiler
 *  that doesn't know "eval") is NOT a teardown — the process, and whatever
 *  session it holds, survived — so no replay must be scheduled; the notebook
 *  latches unsupported instead (executeCell's existing old-compiler path). */
async function testProtocolErrorDoesNotMarkReplay() {
  const fakeUri = mock.Uri.parse("file:///oldcompiler.bladenb");
  const notebookDoc = { uri: fakeUri };
  const key = fakeUri.toString();
  const state = _test.sessionStateFor(key);
  state.keptSources.push("let x = 1"); // history exists — the discriminator must be protocolError, not keptSources
  const err = new Error("unknown cmd 'eval'");
  err.protocolError = true;
  _test.clients.set(key, { eval: () => Promise.reject(err), dispose() {} });
  const controller = mock.notebooks.createNotebookController("t-oldcompiler", "blade-notebook", "Test");
  const cell = { document: vscodeMock.makeDoc("let y = 2", "cell2.blade") };

  await _test.executeCell(cell, notebookDoc, controller);
  check("protocol error does NOT set needsReplay (process alive, session intact)", state.needsReplay === false, state);
  check("protocol error latches unsupported", _test.unsupported.has(key), Array.from(_test.unsupported));

  _test.cleanupNotebook(notebookDoc);
}

async function testRestartClearsStateWithoutLiveClient() {
  const fakeUri = mock.Uri.parse("file:///restart.bladenb");
  const notebookDoc = { uri: fakeUri, notebookType: "blade-notebook" };
  const key = fakeUri.toString();
  const state = _test.sessionStateFor(key);
  state.keptSources.push("let x = 1");
  state.needsReplay = true;
  _test.unsupported.add(key);

  // No compiler in this process — deps.findCompiler would try to spawn
  // "Blade" and fail; resetNotebookSession is written to swallow that
  // (transport failure) and still clear local state. setDeps gives it a
  // findCompiler that fails fast instead of hitting PATH lookup latency.
  _test.setDeps({ findCompiler: () => "definitely-not-a-real-binary-xyz", output: { appendLine() {} } });
  await _test.resetNotebookSession(notebookDoc);

  check("restart clears keptSources even when the client can't connect", state.keptSources.length === 0, state.keptSources);
  check("restart clears needsReplay", state.needsReplay === false, state.needsReplay);

  _test.cleanupNotebook(notebookDoc);
  _test.sessionStates.delete(key);
}

/** docs/display-frames.md §10: a fresh compiler session restarts its
 *  `<SessionTag><ordinal>` id generation from scratch, so the per-session
 *  seen-frame-id set (assembleOutputs' replay-suppression filter) must reset
 *  right alongside keptSources/needsReplay — a stale seen-set after restart
 *  would wrongly treat a genuinely first-time post-restart frame as an
 *  already-shown replay and suppress it from the cell that produced it. */
async function testRestartClearsSeenFrameIds() {
  const fakeUri = mock.Uri.parse("file:///restart-seen.bladenb");
  const notebookDoc = { uri: fakeUri, notebookType: "blade-notebook" };
  const key = fakeUri.toString();
  const state = _test.sessionStateFor(key);
  state.seenFrameIds.add("S1");

  _test.setDeps({ findCompiler: () => "definitely-not-a-real-binary-xyz", output: { appendLine() {} } });
  await _test.resetNotebookSession(notebookDoc);

  check("restart clears the seen-frame-id set", state.seenFrameIds.size === 0, Array.from(state.seenFrameIds));

  // Functional check, not just bookkeeping: a frame carrying the SAME id as
  // before the restart must be attached again post-restart, not suppressed
  // as if it were a replay of the pre-restart run.
  const outputs = _test.assembleOutputs(
    {
      kept: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      bindings: [],
      diagnostics: [],
      display: [{ mime: "image/png", data: "AA==", meta: { id: "S1" } }],
    },
    state.seenFrameIds
  );
  check("restart: a pre-restart id is attached again post-restart, not suppressed", outputs.length === 1, outputs.length);

  _test.cleanupNotebook(notebookDoc);
  _test.sessionStates.delete(key);
}

// --- 5. Session-aware IDE features (N3): the checkCells remap contract ---
//
// Session assembly itself is the compiler's now (checkCells), so what is left
// to pin on this side is the coordinate arithmetic over the `windows` array
// it answers with: literal windows in, cell-local payloads out.

function testRemapUnshiftsWrappedLineColumns() {
  // The windows a `checkCells` response carries for two cells whose second is
  // a bare expression: cell 0 is a plain decl on line 1, cell 1 landed on
  // line 2 wrapped in the compiler's synthetic `let __cell1 = `.
  const prefixLen = "let __cell1 = ".length;
  const windows = [
    { startLine: 1, endLine: 1 },
    { startLine: 2, endLine: 2, wrapLine: 2, wrapCol: prefixLen },
  ];
  const payload = {
    diagnostics: [
      // As the compiler reports it: against the WRAPPED line, cols shifted
      // right by the prefix. `reduce(` is 7 chars, so `ys` starts at col 8
      // cell-locally = col 8 + prefixLen in the assembled source.
      { severity: "error", line: 2, col: 8 + prefixLen, endLine: 2, endCol: 10 + prefixLen, message: "Unbound variable: ys" },
    ],
    bindings: [
      { name: "xs", line: 1, col: 5 },
      { name: "__cell1", line: 2, col: 5 }, // the synthetic wrapper itself
    ],
    references: [{ name: "__cell1", kind: "value", def: { line: 2, col: 5, endLine: 2, endCol: 14 }, uses: [] }],
    calls: [],
    kernels: [{ line: 2, col: 1 + prefixLen }],
    providers: [],
  };
  const cell1 = _test.remapPayloadForCell(payload, windows, 1);
  check(
    "diagnostic columns on the wrapped line shift back to cell-local",
    cell1.diagnostics.length === 1 && cell1.diagnostics[0].line === 1 && cell1.diagnostics[0].col === 8 && cell1.diagnostics[0].endCol === 10,
    cell1.diagnostics
  );
  check(
    "the synthetic __cell binding never reaches any cell's payload",
    !cell1.bindings.some((b) => /^__cell\d+$/.test(b.name)),
    cell1.bindings
  );
  check(
    "the synthetic __cell reference entry is filtered too",
    cell1.references.length === 0,
    cell1.references
  );
  check(
    "kernel point spans on the wrapped line unshift as well",
    cell1.kernels.length === 1 && cell1.kernels[0].col === 1,
    cell1.kernels
  );
  const cell0 = _test.remapPayloadForCell(payload, windows, 0);
  check(
    "the synthetic binding is not offered as a foreign binding in other cells either",
    !cell0.bindings.some((b) => /^__cell\d+$/.test(b.name)),
    cell0.bindings
  );
}

function testRemapFiltersMixedCellWrappers() {
  // A cell mixing declarations with SEVERAL bare expressions takes one wrapper
  // per expression, numbered `__cellK_j`. The window still names only the
  // first wrap (one pair on the wire), but every wrapper is synthetic and has
  // to be filtered — `/^__cell\d+$/` matched none of them, so each one showed
  // up as a hover/completion candidate in the cell that owns it AND, via the
  // foreign-binding clamp, in every cell after it.
  const windows = [{ startLine: 1, endLine: 4, wrapLine: 2, wrapCol: "let __cell0_0 = ".length }];
  const payload = {
    diagnostics: [],
    bindings: [
      { name: "ma", line: 1, col: 5 },
      { name: "__cell0_0", line: 2, col: 5 },
      { name: "mb", line: 3, col: 5 },
      { name: "__cell0_1", line: 4, col: 5 },
    ],
    references: [{ name: "__cell0_1", kind: "value", def: { line: 4, col: 5, endLine: 4, endCol: 14 }, uses: [] }],
    calls: [],
    kernels: [],
    providers: [],
  };
  const cell0 = _test.remapPayloadForCell(payload, windows, 0);
  check(
    "every __cellK_j wrapper of a mixed cell is filtered out",
    !cell0.bindings.some((b) => /^__cell\d+(_\d+)?$/.test(b.name)),
    cell0.bindings
  );
  check(
    "the user's own bindings in a mixed cell survive the filter",
    JSON.stringify(cell0.bindings.map((b) => b.name)) === JSON.stringify(["ma", "mb"]),
    cell0.bindings
  );
  check("a __cellK_j reference entry is filtered too", cell0.references.length === 0, cell0.references);
}

// --- 6. Remap fan-out: canned checkCells payload, two cells ----------------

function testRemapFanOut() {
  // cell0 window [1,2] defines `helper`; cell1 window [3,4] uses it and
  // defines its own `answer`.
  const windows = [
    { startLine: 1, endLine: 2 },
    { startLine: 3, endLine: 4 },
  ];
  const payload = {
    tier: "fast",
    diagnostics: [
      { line: 1, col: 1, endLine: 1, endCol: 5, severity: "warning", message: "cell0 warning" },
      { line: 4, col: 3, endLine: 4, endCol: 6, severity: "error", message: "cell1 error" },
    ],
    bindings: [
      { name: "helper", type: "Int64", line: 1, col: 5, kind: "value" },
      { name: "answer", type: "Int64", line: 3, col: 5, kind: "value" },
    ],
    references: [
      {
        name: "helper",
        kind: "value",
        def: { line: 1, col: 5, endLine: 1, endCol: 11 },
        uses: [{ line: 3, col: 14, endLine: 3, endCol: 20 }], // used from cell1 -> straddles cells
      },
      {
        name: "answer",
        kind: "value",
        def: { line: 3, col: 5, endLine: 3, endCol: 11 },
        uses: [],
      },
    ],
    calls: [],
    kernels: [],
    providers: [{ store: "z", provider: "csv", path: "data/z.csv", line: 1 }],
  };

  const cell0 = _test.remapPayloadForCell(payload, windows, 0);
  const cell1 = _test.remapPayloadForCell(payload, windows, 1);

  check(
    "cell0 diagnostics: only its own warning, shifted to local line 1",
    cell0.diagnostics.length === 1 && cell0.diagnostics[0].line === 1 && cell0.diagnostics[0].message === "cell0 warning",
    cell0.diagnostics
  );
  check(
    "cell1 diagnostics: its own error, shifted to local line 2 (window starts at 3)",
    cell1.diagnostics.length === 1 && cell1.diagnostics[0].line === 2 && cell1.diagnostics[0].message === "cell1 error",
    cell1.diagnostics
  );

  check(
    "cell1 bindings: its own 'answer' shifted to local line 1, not foreign",
    cell1.bindings.some((b) => b.name === "answer" && b.line === 1 && !b._foreign),
    cell1.bindings
  );
  check(
    "cell1 bindings: earlier-cell 'helper' present, clamped to line 1 col 1 and tagged _foreign",
    cell1.bindings.some((b) => b.name === "helper" && b.line === 1 && b.col === 1 && b._foreign === true),
    cell1.bindings
  );
  check(
    "cell0 bindings: later-cell 'answer' absent (not yet in scope top-to-bottom)",
    !cell0.bindings.some((b) => b.name === "answer"),
    cell0.bindings
  );

  check(
    "cell1 references: its own 'answer' entry remaps inside the window",
    cell1.references.some((e) => e.name === "answer" && e.def.line === 1),
    cell1.references
  );
  check(
    "cell0 references: cross-cell 'helper' entry is dropped wholesale (def in cell0, use in cell1)",
    !cell0.references.some((e) => e.name === "helper"),
    cell0.references
  );
  check(
    "cell1 references: same cross-cell 'helper' entry is ALSO dropped (not partially remapped)",
    !cell1.references.some((e) => e.name === "helper"),
    cell1.references
  );

  check("providers pass through unshifted", cell0.providers.length === 1 && cell0.providers[0].line === 1, cell0.providers);

  // Hover: applying cell1's remapped payload to a real cell doc resolves the
  // foreign `helper` binding via lookupBinding's nearest-line-at-or-before
  // heuristic (clamped to line 1 beats "not found").
  const cellDoc1 = vscodeMock.makeDoc("let answer = helper + 1", "cell1.blade");
  extTest.applyCheckPayload(cellDoc1, cell1);
  const helperPos = new mock.Position(0, 14); // inside "helper"
  const hover = extTest.hoverProvider.provideHover(cellDoc1, helperPos);
  const md = hover && hover.contents[0].value;
  check("hover on the foreign 'helper' binding resolves it", !!md && md.includes("helper"), md);

  // Lens: the foreign binding must NOT grow a signature/array lens at the
  // top of cell1 — it would otherwise stack one for every earlier cell's
  // binding on top of every later cell's first line.
  const lenses = extTest.codeLensProvider.provideCodeLenses(cellDoc1);
  check(
    "foreign binding produces no lens in the later cell",
    !lenses.some((l) => l.command && l.command.title && l.command.title.startsWith("helper")),
    lenses.map((l) => l.command && l.command.title)
  );
}

// --- 6b. A parse failure anywhere blanks the WHOLE assembled payload -------

function testRemapCarriesParseFailureToEveryCell() {
  // What the compiler answers when the assembled notebook doesn't parse: no
  // bindings/references/calls/kernels at all, and ONE diagnostic wherever the
  // parse stopped — here in cell 1's window. Cell 0's window is untouched by
  // it and, judged on its own slice, is indistinguishable from an empty cell.
  const windows = [
    { startLine: 1, endLine: 2 },
    { startLine: 3, endLine: 4 },
  ];
  const payload = {
    tier: "fast",
    diagnostics: [{ line: 4, col: 17, endLine: 4, endCol: 18, severity: "error", message: "Expected ')' but got '^'" }],
    bindings: [],
    references: [],
    calls: [],
    kernels: [],
    providers: [],
  };

  const cell0 = _test.remapPayloadForCell(payload, windows, 0);
  const cell1 = _test.remapPayloadForCell(payload, windows, 1);

  check("the cell holding the parse error is flagged", cell1._parseFailure === true, cell1._parseFailure);
  check(
    "a cell with NO diagnostic of its own is flagged too — the failure is the notebook's",
    cell0._parseFailure === true,
    { diagnostics: cell0.diagnostics, flag: cell0._parseFailure }
  );
  check("the flagged cell still carries no diagnostic of its own", cell0.diagnostics.length === 0, cell0.diagnostics);

  // End-to-end: cell 0's hovers survive a parse error introduced in cell 1.
  const cellDoc0 = vscodeMock.makeDoc("let helper = 41", "pf_cell0.blade");
  extTest.applyCheckPayload(cellDoc0, {
    bindings: [{ name: "helper", kind: "value", line: 1, col: 5, type: "Int64" }],
    references: [],
    calls: [],
    kernels: [],
    providers: [],
    diagnostics: [],
  });
  const hoverHelper = () => {
    const h = extTest.hoverProvider.provideHover(cellDoc0, new mock.Position(0, 6));
    return h && h.contents[0].value;
  };
  check("baseline: cell 0 hovers `helper`", !!hoverHelper() && hoverHelper().includes("Int64"), hoverHelper());

  extTest.applyCheckPayload(cellDoc0, cell0);
  check(
    "cell 0 keeps its hover when cell 1 stops parsing",
    !!hoverHelper() && hoverHelper().includes("Int64"),
    hoverHelper()
  );

  // A payload with genuinely nothing to say (an empty notebook that parses)
  // must NOT be flagged — that would freeze stale bindings forever.
  const clean = _test.remapPayloadForCell(
    { diagnostics: [], bindings: [], references: [], calls: [], kernels: [], providers: [] },
    windows,
    0
  );
  check("a clean empty payload is not flagged", clean._parseFailure === false, clean._parseFailure);
  extTest.applyCheckPayload(cellDoc0, clean);
  check("and it DOES clear the cell's bindings", !hoverHelper() || !hoverHelper().includes("Int64"), hoverHelper());
}

// --- Live plot streams in a cell (plan-equivariant-nn-notebooks.md §4) -------
//
// A long cell (a training loop) emits `plot.stream` chunks while it runs. They
// reach the extension on the display bus — during an `ide serve` eval as
// out-of-band `{"event":"display", …}` NDJSON lines, which the protocol
// client publishes (@blade-lang/ide-protocol client.js: handleEvent →
// display.publish). An executing cell subscribes for the duration of its own
// eval and repaints from the accumulated series; the subscription dies in a
// finally, and NOTHING a stream produced is ever a persistent cell output.

function streamFrame(channel, data) {
  return display.decodeFrame({
    mime: plots.STREAM_MIME,
    data: Object.assign({ channel, epoch: -1, x: [], y: [] }, data || {}),
    meta: { id: channel, stream: true, backend: "plotly" },
  }).frame;
}

function streamOutputsOf(exec) {
  return exec._outputs.filter((o) => o.items.some((it) => it.mime === plots.STREAM_MIME));
}

function testStreamFramesNeverPersist() {
  // A stream frame that DOES reach an eval response's display[] (the lanes
  // with no sink; the serve lane is supposed to skip buffering these) must
  // not become a cell output, and must not enter seenFrameIds — the id is
  // stable per CHANNEL, so recording it would suppress every later frame of
  // that channel for the rest of the session.
  const seenFrameIds = new Set();
  const outputs = _test.assembleOutputs(
    {
      kept: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      bindings: [],
      diagnostics: [],
      display: [
        { mime: plots.STREAM_MIME, data: { channel: "loss", epoch: 0, x: [0], y: [1] }, meta: { id: "loss", stream: true } },
        { mime: "application/vnd.plotly.v1+json", data: { data: [], layout: {} }, meta: { id: "S1", title: "final" } },
      ],
    },
    seenFrameIds
  );
  check("stream frames are not persistent cell outputs", outputs.length === 1, outputs.length);
  check("the persistent output is the ordinary figure frame", outputs[0].items[0].mime === "application/vnd.plotly.v1+json", outputs[0].items[0].mime);
  check("a stream channel id never enters seenFrameIds", !seenFrameIds.has("loss") && seenFrameIds.has("S1"), Array.from(seenFrameIds));
}

async function testLiveStreamRepaintsAndUnsubscribes() {
  const controller = mock.notebooks.createNotebookController("t-live", "blade-notebook", "Test");
  const exec = controller.createNotebookCellExecution({ document: vscodeMock.makeDoc("train()", "cell0.blade") });
  const live = _test.startLiveStream(exec);

  display.publish(streamFrame("loss", { epoch: 0, x: [0, 1], y: [2, 1.8], title: "training loss", ylabel: "loss" }), "notebook");
  display.publish(streamFrame("loss", { epoch: 1, x: [2, 3], y: [1.5, 1.2] }), "notebook");
  // A non-stream frame belongs to the panel and to the cell's FINAL outputs —
  // the live animator must ignore it entirely.
  display.publish(display.decodeFrame({ mime: "application/vnd.plotly.v1+json", data: { data: [], layout: {} }, meta: { id: "S1" } }).frame, "notebook");

  live.flush();
  const shown = streamOutputsOf(exec);
  check("live: one output per streaming channel", exec._outputs.length === 1 && shown.length === 1, exec._outputs.length);
  const figure = jsonOf(shown[0].items[0]);
  check("live: the cell shows the ACCUMULATED series, not the last chunk", figure.data[0].x.join(",") === "0,1,2,3", figure.data[0].x);
  check("live: epoch boundaries are drawn", (figure.layout.shapes || []).length === 2, figure.layout.shapes);
  check("live: figure keeps the program's labels", figure.layout.title.text === "training loss" && figure.layout.yaxis.title.text === "loss", figure.layout);
  check("live: a text/plain summary rides along for hosts with no renderer", shown[0].items[1].mime === "text/plain", shown[0].items.map((i) => i.mime));
  check("live: repainted once for the burst", live.repaints() === 1, live.repaints());

  // A replayed run (same channel, starting over) rebuilds instead of doubling.
  display.publish(streamFrame("loss", { epoch: 0, x: [0, 1], y: [2, 1.8] }), "notebook");
  live.flush();
  check("live: a replayed run resets the accumulator", jsonOf(streamOutputsOf(exec)[0].items[0]).data[0].x.join(",") === "0,1", jsonOf(streamOutputsOf(exec)[0].items[0]).data[0].x);

  // Two channels, two outputs.
  display.publish(streamFrame("accuracy", { epoch: 0, x: [0], y: [0.1] }), "notebook");
  live.flush();
  check("live: a second channel gets its own output", streamOutputsOf(exec).length === 2, exec._outputs.length);

  // Disposed: the subscription is gone and a late chunk changes nothing.
  live.dispose();
  const repaintsAtDispose = live.repaints();
  display.publish(streamFrame("loss", { epoch: 9, x: [99], y: [0] }), "notebook");
  live.flush();
  await new Promise((r) => setTimeout(r, 5));
  check("live: dispose unsubscribes — a later chunk is not accumulated", live.channels.get("loss").x.indexOf(99) === -1, live.channels.get("loss").x.slice(-3));
  check("live: and no repaint happens after dispose", live.repaints() === repaintsAtDispose, [repaintsAtDispose, live.repaints()]);
}

async function testExecuteCellAnimatesThenPersists() {
  const fakeUri = mock.Uri.parse("file:///stream.bladenb");
  const notebookDoc = { uri: fakeUri };
  const key = fakeUri.toString();
  const state = _test.sessionStateFor(key);
  const controller = mock.notebooks.createNotebookController("t-stream", "blade-notebook", "Test");
  const cell = { document: vscodeMock.makeDoc("train()", "cell0.blade") };
  _test.setLiveStreamIntervalMs(0); // trailing timer fires on the next tick

  let midRun = null;
  _test.clients.set(key, {
    eval: async () => {
      // The compiler streams while the eval is still in flight.
      const exec = controller._executions[controller._executions.length - 1];
      display.publish(streamFrame("loss", { epoch: 0, x: [0, 1], y: [2, 1.8] }), "notebook");
      display.publish(streamFrame("loss", { epoch: 1, x: [2, 3], y: [1.5, 1.2] }), "notebook");
      await new Promise((r) => setTimeout(r, 5));
      midRun = exec._outputs.slice();
      // …and the run ends with the ordinary figure frame that PERSISTS.
      return {
        kept: true,
        exitCode: 0,
        stdout: "",
        stderr: "",
        bindings: [],
        diagnostics: [],
        display: [{ mime: "application/vnd.plotly.v1+json", data: { data: [], layout: {} }, meta: { id: "loss-final", title: "training loss" } }],
      };
    },
    dispose() {},
  });

  await _test.executeCell(cell, notebookDoc, controller);
  const exec = controller._executions[controller._executions.length - 1];

  check("executeCell: the cell animated WHILE the eval was in flight", !!midRun && midRun.some((o) => o.items.some((it) => it.mime === plots.STREAM_MIME)), midRun && midRun.length);
  check("executeCell: the mid-run figure held the accumulated series",
    jsonOf(midRun.find((o) => o.items.some((it) => it.mime === plots.STREAM_MIME)).items[0]).data[0].x.join(",") === "0,1,2,3");
  check("executeCell: the final outputs carry no stream output", streamOutputsOf(exec).length === 0, exec._outputs.map((o) => o.items[0].mime));
  check("executeCell: the persistent chart is the ordinary figure frame",
    exec._outputs.some((o) => o.items[0].mime === "application/vnd.plotly.v1+json"),
    exec._outputs.map((o) => o.items[0].mime));
  check("executeCell: the cell succeeded", exec._success === true, exec._success);
  check("executeCell: no stream channel polluted seenFrameIds", !state.seenFrameIds.has("loss") && state.seenFrameIds.has("loss-final"), Array.from(state.seenFrameIds));

  // The subscription died with the execution: a stray late chunk must not
  // repaint a finished cell.
  const after = exec._outputs.slice();
  display.publish(streamFrame("loss", { epoch: 9, x: [99], y: [0] }), "notebook");
  await new Promise((r) => setTimeout(r, 5));
  check("executeCell: a chunk after the run does not touch the finished cell", exec._outputs.length === after.length && streamOutputsOf(exec).length === 0, exec._outputs.length);

  _test.setLiveStreamIntervalMs(500);
  _test.cleanupNotebook(notebookDoc);
}

// --- Zoom-to-recompute helpers (docs/plot-zoom-reeval.md) ----------------------

function testBladeFloat() {
  check("bladeFloat: integers gain a point", _test.bladeFloat(2) === "2.0");
  check("bladeFloat: negative integers too", _test.bladeFloat(-1) === "-1.0");
  check("bladeFloat: round-trip decimals pass through", _test.bladeFloat(-0.743643887037151) === "-0.743643887037151");
  check("bladeFloat: bare exponent gains a point", _test.bladeFloat(1e-14) === "1.0e-14", _test.bladeFloat(1e-14));
  check("bladeFloat: pointed exponent untouched", _test.bladeFloat(7.8125e-17) === "7.8125e-17", _test.bladeFloat(7.8125e-17));
}

function testRewriteCameraSource() {
  const src = [
    "// the camera",
    "let cam_cx = -0.743643887037151",
    "let cam_cy = 0.131825904205330   // seahorse",
    "let cam_r = 0.004",
    "let unrelated = 7",
  ].join("\n");
  const { text, replaced } = _test.rewriteCameraSource(src, ["cam_cx", "cam_cy", "cam_r"], [-0.75, 0.13, 1e-14]);
  const lines = text.split("\n");
  check("rewrite: all three bindings replaced", replaced.size === 3, [...replaced]);
  check("rewrite: value replaced in place", lines[1] === "let cam_cx = -0.75", lines[1]);
  check("rewrite: trailing comment preserved", lines[2] === "let cam_cy = 0.13   // seahorse", lines[2]);
  check("rewrite: exponent value is lexically a Float", lines[3] === "let cam_r = 1.0e-14", lines[3]);
  check("rewrite: unrelated binding untouched", lines[4] === "let unrelated = 7", lines[4]);
  const miss = _test.rewriteCameraSource("let other = 1", ["cam_cx", "cam_cy", "cam_r"], [1, 2, 3]);
  check("rewrite: missing bindings reported, text unchanged", miss.replaced.size === 0 && miss.text === "let other = 1");
}

function testRecordZoomTargets() {
  _test.zoomTargets.clear();
  const cell = { index: 4, notebook: { uri: { toString: () => "nb://one" } } };
  const camFrame = {
    meta: { id: "mandel-view" },
    data: { layout: { blade_camera: { bindings: "a,b,c" } } },
  };
  const plainFrame = { meta: { id: "plain" }, data: { layout: {} } };
  _test.recordZoomTargets({ cell }, [camFrame, plainFrame]);
  check("zoom targets: camera frame recorded with its cell", (() => {
    const t = _test.zoomTargets.get("mandel-view");
    return !!t && t.key === "nb://one" && t.cellIndex === 4;
  })(), _test.zoomTargets.get("mandel-view"));
  check("zoom targets: plain frame not recorded", !_test.zoomTargets.has("plain"));
  // The hermetic mock executions carry no real cell — recording tolerates that.
  _test.recordZoomTargets({}, [camFrame]);
  _test.recordZoomTargets(undefined, [camFrame]);
  check("zoom targets: cell-less executions tolerated", _test.zoomTargets.size === 1, _test.zoomTargets.size);
  _test.zoomTargets.clear();
}

// --- Run -----------------------------------------------------------------------

(async () => {
  testPureRoundTrip();
  testMarkersToCells();
  testTitles();
  testMarkdownCells();
  testNoLeadingMarker();
  testNoTrailingNewline();
  testEmptyFile();

  await testKeptWithBindingAndStdout();
  await testBareExpressionEcho();
  await testFunctionDeclEcho();
  await testRejectedWithDiagnostics();
  await testRejectedSingleDiagnosticNoTrailingOutput();
  await testGppLaneBadge();
  await testWarningDiagnosticsOnKept();
  await testStderrOutput();

  testRemapUnshiftsWrappedLineColumns();
  testRemapFiltersMixedCellWrappers();
  testRemapFanOut();
  testRemapCarriesParseFailureToEveryCell();

  testInterruptMarksReplay();
  await testTransportFailureMarksReplay();
  await testProtocolErrorDoesNotMarkReplay();
  await testRestartClearsStateWithoutLiveClient();
  await testRestartClearsSeenFrameIds();

  testStreamFramesNeverPersist();
  await testLiveStreamRepaintsAndUnsubscribes();
  await testExecuteCellAnimatesThenPersists();

  testBladeFloat();
  testRewriteCameraSource();
  testRecordZoomTargets();

  if (failures) {
    console.error(`\n${failures} notebook check(s) failed.`);
    process.exit(1);
  }
  console.log("\nOK — notebook serializer + output assembly contract holds.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
