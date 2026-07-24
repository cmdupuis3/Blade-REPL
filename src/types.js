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
  Int: "32-bit integer.",
  Int32: "32-bit integer.",
  Int64: "64-bit integer.",
  Float: "64-bit float",
  Float32: "32-bit float.",
  Float64: "64-bit float.",
  Double: "64-bit float.",
  Complex64: "64-bit complex number (pair of Float32).",
  Complex128: "128-bit complex number (pair of Float64).",
  Bool: "Boolean.",
  String: "String of text.",
  Nat: "Type-level natural: a static size/extent (indices, arities).",
  Char: "Character literal.",
  Void: "No value; the type of pure-effect positions.",
  Unit: "The unit (empty tuple) type. Not to be confused with the `Unit` declaration keyword, which introduces a unit of measure for `Float<unit>` annotations.",
};

// The index-type family. `sig` shows the argument shape; `desc` is a very
// short description of the index type and the arguments it takes.
const indexTypes = {
  Idx: {
    sig: "Idx<n: Nat>",
    desc: "Simple index type.\n Index type of extent n: Nat.",
  },
  SymIdx: {
    sig: "SymIdx<r: Nat, n: Nat>",
    desc: "Symmetric index type. \n Rank-r symmetric dimensions over an extent-n index.",
  },
  AntisymIdx: {
    sig: "AntisymIdx<r: Nat, n: Nat>",
    desc: "Antisymmetric index type. \n Rank-r antisymmetric dimensions over an extent-n index (no diagonal).",
  },
  HermitianIdx: {
    sig: "HermitianIdx<n: Nat>",
    desc: "Hermitian index type. \n Rank-2 conjugate-symmetric dimensions over an extent-n index (real- and complex-valued only).",
  },
  CompoundIdx: {
    sig: "CompoundIdx<Tuple<I_j: Idx<n_j: Nat>>, mask: bool^r>",
    desc: "Compound index type.\n Contiguous storage of a masked or sparse view over one or more base index types.",
  },
  EnumIdx: {
    sig: "EnumIdx<Enum>",
    desc: "Enumerated index type. \n Only one position per case of an enum / tag set.",
  },
  DepIdx: {
    sig: "DepIdx<Parent, f: static Nat -> Idx<Nat>>",
    desc: "Dependent index type. \n Per-parent extent given by a function f (ragged / jagged shapes).",
  },
  RaggedIdx: {
    sig: "RaggedIdx<I: Idx<Nat>, n: Nat>",
    desc: "Ragged index type. \n Variable inner extent of length n per outer position.",
  },
  IrrepsIdx: {
    sig: "IrrepsIdx<l: Nat, parity: bool, mult: Nat>",
    desc: "Irreps-structured index: block layout from a static `(l, parity, mult)` spec (equivariant-ML arrays). Navigate blocks with the static builtins `ml.irreps_offset` / `ml.irreps_dim` / `ml.irreps_len` / ...",
  },
};

// Other built-in type constructors that aren't primitives, index types, or
// Array. Rendered as `name` + the given `kind` + `desc`.
const constructors = {
  Poly: {
    sig: "Poly<T, args>",
    kind: "Type Constructor",
    desc: "Polyvariadic parameter pack.\n Query with arity() and nth().",
  },
  Dist: {
    sig: "Dist<order, Elem like axes>",
    kind: "Type Constructor",
    desc: "Typed cumulant tower of a random vector. \n Carries the cumulants k1..k_order over the variable axes. Built with `ppl.dist(A, r)`; project a component with `ppl.cumulant(d, k)`; `+` and scalar `*` push forward when independence is declared.",
  },
};

module.exports = { primitives, indexTypes, constructors };
