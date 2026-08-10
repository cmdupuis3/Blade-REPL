# Blade Plotting & Units — Implementation Plan

Status: design settled 2026-08-06. **Phases 1–5 implemented 2026-08-07** (plotly path;
GR deferred). Spans two repos: the compiler (`../Blade`, F#) and this extension
(`Blade-REPL`). The graphics package is the driving use case for three language
features: **quantity kinds**, **default parameter values**, and **type-driven optional
arguments**.

---

## Implementation status (2026-08-07)

Compiler suite **4415 passed / 0 failed**; extension `npm test` green. Nothing committed
in either repo.

| Phase | State | Landed as |
|---|---|---|
| 1 · Quantity kinds | **Done** | `UnitSig = {Nominal; Dims}`, `Unit speed: mps`, terminality (BL3011), bare-unit ascription, String/Bool units, `Unitless`, strict quantity slots (BL3010) |
| 1 · Default params | **Done** | `param: T = expr` on functions + lambdas, call-site desugar, BL3012; defaults are introduction positions (a slot's default adopts its quantity) |
| 2 · Factory flattening | **Done** | By-nominal routing, chained sugar → one call node (byte-identical C++ proven), BL3013/BL3014 |
| 4 · `units.SI` + resolver | **Done** | `src/ModuleResolve.fs`, `stdlib/units/SI.blade` (28 coherent units), all four CLI lanes, BL2004–6 |
| 5 · Display frames | **Done** | `src/display/`, `display.emit`, SOH-sentinel on the pty + `display[]` on serve responses, interpreter/compiled byte parity gated |
| 5 · `plot` module | **Done** | `stdlib/plot.blade` — contourf/contour/heatmap/line/scatter |
| 5 · Panel + protocol | **Done** | `src/plots.js`, `src/display.js`, `docs/display-frames.md`, `blade.plotDemo` |
| — · GR backend | **Deferred** | Installed + smoke-tested at `vendor/gr/`; toggle present but disabled |

**Beyond the original plan** (discovered during implementation):

- Compound unit expressions in type-argument position (`Float<meter/second^2>`) — the
  restriction was undocumented, and `Float<meter^2>` had been *silently dropped*.
- `display.unit_label(x)` — elaboration-time reflection of a value's unit/quantity into a
  string, which is what makes auto-labeled axes real (the stretch goal; it landed).
- `from units.SI import newton` previously bound **nothing** — `Float<newton>` degraded to
  no annotation at all, a silent false OK. Fixed.

**Verified end to end** — `import units.SI` + `import plot`, SI-annotated arrays through
`plot.line` with quantity-tagged slots, producing one frame whose axes read `second` and
`meter` straight from the unit system; that exact frame parsed by the extension's real
parser and rendered by the bundled plotly 3.7.0.

### Known gaps (tracked, not blocking)

1. The REPL rejects `Unit` declarations (pre-existing BL1999) — units must be imported,
   not declared interactively.
2. The corpus runner's lane doesn't resolve stdlib imports, so SI-semantic corpus
   assertions are only enforced in the `blade run` lane.
3. A stderr warning `module 'units.SI' not found in typed pipeline` on REPL
   bare-expression submissions (cosmetic; pre-dates the plot work).
4. `plot` v1: title/label strings are not JSON-escaped; NaN/Inf serialize as
   JSON-invalid tokens (plotly wants `null`); colormaps are an Int table index rather
   than an `EnumIdx`.
5. `media/plotly.min.js` and `docs/` are untracked in git — `git add` them or a fresh
   clone packages without the renderer.

---

## Settled design decisions

### Units vs. Quantities (two layers, metrology-style)

- **Structural units** — what exists today. `Unit meters` declares a base dimension;
  `Unit mps = meters / seconds` canonicalizes to an exponent map `{m:1, s:-1}` and the
  name is algebraically transparent. Full `*` `/` `^` algebra.
- **Quantities** — new. `Unit speed: mps` (exact syntax open; `:` vs `of`) mints a
  *nominal* identity that **entails** a dimension vector. Representation: extend
  `UnitSig` from `Map<string,int>` to `{ nominal: string option; dims: Map<string,int> }`.
  Do **not** nest `IRTIdxTagged`/`IRTUnitAnnotated` wrappers (avoids the ~25–30-site
  single-layer-assumption audit).
- **Quantities are terminal.** A quantity name may not appear in any unit-algebra
  expression: `Unit x = speed / seconds` and `Unit headwind: speed` are declaration
  errors. The nominal layer is exactly one level deep, always.
- **Checking rules.** Ascription (`v: speed`) mints the nominal *with* a dims check
  (a `Float<seconds>` value cannot be ascribed `speed`). Slot/parameter matching
  requires nominal equality. `+`/`-`/comparisons: nominals must agree; result keeps
  the nominal. `×`/`÷`: dims compose, nominal drops (`speed * time` → plain meters).
- **Unitless.** Cancelled dims (`speed / speed`) display as `Float<Unitless>` —
  distinct from bare `Float`, which never entered the unit system. They unify freely;
  only the display differs (provenance is information).
- **Option markers are dimensionless quantities.** `Unit levels` as a quantity is
  `{nominal: "levels", dims: {}}` — this *replaces* today's odd behavior where an
  atomic unit becomes a base dimension (`levels * levels` → `levels²`).
- **Tooltips/docs:** Quantities badge as **"Quantity"** (structural units keep
  "Unit of Measure"), show entailed dims (`Quantity speed — mps ≡ m·s⁻¹`), distinct
  completion icon, rows in the unit documentation tables.

### Call syntax: flat, type-driven optional args

- **Canonical form is a single flat call** — required positionals first, then
  unordered unit/quantity-tagged optionals:

  ```
  plot.contourf(x, y, z, 20: levels, viridis: cmap)
  ```

- Chained trailing applications `plot.contourf(x, y, z)(20: levels)(viridis: cmap)`
  are **sugar** that elaborates into the same flat call (useful for programmatic
  building/piping). Either way, after elaboration there is exactly one call node.
- Rules: optionals strictly **after** all required args; unordered among themselves;
  duplicate slot at a call site = error; two slots sharing a tag type in one
  signature = declaration-site error; unknown tag = error at the call site.
- **No option monad.** Which slots were supplied is static (resolved at elaboration);
  absence never survives to runtime. The body always sees a concrete value.

### Default parameter values (new language feature)

- Functions **and lambdas** gain `param: Type = expr` defaults.
- A default expression may reference the **required** params (`levels = auto_levels(z)`),
  evaluated at call entry when the slot is unfilled. Defaults may not reference other
  optional slots (avoids ordering puzzles; revisit only if a real need appears).
- Reserved for later, only if a real case appears: a static `given(slot)` predicate
  (compile-time branch pruning, monomorphization-style).

### Deferred, deliberately

- **Scale factors / non-coherent units** (`km`, hours, feet, °C offsets): `UnitSig`
  has no scale dimension and codegen erases units, so `Unit km = m` would silently
  alias. Coherent SI is scale-1 by construction and works today — ship `units.SI`
  only; prefixed/imperial systems are a separate future decision (requires scale in
  `UnitSig` + real conversion ops at codegen).
- **Quantity-of-quantity, tag+unit co-occurrence** on one value: out of scope.
- **`given()`** static presence predicate: reserved.

---

## Phase 1 — Compiler: Units, Quantities, default args

The unlock phase; everything downstream depends on it. Anchors from the gap analysis
(file:line in `../Blade/src`):

1. **Bare-unit ascription.** `10: levels` currently parses but lowers the bare name
   to a forward-referenced `IRTNamed`, not a unit. Fix: `lowerTypeExpr`
   (TypeCheck.fs ~285–367) checks `env.Units` for `TyNamed(name, [])` before the
   named-type fallback. Add literal-adoption arms for string/bool literals against
   `IRTUnitAnnotated` targets (TypeCheck.fs ~8086–8112).
2. **String/Bool unit unlock.** `"Bool" -> IRTScalar ETBool` (TypeCheck.fs:322) and
   `"String" -> IRTScalar ETString` (:328) silently drop type args today — route
   both through `tryResolveUnitArg`. Harden Complex (type-level support exists but
   is untested; excluded from some intrinsic rules).
3. **`UnitSig` becomes `{nominal, dims}`.** Touch: `Types.fs` algebra helpers
   (`unitMul`/`unitDiv`/`unitPow` drop nominal; `unitCompatible` gains the nominal
   equality rule for consuming positions), `registerUnit` (TypeEnv.fs:823–835) for
   the new declaration form + terminality enforcement, `ppUnitSig` for `Unitless`
   and quantity rendering. IDE JSON needs nothing (types are pretty-printed strings;
   the renderer is already generic).
4. **Quantity declaration parsing.** `parseUnitDecl` (Parser.fs:3177–3186) gains the
   nominal form; decide `:` vs `of`. Doc comments carry through like today's units.
5. **Default parameter values.** `ParamDecl` (Ast.fs:546–552) gains
   `Default: Expr option`; parser accepts `= expr` in function decls and lambdas;
   TypeCheck checks the default expr in scope of the required params; call sites
   fill unfilled slots. (This lands here because it's independent of factories —
   ordinary trailing optional args benefit immediately.)
6. **Strict consuming positions.** Today's asymmetric unify arm (Unify.fs:751–758)
   lets bare values flow into annotated slots — correct for *introduction*
   (`let x: Float<mps> = 4.0`), wrong for quantity slots. Split
   introducing-vs-consuming contexts (unify mode or a call-site pre-check extending
   `unitClash`, TypeCheck.fs:2390–2401): a quantity-typed parameter requires a
   nominal match, not adoption.
7. **Extension side (this repo).** "Quantity" hover badge + completion icon
   (scanDecls / typeMarkdown in src/extension.js), unit docs table rows,
   check-consistency coverage for the new declaration form.

**Tests:** corpus units/ additions — quantity declaration, terminality errors,
ascription dims-check, Unitless display, string/bool-tagged values, defaults in
functions and lambdas, strict-slot rejection. Interpreter parity for all (the REPL
runs the interpreter).

## Phase 2 — Compiler: factory recognition, flat elaboration, flat codegen

1. **Recognize the factory pattern.** A call with required positionals + trailing
   tagged args (flat form), and chained-application sugar
   (`ExprApp(ExprApp(f, req), [opt])…` — the parser already produces this shape,
   Parser.fs:1695–1711).
2. **Flatten at elaboration.** Collapse chains into one call node *before/during*
   typecheck; match each tagged arg to its slot by nominal identity; emit the
   diagnostics set (duplicate slot, unknown tag, optional-before-required,
   ambiguous signature at declaration).
3. **Flat results in codegen.** The "tail-call-like" guarantee: because flattening
   is an elaboration-time rewrite, codegen sees exactly one direct call — **no
   intermediate builder values, closures, or partial applications are ever
   materialized**, in either the C++ backend or the interpreter. The existing
   over-application arrow path (TypeCheck.fs:2448–2457) remains for genuine
   multi-arrow functions; factories never route through it after flattening.
   Verify with codegen-inspection tests (emitted C++ contains a single call) and
   interpreter parity tests.

## Phase 3 — Integrate defaults into factory semantics

1. Unfilled slots take their defaults at the flattened call site; default exprs
   evaluate at call entry, left-to-right, with required params in scope.
2. Diagnostics/tooling polish (this repo): signature help lists **unfilled** slots
   for the call under the cursor; hover on a factory call shows the fully-resolved
   slot assignment (supplied vs defaulted); error messages name the slot, not the
   position.

## Phase 4 — `units.SI` stdlib + module resolution

Type-checker plumbing already works (`module units.SI` dotted names parse; per-module
`Units` export/import exists — TypeEnv.fs:101–115, TypeCheck.fs:12261–12286). What's
missing is delivery:

1. A module resolver: dotted import name → file path, with a search path (install
   dir beside `Blade.exe`, env var override); transitive import discovery +
   topological ordering feeding `parseMultiSource`/`lowerMultiSource` (exists,
   currently test-harness-only) instead of the single-file path in `Cli.fs:142–173`.
2. Author the stdlib tree: `stdlib/units/SI.blade` — base dimensions (m, kg, s, A,
   K, mol, cd) + coherent derived units (N, Pa, J, W, Hz, …). Coherent SI only
   (scale-1); no prefixed units yet.
3. Cycle/duplicate-module validation with real error messages.

The plot package takes a **hard dependency** on `units.SI` (e.g. axis-label
inference), proving the "module depends on units module" story.

## Phase 5 — The `plot` package + protocol + IDE panel (the use case)

**Language side** — `plot` module (module + struct, no classes):

- Backend-neutral spec struct; factories `plot.contourf`, `plot.contour`,
  `plot.heatmap`, `plot.line`, `plot.scatter` as slot-based factories using
  quantity markers (`levels`, `cmap`, `title`, …) — the first real consumer of
  Phases 1–3. Colormaps as `EnumIdx` (compile-checked names, completions).
- **Auto axis/colorbar labels from data units** — the headline science feature:
  arrays carrying `K` or `m/s` label themselves; a level-slot can demand the
  z-data's unit.
- Serializers: plotly trace JSON (contour: `z` grid + `contours{start,end,size}` +
  `coloring: "lines"` for line-contours); GR render path. Server-side decimation
  for grids larger than display resolution. Base64 typed arrays (`bdata`) when
  JSON numbers get heavy.

**Protocol** — display frames `{mime, data}` alongside stdout/stderr on the
serve/REPL channel: `application/vnd.plotly.v1+json`, `image/png`. notebook.js
already ships MIME-typed `NotebookCellOutputItem`s over NDJSON — same model, so
notebook cells light up with the same frames. **Specified in
[display-frames.md](display-frames.md)** (frozen; the extension side is
implemented — `src/display.js` parses/routes, `src/plots.js` renders — so the
compiler work is exactly what that document's §9 checklist lists).

**Extension** — docked "Blade Plots" webview panel (julia-vscode plot-navigator
pattern): plot history with prev/next, **plotly/GR backend toggle in the toolbar**,
export (SVG/PNG). The panel retains the backend-neutral spec per plot: toggling
re-renders — plotly instantly in-webview, GR via one round-trip to the warm serve
process — and caches both renders per plot. Eager render on the active backend;
the inactive backend renders on first toggle. plotly.min.js bundled into the
extension (no CDN at runtime; webviews are offline).

**Backends:** plotly = interactive default (REPL loop, hover/zoom); GR = static
PNG for big grids, animation frames, publication export. Rough crossover: plotly
contour is SVG-rendered — comfortable to a few hundred² grid, sluggish around
1000², GR beyond (decimation pushes the boundary out).

## Installed packages (done — both verified rendering contours)

| What | Version | Installed at | Source |
|---|---|---|---|
| plotly.js | 3.7.0 | `media/plotly.min.js` (4.85 MB, **tracked** — ships in the .vsix; webviews are offline) | cdn.plot.ly |
| GR | 0.73.26 | `vendor/gr/` (147 MB extracted, MinGW build matching the g++ toolchain) | github.com/sciapp/gr releases |

Originals kept at `vendor/plotly-3.7.0.min.js` and
`vendor/gr-0.73.26-Windows-x86_64.tar.gz` (52.6 MB).

**Verification performed at install time** — both rendered a filled contour of
`sin(x)·cos(y)`:

- GR: a C smoke test compiled with `g++ -I vendor/gr/include -L vendor/gr/lib -lGR`
  called `gr_contourf` under `gr_beginprint("out.png")` and produced a 492 KB PNG
  with filled bands *and* isolines, viridis colormap — headless, no display server.
  Confirms the Phase 5 GR path (offscreen PNG → `image/png` frame).
- plotly: `Plotly.newPlot` with a `contour` trace rendered from the local
  `media/plotly.min.js` over `file://`, including colorbar and axis titles.
  Confirms the bundle is complete and loads without a CDN.

**Runtime requirement for GR:** `GRDIR` must point at the install root and
`$GRDIR/bin` must be on `PATH` (Qt/GKS DLLs live there). The serve process should
set both when invoking the GR backend rather than relying on the user's
environment.

**Packaging:** `vendor/` is in `.gitignore` (202 MB, re-fetchable) and in the new
`.vscodeignore` (otherwise `vsce package` would emit a ~200 MB .vsix). `media/` is
deliberately excluded from both.

Other-platform GR tarballs (Linux/macOS, ~46–61 MB; an MSVC Windows variant at
35 MB) ship from the same release page when distribution broadens.

## Sequencing rationale

Phase 1 unlocks everything and is mostly small, contained edits with one design-y
item (strict consuming positions). Phase 2 is the genuinely new machinery but
touches nothing downstream of elaboration. Phase 3 is the junction of 1+2 and is
small once both exist. Phase 4 is parallel-friendly systems work (no type-theory
dependency; can proceed alongside 2–3). Phase 5 consumes all of it and delivers
the visible feature.
