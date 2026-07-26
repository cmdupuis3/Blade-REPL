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
// X, Y, Z — so a reduction kernel reads `U -> T -> U` (accumulator U,
// element T). A function type is an "arrow" (domain -> codomain), written as
// a plain ML-style curried arrow — `T -> U`, never `lambda(T) -> U` (the
// wrapper is redundant; `lambda(x) -> expr` appears only where an argument
// must syntactically BE a lambda literal, e.g. dist_map). Arrays are the
// other kind of arrow, written `Array<T like ...>`. (Types the compiler
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
// ML sizing statics ml/compiler/MLStatics.fs; Cartesian<->irreps bridge
// specs ml/compiler/CartesianBridge.fs; rand surface
// rand/compiler/RandElaborate.fs; spectra surface
// spectra/compiler/SpectraElaborate.fs; sgs surface
// sgs/compiler/SgsElaborate.fs; static-only builtins StaticEval.fs
// evalBuiltin.

"use strict";

// Category -> hover badge text. Rendered as an italic line under the
// signature block; also drives completion detail and the consistency check.
const categories = {
  core: "Builtin",
  virtual: "Virtual array",
  autodiff: "Autodifferentiation — requires `import ad`",
  math: "Math intrinsic — requires `import math`",
  static: "Static builtin — statically evaluable native functions for `let static` contexts",
  ppl: "PPL — requires `import ppl`",
  ml: "ML — requires `import ml`",
  module: "Module — requires `import <module>`",
};

// --- Core: loop builders, combinators, array/SQL algebra ---------------------

const identifiers = {
  method_for: {
    category: "core",
    doc: "Builds a method loop over the given arrays' outer iteration space. Apply to a kernel with <@>.",
    params: [
      { name: "a, ...", type: "(Idx... -> T)...", doc: "Tuple of arrays (or a single zip(...))" },
    ],
    ret: "MethodLoop<n>",
  },
  object_for: {
    category: "core",
    doc: "Builds an object loop from a kernel function. Apply to an array tuple with <@>.",
    params: [
      { name: "kernel", type: "T... -> U", doc: "Kernel function" },
    ],
    ret: "ObjectLoop<n>",
  },
  compute: {
    category: "core",
    doc: "Evaluates a computation. Used as a pipe terminal: `comp |> compute`.",
    params: [
      { name: "comp", type: "Computation<T>", doc: "Unevaluated computation resulting from loop application" },
    ],
    ret: "T",
  },
  pure: {
    category: "core",
    doc: "Wraps a value as a pure computation.",
    params: [
      { name: "value", type: "T", doc: "Value to lift" },
    ],
    ret: "Computation<T>",
  },
  read: {
    category: "core",
    doc: "Read terminal for a file-provided value: `value |> read`.",
    params: [
      { name: "value", type: "T", doc: "File-provided value to read" },
    ],
    ret: "T",
  },
  reduce: {
    category: "core",
    doc: "Reduction over an array or unforced deferred pipeline (fused into one loop nest with scalar accumulators when deferred).",
    params: [
      { name: "array", type: "(Idx... -> T) | deferred", doc: "Array (or unforced pipeline) to reduce" },
      { name: "kernel", type: "U -> T -> U", doc: "Combining function (accumulator first)" },
      { name: "init", type: "U  (optional)", doc: "Initial accumulator; defaults to the (+)/(*) section identity — required for other kernels over rank >= 2 or deferred inputs" },
    ],
    ret: "U",
  },
  mask: {
    category: "core",
    doc: "Builds the Bool selection mask of a predicate over an array: evaluates the predicate elementwise, keeping the source's exact index records. Positions, not values — compose masks with elementwise Bool algebra, compact with compound(A, m), iterate the filtered space with range<CompoundIdx<m>>.",
    params: [
      { name: "array", type: "Idx... -> T", doc: "source array" },
      { name: "predicate", type: "T -> Bool", doc: "per-element selection predicate" },
    ],
    ret: "Idx... -> Bool  (same index space as the source)",
  },
  compound: {
    category: "core",
    doc: "Compacts a dense array through a boolean mask over its leading dimensions into a compound (sparse) view — the in-language analog of a provider's load_compound.",
    params: [
      { name: "dense", type: "Idx... -> T", doc: "dense source values" },
      { name: "mask", type: "Idx... -> Bool", doc: "present/absent mask over a leading prefix of the dense array's dims; must live over its exact index space (build with mask())" },
    ],
    ret: "Array<T, CompoundIdx<mask>, Idx...>  (compact view)",
  },
  zip: {
    category: "core",
    doc: "Co-iterates arrays over a shared index space.",
    params: [
      { name: "a, ...", type: "(Idx... -> Tn)...", doc: "arrays sharing an index space" },
    ],
    ret: "Idx... -> (T1, ..., Tn)",
  },
  stack: {
    category: "core",
    doc: "Stacks arrays along a new leading dimension.",
    params: [
      { name: "a, ...", type: "(Idx... -> T)...", doc: "same-shaped arrays to stack" },
    ],
    ret: "Idx<n> -> Idx... -> T",
  },
  sort: {
    category: "core",
    doc: "Sorts a rank-1 array (stable, ascending by key). Rearrangement combinator; forces deferred inputs.",
    params: [
      { name: "array", type: "Idx<n> -> T", doc: "Rank-1 array of values to sort" },
      { name: "key", type: "T -> U  (optional)", doc: "Sort key; defaults to the element itself" },
    ],
    ret: "Idx<n> -> T",
  },
  unique: {
    category: "core",
    doc: "Distinct elements, preserving first-occurrence order. Rearrangement combinator; forces deferred inputs.",
    params: [
      { name: "array", type: "Idx... -> T", doc: "source values" },
    ],
    ret: "Idx<u> -> T  (fresh dynamic-extent axis)",
  },
  intersect: {
    category: "core",
    doc: "Set intersection of two arrays. Forces deferred inputs.",
    params: [
      { name: "a", type: "Idx... -> T", doc: "left operand" },
      { name: "b", type: "Idx... -> T", doc: "right operand" },
    ],
    ret: "Idx<u> -> T  (fresh dynamic-extent axis)",
  },
  union: {
    category: "core",
    doc: "Set union of two arrays. Forces deferred inputs.",
    params: [
      { name: "a", type: "Idx... -> T", doc: "left operand" },
      { name: "b", type: "Idx... -> T", doc: "right operand" },
    ],
    ret: "Idx<u> -> T  (fresh dynamic-extent axis)",
  },
  contains: {
    category: "core",
    doc: "Membership test.",
    params: [
      { name: "array", type: "Idx... -> T", doc: "values to search" },
      { name: "value", type: "T", doc: "element to look for" },
    ],
    ret: "Bool",
  },
  group_by: {
    category: "core",
    doc: "Groups a rank-1 values array through a grouping structure into a rank-2 groups × members array. Shared rearrangement helper; forces deferred inputs.",
    params: [
      { name: "values", type: "Idx1 -> T", doc: "values to group (over the source axis)" },
      { name: "grouping", type: "GroupKeys<Idx2, Idx1>", doc: "grouping structure over the same source axis" },
    ],
    ret: "Idx2 -> IdxM -> T  (IdxM: ragged member axis)",
  },
  group_keys: {
    category: "core",
    doc: "Builds the grouping structure (key set + membership) from rank-1 key arrays over one shared source axis; 2+ keys form a compound grouping (one bucket per distinct tuple). Indexable alongside group_by results.",
    params: [
      { name: "k, ...", type: "(Idx1 -> T)...", doc: "key arrays over the shared source axis" },
    ],
    ret: "GroupKeys<Idx2, Idx1>  (group axis Idx2, source axis Idx1)",
  },
  transpose: {
    category: "core",
    doc: "Hard-transposes two dimensions (a physical data move between plain axes). Within one symmetry group it resolves storage-preservingly instead: symmetric — identity, antisymmetric — negation, hermitian — conjugation.",
    params: [
      { name: "array", type: "Idx1 -> Idx2 -> ... -> T", doc: "source array (rank >= 2)" },
      { name: "d1", type: "Int (static)", doc: "first dimension to transpose" },
      { name: "d2", type: "Int (static)", doc: "second dimension to transpose" },
    ],
    ret: "Idx... -> T  (dims d1 and d2 swapped)",
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
    doc: "Gram product gram(A, B) = A * B^H: result[i, j] = sum_k A[i, k] * conj(B[j, k]) over the shared trailing axis (complex element iff either operand is complex). gram(A) — or B syntactically the same array — yields the square symmetric (real) / Hermitian (complex) form, packed triangular.",
    params: [
      { name: "a", type: "Array<T, Idx<m>, Idx<n>>", doc: "left factor (rank 2)" },
      { name: "b", type: "Array<T, Idx<p>, Idx<n>>  (optional)", doc: "right factor sharing the trailing axis; defaults to `a`" },
    ],
    ret: "Array<T, Idx<m>, Idx<p>>  (same-array: SymIdx<2, m> / HermitianIdx<m> packed)",
  },
  replicate: {
    category: "core",
    doc: "Repeats a computation `count` times into an array.",
    params: [
      { name: "count", type: "Int64 (static)", doc: "number of repetitions (a literal, `let static`, or static-function call)" },
      { name: "body", type: "T", doc: "expression evaluated per repetition" },
    ],
    ret: "Array<T, Idx<count>>",
  },
  sequence: {
    category: "core",
    doc: "Assembles same-typed expressions into an array along a fresh leading Idx<n> axis (n = the expression count; element types unify, array elements nest under the new axis).",
    params: [
      { name: "e, ...", type: "T", doc: "expressions, evaluated left to right" },
    ],
    ret: "Array<T, Idx<n>>",
  },
  extents: {
    category: "core",
    doc: "The array's extents, answered from the type when statically known: rank 1 — the extent itself; higher rank — a tuple with one Int64 per dimension. Ragged, grouped, and compound dims reject (no scalar extent exists).",
    params: [
      { name: "array", type: "Array<T, Idx...>", doc: "array to measure" },
    ],
    ret: "Int64 | (Int64, ..., Int64)",
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
      { name: "x", type: "T  (Complex128 | Array<Complex128, Idx...>)", doc: "value or array to conjugate" },
    ],
    ret: "T",
  },
  hermitian: {
    category: "core",
    doc: "Conjugate transpose (adjoint) A^H — sugar for conj(transpose(A, 0, 1)). The name is the operation, not the property: the result is a plain dense array, NOT a Hermitian-typed matrix (that producer is gram on a complex array).",
    params: [
      { name: "array", type: "Array<Complex128, Idx<m>, Idx<n>>", doc: "complex matrix (rank 2)" },
    ],
    ret: "Array<Complex128, Idx<n>, Idx<m>>",
  },
  guard: {
    category: "core",
    doc: "Evaluates the body only where the condition holds. Also a reserved keyword (cannot be rebound).",
    params: [
      { name: "cond", type: "Bool", doc: "guard condition" },
      { name: "body", type: "T", doc: "expression evaluated when the condition holds" },
    ],
    ret: "T",
  },
  reynolds: {
    category: "core",
    doc: "Reynolds operator: group-averages a kernel over its argument permutations — reynolds(f) yields the symmetrized kernel (f(x, y) + f(y, x)); reynolds(f, Antisymmetric) the sign-weighted average. Feeds <@> like any kernel; results pack into SymIdx / AntisymIdx storage.",
    params: [
      { name: "kernel", type: "T... -> U", doc: "kernel to symmetrize" },
      { name: "symmetry", type: "Antisymmetric  (optional)", doc: "sign-weighted (antisymmetric) averaging; default symmetric" },
    ],
    ret: "T... -> U  (same type as the kernel)",
  },
  zero: {
    category: "core",
    doc: "The zero element of the expected type (context-typed).",
    params: [],
    ret: "T",
  },
  rank: {
    category: "core",
    doc: "Number of dimensions of an array. Typed Int64 in any context; folds statically when the operand's rank is known.",
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
    ret: "Array<T, Idx...>  (shape from the binding's annotation)",
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
    ret: "primal args... -> mut out-buffers... -> T  (the primal value)",
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
  params: [{ name: "x", type: "T  (Int | Float)", doc: "numeric scalar" }],
  ret: "T",
};

// --- Static-evaluator-only builtins (StaticEval.fs evalBuiltin) --------------
// Resolve only in `let static` contexts. At runtime min/max are written as
// reduce fold kernels, not intrinsics. (rank and arity are NOT static-only:
// they are keywords typed Int64 in any context that merely fold statically —
// see their core entries above.)

identifiers.min = {
  category: "static",
  doc: "Smaller of two static numbers. Static evaluator only (`let static` contexts) — at runtime, write a reduce fold kernel instead.",
  params: [
    { name: "a", type: "T  (static Int | Float)", doc: "first value" },
    { name: "b", type: "T", doc: "second value (same numeric type; no int/float mixing)" },
  ],
  ret: "T (static)",
};
identifiers.max = {
  category: "static",
  doc: "Larger of two static numbers. Static evaluator only (`let static` contexts) — at runtime, write a reduce fold kernel instead.",
  params: [
    { name: "a", type: "T  (static Int | Float)", doc: "first value" },
    { name: "b", type: "T", doc: "second value (same numeric type; no int/float mixing)" },
  ],
  ret: "T (static)",
};
identifiers.length = {
  category: "static",
  doc: "Length of a static array or tuple. Static evaluator only (`let static` contexts) — at runtime use extents.",
  params: [{ name: "xs", type: "array | tuple  (static)", doc: "compile-time value to measure" }],
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
    ret: "(mu_1, ..., mu_k)  (SymIdx-packed moment tensors over the leading axes)",
  },
  comoments: {
    doc: "Central comoments: comoments(A, 2) is the same-array covariance block; comoments(X, Y) the cross-covariance block between two arrays (rectangular, zero if declared independent).",
    params: [
      { name: "X", type: "Array<Float, ..., SampleIdx>", doc: "annotated module-level sample array" },
      { name: "k_or_Y", type: "2 | Array<Float, ..., SampleIdx>", doc: "the static order 2 (same-array), or a second array (cross block)" },
    ],
    ret: "Array<Float, SymIdx<2, d>> | Array<Float, Idx<d1>, Idx<d2>>  (same-array / cross block)",
  },
  cumulants: {
    doc: "Cumulant tower kappa_1..kappa_r of a sample array (Möbius inversion over set partitions).",
    params: [
      { name: "A", type: "Array<Float, ..., SampleIdx>", doc: "annotated module-level sample array" },
      { name: "r", type: "Int (static)", doc: "highest order, 1..6" },
    ],
    ret: "(kappa_1, ..., kappa_r)  (SymIdx-packed cumulant tensors)",
  },
  free_cumulants: {
    doc: "Free-probability cumulants of a sample array (order 1..6).",
    params: [
      { name: "A", type: "Array<Float, ..., SampleIdx>", doc: "annotated module-level sample array" },
      { name: "r", type: "Int (static)", doc: "highest order, 1..6" },
    ],
    ret: "(kappa_1, ..., kappa_r)  (free-cumulant tensors)",
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
      { name: "cA", type: "Array<Float, SymIdx<2, d>>", doc: "pair comoments of the first chunk (a module-level comoments binding, by name)" },
      { name: "mA", type: "Array<Float, Idx<d>>", doc: "per-variable means of the first chunk (by name)" },
      { name: "nA", type: "Int (static)", doc: "first chunk's sample count, >= 1" },
      { name: "cB", type: "Array<Float, SymIdx<2, d>>", doc: "pair comoments of the second chunk (by name)" },
      { name: "mB", type: "Array<Float, Idx<d>>", doc: "per-variable means of the second chunk (by name)" },
      { name: "nB", type: "Int (static)", doc: "second chunk's sample count, >= 1" },
    ],
    ret: "Array<Float, SymIdx<2, d>>  (merged pair comoments)",
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
    ret: "(kappa_1, ..., kappa_r)  (cumulant tensors)",
  },
  dist_expect: {
    doc: "Expectation of a polynomial under a univariate dist: E[c0 + c1 X + ... + cq X^q], read from the dist's raw-moment reconstruction (degree q <= 8).",
    params: [
      { name: "d", type: "Dist  (univariate)", doc: "previously declared dist binding" },
      { name: "c0..cq", type: "Float", doc: "polynomial coefficients, constant first" },
    ],
    ret: "Float64  (scalar expectation)",
  },
  dist_reweight: {
    doc: "Polynomial reweighting (tower Bayes) of a univariate dist: multiplies the quasi-density by w(x) = c0 + ... + cq x^q and renormalizes. A degree-q weight consumes q orders of the tower, so the result carries order r - q (must be >= 1).",
    params: [
      { name: "d", type: "Dist<r>  (univariate)", doc: "previously declared dist binding" },
      { name: "c0..cq", type: "Float", doc: "weight-polynomial coefficients, constant first" },
    ],
    ret: "Dist<r - q>",
  },
  dist_mix: {
    doc: "Two-component mixture of univariate dists with scalar weights, normalized by w1 + w2; the result carries order min(r1, r2).",
    params: [
      { name: "w1", type: "Float", doc: "first mixture weight (any pure scalar expression)" },
      { name: "d1", type: "Dist<r1>  (univariate)", doc: "previously declared dist binding" },
      { name: "w2", type: "Float", doc: "second mixture weight" },
      { name: "d2", type: "Dist<r2>  (univariate)", doc: "previously declared dist binding" },
    ],
    ret: "Dist<min(r1, r2)>",
  },
  dist_atoms: {
    doc: "Order-r tower of the atomic quasi-measure w1*delta(x1) + ... + wk*delta(xk), normalized by the weight sum. Deliberately sign-agnostic: weights may be negative, so non-classical towers (negative variance included) are carryable values.",
    params: [
      { name: "r", type: "Int (static)", doc: "carried order, 1..6" },
      { name: "x1, w1, ...", type: "Float", doc: "atom positions and weights, alternating (k >= 1 atoms)" },
    ],
    ret: "Dist<r>",
  },
  dist_negativity: {
    doc: "L1 negativity of a dist read as a quasi-distribution on the claimed support {x1..xs}: cell weights via Lagrange indicators (exact when s - 1 <= the carried order; demanded), N = sum of max(0, -cell). Zero iff the tower is a genuine probability on that support.",
    params: [
      { name: "d", type: "Dist<r>  (univariate)", doc: "previously declared dist binding" },
      { name: "x1..xs", type: "Float", doc: "claimed support points; s - 1 <= r" },
    ],
    ret: "Float64  (0 iff classical on that support)",
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
  ret: "Array<Float, Idx<total_dim(sh_spec(LMAX))>>",
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
identifiers.scalars = {
  category: "ml",
  doc: "Invariant-exit op: copies the l=0 blocks' entries of an irreps vector into a plain array (block order, multiplicity order). Emits ALL l=0 entries regardless of parity — the equiv judgment governs which callers may treat them as invariants (O3 rejects (0, odd) specs). The spec must have at least one l=0 block.",
  params: [
    { name: "SPEC", type: "spec (static)", doc: "irreps spec of x" },
    { name: "x", type: "Array<Float, Idx<dim>>", doc: "irreps vector" },
  ],
  ret: "Array<Float, Idx<n0>>  (n0 = total l=0 entries)",
};
identifiers.norms = {
  category: "ml",
  doc: "Per-(block, multiplicity) 2-norms of an irreps vector, in (block, mu) order. O(3)-invariant for every parity — an invariant-exit op like scalars.",
  params: [
    { name: "SPEC", type: "spec (static)", doc: "irreps spec of x" },
    { name: "x", type: "Array<Float, Idx<dim>>", doc: "irreps vector" },
  ],
  ret: "Array<Float, Idx<nslots>>  (nslots = sum of block multiplicities)",
};
identifiers.derive_linear = {
  category: "ml",
  doc: "Derived equivariant linear layer: the COMPLETE Schur basis of Hom_G(V_in, V_out) — every (l, parity)-matched (input, output) block pair mixes multiplicities (duplicate matches accumulate, unlike linear's first-match rule), and output blocks with no matching input stay exactly zero. Rejects spec pairs sharing no (l, parity) — every equivariant map is zero (BL4007). The two-argument form binds the layer as a function value: `let layer = ml.derive_linear(SIN, SOUT)`, then `layer(w, x)`.",
  params: [
    { name: "SPEC_IN", type: "spec (static)", doc: "input irreps spec" },
    { name: "SPEC_OUT", type: "spec (static)", doc: "output irreps spec" },
    { name: "w", type: "Array<Float, Idx<wdim>>  (optional)", doc: "weights, pair-major mult_out x mult_in; wdim = ml.hom_dim(SPEC_IN, SPEC_OUT)" },
    { name: "x", type: "Array<Float, Idx<dimIn>>  (optional)", doc: "input irreps vector (omit both w and x for the binding form)" },
  ],
  ret: "Array<Float, Idx<dimOut>>  (two-argument form: the layer as lambda(w, x))",
};
identifiers.derive_tp = {
  category: "ml",
  doc: "Derived tensor product: tensor_product with the output spec DERIVED as the full Clebsch-Gordan decomposition ml.tp_spec(SPEC1, SPEC2), so every output block is reachable by construction. The two-argument form binds the op as a function value: `let tp = ml.derive_tp(S1, S2)`, then `tp(x, y, w)`.",
  params: [
    { name: "SPEC1", type: "spec (static)", doc: "left input irreps spec" },
    { name: "SPEC2", type: "spec (static)", doc: "right input irreps spec" },
    { name: "x", type: "Array<Float, Idx<dim1>>  (optional)", doc: "left irreps vector" },
    { name: "y", type: "Array<Float, Idx<dim2>>  (optional)", doc: "right irreps vector" },
    { name: "w", type: "Array<Float, Idx<wdim>>  (optional)", doc: "path weights; wdim = ml.tp_full_weight_dim(SPEC1, SPEC2) (omit x, y, w for the binding form)" },
  ],
  ret: "Array<Float, Idx<total_dim(tp_spec(SPEC1, SPEC2))>>  (two-argument form: the op as lambda(x, y, w))",
};
identifiers.tensor_to_irreps = {
  category: "ml",
  doc: "Cartesian->irreps bridge (rank-2, 3-D): decomposes a flat row-major 3x3 tensor (g[3i + j] = G_ij) into trace, axial pseudovector in Y1 component order (y, z, x), and symmetric-traceless part in Y2 order. Rows orthonormal in the Frobenius inner product. A rank-2 Cartesian tensor is parity-EVEN throughout — the l=1 block does not flip under improper elements.",
  params: [
    { name: "g", type: "Array<Float, Idx<9>>", doc: "flat row-major 3x3 Cartesian tensor" },
  ],
  ret: "Array<Float, IrrepsIdx<[(0,0,1), (1,0,1), (2,0,1)]>>  (dim 9)",
};
identifiers.sym_to_irreps = {
  category: "ml",
  doc: "Cartesian->irreps bridge for symmetric tensors: decomposes the packed symmetric tensor [s00, s01, s02, s11, s12, s22] (upper triangle, row-major) into its trace and symmetric-traceless irreps. Orthonormal (off-diagonals weighted sqrt(2)); irreps_to_sym is the exact inverse.",
  params: [
    { name: "s", type: "Array<Float, Idx<6>>", doc: "packed symmetric tensor, upper triangle row-major" },
  ],
  ret: "Array<Float, IrrepsIdx<[(0,0,1), (2,0,1)]>>  (dim 6)",
};
identifiers.irreps_to_sym = {
  category: "ml",
  doc: "Irreps->Cartesian bridge: the exact inverse of sym_to_irreps — rebuilds the packed symmetric tensor [s00, s01, s02, s11, s12, s22] (upper triangle, row-major) from its irreps decomposition.",
  params: [
    { name: "t", type: "Array<Float, IrrepsIdx<[(0,0,1), (2,0,1)]>>", doc: "irreps vector (trace + symmetric-traceless blocks)" },
  ],
  ret: "Array<Float, Idx<6>>  (packed upper triangle, row-major)",
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
  tp_spec: {
    doc: "Full Clebsch-Gordan decomposition spec of spec1 (x) spec2, merged-canonical: contributions aggregated by (l, parity) and ordered ascending — the output spec derive_tp uses, stable to write in annotations. Completeness: total_dim(tp_spec(s1, s2)) = total_dim(s1) * total_dim(s2).",
    params: [
      { name: "spec1", type: "spec (static)", doc: "left input irreps spec" },
      { name: "spec2", type: "spec (static)", doc: "right input irreps spec" },
    ],
    ret: "spec (static)",
  },
  hom_dim: {
    doc: "Dimension of Hom_G(V_in, V_out) by Schur's lemma: sum of multIn * multOut over shared (l, parity), multiplicities aggregated across duplicate blocks. Zero iff every equivariant linear map is zero; the derive_linear weight count.",
    params: [
      { name: "specIn", type: "spec (static)", doc: "input irreps spec" },
      { name: "specOut", type: "spec (static)", doc: "output irreps spec" },
    ],
    ret: "Int (static)",
  },
  tp_full_weight_dim: {
    doc: "Number of derive_tp path weights for a spec pair — tp_weight_dim of the full config (spec1, spec2, tp_spec(spec1, spec2)).",
    params: [
      { name: "spec1", type: "spec (static)", doc: "left input irreps spec" },
      { name: "spec2", type: "spec (static)", doc: "right input irreps spec" },
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
  doc: "Probabilistic programming module. Surface (qualified through the import's alias): the formers moments, comoments, cumulants, free_cumulants, mixed_cumulants, comoments_merge, dist, dist_add, dist_scale, dist_affine, dist_jet(_closed), dist_map(_closed), mstate, mstate_merge, mstate_cumulants, dist_expect, dist_reweight, dist_mix, dist_atoms, dist_negativity; plus cumulant(d, k) projection, the independent(X, Y) declaration, and the where-clause license `where p.indep(a, b)`.",
};
identifiers.ml = {
  category: "module",
  sig: "import ml as ml",
  doc: "Equivariant ML module. Surface (qualified through the import's alias): ops y_to, tensor_product, linear, linear_rows, gated, gated_rows, scalars, norms, derive_linear, derive_tp, tensor_to_irreps, sym_to_irreps, irreps_to_sym; sizing/navigation statics sh_spec, total_dim, tp_weight_dim, linear_weight_dim, tp_spec, hom_dim, tp_full_weight_dim, irreps_len, irreps_l, irreps_parity, irreps_mult, irreps_dim, irreps_offset.",
};
identifiers.rand = {
  category: "module",
  sig: "import rand as rand",
  doc: "Random-array module. Surface (qualified through the import's alias): uniform(key, shape) — dense Float64 draws ~ U[0, 1); normal(key, shape) — N(0, 1) via Box-Muller. `key` is an Int64 stream key (same key => same draws); `shape` is a static int (rank 1) or list of static ints (row-major). The RNG lives in the C++ runtime (opaque builtins, not synthesized Blade source), and rand output is not differentiable. Only `import rand [as <alias>]` is allowed.",
};
identifiers.spectra = {
  category: "module",
  sig: "import spectra as sp",
  doc: "Spectral-analysis module. Surface (qualified through the import's alias): fft(x) — unnormalized forward DFT of a real signal, Array<Complex128 like Idx<n>>; ifft(X) — real inverse synthesis of a complex spectrum (carries the 1/n); fft2(x) / ifft2(X) — the rank-2 field forms; power(x) — |FFT(x)|^2 per bin (real); polyspec(x1, ..., xk) — order-k cross-polyspectrum, k = the call-site arity, 2..4 (2 cross-power, 3 bispectrum, 4 trispectrum). Ops read the DECLARED shape (the pass runs before type inference), so an array argument must carry an annotation: an annotated let or parameter, a call of a function with an annotated array return type, or an ascription `(expr : Array<...>)`.",
};
identifiers.sgs = {
  category: "module",
  sig: "import sgs as sgs",
  doc: "Subgrid-scale closure module: field formers over (3, n, n, n) velocity fields. Surface (qualified through the import's alias; W a `let static` name or literal): grad(U, DX) — velocity-gradient field (3, 3, n, n, n) with G(c, d, i, j, k) = d_d u_c, 2nd-order central differences, periodic; box_filter(U, W) — tile means (3, m, m, m), m = n/W; stress(U, W) — exact subgrid stress tau_ij = mean(u_i u_j | tile) - mean_i mean_j, packed (6, m, m, m) in upper-triangle row-major order. Ops read the DECLARED shape, so the field argument must carry an annotation (annotated let/parameter, annotated-return function call, or ascription).",
};

// --- Operators ----------------------------------------------------------------

const operators = {
  "<@>": {
    sig: "| ObjectLoop<n> -> (Idx... -> T)... -> Computation \n| MethodLoop<n> -> (T... -> U) -> Computation",
    doc: "Apply combinator: apply an object loop to an array tuple, or a method loop to a kernel to yield a computation.",
  },
  "<$>": {
    sig: "(T -> U) -> Computation<T> -> Computation<U>",
    doc: "Functor map over a computation.",
  },
  "<&>": {
    sig: "Computation<T> -> Computation<U> -> Computation<(T, U)>",
    doc: "Loop Join: Merge loop nests of two computations if possible. Yields results as a tuple.",
  },
  "<&!>": {
    sig: "Computation<T> -> Computation<U> -> Computation<(T, U)>",
    doc: "Force Join: fuse two computations completely, error if incompatible. Yields results as a tuple.",
  },
  "<|>": {
    sig: "T -> T -> T",
    doc: "Value-keyed choice: the left value where it is nonzero, else the right (an allocated zero falls through — contrast <|:>).",
  },
  "<|:>": {
    sig: "Array<T, Idx...> -> Array<T, Idx...> -> Array<T, Idx...>",
    doc: "Storage-keyed fallback on arrays: the left where its storage holds the cell, else the right — an allocated zero survives (unlike <|>).",
  },
  ">>=": {
    sig: "Computation<T> -> (T -> Computation<U>) -> Computation<U>",
    doc: "Bind: sequence a computation into a continuation.",
  },
  ">>@": {
    sig: "ObjectLoop(T -> U) -> ObjectLoop(U -> V) -> ObjectLoop(T -> V)",
    doc: "Compose-apply: Compose functions inside object loops; object_for(f >> g).",
  },
  "@>>": {
    sig: "Computation<T> -> Computation<U> -> Computation<U>",
    doc: "Apply-compose: Compose functions inside method loop computations; method_for(arrays) <@> (f >> g).",
  },
  "<*>": {
    sig: "MethodLoop<m> -> MethodLoop<n> -> MethodLoop<m + n>",
    doc: "Loop product: concatenates two method loops' array tuples into one loop (the applied kernel then takes m + n arguments).",
  },
  "|>": {
    sig: "T -> (T -> U) -> U",
    doc: "Pipe: feeds the left value to the right function/terminal (compute, read, ...).",
  },
  "|@>": {
    sig: "(Idx... -> T) -> (T -> U) -> Computation",
    doc: "Pipe-apply: desugars to the <@> apply with operands flipped: f <@> a",
  },
  ">>": {
    sig: "(T -> U) -> (U -> V) -> (T -> V)",
    doc: "Compose: applies f, then g.",
  },
  "..": {
    sig: "lo..hi",
    doc: "Anonymous range, lo (inclusive) to hi (exclusive), sugar for range<I>.",
  },
  "::": {
    sig: "head :: tail",
    doc: "Cons: prepends an element (also the list pattern form in match arms: `| h :: t -> ...`).",
  },
  "->": {
    sig: "lambda(x) -> expr",
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
    sig: "x += e",
    doc: "Accumulating assignment on a mut binding: x = x + e. The accumulation form ad.grad() differentiates through.",
  },
  "-=": {
    sig: "x -= e",
    doc: "Subtracting assignment on a mut binding: x = x - e.",
  },
  "*=": {
    sig: "x *= e",
    doc: "Multiplying assignment on a mut binding: x = x * e.",
  },
  "/=": {
    sig: "x /= e",
    doc: "Dividing assignment on a mut binding: x = x / e.",
  },
};

// Bracketed outer-product operators [op]: one entry each, generated.
for (const op of ["+", "-", "*", "/", "%", "^", "==", "!=", "<", "<=", ">", ">=", "&&", "||"]) {
  operators[`[${op}]`] = {
    sig: `(Idx1... -> T) [${op}] (Idx2... -> T) -> Idx1... -> Idx2... -> U`,
    doc: `Outer ${op}: applies ${op} across all index combinations of the operands, producing a higher-rank array.`,
  };
}

module.exports = { identifiers, operators, categories };
