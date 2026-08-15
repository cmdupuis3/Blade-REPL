// Cross-seam integration test for workstream 2 (navigation): drives a REAL
// `blade ide check --json` payload for samples/demo.blade through the REAL
// extension providers (via scripts/vscode-mock.js), instead of the canned
// payloads scripts/provider-test.js uses. That script proves the extension's
// containment math is internally consistent; scripts/serve-protocol-test.js
// proves the compiler's serve protocol frames correctly. Neither one proves
// the two sides agree on the actual coordinate contract (1-based, endCol
// EXCLUSIVE) for a real file — this script is that missing seam.
//
// Needs the compiler binary (BLADE_EXE env var, else the newest local
// Release/Debug build — same discovery as scripts/serve-protocol-test.js), so
// this is NOT part of the hermetic `npm test`; run it with `npm run test:nav`.
// A compiler whose `ide check --json` payload has no `references[]` array
// (older compiler; the references emitter is a separate, concurrent
// workstream) is an expected SKIP (exit 0), not a failure.

"use strict";

const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const pkg = require("@blade-lang/ide-protocol");

function findExe() {
  // env BLADE_EXE -> newest-mtime DEFAULT_CANDIDATES -> "Blade" on PATH, now
  // shared with src/extension.js and every other script via the package.
  // origin "path" means nothing better was found — still fatal here: these
  // live suites want a known, freshly-built binary, not whatever "Blade"
  // resolves to on $PATH.
  const { exe, origin } = pkg.resolveCompiler({ env: process.env });
  if (origin === "path") {
    console.error("no compiler binary found — set BLADE_EXE");
    process.exit(1);
  }
  return exe;
}

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

function skip(reason) {
  console.log(`SKIP — ${reason}; expected until the references[] emitter lands on this compiler.`);
  process.exit(0);
}

/** Pick a references[] entry to anchor a test on: try `preferNames` in order
 *  (so the test reads against real, recognizable demo.blade bindings), else
 *  fall back to the first entry matching `pred` — keeps the test alive even
 *  if demo.blade's content shifts under it. */
function pickEntry(entries, preferNames, pred) {
  for (const name of preferNames) {
    const hit = entries.find((e) => e.name === name && pred(e));
    if (hit) return hit;
  }
  return entries.find(pred);
}

/** 1-based {line,col} (references[] convention) -> 0-based vscode Position. */
function toPos(mock, span) {
  return new mock.Position(span.line - 1, span.col - 1);
}

/** Does 0-based `range` (vscode Range) start exactly at 1-based `span`? */
function rangeStartsAt(range, span) {
  return range.start.line === span.line - 1 && range.start.character === span.col - 1;
}

const demoPath = path.resolve(__dirname, "..", "samples", "demo.blade");
const exe = findExe();
console.log(`compiler: ${exe}`);

cp.execFile(
  exe,
  ["ide", "check", "--json", demoPath],
  { cwd: path.dirname(demoPath), maxBuffer: 16 * 1024 * 1024 },
  (err, stdout /*, stderr */) => {
    let payload;
    try {
      payload = JSON.parse(stdout);
    } catch (e) {
      // A nonzero exit with unparseable stdout means the subcommand itself
      // isn't there yet (old compiler) — SKIP. Anything else (JSON that
      // fails to parse from a compiler that clearly has the subcommand) is a
      // real failure, not a version gap.
      if (err) return skip(`'ide check --json' produced no JSON (${e.message})`);
      console.error(`unexpected: exit 0 but stdout is not JSON: ${e.message}`);
      process.exit(1);
    }
    if (!Array.isArray(payload.references)) {
      return skip("payload has no references[] array");
    }
    if (payload.diagnostics && payload.diagnostics.length > 0) {
      console.error(
        `demo.blade did not check clean (${payload.diagnostics.length} diagnostic(s)) — fix the fixture, not this test:\n` +
          JSON.stringify(payload.diagnostics, null, 2)
      );
      process.exit(1);
    }

    const vscodeMock = require("./vscode-mock");
    const mock = vscodeMock.install();
    const { makeDoc } = vscodeMock;
    const ext = require("../src/extension");
    const _test = ext._test;

    _test.setOutput({ appendLine() {} });
    _test.setDiagnostics(mock.languages.createDiagnosticCollection("blade"));

    const text = fs.readFileSync(demoPath, "utf8");
    const doc = makeDoc(text, demoPath);
    _test.applyCheckPayload(doc, payload);

    const entries = payload.references;

    // --- (a)/(b)/(c): a VALUE binding with at least one real use ------------
    const valueEntry = pickEntry(
      entries,
      ["dense", "xs"],
      (e) => (e.kind === "value" || e.kind === "function") && e.def && (e.uses || []).length > 0
    );
    if (!valueEntry) {
      console.error("no references[] entry with kind value/function and >=1 use found in demo.blade's payload");
      process.exit(1);
    }
    console.log(`-- anchor (a)/(b)/(c): ${valueEntry.kind} "${valueEntry.name}" --`);

    // (a) DefinitionProvider on a USE resolves to the entry's def.
    const usePos = toPos(mock, valueEntry.uses[0]);
    const defLoc = _test.definitionProvider.provideDefinition(doc, usePos);
    check(
      `definition of a use of "${valueEntry.name}" resolves to its def`,
      !!defLoc && rangeStartsAt(defLoc.range, valueEntry.def),
      defLoc && defLoc.range
    );

    // (b) ReferenceProvider returns exactly this entry's uses (+ def).
    const refs = _test.referenceProvider.provideReferences(doc, usePos, { includeDeclaration: true });
    check(
      `references of "${valueEntry.name}" = all ${valueEntry.uses.length} use(s) + def`,
      !!refs && refs.length === valueEntry.uses.length + 1,
      refs && refs.map((r) => r.range)
    );
    const expectedStarts = [valueEntry.def, ...valueEntry.uses].map((s) => `${s.line}:${s.col}`);
    const actualStarts = (refs || []).map((r) => `${r.range.start.line + 1}:${r.range.start.character + 1}`);
    check(
      `references of "${valueEntry.name}" cover exactly def+uses (as a set)`,
      expectedStarts.length === actualStarts.length &&
        expectedStarts.every((s) => actualStarts.includes(s)) &&
        actualStarts.every((s) => expectedStarts.includes(s)),
      { expectedStarts, actualStarts }
    );

    // (c) RenameProvider: edits cover def+uses, and every edit range's
    // CURRENT text (before the edit) equals the old name — the sharpest
    // available check on the 1-based/0-based and endCol inclusive/exclusive
    // contract, since a one-off in either direction shifts the slice.
    const renameEdit = _test.renameProvider.provideRenameEdits(doc, usePos, "blade_nav_renamed");
    const ops = renameEdit ? renameEdit.get(doc.uri) : [];
    check(
      `rename edit set for "${valueEntry.name}" has exactly ${valueEntry.uses.length + 1} op(s) (def+uses)`,
      ops.length === valueEntry.uses.length + 1,
      ops
    );
    const badTextOps = ops.filter((op) => doc.getText(op.range) !== valueEntry.name);
    check(
      `every rename op's range currently spans exactly "${valueEntry.name}" (endCol-exclusive contract holds)`,
      badTextOps.length === 0,
      badTextOps.map((op) => ({ range: op.range, text: doc.getText(op.range) }))
    );
    check(
      `every rename op's newText is the new name`,
      ops.every((op) => op.newText === "blade_nav_renamed"),
      ops.map((op) => op.newText)
    );

    // --- (d): document outline contains a known function with a nested param
    const outline = _test.documentSymbolProvider.provideDocumentSymbols(doc);
    const fnEntry = pickEntry(entries, ["covariance", "total"], (e) => e.kind === "function" && e.def);
    const fnSym = fnEntry && outline.find((s) => s.name === fnEntry.name);
    check(
      `document outline contains function "${fnEntry && fnEntry.name}"`,
      !!fnSym && fnSym.kind === mock.SymbolKind.Function,
      outline.map((s) => s.name)
    );
    check(
      `"${fnEntry && fnEntry.name}" has at least one nested param child`,
      !!fnSym && fnSym.children.some((c) => c.kind === mock.SymbolKind.TypeParameter),
      fnSym && fnSym.children.map((c) => ({ name: c.name, kind: c.kind }))
    );

    // --- (e): a PARAM entry resolves via DefinitionProvider from inside the
    // function body (a use, not the def itself).
    const paramEntry = pickEntry(
      entries,
      ["w", "A", "B"],
      (e) => e.kind === "param" && e.def && (e.uses || []).length > 0
    );
    if (!paramEntry) {
      console.error("no references[] entry with kind param and >=1 use found in demo.blade's payload");
      process.exit(1);
    }
    const paramUsePos = toPos(mock, paramEntry.uses[0]);
    const paramDefLoc = _test.definitionProvider.provideDefinition(doc, paramUsePos);
    check(
      `definition of param "${paramEntry.name}"'s in-body use resolves to its own def`,
      !!paramDefLoc && rangeStartsAt(paramDefLoc.range, paramEntry.def),
      paramDefLoc && paramDefLoc.range
    );

    if (failures) {
      console.error(`\n${failures} nav-integration check(s) failed.`);
      process.exit(1);
    }
    console.log("\nOK — navigation providers agree with the live compiler's references[] payload.");
  }
);
