// Hover table for DOMAIN-SPECIFIC keywords only — the where-clause /
// constraint / staging surface a reader may genuinely not know. Everyday
// keywords (if/else/let/match/for/...) deliberately get no hover.
//
// Call-shaped keyword forms (pure, guard, reynolds, mask, reduce, ...) live
// in builtins.js as callable entries instead — hover dispatch checks
// builtins.identifiers before this table, so listing them here would be
// dead code.
//
// Each entry: `usage` (one-line idiomatic form, shown in the code block)
// and `doc` (prose below the rule). Sources: Lexer.fs keyword table,
// Ast.fs WhereClause, tests/corpus (omp/mpi exclusivity:
// inference-probes/021), ppl/compiler/PplElaborate.fs (indep).

"use strict";

const keywords = {
  comm: {
    usage: "where comm(A, B)",
    doc: "Kernel commutativity group. All args in a single comm(...) conjunct are mutually commutative. If these args recieve copies of the same array, the output dimensions are transposed and made symmetric.",
  },
  anticomm: {
    usage: "where anticomm(A, B)",
    doc: "Kernel anticommutativity group — the signed sibling of comm: f(B, A) = -f(A, B). Needs at least two names. If these args receive copies of the same array, the output compacts to strict-triangular (zero-diagonal) antisymmetric storage. A name cannot appear in both a comm and an anticomm group.",
  },
  omp: {
    usage: "where omp(x: 1)",
    doc: "OpenMP parallelization strategy. The first n dimensions of x are parallelized with OpenMP.",
  },
  cuda: {
    usage: "where cuda(block: 64)",
    doc: "CUDA parallelization strategy. S-dimensions are collapsed and pooled, then distributed to CUDA blocks of the given size.",
  },
  mpi: {
    usage: "where mpi",
    doc: "MPI parallelization strategy. Only applies to the first S-dimension.",
  },
  indep: {
    usage: "where ppl.indep(a, b)",
    doc: "PPL conjunct: declares two Dist-typed parameters independent within this function, licensing `+` on them. Call sites discharge it from declared or derived independence. Must be written qualified with the ppl import's alias — bare `where indep(a, b)` no longer resolves. Module-level form: `let _ = ppl.independent(X, Y)`.",
  },
  like: {
    usage: "Array<Float64 like Lat, Lon>",
    doc: "Separates an array's element type from its index-type list inside Array<...> and Dist<...> annotations.",
  },
  where: {
    usage: "function f(A, B) where comm(A, B), omp(x: 1) -> T",
    doc: "Constraint clause on functions and lambdas: commutativity groups (comm / anticomm), at most one parallel strategy (omp / cuda / mpi), and module-qualified conjuncts such as ppl.indep(a, b), comma-separated. Also opens the constraint block of grouped type aliases (`type P1 = T1 and P2 = T2 where ...`).",
  },
  static: {
    usage: "let static n = 2",
    doc: "Compile-time binding or function, evaluated by the static evaluator. Required where shapes must fold at compile time: index extents, ML spec configs, PPL orders. Static-only builtins (min, max, length) resolve here.",
  },
};

module.exports = { keywords };
