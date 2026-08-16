# Blade-REPL

A VS Code extension for the [Blade language](https://github.com/cmdupuis3/Blade): live diagnostics, type hovers, navigation, deduction-aware code actions, Ionide-style type lenses, and an interpreter-backed REPL with inline results.

## Features & keybindings

| Feature | Surface | Keybinding / trigger |
|---|---|---|
| Fast check (parse + typecheck + deduce) | squiggles, hovers, lenses refresh | automatic while typing (~300 ms debounce, via `blade ide serve`) |
| Full check (+ monomorphization → concrete types) | hover/lens type upgrades | automatic on save / open / ~2 s idle; manual `Ctrl+Alt+Enter` (Blade: Check Current File) |
| Go to definition | editor | `F12` / `Ctrl+Click` |
| Peek definition | editor | `Alt+F12` |
| Find all references | references view | `Shift+F12` |
| Rename symbol | in-file rename | `F2` |
| Document outline / breadcrumbs | outline view | `Ctrl+Shift+O` |
| Quick fix: pin deduced comm/anticomm, annotate deduced rank | lightbulb | `Ctrl+.` |
| Signature lens (functions; arrays as `Idx<N> -> T`) | above-line lens | always on (settings toggles) |
| Deduction lens (`deduced comm(a, b) · storage — pin`) | above-line lens, clickable | click applies the pin |
| Type/keyword/builtin/provider hovers | hover | mouse hover |
| Signature help | parameter hints | `(` and `,` while typing a call |
| Completions (bindings, builtins, deduction pins) | IntelliSense | `Ctrl+Space` |
| Send selection/line to REPL (inline result) | REPL + inline decoration | `Alt+Enter` |
| Send file to REPL | REPL terminal | `Alt+Shift+Enter` |
| Notebooks (`.bladenb`): run cell / run all | notebook UI | `Shift+Enter` and the standard notebook keys |
| New notebook / open `.blade` as notebook | notebook editor | command palette |
| Restart notebook kernel (reset session) | notebook toolbar | command palette |
| Run file (full compile + run) | ▶ editor title button | — |
| Show generated C++ | side-by-side editor | command palette |
| Start / Reset REPL session | REPL terminal | command palette |
| Plots (contours, images) from REPL/notebook output | "Blade Plots" panel beside the editor | automatic when evaluated code emits a display frame; `Blade: Plot Demo` renders a sample |

All navigation features land on VS Code's standard keys — no custom chords to learn beyond the three REPL/check bindings.

## Requirements

A built [Blade compiler](https://github.com/cmdupuis3/Blade). The extension auto-detects the most recently built of `bin/Release` / `bin/Debug` in the standard repo location, or `Blade` on PATH; override with `blade.compilerPath`.

- Compiler discovery order: the `blade.compilerPath` setting, then the `BLADE_EXE` environment variable, then the newest-built of `bin/Release` / `bin/Debug` in the standard repo location, then `Blade` on PATH. `BLADE_EXE` is new to the extension itself as of this release — previously only the standalone test scripts (`npm run test:serve` etc.) honored it; `blade.compilerPath` still wins when set, but leaving it empty and setting `BLADE_EXE` now works too.
- Compilers with the `ide serve` subcommand get as-you-type checking through a persistent process (two tiers: a fast parse+typecheck+deduce pass while you type, and a full pass through monomorphization on save/idle that upgrades polymorphic value types to their concrete instantiations).
- Older compilers fall back automatically for `.blade` files: `ide check --json` on save/open, or plain-text diagnostics for compilers without the JSON subcommand.
- Notebooks are the exception — there is no fallback. Running cells needs `ide serve`'s `eval`/`resetSession`, and in-cell checking (diagnostics, hovers, completions, lenses) needs its `checkCells` command, which assembles the cells into one session source compiler-side. On a compiler without them, cells report the missing support when run and simply go unchecked while you type; `.blade` files in the same window are unaffected.

## Notebooks

`.bladenb` files open as native VS Code notebooks. The format is plain Blade text with `// %%` cell markers (`// %% [markdown]` for prose cells), so the same file still runs under `blade run` and diffs cleanly in git. Cells evaluate with exact REPL semantics — an accumulating session, rebind-in-place, typed value echoes (`xs = [1.0, 2.0, 3.0] : Array<Float64 like Idx<3>>`), interpreter-first evaluation with a g++ fallback badge — on a dedicated `ide serve` process, so a slow cell never blocks typing-time checking. Cells also get the full IDE feature set: diagnostics, session-aware hovers and completions (names from earlier cells resolve), and type lenses. "Restart Kernel" resets the session; interrupting kills the evaluator and transparently replays the session on the next run.

## Plots

Evaluated code that produces a plot ships it to the extension as a **display frame** — a `{mime, data}` payload carried alongside stdout on the REPL and `ide serve` channels ([wire format](docs/display-frames.md)). Frames render in a "Blade Plots" webview docked beside the editor: plot history with prev/next, export, and a **plotly/GR backend toggle**. plotly.js is bundled in the extension, so the panel works offline. `Blade: Plot Demo` pushes a sample contour through the same path without needing compiler support.

**Backends.** plotly is the interactive default (hover, zoom, pan), rendered in the webview. GR is a static renderer for large grids and publication output: clicking **GR** sends the plot's spec to the warm `ide serve` process, which renders a PNG through the `gr-render` helper and sends it back attached to the same plot — so toggling is instant in both directions once each render is cached. GR renders export as PNG, SVG, or PDF; plotly renders export as PNG or SVG. The GR button stays disabled, with the reason in its tooltip, until a GR installation resolves — `npm run fetch-vendor` provides one, or point `blade.grPath` at your own (see [Vendor dependencies](#vendor-dependencies-plotting)).

Plots come from the compiler's `plot` stdlib module. Options are **tagged by quantity** rather than by position, so they can be given in any order — and axis labels can be read straight off the data's units:

```blade
import units.SI
import plot
import display as d

let t: Array<Float64<second> like Idx<4>> = [0.0, 1.0, 2.0, 3.0]
let v: Array<Float64<meter> like Idx<4>> = [0.0, 2.5, 6.0, 9.5]

let _ = plot.line(t, v, "drift": title, d.unit_label(t): xlabel, d.unit_label(v): ylabel)
```

`plot` provides `contourf`, `contour`, `heatmap`, `line`, and `scatter`; option slots are `levels`, `cmap`, `title`, `xlabel`, `ylabel`, and `backend`, plus `maxdim` on the three grid factories — each with a default, so `plot.contourf(x, y, z)` alone is valid.

Two slots exist for the backends. `maxdim` (default 512) caps how many samples per axis a grid serializes: a raw 2000² grid would be ~74 MB of figure JSON, past the frame size limit and far past display resolution, so bigger grids are resampled before they go on the wire. `backend` asks the panel to *show* this plot with a particular backend — the frame is still plotly JSON either way, so a viewer without GR simply ignores the request, and your own toggling always wins.

## Settings

| Setting | Default | Effect |
|---|---|---|
| `blade.compilerPath` | `""` (auto-detect) | Path to `Blade.exe` |
| `blade.liveChecking` | `true` | As-you-type fast checks (requires `ide serve`) |
| `blade.fastCheckDebounceMs` | `300` | Typing debounce before a fast check |
| `blade.fullCheckIdleMs` | `2000` | Idle time before a full-tier check |
| `blade.checkOnSave` / `blade.checkOnOpen` | `true` | Full check on save / open |
| `blade.runTimeoutSeconds` | `180` | Timeout for `Blade run` (first runs invoke g++) |
| `blade.inlineReplResults` | `true` | Inline green/red REPL results at the evaluated line |
| `blade.signatureLens.functions` | `true` | Abstract signature lens above functions |
| `blade.signatureLens.arrays` | `true` | Index-arrow lens above array bindings (`Idx<N> -> Float64`) |
| `blade.deductionLens` | `true` | Deduced comm/anticomm + storage lens with one-click pin |

## Development

One runtime dependency: [`@blade-lang/ide-protocol`](../Blade/protocol) (the shared NDJSON client, wire-protocol codecs, and generated language-surface data the Blade compiler repo publishes) — vendored as a committed tarball under `vendor/`, no npm registry involved. No build step for this extension's own code; everything under `src/` is still plain CommonJS executed directly by VS Code's Node runtime.

```bash
npm install    # extracts vendor/blade-lang-ide-protocol-<version>.tgz into node_modules
npm test
```

runs the hermetic suite (syntax gates, grammar/table/surface consistency, provider tests against a vscode mock). Live suites need a built compiler (`BLADE_EXE` env var or the standard build locations): `npm run test:serve` (ide-serve protocol), `npm run test:repl` (REPL protocol), `npm run test:nav` (navigation providers against real compiler payloads), `npm run test:nb` (notebook eval session semantics).

### Refreshing the vendored protocol package

After a change lands in `../Blade/protocol` (new compiler surface, a client bugfix), re-vendor it from a sibling `Blade` checkout:

```bash
npm run vendor:protocol
```

This re-packs `../Blade/protocol` into `vendor/blade-lang-ide-protocol-<version>.tgz` and reinstalls. Commit the refreshed tarball together with the matching version bump in `package.json`'s `dependencies` entry (kept lockstep with the compiler's `compilerVersion`).

### Vendor dependencies (plotting)

Two upstream graphics packages back the plots panel. Neither is an npm package —
they are prebuilt artifacts pinned in [`deps.json`](deps.json) and fetched by a
script, so "zero dependencies" above still holds.

| Package | Version | Lands at | In git? |
|---|---|---|---|
| [plotly.js](https://plotly.com/javascript/) | 3.7.0 | `media/plotly.min.js` (4.85 MB) | **yes, committed** |
| [GR](https://gr-framework.org/) | 0.73.26 | `vendor/gr/` (~30 MB headless subset) | no, gitignored |

```bash
npm run fetch-vendor            # fetch whatever is missing
npm run fetch-vendor -- --check # verify presence + hashes, no network
npm run fetch-vendor -- --force # re-fetch and re-extract regardless
```

plotly is the live backend and is **committed on purpose**: VS Code webviews have
no network access, so the panel loads it from disk and it has to ship inside the
.vsix. `fetch-vendor` normally just verifies its sha256 and does nothing.

GR is the static-PNG backend for large grids, still stubbed in the UI. It is
gitignored because it is large and re-fetchable, so a fresh clone has
to run `npm run fetch-vendor` before the GR path can work. The script picks the
release asset matching `${process.platform}-${process.arch}`, reuses an
already-downloaded tarball when its hash matches, and normalizes the archive's
top-level directory away so the result always lands at exactly `vendor/gr/`.
Extraction is pruned to the headless render subset pinned in `deps.json`
(`keep`): ~30 MB instead of the 147 MB full tree, verified to render
byte-identical PNGs (see `docs/gr-graphics-plan.md` §7). Pass `--full` (with
`--force` to re-extract an existing tree) when you want the whole thing —
`gksqt.exe` for interactive debugging, `videoplugin.dll` for animation work.
Only the Windows asset's hash is pinned today; the other platforms are recorded
as `null`, and the script prints the hash it computed on first fetch so it can be
pasted into `deps.json`.

**GR runtime note:** `GRDIR` must point at `vendor/gr` and `$GRDIR/bin` must be on
`PATH` — the Qt/GKS shared libraries live there. The extension's `serve` process
will set both itself when the GR backend lands; nothing needs to be added to your
shell profile.

`npm test` only syntax-checks the fetcher. It deliberately does not run
`--check`, which would fail on any clone that has not fetched GR.
