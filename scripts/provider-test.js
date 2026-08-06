// Hermetic tests for the navigation providers (workstream 2), code actions
// (workstream 3), and type lenses (workstream 4) added to src/extension.js —
// driven through scripts/vscode-mock.js with CANNED check payloads fed via
// _test.applyCheckPayload, exactly like a real serve/one-shot check response
// would be applied. No compiler, no VS Code host: added to `npm test` (see
// package.json) right after check-consistency.js.
//
// Why canned payloads: the compiler doesn't emit `references[]` yet (a
// concurrent, separate workstream owns that) — this is how navigation gets
// verified before that lands. Everything here that CAN be exercised without
// references[] (code actions, lenses, the flat outline fallback) is also
// exactly what `npm run test:serve` / manual F5 testing would exercise live
// once the compiler side ships.

"use strict";

const vscodeMock = require("./vscode-mock");
const mock = vscodeMock.install();
const { makeDoc } = vscodeMock;
const ext = require("../src/extension");
const _test = ext._test;

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

// --- Fixture helpers -----------------------------------------------------------

/** The 0-based char index of `word`'s `occurrence`-th WORD-BOUNDARY match on
 *  `lineText` (so a single-letter name like "x" doesn't match inside a
 *  longer word like "Int64" — it can't here, but "f" inside "function"
 *  definitely would with a plain substring search). */
function findWordCol(lineText, word, occurrence) {
  const re = new RegExp(`\\b${word}\\b`, "g");
  let m;
  let count = 0;
  while ((m = re.exec(lineText))) {
    count++;
    if (count === occurrence) return m.index;
  }
  throw new Error(`word ${JSON.stringify(word)} occurrence ${occurrence} not found in ${JSON.stringify(lineText)}`);
}

/** A 1-based {line,col,endLine,endCol} span (references[]/calls[]
 *  convention) for `word`'s `occurrence`-th (default 1) appearance on
 *  `lines`' 1-based `line1`. */
function spanOfWord(lines, line1, word, occurrence) {
  const col0 = findWordCol(lines[line1 - 1], word, occurrence || 1);
  return { line: line1, col: col0 + 1, endLine: line1, endCol: col0 + 1 + word.length };
}

/** Apply a WorkspaceEdit's recorded {range, newText} ops (mock.WorkspaceEdit
 *  .get(uri)) to `text`, in reverse-document order so earlier edits don't
 *  invalidate later positions — lets a test assert the EXACT resulting text
 *  instead of just inspecting raw op ingredients. */
function applyOps(text, ops) {
  const lines = text.split("\n");
  const sorted = ops.slice().sort((a, b) => {
    if (a.range.start.line !== b.range.start.line) return b.range.start.line - a.range.start.line;
    return b.range.start.character - a.range.start.character;
  });
  for (const op of sorted) {
    const { start, end } = op.range;
    if (start.line === end.line) {
      const line = lines[start.line];
      lines[start.line] = line.slice(0, start.character) + op.newText + line.slice(end.character);
    } else {
      const startPart = lines[start.line].slice(0, start.character);
      const endPart = lines[end.line].slice(end.character);
      lines.splice(start.line, end.line - start.line + 1, startPart + op.newText + endPart);
    }
  }
  return lines.join("\n");
}

// A single shared diagnostics collection + no-op output channel — the same
// two objects activate() would install, wired in via the existing
// setOutput/setDiagnostics test hooks so applyCheckPayload works headlessly.
const diagCollection = mock.languages.createDiagnosticCollection("blade");
_test.setOutput({ appendLine() {} });
_test.setDiagnostics(diagCollection);

// --- 1. Definition / references / rename over a shadowed name ---------------

function testNavigationShadowing() {
  const text = ["let x = 1", "function f(x: Int64) -> Int64 = x"].join("\n");
  const lines = text.split("\n");
  const doc = makeDoc(text, "shadow.blade");

  const outerDef = spanOfWord(lines, 1, "x", 1);
  const paramDef = spanOfWord(lines, 2, "x", 1); // "function f(x: ..." — the param name
  const paramUse = spanOfWord(lines, 2, "x", 2); // "... = x" — the body use

  const references = [
    { name: "x", kind: "value", def: outerDef, uses: [] },
    { name: "x", kind: "param", def: paramDef, uses: [paramUse] },
  ];
  _test.applyCheckPayload(doc, { bindings: [], references });

  const usePos = new mock.Position(paramUse.line - 1, paramUse.col - 1);

  const defLoc = _test.definitionProvider.provideDefinition(doc, usePos);
  check(
    "definition from inner use resolves to the INNER (param) def, not the outer let",
    !!defLoc && defLoc.range.start.line === paramDef.line - 1 && defLoc.range.start.character === paramDef.col - 1,
    defLoc && defLoc.range
  );

  const refs = _test.referenceProvider.provideReferences(doc, usePos, { includeDeclaration: true });
  check("references from inner use = only the inner entry's use + def (2 locations)", !!refs && refs.length === 2, refs);

  const prepared = _test.renameProvider.prepareRename(doc, usePos);
  check(
    "prepareRename returns the range under the cursor (the use, not the def)",
    prepared.start.line === paramUse.line - 1 && prepared.start.character === paramUse.col - 1,
    prepared
  );

  const renameEdit = _test.renameProvider.provideRenameEdits(doc, usePos, "renamed");
  const ops = renameEdit.get(doc.uri);
  check("rename edit set covers exactly def + use (2 ops)", ops.length === 2, ops);
  const applied = applyOps(text, ops);
  check(
    "rename edit result text is exact",
    applied === "let x = 1\nfunction f(renamed: Int64) -> Int64 = renamed",
    applied
  );

  let threw = false;
  try {
    _test.renameProvider.provideRenameEdits(doc, usePos, "comm");
  } catch (e) {
    threw = true;
  }
  check("rename rejects a keyword collision (comm)", threw);

  threw = false;
  try {
    _test.renameProvider.prepareRename(doc, new mock.Position(0, 0));
  } catch (e) {
    threw = true;
  }
  check("prepareRename rejects a position with no tracked binder", threw);
}

// --- 2. Outline: nested (references present) vs. flat (references absent) --

function testOutline() {
  const text = [
    "function f(a: Int64, b: Int64) -> Int64 = {",
    "    let c = a + b",
    "    c",
    "}",
    "let d = 5",
  ].join("\n");
  const lines = text.split("\n");

  const fDef = spanOfWord(lines, 1, "f", 1);
  const aDef = spanOfWord(lines, 1, "a", 1);
  const bDef = spanOfWord(lines, 1, "b", 1);
  const aUse = spanOfWord(lines, 2, "a", 1);
  const bUse = spanOfWord(lines, 2, "b", 1);
  const cDef = spanOfWord(lines, 2, "c", 1);
  const cUse = spanOfWord(lines, 3, "c", 1);
  const dDef = spanOfWord(lines, 5, "d", 1);

  const references = [
    { name: "f", kind: "function", def: fDef, uses: [] },
    { name: "a", kind: "param", def: aDef, uses: [aUse] },
    { name: "b", kind: "param", def: bDef, uses: [bUse] },
    { name: "c", kind: "local", def: cDef, uses: [cUse] },
    { name: "d", kind: "value", def: dDef, uses: [] },
  ];
  const bindings = [
    {
      name: "f", kind: "function", line: 1, col: fDef.col,
      params: [{ name: "a", type: "Int64" }, { name: "b", type: "Int64" }],
      ret: "Int64", where: [],
    },
    { name: "d", kind: "value", line: 5, col: dDef.col, type: "Int64" },
  ];

  const doc = makeDoc(text, "outline_nested.blade");
  _test.applyCheckPayload(doc, { bindings, references });
  const outline = _test.documentSymbolProvider.provideDocumentSymbols(doc);

  check("nested outline: 2 top-level symbols (f, d)", outline.length === 2, outline.map((s) => s.name));
  const fSym = outline.find((s) => s.name === "f");
  const dSym = outline.find((s) => s.name === "d");
  check("f is a Function symbol", !!fSym && fSym.kind === mock.SymbolKind.Function);
  check(
    "f has 3 nested children in source order: a, b, c",
    !!fSym && fSym.children.map((c) => c.name).join(",") === "a,b,c",
    fSym && fSym.children.map((c) => c.name)
  );
  check(
    "param children use TypeParameter kind, the local uses Variable",
    !!fSym &&
      fSym.children[0].kind === mock.SymbolKind.TypeParameter &&
      fSym.children[1].kind === mock.SymbolKind.TypeParameter &&
      fSym.children[2].kind === mock.SymbolKind.Variable
  );
  check("d is a top-level Variable symbol with no children", !!dSym && dSym.kind === mock.SymbolKind.Variable && dSym.children.length === 0);

  // Flat fallback: identical bindings, but references[] empty — the path a
  // compiler without references[] exercises today.
  const doc2 = makeDoc(text, "outline_flat.blade");
  _test.applyCheckPayload(doc2, { bindings, references: [] });
  const flat = _test.documentSymbolProvider.provideDocumentSymbols(doc2);
  const fFlat = flat.find((s) => s.name === "f");
  check("flat fallback: still lists f and d", flat.some((s) => s.name === "f") && flat.some((s) => s.name === "d"), flat.map((s) => s.name));
  check("flat fallback: f has NO nested children (no scope info without references[])", !!fFlat && fFlat.children.length === 0, fFlat && fFlat.children);
}

// --- 3. arrowNotation (pure renderer) ----------------------------------------

function testArrowNotation() {
  const { arrowNotation } = _test;
  check(
    "single index: Array<Float64 like Idx<3>>",
    arrowNotation("Array<Float64 like Idx<3>>") === "Idx<3> -> Float64",
    arrowNotation("Array<Float64 like Idx<3>>")
  );
  check(
    "two-index `like` form",
    arrowNotation("Array<Float64 like Idx<2>, Idx<3>>") === "Idx<2> -> Idx<3> -> Float64",
    arrowNotation("Array<Float64 like Idx<2>, Idx<3>>")
  );
  check(
    "pretty-printer form (no `like`)",
    arrowNotation("Array<Float64, Idx<3>, Idx<3>>") === "Idx<3> -> Idx<3> -> Float64",
    arrowNotation("Array<Float64, Idx<3>, Idx<3>>")
  );
  check(
    "SymIdx form",
    arrowNotation("Array<Float64 like SymIdx<2, 32>>") === "SymIdx<2, 32> -> Float64",
    arrowNotation("Array<Float64 like SymIdx<2, 32>>")
  );
  check("non-array returns null", arrowNotation("Int64") === null);
  check("empty string returns null", arrowNotation("") === null);
}

// --- 4. Pin insertion: function w/o where, function w/ where, lambda --------

function testPinInsertionCodeActions() {
  // (a) function header, no existing where — pin lands right after the
  // close paren, before the return-type arrow.
  {
    const text = "function g(a: Int64, b: Int64) -> Int64 = a + b";
    const doc = makeDoc(text, "pin_a.blade");
    const bindings = [
      {
        name: "g", kind: "function", line: 1, col: 10,
        params: [{ name: "a", type: "Int64" }, { name: "b", type: "Int64" }],
        ret: "Int64", where: [], deducedComm: ["comm(a, b)"],
      },
    ];
    _test.applyCheckPayload(doc, { bindings, kernels: [] });
    const range = new mock.Range(0, 0, 0, text.length);
    const actions = _test.codeActionProvider.provideCodeActions(doc, range, { diagnostics: [] });
    const action = actions.find((a) => a.title === "Pin deduced comm(a, b)");
    check("pin action offered (no existing where)", !!action, actions.map((a) => a.title));
    check("kind is RefactorRewrite (no overlapping diagnostic)", action.kind === mock.CodeActionKind.RefactorRewrite);
    const applied = applyOps(text, action.edit.get(doc.uri));
    check(
      "no-where pin: exact result text",
      applied === "function g(a: Int64, b: Int64) where comm(a, b) -> Int64 = a + b",
      applied
    );
  }

  // (b) function header with an existing where — appended after the last
  // conjunct. A BL4010 diagnostic overlapping the range makes it a QuickFix.
  {
    const text = "function h(a: Int64, b: Int64) where mpi -> Int64 = a + b";
    const doc = makeDoc(text, "pin_b.blade");
    const bindings = [
      {
        name: "h", kind: "function", line: 1, col: 10,
        params: [{ name: "a", type: "Int64" }, { name: "b", type: "Int64" }],
        ret: "Int64", where: ["mpi"], deducedComm: ["comm(a, b)"],
      },
    ];
    _test.applyCheckPayload(doc, { bindings, kernels: [] });
    const range = new mock.Range(0, 0, 0, text.length);
    const diag = new mock.Diagnostic(range, "deduced comm", mock.DiagnosticSeverity.Warning);
    diag.code = "BL4010";
    const actions = _test.codeActionProvider.provideCodeActions(doc, range, { diagnostics: [diag] });
    const action = actions.find((a) => a.title === "Pin deduced comm(a, b)");
    check("pin action offered (existing where)", !!action, actions.map((a) => a.title));
    check("kind is QuickFix (BL4010 overlaps the range)", action.kind === mock.CodeActionKind.QuickFix);
    check("QuickFix action carries the overlapping diagnostics", !!action.diagnostics && action.diagnostics.length === 1);
    const applied = applyOps(text, action.edit.get(doc.uri));
    check(
      "existing-where pin: exact result text (appended after last conjunct)",
      applied === "function h(a: Int64, b: Int64) where mpi comm(a, b) -> Int64 = a + b",
      applied
    );
  }

  // (c) lambda header — pin lands before the body arrow.
  {
    const text = "let k = lambda(a, b) -> a * b";
    const lines = text.split("\n");
    const doc = makeDoc(text, "pin_c.blade");
    const lambdaCol = spanOfWord(lines, 1, "lambda", 1).col;
    const kernels = [{ line: 1, col: lambdaCol, params: ["a", "b"], deducedComm: ["comm(a, b)"], declaredWhere: [] }];
    _test.applyCheckPayload(doc, { bindings: [], kernels });
    const range = new mock.Range(0, 0, 0, text.length);
    const actions = _test.codeActionProvider.provideCodeActions(doc, range, { diagnostics: [] });
    const action = actions.find((a) => a.title === "Pin deduced comm(a, b)");
    check("pin action offered (lambda)", !!action, actions.map((a) => a.title));
    const applied = applyOps(text, action.edit.get(doc.uri));
    check(
      "lambda pin: exact result text (before the body arrow)",
      applied === "let k = lambda(a, b) where comm(a, b) -> a * b",
      applied
    );
  }

  // Annotate deduced rank: cursor/range on the unannotated param gets the
  // "Annotate deduced rank: T^k" action; an already-annotated param doesn't.
  {
    const text = "function r(v: Array<Float64 like Idx<3>>, s) -> Int64 = 0";
    const lines = text.split("\n");
    const doc = makeDoc(text, "rank.blade");
    const bindings = [
      {
        name: "r", kind: "function", line: 1, col: 10,
        params: [{ name: "v", type: "Array<Float64 like Idx<3>>" }, { name: "s", type: "Int64" }],
        ret: "Int64", where: [],
        deducedComm: [],
      },
    ];
    _test.applyCheckPayload(doc, { bindings, kernels: [] });
    // Fake minRanks the way bindingMinRanks would read them off b.params.
    bindings[0].params[1].minRank = 2;
    const sCol = spanOfWord(lines, 1, "s", 1);
    const sRange = new mock.Range(0, sCol.col - 1, 0, sCol.endCol - 1);
    const actions = _test.codeActionProvider.provideCodeActions(doc, sRange, { diagnostics: [] });
    const rankAction = actions.find((a) => a.title === "Annotate deduced rank: T^2");
    check("rank action offered on the unannotated param under the cursor", !!rankAction, actions.map((a) => a.title));
    const applied = applyOps(text, rankAction.edit.get(doc.uri));
    check(
      "rank annotation inserted right after the param name",
      applied === "function r(v: Array<Float64 like Idx<3>>, s: T^2) -> Int64 = 0",
      applied
    );

    const vCol = spanOfWord(lines, 1, "v", 1);
    const vRange = new mock.Range(0, vCol.col - 1, 0, vCol.endCol - 1);
    const actionsOnAnnotated = _test.codeActionProvider.provideCodeActions(doc, vRange, { diagnostics: [] });
    check(
      "no rank action on an already-annotated param",
      !actionsOnAnnotated.some((a) => a.title.startsWith("Annotate deduced rank")),
      actionsOnAnnotated.map((a) => a.title)
    );
  }
}

// The deduction lens's command args must reproduce the SAME edit the code
// action offers, and running blade.pinDeduction through them must produce
// the identical resulting text.
async function testPinDeductionCommandMatchesAction() {
  const text = "function g(a: Int64, b: Int64) -> Int64 = a + b";
  const doc = makeDoc(text, "pin_lens.blade");
  const bindings = [
    {
      name: "g", kind: "function", line: 1, col: 10,
      params: [{ name: "a", type: "Int64" }, { name: "b", type: "Int64" }],
      ret: "Int64", where: [], deducedComm: ["comm(a, b)"],
    },
  ];
  _test.applyCheckPayload(doc, { bindings, kernels: [] });
  mock.workspace._config["blade.deductionLens"] = true;
  mock.workspace._config["blade.signatureLens.functions"] = false;
  mock.workspace._config["blade.signatureLens.arrays"] = false;

  const lenses = _test.codeLensProvider.provideCodeLenses(doc);
  check("exactly one deduction lens", lenses.length === 1, lenses.map((l) => l.command && l.command.title));
  const lens = lenses[0];
  check(
    "lens title (no cells: no literal-extent group to count)",
    lens.command.title === "deduced comm(a, b) · symmetric storage — pin",
    lens.command.title
  );
  check("lens command is blade.pinDeduction", lens.command.command === "blade.pinDeduction");

  const [uriString, position, insertText] = lens.command.arguments;
  await _test.pinDeductionCommand(uriString, position, insertText);
  const applied = mock.workspace._appliedEdits[mock.workspace._appliedEdits.length - 1];
  const resultText = applyOps(text, applied.get(doc.uri));
  check(
    "pinDeductionCommand's applied edit matches the code action's result exactly",
    resultText === "function g(a: Int64, b: Int64) where comm(a, b) -> Int64 = a + b",
    resultText
  );
}

// --- 5. Deduction lens cell counts + omission --------------------------------

function testDeductionLensCells() {
  {
    const text =
      "function cov(A: Array<Float64 like Idx<32>, Idx<32>>, B: Array<Float64 like Idx<32>, Idx<32>>) -> Array<Float64 like Idx<32>, Idx<32>> = A";
    const doc = makeDoc(text, "cells.blade");
    const bindings = [
      {
        name: "cov", kind: "function", line: 1, col: 10,
        params: [
          { name: "A", type: "Array<Float64 like Idx<32>, Idx<32>>" },
          { name: "B", type: "Array<Float64 like Idx<32>, Idx<32>>" },
        ],
        ret: "Array<Float64 like Idx<32>, Idx<32>>",
        where: [], deducedComm: ["comm(A, B)"],
      },
    ];
    _test.applyCheckPayload(doc, { bindings, kernels: [] });
    mock.workspace._config["blade.deductionLens"] = true;
    mock.workspace._config["blade.signatureLens.functions"] = false;
    mock.workspace._config["blade.signatureLens.arrays"] = false;
    const lenses = _test.codeLensProvider.provideCodeLenses(doc);
    check("cells lens present", lenses.length === 1, lenses);
    check(
      "cells lens text: SymIdx<2,32> = 528 vs 1024 cells",
      lenses[0].command.title === "deduced comm(A, B) · symmetric storage: 528 vs 1024 cells — pin",
      lenses[0].command.title
    );
  }
  {
    // anticomm: strict-triangular wording, C(n, r) instead of C(n+r-1, r).
    const text =
      "function anti(A: Array<Float64 like Idx<32>, Idx<32>>, B: Array<Float64 like Idx<32>, Idx<32>>) -> Array<Float64 like Idx<32>, Idx<32>> = A";
    const doc = makeDoc(text, "cells_anti.blade");
    const bindings = [
      {
        name: "anti", kind: "function", line: 1, col: 10,
        params: [
          { name: "A", type: "Array<Float64 like Idx<32>, Idx<32>>" },
          { name: "B", type: "Array<Float64 like Idx<32>, Idx<32>>" },
        ],
        ret: "Array<Float64 like Idx<32>, Idx<32>>",
        where: [], deducedComm: ["anticomm(A, B)"],
      },
    ];
    _test.applyCheckPayload(doc, { bindings, kernels: [] });
    const lenses = _test.codeLensProvider.provideCodeLenses(doc);
    check(
      "anticomm cells lens: strict-triangular storage, C(32,2) = 496",
      lenses[0].command.title === "deduced anticomm(A, B) · strict-triangular storage: 496 vs 1024 cells — pin",
      lenses[0].command.title
    );
  }
  {
    // Non-literal extent: cells segment omitted entirely.
    const text =
      "function cov2(A: Array<Float64 like Idx<n>, Idx<n>>, B: Array<Float64 like Idx<n>, Idx<n>>) -> Array<Float64 like Idx<n>, Idx<n>> = A";
    const doc = makeDoc(text, "cells_none.blade");
    const bindings = [
      {
        name: "cov2", kind: "function", line: 1, col: 10,
        params: [
          { name: "A", type: "Array<Float64 like Idx<n>, Idx<n>>" },
          { name: "B", type: "Array<Float64 like Idx<n>, Idx<n>>" },
        ],
        ret: "Array<Float64 like Idx<n>, Idx<n>>",
        where: [], deducedComm: ["comm(A, B)"],
      },
    ];
    _test.applyCheckPayload(doc, { bindings, kernels: [] });
    const lenses = _test.codeLensProvider.provideCodeLenses(doc);
    check(
      "non-literal extent: cells segment omitted",
      lenses[0].command.title === "deduced comm(A, B) · symmetric storage — pin",
      lenses[0].command.title
    );
  }
}

// --- 6. Function/array signature lenses + settings gate ----------------------

function testSignatureLenses() {
  const text = [
    "function add(a: Int64, b: Int64) -> Int64 = a + b",
    "let arr: Array<Float64 like Idx<3>> = [1.0, 2.0, 3.0]",
  ].join("\n");
  const doc = makeDoc(text, "sig_lenses.blade");
  const bindings = [
    { name: "add", kind: "function", line: 1, col: 10, params: [{ name: "a", type: "Int64" }, { name: "b", type: "Int64" }], ret: "Int64", where: [] },
    { name: "arr", kind: "value", line: 2, col: 5, type: "Array<Float64 like Idx<3>>" },
  ];
  _test.applyCheckPayload(doc, { bindings, kernels: [] });
  mock.workspace._config["blade.signatureLens.functions"] = true;
  mock.workspace._config["blade.signatureLens.arrays"] = true;
  mock.workspace._config["blade.deductionLens"] = false;

  const lenses = _test.codeLensProvider.provideCodeLenses(doc);
  const addLens = lenses.find((l) => l.range.start.line === 0);
  const arrLens = lenses.find((l) => l.range.start.line === 1);
  check("function signature lens text", !!addLens && addLens.command.title === "add : Int64 -> Int64 -> Int64", addLens && addLens.command.title);
  check("function signature lens is non-clickable (empty command id)", !!addLens && addLens.command.command === "");
  check("array signature lens text (index-arrow notation)", !!arrLens && arrLens.command.title === "arr : Idx<3> -> Float64", arrLens && arrLens.command.title);

  mock.workspace._config["blade.signatureLens.functions"] = false;
  mock.workspace._config["blade.signatureLens.arrays"] = false;
  const none = _test.codeLensProvider.provideCodeLenses(doc);
  check("both signature lenses disabled by settings yields none", none.length === 0, none);
}

// --- 7. Diagnostic doc links --------------------------------------------------

function testDiagnosticDocLinks() {
  const { diagnosticCode, diagnosticCodeValue } = _test;
  const known = diagnosticCode("BL4010");
  check(
    "known BL-code (BL4010) upgrades to {value,target}",
    typeof known === "object" && known.value === "BL4010" && known.target instanceof mock.Uri,
    known
  );
  const unknown = diagnosticCode("BL0001");
  check("unknown BL-code stays a plain string", unknown === "BL0001", unknown);
  check("diagnosticCodeValue unwraps the {value,target} form", diagnosticCodeValue({ code: known }) === "BL4010");
  check("diagnosticCodeValue passes a plain string through", diagnosticCodeValue({ code: "BL0001" }) === "BL0001");

  const doc = makeDoc("let x: Int64 = 1\n", "diag.blade");
  _test.applyCheckPayload(doc, {
    bindings: [], kernels: [],
    diagnostics: [{ line: 1, col: 1, endLine: 1, endCol: 2, message: "deduced comm", severity: "warning", code: "BL4010" }],
  });
  const stored = diagCollection.get(doc.uri);
  check(
    "end-to-end: jsonToDiagnostics upgrades a BL4010 diagnostic's code",
    !!stored && stored[0] && typeof stored[0].code === "object" && stored[0].code.value === "BL4010",
    stored && stored[0] && stored[0].code
  );
}

// --- 8. Hover shadowing fix ----------------------------------------------------

function testHoverShadowing() {
  const text = ["let x = 1", "function f(x: Int64) -> Int64 = x", "function g() -> Int64 = x"].join("\n");
  const lines = text.split("\n");
  const doc = makeDoc(text, "hover_shadow.blade");

  const outerDef = spanOfWord(lines, 1, "x", 1);
  const paramDef = spanOfWord(lines, 2, "x", 1);
  const gUse = spanOfWord(lines, 3, "x", 1);

  const references = [
    { name: "x", kind: "value", def: outerDef, uses: [gUse] },
    { name: "x", kind: "param", def: paramDef, uses: [spanOfWord(lines, 2, "x", 2)] },
  ];
  const bindings = [
    { name: "x", kind: "value", line: 1, col: outerDef.col, type: "Int64" },
    {
      name: "f", kind: "function", line: 2, col: spanOfWord(lines, 2, "f", 1).col,
      params: [{ name: "x", type: "Float64" }], ret: "Int64", where: [],
    },
    // f's OWN param x — a distinct binder from the outer value, deliberately
    // given a DIFFERENT type so the two are distinguishable in assertions.
    { name: "x", kind: "param", line: 2, col: paramDef.col, type: "Float64" },
    { name: "g", kind: "function", line: 3, col: spanOfWord(lines, 3, "g", 1).col, params: [], ret: "Int64", where: [] },
  ];
  _test.applyCheckPayload(doc, { bindings, references });

  const pos = new mock.Position(gUse.line - 1, gUse.col - 1);

  const heuristicOnly = _test.lookupBinding(doc, "x", pos.line);
  check(
    "sanity: the nearest-line heuristic ALONE mispicks f's param (Float64) for g's use",
    !!heuristicOnly && heuristicOnly.type === "Float64",
    heuristicOnly
  );

  const precise = _test.lookupBindingPrecise(doc, "x", pos);
  check(
    "fix: references-based resolution picks the correct outer binding (Int64)",
    !!precise && precise.type === "Int64",
    precise
  );

  const hover = _test.hoverProvider.provideHover(doc, pos);
  const md = hover && hover.contents[0].value;
  check("hover on g's use reflects the correct (Int64) binding, not Float64", !!md && md.includes("Int64") && !md.includes("Float64"), md);
}

// --- 9. Activation smoke test --------------------------------------------------

function testActivationSmoke() {
  const ctx = { subscriptions: [] };
  let threw;
  try {
    ext.activate(ctx);
  } catch (e) {
    threw = e;
  }
  check("activate() does not throw", !threw, threw && threw.stack);
  check("activate() registers subscriptions", ctx.subscriptions.length > 0, ctx.subscriptions.length);
  check("blade.pinDeduction is registered as a command", mock.commands._registry.has("blade.pinDeduction"));
  ext.deactivate();
}

// --- Run ------------------------------------------------------------------------

(async () => {
  testNavigationShadowing();
  testOutline();
  testArrowNotation();
  testPinInsertionCodeActions();
  await testPinDeductionCommandMatchesAction();
  testDeductionLensCells();
  testSignatureLenses();
  testDiagnosticDocLinks();
  testHoverShadowing();
  testActivationSmoke();

  if (failures) {
    console.error(`\n${failures} provider check(s) failed.`);
    process.exitCode = 1;
  } else {
    console.log("\nOK — provider contract holds against canned payloads.");
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
