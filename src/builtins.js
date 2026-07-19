// Hover/signature-help table for Blade primitives: combinators, loop
// builders, array builtins, math intrinsics, the PPL and ML surfaces, and
// operators. These have no source binding for the compiler to report, so the
// extension carries a static table.
//
// This is the extension point for primitive documentation — extend or
// correct entries freely. Callable identifiers carry `params`
// ({name, type, doc}) and `ret`, rendered in the same multi-line style as
// user functions and fed to signature help. Generic-bracket forms (range<I>,
// reverse<I>) carry a `sig` string instead — they are not paren calls, so
// they get no synthesized parameter list and no signature help. `doc` is the
// prose summary. Operators carry `sig` (one-line usage) and `doc`.
//
// Every identifier carries a `category` key (see `categories` below): the
// hover and completion providers render its text as a badge line, and
// scripts/check-consistency.js maps categories to the grammar's
// support.function.* scopes.
//
// Type spellings follow the compiler's pretty-printer: `Array<T, Idx...>`
// for arrays, `virtual Array<...>` for the storage-free virtual-array kind
// (IR arrows whose slots are all SIdxVirt), `MethodLoop<n>` /
// `ObjectLoop<n>` for loops, `deferred` for an unforced pipeline. Templated
// (polymorphic) element/result types are written as abstract type variables
// — OCaml-style but without the apostrophe, drawn in order from T, U, V, W,
// X, Y, Z — so a reduction kernel reads `lambda(U, T) -> U` (accumulator U,
// element T). A function type is an "arrow" (domain -> codomain); arrays are
// the other kind of arrow, written `Array<T like ...>`. (Types the compiler
// reports are normalized the same way at display time — see typeNormalizer
// in extension.js.)
//
// Operator names follow the parser's canonical mapping (Parser.fs):
// <@> OpApply, <$> OpFunctor, <&> OpParallel, <&!> OpFusion, <|> OpChoice,
// <|:> OpFallback, >>= OpBind, >>@ OpComposeObj, @>> OpComposeMeth,
// <*> OpArrayProd, |@> pipe-apply (desugars to <@>).
//
// Compiler sources of truth: math intrinsics Grad.fs mathIntrinsics +
// TypeCheck.fs; autodiff surface Grad.fs (import-gated `import ad`,
// qualified ad.grad); PPL formers ppl/compiler/PplElaborate.fs (arity error
// messages quote the expected shapes); ML ops ml/compiler/MLElaborate.fs;
// ML sizing statics ml/compiler/MLStatics.fs; static-only builtins
// StaticEval.fs evalBuiltin.

"use strict";

// Category -> hover badge text. Rendered as an italic line under the
// signature block; also drives completion detail and the consistency check.
const categories = {
  core: "builtin",
  virtual: "virtual array — index-defined, no storage",
  autodiff: "autodiff — requires `import ad`, call qualified (ad.…)",
  math: "math intrinsic — scalar, result Float64",
  static: "static builtin — `let static` contexts only",
  ppl: "PPL — requires `import ppl`, call qualified (ppl.…)",
  ml: "ML — requires `import ml`, call qualified (ml.…)",
  module: "import-gated module — members resolve only qualified through the import's alias",
};

// --- Core: loop builders, combinators, array/SQL algebra ---------------------

const identifiers = {
  method_for: {
    category: "core",
    doc: "Builds a method loop over the given arrays' shared iteration space. Apply a kernel with <@>, then force with |> compute.",
    params: [
      { name: "a1..an", type: "Array<T, Idx...> | lo..hi", doc: "arrays (or an anonymous range) defining the iteration space" },
    ],
    ret: "MethodLoop<n>",
  },
  object_for: {
    category: "core",
    doc: "Builds an object loop from a kernel. Compose with >>@ / @>>, apply with <@>.",
    params: [
      { name: "kernel", type: "lambda(T...) -> U", doc: "kernel defining the object's per-site value" },
    ],
    ret: "ObjectLoop<n>",
  },
  compute: {
    category: "core",
    doc: "Forces a deferred loop pipeline, materializing its result (single fused loop nest where possible). Used as a pipe terminal: `... |> compute`.",
    params: [
      { name: "pipeline", type: "deferred", doc: "unforced loop pipeline (piped in with |>)" },
    ],
    ret: "Array | scalar | tuple",
  },
  pure: {
    category: "core",
    doc: "Wraps a value as a pure (effect-free) computation. Also a reserved keyword (cannot be rebound).",
    params: [
      { name: "expr", type: "T", doc: "value to lift" },
    ],
    ret: "Computation<T>",
  },
  read: {
    category: "core",
    doc: "Read terminal for a deferred pipeline: `... |> read`.",
    params: [
      { name: "pipeline", type: "deferred", doc: "unforced loop pipeline (piped in with |>)" },
    ],
    ret: "T",
  },
  reduce: {
    category: "core",
    doc: "Reduction over an array or unforced deferred pipeline (fused into one loop nest with scalar accumulators when deferred).",
    params: [
      { name: "array", type: "Array<T, Idx...> | deferred", doc: "values to reduce" },
      { name: "kernel", type: "lambda(U, T) -> U", doc: "combining function" },
      { name: "init", type: "U  (optional)", doc: "initial accumulator; defaults to the kernel's zero" },
    ],
    ret: "U",
  },
  mask: {
    category: "core",
    doc: "Filters an array by a boolean predicate array, yielding a compound (masked) view. Rearrangement combinator; forces deferred inputs.",
    params: [
      { name: "array", type: "Array<T, Idx...>", doc: "source array" },
      { name: "predicate", type: "Array<Bool, Idx...>", doc: "boolean mask over the same index space" },
    ],
    ret: "compound view of Array<T, Idx...>",
  },
  compound: {
    category: "core",
    doc: "Constructs a compound (sparse-view) array from a dense array and a boolean mask sharing its named index types.",
    params: [
      { name: "dense", type: "Array<T, Idx...>", doc: "dense source values" },
      { name: "mask", type: "Array<Bool, Idx...>", doc: "present/absent mask; must share the dense array's index types" },
    ],
    ret: "compound view of Array<T, Idx...>",
  },
  zip: {
    category: "core",
    doc: "Co-iterates arrays over a shared index space.",
    params: [
      { name: "a1..an", type: "Array<T, Idx>", doc: "arrays sharing an index space" },
    ],
    ret: "co-iterated view",
  },
  stack: {
    category: "core",
    doc: "Stacks arrays along a new leading dimension.",
    params: [
      { name: "a1..an", type: "Array<T, Idx...>", doc: "same-shaped arrays to stack" },
    ],
    ret: "Array<T, Idx<n>, Idx...>",
  },
  sort: {
    category: "core",
    doc: "Sorts an array. Rearrangement combinator; forces deferred inputs.",
    params: [
      { name: "array", type: "Array<T, Idx>", doc: "values to sort" },
      { name: "key", type: "lambda(T) -> U  (optional)", doc: "sort key; defaults to the element itself" },
    ],
    ret: "Array<T, Idx>",
  },
  unique: {
    category: "core",
    doc: "Distinct elements. Rearrangement combinator; forces deferred inputs.",
    params: [
      { name: "array", type: "Array<T, Idx>", doc: "source values" },
    ],
    ret: "Array<T, Idx>",
  },
  intersect: {
    category: "core",
    doc: "Set intersection of two arrays. Forces deferred inputs.",
    params: [
      { name: "a", type: "Array<T, Idx>", doc: "left operand" },
      { name: "b", type: "Array<T, Idx>", doc: "right operand" },
    ],
    ret: "Array<T, Idx>",
  },
  union: {
    category: "core",
    doc: "Set union of two arrays. Forces deferred inputs.",
    params: [
      { name: "a", type: "Array<T, Idx>", doc: "left operand" },
      { name: "b", type: "Array<T, Idx>", doc: "right operand" },
    ],
    ret: "Array<T, Idx>",
  },
  contains: {
    category: "core",
    doc: "Membership test.",
    params: [
      { name: "array", type: "Array<T, Idx>", doc: "values to search" },
      { name: "value", type: "T", doc: "element to look for" },
    ],
    ret: "Bool",
  },
  group_by: {
    category: "core",
    doc: "Groups values by a grouping array. Shared rearrangement helper; forces deferred inputs.",
    params: [
      { name: "values", type: "Array<T, Idx>", doc: "values to group" },
      { name: "grouping", type: "Array<U, Idx>", doc: "group key for each value (same index space)" },
    ],
    ret: "grouped Array (ragged by group)",
  },
  group_keys: {
    category: "core",
    doc: "Key set of a grouping, indexable alongside group_by results.",
    params: [
      { name: "grouping", type: "Array<T, Idx>", doc: "the grouping array" },
    ],
    ret: "GroupKeys<Idx, Idx>",
  },
  transpose: {
    category: "core",
    doc: "Swaps two dimensions (default: the first two). Rearrangement combinator; forces deferred inputs.",
    params: [
      { name: "array", type: "Array<T, Idx1, Idx2, ...>", doc: "source array (rank >= 2)" },
      { name: "d1", type: "Int  (optional)", doc: "first dimension to swap (default 0)" },
      { name: "d2", type: "Int  (optional)", doc: "second dimension to swap (default 1)" },
    ],
    ret: "Array<T, Idx2, Idx1, ...>",
  },
  decompact: {
    category: "core",
    doc: "Expands a symmetry-compacted dimension (SymIdx/AntisymIdx storage) back to dense form. Forces deferred inputs.",
    params: [
      { name: "array", type: "Array<T, SymIdx<r, n>, ...>", doc: "symmetry-compacted array" },
      { name: "dim", type: "Int", doc: "which compacted dimension to expand" },
    ],
    ret: "Array<T, Idx<n>, ..., Idx<n>>",
  },
  gram: {
    category: "core",
    doc: "Gram-style product: pairwise products of an array with itself (or with a second array).",
    params: [
      { name: "a", type: "Array<T, Idx<n>>", doc: "left factor" },
      { name: "b", type: "Array<T, Idx<n>>  (optional)", doc: "right factor; defaults to `a` (symmetric result)" },
    ],
    ret: "Array<T, Idx<n>, Idx<n>>",
  },
  replicate: {
    category: "core",
    doc: "Repeats a computation `count` times into an array.",
    params: [
      { name: "count", type: "Int64", doc: "number of repetitions (static or provider-backed)" },
      { name: "body", type: "T expr", doc: "expression evaluated per repetition" },
    ],
    ret: "Array<T, Idx<count>>",
  },
  sequence: {
    category: "core",
    doc: "Evaluates expressions in order; the result is the last one.",
    params: [
      { name: "e1..en", type: "expr", doc: "expressions, evaluated left to right" },
    ],
    ret: "type of the last expression",
  },
  extents: {
    category: "core",
    doc: "The array's per-dimension extents.",
    params: [
      { name: "array", type: "Array<T, Idx...>", doc: "array to measure" },
    ],
    ret: "(Int64, ...)",
  },
  complex: {
    category: "core",
    doc: "Complex literal constructor — the one way to build a complex value. Components must be float-typed (no implicit int promotion). Yields Complex128; checked against a Complex64 annotation it adopts the narrow width.",
    params: [
      { name: "re", type: "Float64", doc: "real part" },
      { name: "im", type: "Float64", doc: "imaginary part" },
    ],
    ret: "Complex128",
  },
  conj: {
    category: "core",
    doc: "Complex conjugate (elementwise on arrays).",
    params: [
      { name: "x", type: "Complex128 | Array<Complex128, Idx...>", doc: "value or array to conjugate" },
    ],
    ret: "same as input",
  },
  hermitian: {
    category: "core",
    doc: "Hermitian view/marker for complex arrays (conjugate-transpose symmetry).",
    params: [
      { name: "array", type: "Array<Complex128, Idx<n>, Idx<n>>", doc: "complex square array" },
    ],
    ret: "hermitian view",
  },
  guard: {
    category: "core",
    doc: "Evaluates the body only where the condition holds. Also a reserved keyword (cannot be rebound).",
    params: [
      { name: "cond", type: "Bool", doc: "guard condition" },
      { name: "body", type: "T expr", doc: "expression evaluated when the condition holds" },
    ],
    ret: "guarded T",
  },
  reynolds: {
    category: "core",
    doc: "Reynolds operator: group-averages a kernel over its argument permutations — reynolds(f) yields the symmetrized kernel (f(x, y) + f(y, x)); reynolds(f, Antisymmetric) the sign-weighted average. Feeds <@> like any kernel; results pack into SymIdx / AntisymIdx storage.",
    params: [
      { name: "kernel", type: "lambda(T...) -> U", doc: "kernel to symmetrize" },
      { name: "symmetry", type: "Antisymmetric  (optional)", doc: "sign-weighted (antisymmetric) averaging; default symmetric" },
    ],
    ret: "symmetrized kernel",
  },
  zero: {
    category: "core",
    doc: "The zero element of the expected type (context-typed).",
    params: [],
    ret: "T",
  },
  rank: {
    category: "core",
    doc: "Number of dimensions of an array.",
    params: [
      { name: "array", type: "Array<T, Idx...>", doc: "array to inspect" },
    ],
    ret: "Int64",
  },
  arity: {
    category: "core",
    doc: "Arity of a Poly parameter pack (static).",
    params: [
      { name: "pack", type: "Poly<T, args>", doc: "polyvariadic parameter" },
    ],
    ret: "Int64 (static)",
  },
  nth: {
    category: "core",
    doc: "k-th element of a Poly parameter pack.",
    params: [
      { name: "pack", type: "Poly<T, args>", doc: "polyvariadic parameter" },
      { name: "k", type: "Int64 (static)", doc: "0-based element index" },
    ],
    ret: "T",
  },
  prodsum: {
    category: "core",
    doc: "Fused fiber product-sum: sums the elementwise product of k equal-extent rank-1 arrays (the k-fold generalized dot product) in one pass. The kernel the PPL moment formers are built from.",
    params: [
      { name: "x1..xk", type: "Array<Float, Idx<n>>", doc: "equal-extent rank-1 factors" },
    ],
    ret: "Float64",
  },
  fill_random: {
    category: "core",
    doc: "Random-fill array constructor: valid only as the right-hand side of an annotated binding (`let A: Array<...> = fill_random(mod)`), which supplies the shape. Allocates and fills with pseudo-random values modulo `mod`.",
    params: [
      { name: "mod", type: "Int64", doc: "modulus expression bounding the generated values" },
    ],
    ret: "Array (shape from the binding's annotation)",
  },

  // --- Virtual arrays: index-defined, storage-free (their own object kind;
  // IR arrows whose slots are all SIdxVirt — see IR.fs). Generic-bracket
  // syntax, not paren calls, so these are `sig` entries. Of the family
  // (range<>, a..b, reverse<>, blocked<>), only range<> and a..b are fully
  // implemented today. ---------------------------------------------------------

  range: {
    category: "virtual",
    sig: "range<I> : virtual Array<Int64 like I>\nrange<I1, ..., In> : virtual Array<Int64 like I1, ..., In>",
    doc: "Virtual index-range array: its values are the index positions themselves — defined by the index type, no storage, never materialized until a pipeline forces it. Multi-index form spans the product space (elements follow the innermost index). Anonymous counterpart: `lo..hi`.",
  },
  reverse: {
    category: "virtual",
    sig: "reverse<I> : virtual Array<Int64 like I>",
    doc: "Reversed index positions of I — same virtual-array kind as range<>. Planned: parses today, but of the virtual-array family only range<> (and the anonymous lo..hi) is fully implemented; reverse<> and blocked<I, K> are still landing.",
  },

  // --- Autodiff (Grad.fs) -------------------------------------------------------
  // Gated on `import ad [as <alias>]`, called qualified (ad.grad(f)). Bare
  // `grad(...)` no longer resolves, and selective `from ad import ...` is
  // rejected by the compiler (it would reintroduce global names).

  grad: {
    category: "autodiff",
    doc: "Reverse-mode derivative of a function: `import ad as ad`, then ad.grad(f) — bare grad(...) is unbound. f must be a named top-level function (e.g. ad.grad(loss)); both direct calls ad.grad(f)(args..., buffers...) and bindings let g = ad.grad(f) work. Array gradients accumulate into caller-allocated mut out-buffers (caller zeroes them); the primal value is returned.",
    params: [
      { name: "f", type: "function", doc: "named top-level differentiable function" },
    ],
    ret: "gradient function (primal args + mut out-buffers) -> primal value",
  },
};

// --- Math intrinsics (Grad.fs mathIntrinsics; TypeCheck.fs) ------------------
// All unary and scalar-only with result Float64: Int operands promote,
// complex is rejected, and an array operand is a type error — map with a
// kernel instead. A user binding with the same name shadows the intrinsic.

const MATH = {
  exp: "Exponential e^x.",
  log: "Natural logarithm ln(x).",
  sqrt: "Square root.",
  sin: "Sine (radians).",
  cos: "Cosine (radians).",
  tan: "Tangent (radians).",
  sinh: "Hyperbolic sine.",
  cosh: "Hyperbolic cosine.",
  tanh: "Hyperbolic tangent.",
  asin: "Inverse sine (radians).",
  acos: "Inverse cosine (radians).",
  atan: "Inverse tangent (radians).",
  floor: "Round down (toward negative infinity).",
  ceil: "Round up (toward positive infinity).",
};
for (const [name, doc] of Object.entries(MATH)) {
  identifiers[name] = {
    category: "math",
    doc:
      doc +
      ` Scalar-only — map over an array with a kernel (method_for(A) <@> lambda(x) -> ${name}(x) |> compute). A user binding named ${name} shadows the intrinsic.`,
    params: [{ name: "x", type: "Float", doc: "numeric scalar (Int promotes)" }],
    ret: "Float64",
  };
}

identifiers.abs = {
  category: "math",
  doc: "Absolute value. Unlike the other math intrinsics, abs preserves the operand's numeric type (Int stays Int, Float stays Float). Scalar-only; a user binding named abs shadows it.",
  params: [{ name: "x", type: "Int | Float", doc: "numeric scalar" }],
  ret: "same numeric type as x",
};

// --- Static-evaluator-only builtins (StaticEval.fs evalBuiltin) --------------
// Resolve only in `let static` contexts. At runtime min/max are written as
// reduce fold kernels, not intrinsics.

identifiers.min = {
  category: "static",
  doc: "Smaller of two static numbers. Static evaluator only (`let static` contexts) — at runtime, write a reduce fold kernel instead.",
  params: [
    { name: "a", type: "Int | Float (static)", doc: "first value" },
    { name: "b", type: "Int | Float (static)", doc: "second value" },
  ],
  ret: "same type (static)",
};
identifiers.max = {
  category: "static",
  doc: "Larger of two static numbers. Static evaluator only (`let static` contexts) — at runtime, write a reduce fold kernel instead.",
  params: [
    { name: "a", type: "Int | Float (static)", doc: "first value" },
    { name: "b", type: "Int | Float (static)", doc: "second value" },
  ],
  ret: "same type (static)",
};
identifiers.length = {
  category: "static",
  doc: "Length of a static array or tuple. Static evaluator only (`let static` contexts) — at runtime use extents.",
  params: [{ name: "xs", type: "static array | tuple", doc: "compile-time value to measure" }],
  ret: "Int (static)",
};

// --- PPL formers (ppl/compiler/PplElaborate.fs) ------------------------------
// Gated on `import ppl`, called qualified (ppl.moments(...)). Formers must be
// the ENTIRE right-hand side of a top-level let; the source array must be a
// module-level let with an Array annotation whose LAST declared index is the
// sample (fiber) axis, extents statically known. The RHS-only note is
// appended to each doc below (cumulant and independent carry their own
// placement rules).

const PPL_FORMERS = {
  moments: {
    doc: "Raw-moment tower mu_1..mu_k of a sample array — or, on a previously declared dist binding, the kappa->mu (cumulant-to-moment) reconstruction.",
    params: [
      { name: "A", type: "Array<Float, ..., SampleIdx> | dist", doc: "annotated module-level sample array, or a dist binding" },
      { name: "k", type: "Int (static)", doc: "highest order, >= 1 (1..8 on a dist)" },
    ],
    ret: "moment tensors mu_1..mu_k (SymIdx-packed over the leading axes)",
  },
  comoments: {
    doc: "Central comoments: comoments(A, 2) is the same-array covariance block; comoments(X, Y) the cross-covariance block between two arrays (rectangular, zero if declared independent).",
    params: [
      { name: "X", type: "Array<Float, ..., SampleIdx>", doc: "annotated module-level sample array" },
      { name: "k_or_Y", type: "2 | Array<Float, ..., SampleIdx>", doc: "the static order 2 (same-array), or a second array (cross block)" },
    ],
    ret: "central comoment block",
  },
  cumulants: {
    doc: "Cumulant tower kappa_1..kappa_r of a sample array (Möbius inversion over set partitions).",
    params: [
      { name: "A", type: "Array<Float, ..., SampleIdx>", doc: "annotated module-level sample array" },
      { name: "r", type: "Int (static)", doc: "highest order, 1..6" },
    ],
    ret: "cumulant tensors kappa_1..kappa_r (SymIdx-packed)",
  },
  free_cumulants: {
    doc: "Free-probability cumulants of a sample array (order 1..6).",
    params: [
      { name: "A", type: "Array<Float, ..., SampleIdx>", doc: "annotated module-level sample array" },
      { name: "r", type: "Int (static)", doc: "highest order, 1..6" },
    ],
    ret: "free-cumulant tensors",
  },
  mixed_cumulants: {
    doc: "Mixed cumulants across two sample arrays, order p in the first and q in the second.",
    params: [
      { name: "X", type: "Array<Float, ..., SampleIdx>", doc: "first annotated sample array" },
      { name: "Y", type: "Array<Float, ..., SampleIdx>", doc: "second annotated sample array" },
      { name: "p", type: "Int (static)", doc: "order in X, 1..5" },
      { name: "q", type: "Int (static)", doc: "order in Y, 1..5" },
    ],
    ret: "mixed-cumulant tensors",
  },
  comoments_merge: {
    doc: "Merges two data chunks' pair comoments into the whole-data covariance: takes each chunk's comoments, means, and static size.",
    params: [
      { name: "cA", type: "comoments of chunk A", doc: "pair comoments of the first chunk" },
      { name: "mA", type: "means of chunk A", doc: "per-variable means of the first chunk" },
      { name: "nA", type: "Int (static)", doc: "first chunk's sample count" },
      { name: "cB", type: "comoments of chunk B", doc: "pair comoments of the second chunk" },
      { name: "mB", type: "means of chunk B", doc: "per-variable means of the second chunk" },
      { name: "nB", type: "Int (static)", doc: "second chunk's sample count" },
    ],
    ret: "merged pair comoments",
  },
  dist: {
    doc: "Constructs a Dist cumulant tower from a sample array: carries kappa_1..kappa_r over the variable axes. Project with ppl.cumulant(d, k); combine with +, scalar *, dist_add, dist_scale under declared independence.",
    params: [
      { name: "A", type: "Array<Float, ..., SampleIdx>", doc: "annotated module-level sample array" },
      { name: "r", type: "Int (static)", doc: "carried order, 1..6" },
    ],
    ret: "Dist<r, Elem like axes>",
  },
  dist_add: {
    doc: "Sum of two independent dist bindings (cumulants add order-by-order).",
    params: [
      { name: "d1", type: "Dist", doc: "previously declared dist binding" },
      { name: "d2", type: "Dist", doc: "previously declared dist binding" },
    ],
    ret: "Dist",
  },
  dist_scale: {
    doc: "Scales a dist by a scalar c (kappa_k scales by c^k).",
    params: [
      { name: "c", type: "Float", doc: "scale factor" },
      { name: "d", type: "Dist", doc: "previously declared dist binding" },
    ],
    ret: "Dist",
  },
  dist_affine: {
    doc: "Affine pushforward of a dist through a static m×n matrix W (an annotated module-level Array<Elem like Idx<m>, Idx<n>>): returns the pushed-forward cumulant arrays for tuple-destructuring.",
    params: [
      { name: "W", type: "Array<Float like Idx<m>, Idx<n>>", doc: "annotated module-level matrix, extents static" },
      { name: "d", type: "Dist", doc: "previously declared dist binding" },
    ],
    ret: "(h1, h2, ...) pushed cumulant arrays",
  },
  dist_jet: {
    doc: "Jet pushforward of a dist through derivative data supplied at the mean: g0 = g(mu) plus derivative tensors D1..Ds (Dk rank-1 in canonical lex order over the dist's dimension).",
    params: [
      { name: "d", type: "Dist", doc: "previously declared dist binding" },
      { name: "q", type: "Int (static)", doc: "output order, 1..6" },
      { name: "g0", type: "Float", doc: "g evaluated at the mean" },
      { name: "D1..Ds", type: "Array | literal", doc: "derivative tensors at the mean, one per degree" },
    ],
    ret: "Dist<q>",
  },
  dist_jet_closed: {
    doc: "Closed-form variant of dist_jet: same jet pushforward, cumulants propagated in closed form.",
    params: [
      { name: "d", type: "Dist", doc: "previously declared dist binding" },
      { name: "q", type: "Int (static)", doc: "output order, 1..6" },
      { name: "g0", type: "Float", doc: "g evaluated at the mean" },
      { name: "D1..Ds", type: "Array | literal", doc: "derivative tensors at the mean, one per degree" },
    ],
    ret: "Dist<q>",
  },
  dist_map: {
    doc: "Faà di Bruno pushforward: maps a dist through a lambda, differentiated symbolically at the mean. Optional s bounds the truncation degree (1..8).",
    params: [
      { name: "d", type: "Dist", doc: "previously declared dist binding" },
      { name: "q", type: "Int (static)", doc: "output order, 1..6" },
      { name: "s_or_fn", type: "Int (static) | lambda(x...) -> expr", doc: "truncation degree s (then the lambda follows), or the lambda directly" },
      { name: "fn", type: "lambda(x...) -> expr  (when s given)", doc: "pushforward map, one parameter per dist variable" },
    ],
    ret: "Dist<q>",
  },
  dist_map_closed: {
    doc: "Closed-form variant of dist_map: same symbolic Faà di Bruno pushforward with closed-form cumulant propagation.",
    params: [
      { name: "d", type: "Dist", doc: "previously declared dist binding" },
      { name: "q", type: "Int (static)", doc: "output order, 1..6" },
      { name: "s_or_fn", type: "Int (static) | lambda(x...) -> expr", doc: "truncation degree s (then the lambda follows), or the lambda directly" },
      { name: "fn", type: "lambda(x...) -> expr  (when s given)", doc: "pushforward map, one parameter per dist variable" },
    ],
    ret: "Dist<q>",
  },
  mstate: {
    doc: "Streaming sufficient-statistic state for order-r cumulants of a sample array — a compile-time monoid object; merge with mstate_merge, freeze with mstate_cumulants.",
    params: [
      { name: "A", type: "Array<Float, ..., SampleIdx>", doc: "annotated module-level sample array" },
      { name: "r", type: "Int (static)", doc: "order, 2..6" },
    ],
    ret: "mstate object",
  },
  mstate_merge: {
    doc: "Merges two previously declared mstate objects into one (the monoid operation).",
    params: [
      { name: "sA", type: "mstate", doc: "previously declared mstate binding" },
      { name: "sB", type: "mstate", doc: "previously declared mstate binding" },
    ],
    ret: "mstate object",
  },
  mstate_cumulants: {
    doc: "Freezes an mstate into its cumulant tensors, for tuple-destructuring: `let (k1, k2) = ppl.mstate_cumulants(s)`.",
    params: [
      { name: "s", type: "mstate", doc: "previously declared mstate binding" },
    ],
    ret: "(kappa_1, ..., kappa_r) cumulant tensors",
  },
};
for (const [name, entry] of Object.entries(PPL_FORMERS)) {
  identifiers[name] = {
    category: "ppl",
    ...entry,
    doc: entry.doc + ` Must be the entire right-hand side of a top-level let: \`let x = ppl.${name}(...)\`.`,
  };
}

identifiers.independent = {
  category: "ppl",
  doc: "Declares two arrays statistically independent. Written exactly as `let _ = ppl.independent(X, Y)` (a consumed declaration): their cross comoments elaborate to a literal zero block and Dist `+` between their dists is licensed. Scoped alternative: a struct or function `where p.indep(a, b)` license (qualified with the ppl import's alias).",
  params: [
    { name: "X", type: "Array (module-level name)", doc: "first array" },
    { name: "Y", type: "Array (module-level name)", doc: "second array (distinct from X)" },
  ],
  ret: "declaration (bind to _)",
};
identifiers.cumulant = {
  category: "ppl",
  doc: "Projects cumulant component k out of a Dist-typed value as an ordinary array. Unlike the formers, valid in any expression position; k must be a compile-time integer <= the dist's carried order.",
  params: [
    { name: "d", type: "Dist<r, ...>", doc: "dist value" },
    { name: "k", type: "Int (static)", doc: "component order, 1..r" },
  ],
  ret: "Array (the kappa_k component)",
};

// --- ML surface (ml/compiler/MLElaborate.fs, MLStatics.fs) -------------------
// Gated on `import ml as ml`, called qualified (ml.y_to(...)). Op configs and
// specs must be `let static` bindings; a spec is a static array of
// (l, parity, mult) tuples, e.g. `let static spec = [(0, 0, 2), (1, 1, 2)]`.

identifiers.y_to = {
  category: "ml",
  doc: "Spherical-harmonic embedding of a 3D direction up to degree LMAX: the equivariant feature vector for the (x, y, z) direction.",
  params: [
    { name: "LMAX", type: "Int (static)", doc: "highest harmonic degree (static int or literal)" },
    { name: "x", type: "Float", doc: "direction x component" },
    { name: "y", type: "Float", doc: "direction y component" },
    { name: "z", type: "Float", doc: "direction z component" },
  ],
  ret: "irreps vector Array<Float, Idx<total_dim(sh_spec(LMAX))>>",
};
identifiers.tensor_product = {
  category: "ml",
  doc: "Equivariant tensor product of two irreps vectors with per-path weights. CFG must be a `let static` (spec1, spec2, specOut) triple; every output irrep must be reachable from the inputs.",
  params: [
    { name: "CFG", type: "(spec, spec, spec) (static)", doc: "input/input/output irreps specs" },
    { name: "x", type: "Array<Float, Idx<dim1>>", doc: "left irreps vector" },
    { name: "y", type: "Array<Float, Idx<dim2>>", doc: "right irreps vector" },
    { name: "w", type: "Array<Float, Idx<wdim>>", doc: "path weights; wdim = ml.tp_weight_dim(CFG)" },
  ],
  ret: "Array<Float, Idx<dimOut>>",
};
identifiers.linear = {
  category: "ml",
  doc: "Equivariant linear layer between irreps spaces: block-diagonal mixing within matching (l, parity) blocks.",
  params: [
    { name: "SPEC_IN", type: "spec (static)", doc: "input irreps spec" },
    { name: "SPEC_OUT", type: "spec (static)", doc: "output irreps spec" },
    { name: "w", type: "Array<Float, Idx<wdim>>", doc: "weights; wdim = ml.linear_weight_dim(SPEC_IN, SPEC_OUT)" },
    { name: "x", type: "Array<Float, Idx<dimIn>>", doc: "input irreps vector" },
  ],
  ret: "Array<Float, Idx<dimOut>>",
};
identifiers.linear_rows = {
  category: "ml",
  doc: "Batched equivariant linear layer: applies the same block-diagonal mixing to NROWS stacked irreps rows.",
  params: [
    { name: "SPEC_IN", type: "spec (static)", doc: "input irreps spec" },
    { name: "SPEC_OUT", type: "spec (static)", doc: "output irreps spec" },
    { name: "NROWS", type: "Int (static)", doc: "row count, >= 1" },
    { name: "w", type: "Array<Float, Idx<wdim>>", doc: "weights; wdim = ml.linear_weight_dim(SPEC_IN, SPEC_OUT)" },
    { name: "x", type: "Array<Float, Idx<NROWS * dimIn>>", doc: "stacked input rows" },
  ],
  ret: "Array<Float, Idx<NROWS * dimOut>>",
};
identifiers.gated = {
  category: "ml",
  doc: "Gated equivariant nonlinearity: each irreps block is scaled by a sigmoid gate (scalar blocks gate themselves).",
  params: [
    { name: "SPEC", type: "spec (static)", doc: "irreps spec of x" },
    { name: "x", type: "Array<Float, Idx<dim>>", doc: "irreps vector" },
  ],
  ret: "Array<Float, Idx<dim>>",
};
identifiers.gated_rows = {
  category: "ml",
  doc: "Batched gated nonlinearity: applies the per-block sigmoid gating to NROWS stacked irreps rows.",
  params: [
    { name: "SPEC", type: "spec (static)", doc: "irreps spec of each row" },
    { name: "NROWS", type: "Int (static)", doc: "row count, >= 1" },
    { name: "x", type: "Array<Float, Idx<NROWS * dim>>", doc: "stacked input rows" },
  ],
  ret: "Array<Float, Idx<NROWS * dim>>",
};

// ML sizing/navigation statics: fully static (fold at compile time), used in
// `let static` positions; block accessors take a 0-based block index into
// the spec.
const ML_STATICS = {
  sh_spec: {
    doc: "The (l, parity, mult) irreps spec of spherical harmonics up to degree lmax.",
    params: [{ name: "lmax", type: "Int (static)", doc: "highest degree, >= 0" }],
    ret: "spec (static)",
  },
  total_dim: {
    doc: "Total flattened dimension of an irreps spec (sum of mult * (2l + 1) over blocks).",
    params: [{ name: "spec", type: "spec (static)", doc: "irreps spec" }],
    ret: "Int (static)",
  },
  tp_weight_dim: {
    doc: "Number of tensor_product path weights for a config.",
    params: [{ name: "cfg", type: "(spec, spec, spec) (static)", doc: "tensor_product config triple" }],
    ret: "Int (static)",
  },
  linear_weight_dim: {
    doc: "Number of linear-layer weights between two irreps specs.",
    params: [
      { name: "specIn", type: "spec (static)", doc: "input irreps spec" },
      { name: "specOut", type: "spec (static)", doc: "output irreps spec" },
    ],
    ret: "Int (static)",
  },
  irreps_len: {
    doc: "Number of blocks in an irreps spec.",
    params: [{ name: "spec", type: "spec (static)", doc: "irreps spec" }],
    ret: "Int (static)",
  },
  irreps_l: {
    doc: "Degree l of block b of an irreps spec.",
    params: [
      { name: "spec", type: "spec (static)", doc: "irreps spec" },
      { name: "b", type: "Int (static)", doc: "0-based block index" },
    ],
    ret: "Int (static)",
  },
  irreps_parity: {
    doc: "Parity of block b of an irreps spec.",
    params: [
      { name: "spec", type: "spec (static)", doc: "irreps spec" },
      { name: "b", type: "Int (static)", doc: "0-based block index" },
    ],
    ret: "Int (static)",
  },
  irreps_mult: {
    doc: "Multiplicity of block b of an irreps spec.",
    params: [
      { name: "spec", type: "spec (static)", doc: "irreps spec" },
      { name: "b", type: "Int (static)", doc: "0-based block index" },
    ],
    ret: "Int (static)",
  },
  irreps_dim: {
    doc: "Per-copy dimension (2l + 1) of block b of an irreps spec.",
    params: [
      { name: "spec", type: "spec (static)", doc: "irreps spec" },
      { name: "b", type: "Int (static)", doc: "0-based block index" },
    ],
    ret: "Int (static)",
  },
  irreps_offset: {
    doc: "Flattened start offset of block b — with irreps_dim/irreps_mult, the block-structured loop bounds: x(irreps_offset(spec, b) + mu * irreps_dim(spec, b) + m).",
    params: [
      { name: "spec", type: "spec (static)", doc: "irreps spec" },
      { name: "b", type: "Int (static)", doc: "0-based block index" },
    ],
    ret: "Int (static)",
  },
};
for (const [name, entry] of Object.entries(ML_STATICS)) {
  identifiers[name] = { category: "ml", ...entry };
}

// --- Module names -------------------------------------------------------------
// Hover targets for the import-gated modules themselves (`import ad as ad`,
// `ad.grad(...)`). Sig-form entries — a module name is not a paren call.
// Matching is by bare word, so these fire on the canonical names; a custom
// alias (`import ppl as p`) hovers as the alias only where the compiler
// reports a binding for it.

identifiers.ad = {
  category: "module",
  sig: "import ad as ad",
  doc: "Autodiff module. Surface: ad.grad(f) — reverse-mode derivative of a named top-level function. Only `import ad [as <alias>]` is allowed; selective `from ad import ...` is rejected, and bare grad(...) does not resolve.",
};
identifiers.ppl = {
  category: "module",
  sig: "import ppl as p",
  doc: "Probabilistic programming module. Surface (qualified through the import's alias): the formers moments, comoments, cumulants, free_cumulants, mixed_cumulants, comoments_merge, dist, dist_add, dist_scale, dist_affine, dist_jet(_closed), dist_map(_closed), mstate, mstate_merge, mstate_cumulants; plus cumulant(d, k) projection, the independent(X, Y) declaration, and the where-clause license `where p.indep(a, b)`.",
};
identifiers.ml = {
  category: "module",
  sig: "import ml as ml",
  doc: "Equivariant ML module. Surface (qualified through the import's alias): ops y_to, tensor_product, linear, linear_rows, gated, gated_rows; sizing/navigation statics sh_spec, total_dim, tp_weight_dim, linear_weight_dim, irreps_len, irreps_l, irreps_parity, irreps_mult, irreps_dim, irreps_offset.",
};

// --- Operators ----------------------------------------------------------------

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
  ">>": {
    sig: "f >> g",
    doc: "Function composition: applies f, then g.",
  },
  "..": {
    sig: "lo..hi",
    doc: "Anonymous virtual range over Int64 positions lo (inclusive) to hi (exclusive) — the same storage-free virtual-array kind as range<I>. Drives for-in loops and anonymous method_for spaces.",
  },
  "::": {
    sig: "head :: tail",
    doc: "Cons: prepends an element (also the list pattern form in match arms: `| h :: t -> ...`).",
  },
  "->": {
    sig: "lambda(x) -> expr    (T1, T2) -> R    | pat -> expr",
    doc: "Arrow: introduces a lambda/function result, a function type's codomain, and a match arm's body.",
  },
  "=>": {
    sig: "=>",
    doc: "Reserved operator token: lexed, but no parse rule uses it today.",
  },
  "<-": {
    sig: "<-",
    doc: "Reserved operator token: lexed, but no parse rule uses it today (assignment is `=` / `+=` on mut bindings).",
  },
  "+=": {
    sig: "x += e   (x mut)",
    doc: "Accumulating assignment on a mut binding: x = x + e. The accumulation form ad.grad() differentiates through.",
  },
  "-=": {
    sig: "x -= e   (x mut)",
    doc: "Subtracting assignment on a mut binding: x = x - e.",
  },
  "*=": {
    sig: "x *= e   (x mut)",
    doc: "Multiplying assignment on a mut binding: x = x * e.",
  },
  "/=": {
    sig: "x /= e   (x mut)",
    doc: "Dividing assignment on a mut binding: x = x / e.",
  },
};

// Bracketed outer-product operators [op]: one entry each, generated.
for (const op of ["+", "-", "*", "/", "%", "^", "==", "!=", "<", "<=", ">", ">=", "&&", "||"]) {
  operators[`[${op}]`] = {
    sig: `a [${op}] b -> outer product`,
    doc: `Outer ${op}: applies ${op} across all index combinations of the operands, producing a higher-rank array.`,
  };
}

module.exports = { identifiers, operators, categories };
