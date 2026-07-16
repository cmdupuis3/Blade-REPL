// Hover table for Blade's built-in types: primitives and the index-type
// family. Like builtins.js, these have no source binding for the compiler to
// report, so the extension carries a static table. Nominal index types
// (user `type X = Idx<...>` aliases), unit-of-measure declarations
// (`Unit meters`), and Array<...> types are resolved from the source at
// hover time (see the type-hover section of extension.js).
//
// Type spellings follow the compiler's lexer (Lexer.fs) and the grammar's
// `primitive-types` / `index-types` groups. Alias facts (Int = Int32,
// Double = Float64, Char stored as Int32) mirror the checker's resolution
// table (TypeCheck.fs resolveTypeExpr).

"use strict";

// Simple scalar/value types — rendered as `name` + kind "Primitive Type"
// with the one-liner below the rule. Mirrors the grammar's primitive-types
// list, plus the nullary Void/Unit.
const primitives = {
  Int: "32-bit signed integer (alias of Int32).",
  Int32: "32-bit signed integer.",
  Int64: "64-bit signed integer.",
  Float: "64-bit float (alias of Float64).",
  Float32: "32-bit IEEE float.",
  Float64: "64-bit IEEE float (double precision).",
  Double: "64-bit float (alias of Float64).",
  Complex64: "Single-precision complex number (two Float32 parts).",
  Complex128: "Double-precision complex number (two Float64 parts).",
  Bool: "Boolean truth value.",
  String: "Text string.",
  Nat: "Type-level natural: a static size/extent (indices, arities).",
  Char: "Character literal (stored as Int32).",
  Void: "No value; the type of pure-effect positions.",
  Unit: "The unit (empty tuple) type. As a declaration keyword, `Unit meters` / `Unit velocity = meters / seconds` introduces a unit of measure for `Float<unit>` annotations.",
};

// The index-type family. `sig` shows the argument shape; `desc` is a very
// short description of the index type and the arguments it takes.
const indexTypes = {
  Idx: {
    sig: "Idx<n>",
    desc: "Dense index of extent n (a literal size or a nominal index type).",
  },
  SymIdx: {
    sig: "SymIdx<r, n>",
    desc: "Symmetric index: rank-r symmetric group over an extent-n index (compacted upper-triangular storage).",
  },
  AntisymIdx: {
    sig: "AntisymIdx<r, n>",
    desc: "Antisymmetric index: rank-r antisymmetric group over an extent-n index (strict upper-triangular storage).",
  },
  HermitianIdx: {
    sig: "HermitianIdx<n>",
    desc: "Hermitian index: conjugate-symmetric pair over an extent-n index (complex arrays).",
  },
  CompoundIdx: {
    sig: "CompoundIdx<Idx...>",
    desc: "Compound index: a masked / sparse view over one or more base index types.",
  },
  EnumIdx: {
    sig: "EnumIdx<Enum>",
    desc: "Enumerated index: one position per case of an enum / tag set.",
  },
  DepIdx: {
    sig: "DepIdx<Parent, f>",
    desc: "Dependent index: per-parent extent given by a function f (ragged / jagged shapes).",
  },
  RaggedIdx: {
    sig: "RaggedIdx<Parent, extents>",
    desc: "Ragged index: variable inner extent per outer position.",
  },
  IrrepsIdx: {
    sig: "IrrepsIdx<spec>",
    desc: "Irreps-structured index: block layout from a static `(l, parity, mult)` spec (equivariant-ML arrays). Navigate blocks with the static builtins `ml.irreps_offset` / `ml.irreps_dim` / `ml.irreps_len` / ...",
  },
};

// Other built-in type constructors that aren't primitives, index types, or
// Array. Rendered as `name` + the given `kind` + `desc`.
const constructors = {
  Poly: {
    sig: "Poly<T, args>",
    kind: "Type Constructor",
    desc: "Polyvariadic parameter pack (query with arity / nth).",
  },
  Dist: {
    sig: "Dist<order, Elem like axes>",
    kind: "Type Constructor",
    desc: "Typed cumulant tower of a random vector: carries the cumulants k1..k_order over the variable axes. Built with `ppl.dist(A, r)`; project a component with `ppl.cumulant(d, k)`; `+` and scalar `*` push forward when independence is declared.",
  },
};

module.exports = { primitives, indexTypes, constructors };
