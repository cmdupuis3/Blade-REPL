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
    doc: "Commutativity constraint: declares the listed parameters interchangeable (the kernel is invariant under their exchange). Licenses symmetric packing (SymIdx) and triangular iteration. A where clause may name several comma-separated groups.",
  },
  omp: {
    usage: "where omp(x: 1)",
    doc: "OpenMP parallelization strategy for the enclosing function or lambda's loop nest. Mutually exclusive with cuda and mpi.",
  },
  cuda: {
    usage: "where cuda(block: 64)",
    doc: "CUDA execution strategy for the enclosing function or lambda. Mutually exclusive with omp and mpi.",
  },
  mpi: {
    usage: "where mpi",
    doc: "MPI distribution strategy (bare conjunct) for the enclosing function or lambda. Mutually exclusive with omp and cuda. Run distributed with `blade run <file> --mpi N`.",
  },
  indep: {
    usage: "where p.indep(a, b)   (with import ppl as p)",
    doc: "PPL conjunct: declares two Dist-typed parameters independent within this function, licensing `+` on them. Call sites discharge it from declared or derived independence. Must be written qualified with the ppl import's alias — bare `where indep(a, b)` no longer resolves. Module-level form: `let _ = ppl.independent(X, Y)`.",
  },
  like: {
    usage: "Array<Float64 like Lat, Lon>",
    doc: "Separates an array's element type from its index-type list inside Array<...> (and Dist<...>) annotations.",
  },
  where: {
    usage: "function f(A, B) where comm(A, B), omp(x: 1) -> T",
    doc: "Constraint clause on functions and lambdas: commutativity groups (comm), at most one parallel strategy (omp / cuda / mpi), and module-qualified conjuncts such as p.indep(a, b) (with `import ppl as p`) — comma-separated. Also opens the constraint block of grouped type aliases (`type P1 = T1 and P2 = T2 where ...`).",
  },
  static: {
    usage: "let static n = 2",
    doc: "Compile-time binding or function, evaluated by the static evaluator. Required where shapes must fold at compile time: index extents, ML spec configs, PPL orders. Static-only builtins (min, max, length) resolve here.",
  },
};

module.exports = { keywords };
