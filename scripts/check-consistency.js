// Consistency check between the compiler's language surface, the TextMate
// grammar's word lists, and the hover tables. Run with:
//
//   node scripts/check-consistency.js      (or `npm test`)
//
// Exits 1 and prints asymmetric diffs on any drift — this is how `grad`
// once ended up with a hover but no highlighting. Zero dependencies.

"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const builtins = require(path.join(root, "src", "builtins.js"));
const types = require(path.join(root, "src", "types.js"));
const keywords = require(path.join(root, "src", "keywords.js"));
const grammar = JSON.parse(
  fs.readFileSync(path.join(root, "syntaxes", "blade.tmLanguage.json"), "utf8")
);

// The compiler's reserved words — source: _blade-compiler/Lexer.fs:139-218
// (76 distinct; True/False are lexer aliases of true/false and appear in the
// grammar's booleans pattern only).
const LEXER_KEYWORDS = [
  "let", "const", "mut", "static", "function", "lambda", "type",
  "struct", "interface", "impl", "module", "for", "if", "then",
  "else", "match", "with", "where", "and", "comm", "omp", "cuda",
  "mpi", "reynolds", "true", "false", "in", "import", "from", "as",
  "Void", "Unit", "Array", "Idx", "SymIdx", "AntisymIdx",
  "HermitianIdx", "CompoundIdx", "EnumIdx", "DepIdx", "RaggedIdx",
  "IrrepsIdx", "method_for", "object_for", "range", "reverse",
  "transpose", "hermitian", "gram", "decompact", "pure", "compute",
  "read", "guard", "sequence", "replicate", "zip", "stack", "arity",
  "nth", "zero", "rank", "mask", "compound", "intersect", "union",
  "unique", "contains", "group_by", "group_keys", "sort", "reduce",
  "conj", "extents", "like", "Poly",
];

// Words the grammar highlights that are NOT lexer keywords, with the reason.
const GRAMMAR_EXTRAS = new Set([
  "Dist", // parser special-case type constructor, not a lexer keyword
  "True", "False", // lexer aliases of true/false
]);

// Callable keyword forms: reserved words that live in builtins.identifiers
// (hover as callables, signature help) but keep their keyword highlighting.
const KEYWORD_CALLABLES = new Set(["pure", "guard", "reynolds"]);

// keywords.js entries that are where-clause conjunct names rather than lexer
// keywords (registered handlers, e.g. PPL's indep — PplElaborate.fs).
const CONJUNCT_KEYWORDS = new Set(["indep"]);

// builtins category -> the grammar scope its names must be highlighted under.
// Deliberately absent: "module" (ad/ppl/ml) — module names are ordinary
// identifiers, not highlighted words; their entries are hover-only.
const CATEGORY_SCOPE = {
  core: "support.function.builtin.blade",
  static: "support.function.builtin.blade",
  autodiff: "support.function.builtin.blade",
  virtual: "support.function.virtual.blade",
  math: "support.function.math.blade",
  ppl: "support.function.ppl.blade",
  ml: "support.function.ml.blade",
};

// --- Grammar word-list extraction --------------------------------------------

// Collect every simple `\b(a|b|c)\b` match pattern in the grammar,
// scope name -> Set of words (merged across patterns with the same scope).
const scopeWords = new Map();
(function walk(node) {
  if (Array.isArray(node)) return node.forEach(walk);
  if (!node || typeof node !== "object") return;
  if (typeof node.match === "string" && typeof node.name === "string") {
    const m = /^\\b\(([A-Za-z0-9_|]+)\)\\b$/.exec(node.match);
    if (m) {
      const set = scopeWords.get(node.name) || new Set();
      for (const w of m[1].split("|")) set.add(w);
      scopeWords.set(node.name, set);
    }
  }
  for (const v of Object.values(node)) walk(v);
})(grammar);

const words = (scope) => scopeWords.get(scope) || new Set();

// Scopes whose word lists must contain ONLY lexer keywords (or known extras).
const KEYWORD_SCOPES = [
  "keyword.control.blade",
  "keyword.control.import.blade",
  "storage.type.blade",
  "storage.modifier.blade",
  "keyword.other.backend.blade",
  "support.type.index.blade",
  "support.type.blade",
  "constant.language.boolean.blade",
  "keyword.operator.word.like.blade",
];

// --- Reporting ----------------------------------------------------------------

let failures = 0;
function fail(check, items) {
  failures++;
  console.error(`FAIL ${check}`);
  for (const i of items) console.error(`  - ${i}`);
}

// --- 1. Lexer keywords <-> grammar --------------------------------------------

{
  const allGrammarWords = new Set();
  for (const set of scopeWords.values()) for (const w of set) allGrammarWords.add(w);
  const missing = LEXER_KEYWORDS.filter((w) => !allGrammarWords.has(w));
  if (missing.length) fail("lexer keyword not highlighted anywhere in the grammar", missing);

  const lexerSet = new Set(LEXER_KEYWORDS);
  const unknown = [];
  for (const scope of KEYWORD_SCOPES) {
    for (const w of words(scope)) {
      if (!lexerSet.has(w) && !GRAMMAR_EXTRAS.has(w)) unknown.push(`${w} (${scope})`);
    }
  }
  if (unknown.length) fail("grammar keyword scope contains a non-keyword", unknown);
}

// --- 2. builtins.identifiers <-> support.function.* scopes --------------------

{
  const wrong = [];
  for (const [name, e] of Object.entries(builtins.identifiers)) {
    if (KEYWORD_CALLABLES.has(name)) continue; // highlighted as keywords
    const scope = CATEGORY_SCOPE[e.category];
    if (!scope) continue; // caught by shape validation below
    if (!words(scope).has(name)) wrong.push(`${name} (category ${e.category}) missing from ${scope}`);
  }
  if (wrong.length) fail("identifier not highlighted under its category's scope", wrong);

  const orphaned = [];
  for (const scope of new Set(Object.values(CATEGORY_SCOPE))) {
    const okCategories = Object.entries(CATEGORY_SCOPE)
      .filter(([, s]) => s === scope)
      .map(([c]) => c);
    for (const w of words(scope)) {
      const e = builtins.identifiers[w];
      if (!e) orphaned.push(`${w} (${scope}) has no hover entry`);
      else if (!okCategories.includes(e.category))
        orphaned.push(`${w} (${scope}) has category ${e.category}, expected one of: ${okCategories.join(", ")}`);
    }
  }
  if (orphaned.length) fail("grammar builtin word without a matching hover entry", orphaned);

  const shadowed = KEYWORD_CALLABLES;
  for (const scope of new Set(Object.values(CATEGORY_SCOPE))) {
    const bad = [...words(scope)].filter((w) => shadowed.has(w));
    if (bad.length) fail(`keyword-callable highlighted as builtin in ${scope} (keep keyword scope)`, bad);
  }
}

// --- 3. keywords.js ------------------------------------------------------------

{
  const lexerSet = new Set(LEXER_KEYWORDS);
  const notKeywords = Object.keys(keywords.keywords).filter(
    (k) => !lexerSet.has(k) && !CONJUNCT_KEYWORDS.has(k)
  );
  if (notKeywords.length) fail("keywords.js entry is not a lexer keyword or known conjunct", notKeywords);

  const overlap = Object.keys(keywords.keywords).filter((k) => builtins.identifiers[k]);
  if (overlap.length)
    fail("keywords.js entry shadowed by builtins.identifiers (hover checks builtins first)", overlap);
}

// --- 4. types.js <-> grammar type scopes ---------------------------------------

{
  const primScope = words("support.type.primitive.blade");
  const supportScope = words("support.type.blade");

  const primMissing = Object.keys(types.primitives).filter(
    (t) => !primScope.has(t) && !supportScope.has(t)
  );
  if (primMissing.length) fail("types.primitives entry not highlighted as a type", primMissing);

  const primOrphans = [...primScope].filter((w) => !(w in types.primitives));
  if (primOrphans.length) fail("grammar primitive type without a hover entry", primOrphans);

  const idxScope = words("support.type.index.blade");
  const idxMissing = Object.keys(types.indexTypes).filter((t) => !idxScope.has(t));
  if (idxMissing.length) fail("types.indexTypes entry not in the grammar's index-type list", idxMissing);
  const idxOrphans = [...idxScope].filter((w) => !(w in types.indexTypes));
  if (idxOrphans.length) fail("grammar index type without a hover entry", idxOrphans);

  // support.type.blade = constructors (Poly, Dist) + Array (dynamic hover in
  // extension.js) + Void/Unit (primitives table).
  const ctorMissing = Object.keys(types.constructors).filter((t) => !supportScope.has(t));
  if (ctorMissing.length) fail("types.constructors entry not in the grammar's support-type list", ctorMissing);
  const supportOrphans = [...supportScope].filter(
    (w) => !(w in types.constructors) && w !== "Array" && !(w in types.primitives)
  );
  if (supportOrphans.length) fail("grammar support type without a hover entry", supportOrphans);
}

// --- 5. Entry shape validation --------------------------------------------------

{
  const bad = [];
  for (const [name, e] of Object.entries(builtins.identifiers)) {
    if (!(e.category in builtins.categories)) bad.push(`${name}: unknown category ${e.category}`);
    if (typeof e.doc !== "string" || !e.doc) bad.push(`${name}: missing doc`);
    const callable = Array.isArray(e.params);
    const sigForm = typeof e.sig === "string";
    if (callable === sigForm) bad.push(`${name}: needs exactly one of params[] or sig`);
    if (callable) {
      if (typeof e.ret !== "string") bad.push(`${name}: callable entry missing ret string`);
      const names = e.params.map((p) => p.name);
      if (new Set(names).size !== names.length)
        bad.push(`${name}: duplicate param names break signature-help highlighting`);
      for (const p of e.params) {
        if (typeof p.name !== "string" || typeof p.type !== "string")
          bad.push(`${name}: param missing name/type`);
        if (/'/.test(p.type)) bad.push(`${name}: param type contains ' (typeNormalizer rewrites 'a-style vars — use bare T, U, ...)`);
      }
    }
  }
  for (const [op, e] of Object.entries(builtins.operators)) {
    if (typeof e.sig !== "string" || typeof e.doc !== "string") bad.push(`operator ${op}: needs sig + doc`);
  }
  for (const [k, e] of Object.entries(keywords.keywords)) {
    if (typeof e.usage !== "string" || typeof e.doc !== "string") bad.push(`keyword ${k}: needs usage + doc`);
  }
  for (const [t, d] of Object.entries(types.primitives)) {
    if (typeof d !== "string" || !d) bad.push(`primitive ${t}: needs a one-liner`);
  }
  for (const [t, e] of Object.entries(types.indexTypes)) {
    if (typeof e.sig !== "string" || typeof e.desc !== "string") bad.push(`index type ${t}: needs sig + desc`);
  }
  for (const [t, e] of Object.entries(types.constructors)) {
    if (typeof e.sig !== "string" || typeof e.kind !== "string" || typeof e.desc !== "string")
      bad.push(`constructor ${t}: needs sig + kind + desc`);
  }
  if (bad.length) fail("entry shape validation", bad);
}

// --- Result ---------------------------------------------------------------------

if (failures) {
  console.error(`\n${failures} consistency check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log(
    `OK (${Object.keys(builtins.identifiers).length} identifiers, ` +
      `${Object.keys(builtins.operators).length} operators, ` +
      `${Object.keys(keywords.keywords).length} keywords, ` +
      `${Object.keys(types.primitives).length} primitives, ` +
      `${Object.keys(types.indexTypes).length} index types, ` +
      `${Object.keys(types.constructors).length} constructors, ` +
      `${LEXER_KEYWORDS.length} lexer keywords)`
  );
}
