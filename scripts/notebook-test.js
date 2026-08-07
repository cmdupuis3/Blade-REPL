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
  await testRejectedWithDiagnostics();
  await testRejectedSingleDiagnosticNoTrailingOutput();
  await testGppLaneBadge();
  await testWarningDiagnosticsOnKept();
  await testStderrOutput();

  testRemapUnshiftsWrappedLineColumns();
  testRemapFanOut();

  testInterruptMarksReplay();
  await testRestartClearsStateWithoutLiveClient();

  if (failures) {
    console.error(`\n${failures} notebook check(s) failed.`);
    process.exit(1);
  }
  console.log("\nOK — notebook serializer + output assembly contract holds.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
