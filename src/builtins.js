// Hover/signature-help table for Blade primitives: combinators, loop
// builders, and array builtins. These have no source binding for the
// compiler to report, so the extension carries a static table.
//
// This is the extension point for primitive documentation — extend or
// correct entries freely. Callable identifiers carry `params`
// ({name, type, doc}) and `ret`, rendered in the same multi-line style as
// user functions and fed to signature help. `doc` is the prose summary.
// Operators carry `sig` (one-line usage) and `doc`.
//
// Type spellings follow the compiler's pretty-printer: `Array<Elem, Idx...>`
// for arrays, `MethodLoop<n>` / `ObjectLoop<n>` for loops, `deferred` for an
// unforced pipeline, `elem` for an array's element type.
//
// Operator names follow the parser's canonical mapping (Parser.fs):
// <@> OpApply, <$> OpFunctor, <&> OpParallel, <&!> OpFusion, <|> OpChoice,
// <|:> OpFallback, >>= OpBind, >>@ OpComposeObj, @>> OpComposeMeth,
// <*> OpArrayProd, |@> pipe-apply (desugars to <@>).

"use strict";

const identifiers = {
  method_for: {
    doc: "Builds a method loop over the given arrays' shared iteration space. Apply a kernel with <@>, then force with |> compute.",
    params: [
      { name: "a1..an", type: "Array<elem, Idx...> | lo..hi", doc: "arrays (or an anonymous range) defining the iteration space" },
    ],
    ret: "MethodLoop<n>",
  },
  object_for: {
    doc: "Builds an object loop from a kernel. Compose with >>@ / @>>, apply with <@>.",
    params: [
      { name: "kernel", type: "lambda(x1..xn) -> elem", doc: "kernel defining the object's per-site value" },
    ],
    ret: "ObjectLoop<n>",
  },
  compute: {
    doc: "Forces a deferred loop pipeline, materializing its result (single fused loop nest where possible). Used as a pipe terminal: `... |> compute`.",
    params: [
      { name: "pipeline", type: "deferred", doc: "unforced loop pipeline (piped in with |>)" },
    ],
    ret: "Array | scalar | tuple",
  },
  pure: {
    doc: "Wraps a value as a pure (effect-free) computation.",
    params: [
      { name: "expr", type: "elem", doc: "value to lift" },
    ],
    ret: "Computation<elem>",
  },
  read: {
    doc: "Read terminal for a deferred pipeline: `... |> read`.",
    params: [
      { name: "pipeline", type: "deferred", doc: "unforced loop pipeline (piped in with |>)" },
    ],
    ret: "elem",
  },
  reduce: {
    doc: "Reduction over an array or unforced deferred pipeline (fused into one loop nest with scalar accumulators when deferred).",
    params: [
      { name: "array", type: "Array<elem, Idx...> | deferred", doc: "values to reduce" },
      { name: "kernel", type: "lambda(acc, x) -> acc", doc: "combining function" },
      { name: "init", type: "elem  (optional)", doc: "initial accumulator; defaults to the kernel's zero" },
    ],
    ret: "elem",
  },
  mask: {
    doc: "Filters an array by a boolean predicate array, yielding a compound (masked) view. Rearrangement combinator; forces deferred inputs.",
    params: [
      { name: "array", type: "Array<elem, Idx...>", doc: "source array" },
      { name: "predicate", type: "Array<Bool, Idx...>", doc: "boolean mask over the same index space" },
    ],
    ret: "compound view of Array<elem, Idx...>",
  },
  compound: {
    doc: "Constructs a compound (sparse-view) array from a dense array and a boolean mask sharing its named index types.",
    params: [
      { name: "dense", type: "Array<elem, Idx...>", doc: "dense source values" },
      { name: "mask", type: "Array<Bool, Idx...>", doc: "present/absent mask; must share the dense array's index types" },
    ],
    ret: "compound view of Array<elem, Idx...>",
  },
  zip: {
    doc: "Co-iterates arrays over a shared index space.",
    params: [
      { name: "a1..an", type: "Array<elem, Idx>", doc: "arrays sharing an index space" },
    ],
    ret: "co-iterated view",
  },
  stack: {
    doc: "Stacks arrays along a new leading dimension.",
    params: [
      { name: "a1..an", type: "Array<elem, Idx...>", doc: "same-shaped arrays to stack" },
    ],
    ret: "Array<elem, Idx<n>, Idx...>",
  },
  sort: {
    doc: "Sorts an array. Rearrangement combinator; forces deferred inputs.",
    params: [
      { name: "array", type: "Array<elem, Idx>", doc: "values to sort" },
      { name: "key", type: "lambda(x) -> key  (optional)", doc: "sort key; defaults to the element itself" },
    ],
    ret: "Array<elem, Idx>",
  },
  unique: {
    doc: "Distinct elements. Rearrangement combinator; forces deferred inputs.",
    params: [
      { name: "array", type: "Array<elem, Idx>", doc: "source values" },
    ],
    ret: "Array<elem, Idx>",
  },
  intersect: {
    doc: "Set intersection of two arrays. Forces deferred inputs.",
    params: [
      { name: "a", type: "Array<elem, Idx>", doc: "left operand" },
      { name: "b", type: "Array<elem, Idx>", doc: "right operand" },
    ],
    ret: "Array<elem, Idx>",
  },
  union: {
    doc: "Set union of two arrays. Forces deferred inputs.",
    params: [
      { name: "a", type: "Array<elem, Idx>", doc: "left operand" },
      { name: "b", type: "Array<elem, Idx>", doc: "right operand" },
    ],
    ret: "Array<elem, Idx>",
  },
  contains: {
    doc: "Membership test.",
    params: [
      { name: "array", type: "Array<elem, Idx>", doc: "values to search" },
      { name: "value", type: "elem", doc: "element to look for" },
    ],
    ret: "Bool",
  },
  group_by: {
    doc: "Groups values by a grouping array. Shared rearrangement helper; forces deferred inputs.",
    params: [
      { name: "values", type: "Array<elem, Idx>", doc: "values to group" },
      { name: "grouping", type: "Array<key, Idx>", doc: "group key for each value (same index space)" },
    ],
    ret: "grouped Array (ragged by group)",
  },
  group_keys: {
    doc: "Key set of a grouping, indexable alongside group_by results.",
    params: [
      { name: "grouping", type: "Array<key, Idx>", doc: "the grouping array" },
    ],
    ret: "GroupKeys<Idx, Idx>",
  },
  transpose: {
    doc: "Swaps two dimensions (default: the first two). Rearrangement combinator; forces deferred inputs.",
    params: [
      { name: "array", type: "Array<elem, Idx1, Idx2, ...>", doc: "source array (rank >= 2)" },
      { name: "d1", type: "Int  (optional)", doc: "first dimension to swap (default 0)" },
      { name: "d2", type: "Int  (optional)", doc: "second dimension to swap (default 1)" },
    ],
    ret: "Array<elem, Idx2, Idx1, ...>",
  },
  decompact: {
    doc: "Expands a symmetry-compacted dimension (SymIdx/AntisymIdx storage) back to dense form. Forces deferred inputs.",
    params: [
      { name: "array", type: "Array<elem, SymIdx<r, n>, ...>", doc: "symmetry-compacted array" },
      { name: "dim", type: "Int", doc: "which compacted dimension to expand" },
    ],
    ret: "Array<elem, Idx<n>, ..., Idx<n>>",
  },
  gram: {
    doc: "Gram-style product: pairwise products of an array with itself (or with a second array).",
    params: [
      { name: "a", type: "Array<elem, Idx<n>>", doc: "left factor" },
      { name: "b", type: "Array<elem, Idx<n>>  (optional)", doc: "right factor; defaults to `a` (symmetric result)" },
    ],
    ret: "Array<elem, Idx<n>, Idx<n>>",
  },
  range: {
    doc: "Virtual (computed) index-range array; no storage.",
    params: [
      { name: "lo", type: "Int64", doc: "inclusive lower bound" },
      { name: "hi", type: "Int64", doc: "exclusive upper bound" },
    ],
    ret: "virtual Array<Int64, Idx<hi-lo>>",
  },
  reverse: {
    doc: "Reversed iteration view of an array or index.",
    params: [
      { name: "array", type: "Array<elem, Idx>", doc: "array (or index) to reverse" },
    ],
    ret: "virtual view (same type)",
  },
  replicate: {
    doc: "Repeats a computation `count` times into an array.",
    params: [
      { name: "count", type: "Int64", doc: "number of repetitions (static or provider-backed)" },
      { name: "body", type: "elem expr", doc: "expression evaluated per repetition" },
    ],
    ret: "Array<elem, Idx<count>>",
  },
  sequence: {
    doc: "Evaluates expressions in order; the result is the last one.",
    params: [
      { name: "e1..en", type: "expr", doc: "expressions, evaluated left to right" },
    ],
    ret: "type of the last expression",
  },
  extents: {
    doc: "The array's per-dimension extents.",
    params: [
      { name: "array", type: "Array<elem, Idx...>", doc: "array to measure" },
    ],
    ret: "(Int64, ...)",
  },
  conj: {
    doc: "Complex conjugate (elementwise on arrays).",
    params: [
      { name: "x", type: "Complex128 | Array<Complex128, Idx...>", doc: "value or array to conjugate" },
    ],
    ret: "same as input",
  },
  hermitian: {
    doc: "Hermitian view/marker for complex arrays (conjugate-transpose symmetry).",
    params: [
      { name: "array", type: "Array<Complex128, Idx<n>, Idx<n>>", doc: "complex square array" },
    ],
    ret: "hermitian view",
  },
  guard: {
    doc: "Evaluates the body only where the condition holds.",
    params: [
      { name: "cond", type: "Bool", doc: "guard condition" },
      { name: "body", type: "elem expr", doc: "expression evaluated when the condition holds" },
    ],
    ret: "guarded elem",
  },
  zero: {
    doc: "The zero element of the expected type (context-typed).",
    params: [],
    ret: "elem",
  },
  rank: {
    doc: "Number of dimensions of an array.",
    params: [
      { name: "array", type: "Array<elem, Idx...>", doc: "array to inspect" },
    ],
    ret: "Int64",
  },
  arity: {
    doc: "Arity of a Poly parameter pack (static).",
    params: [
      { name: "pack", type: "Poly<T, args>", doc: "polyvariadic parameter" },
    ],
    ret: "Int64 (static)",
  },
  nth: {
    doc: "k-th element of a Poly parameter pack.",
    params: [
      { name: "pack", type: "Poly<T, args>", doc: "polyvariadic parameter" },
      { name: "k", type: "Int64 (static)", doc: "0-based element index" },
    ],
    ret: "T",
  },
  grad: {
    doc: "Reverse-mode derivative of a function. Array gradients accumulate into caller-allocated mut out-buffers (caller zeroes them); the primal value is returned.",
    params: [
      { name: "f", type: "function", doc: "differentiable function" },
    ],
    ret: "gradient function (primal args + mut out-buffers) -> primal value",
  },
};

const operators = {
  "<@>": {
    sig: "loop <@> kernel -> deferred",
    doc: "Apply: attaches a kernel to a method/object loop, producing a deferred computation (force with |> compute).",
  },
  "<$>": {
    sig: "f <$> computation",
    doc: "Functor map over a computation.",
  },
  "<&>": {
    sig: "deferred <&> deferred -> (a, b)",
    doc: "Parallel composition: run two deferred pipelines side by side; results as a tuple.",
  },
  "<&!>": {
    sig: "deferred <&!> deferred -> (a, b)",
    doc: "Fusion: fuse two deferred pipelines into one loop nest; results as a tuple.",
  },
  "<|>": {
    sig: "a <|> b",
    doc: "Choice combinator.",
  },
  "<|:>": {
    sig: "a <|:> fallback",
    doc: "Choice with fallback.",
  },
  ">>=": {
    sig: "computation >>= f",
    doc: "Bind: sequence a computation into a continuation.",
  },
  ">>@": {
    sig: "object_for(f) >>@ object_for(g)",
    doc: "Compose object loops (g after f).",
  },
  "@>>": {
    sig: "method_loop @>> method_loop",
    doc: "Compose method loops.",
  },
  "<*>": {
    sig: "a <*> b",
    doc: "Array product combinator.",
  },
  "|>": {
    sig: "value |> f",
    doc: "Pipe: feeds the left value to the right function/terminal (compute, read, ...).",
  },
  "|@>": {
    sig: "a |@> f   (= f <@> a)",
    doc: "Pipe-apply: desugars to the <@> apply with operands flipped.",
  },
  "..": {
    sig: "lo..hi",
    doc: "Integer range (for-in loops, anonymous method_for ranges).",
  },
};

// Bracketed outer-product operators [op]: one entry each, generated.
for (const op of ["+", "-", "*", "/", "%", "^", "==", "!=", "<", "<=", ">", ">=", "&&", "||"]) {
  operators[`[${op}]`] = {
    sig: `a [${op}] b -> outer product`,
    doc: `Outer ${op}: applies ${op} across all index combinations of the operands, producing a higher-rank array.`,
  };
}

module.exports = { identifiers, operators };
