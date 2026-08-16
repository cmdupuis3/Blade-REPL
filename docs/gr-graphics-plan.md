# GR backend for Blade plotting — implementation plan

**Date:** 2026-08-15 · **Branch:** `claude/gr-graphics-plan-67007c` (off `main` @ `9a8b165`)
**Scope:** Blade-REPL (this repo), the Blade compiler repo (`../Blade`, incl. its `protocol/` package), and a new native render helper.
**Inputs:** the settled Phase-5 design in `docs/plotting-and-units-plan.md` / `docs/display-frames.md` (on `feat/vendor-packaging`), a code inventory of both repos, and a round of hands-on GR experiments on this machine (results in §7).

---

## 1. Goal and UX contract

The Blade Plots panel gets a working **plotly ⇄ GR toggle**. plotly stays the interactive
default (hover/zoom, rendered in-webview). Clicking **GR** re-renders the *same plot* as a
static PNG: instantly if a GR render is already cached, otherwise via one round-trip to the
warm `blade ide serve` process. Toggling back to plotly is always instant (its frame is
cached). GR is the lane for big grids, publication export, and (later) animation.

Everything below serves that one interaction.

## 2. What already exists (don't rebuild it)

The Phase-5 groundwork shipped further than the docs suggest. Verified state on `main`:

| Piece | State | Anchor |
|---|---|---|
| `image/*` → `"gr"` backend inference | done | protocol pkg `display.js:68-73` (`backendFor`) |
| Per-plot per-backend render cache + retained spec | done, unit-tested | `src/plots.js:73-102` (`appendFrame`), `:124-127` (`renderFor`) |
| Merge a later GR frame into the same plot by `meta.id` | done | `src/plots.js:78-87` |
| `image/png` webview render path + PNG export + CSP | done | `src/plots.js:327-330`, `:374-377`, `:170-178` |
| GR toggle button (disabled, "coming soon") | done | `src/plots.js:39-44`, guard `:464-469` |
| `meta.backend` on every plotly frame | done, hardcoded `"plotly"` | `../Blade/stdlib/plot.blade:69-70` (`__emit_fig`) |
| `meta.spec` reserved for backend-neutral spec | reserved, unused | `docs/display-frames.md` §5 |
| Serve protocol with capability probing (`unknown cmd` error) | done | `../Blade/src/IdeServe.fs:308-374`, `:372-374` |
| GR 0.73.26 MinGW build + pinned sha256 | on disk / on branch | `vendor/gr` (main tree), `deps.json` on `feat/vendor-packaging` |
| Notebook cells render base64 `image/*` natively | done | `src/notebook.js:216-228` |

Two structural facts that reframe the work:

1. **The display/serve plumbing no longer lives in this repo.** `src/display.js`,
   `src/serveProto.js`, `src/replProto.js` were moved into the vendored
   `@blade-lang/ide-protocol` package built from `../Blade/protocol` (`npm run
   vendor:protocol`, `package.json:35`). The two blocking gaps — serve spawn accepts no
   `env` (`client.js:233`), and no render request exists in the protocol — are **compiler-repo
   work plus a package version bump and re-vendor**.
2. **Nothing anywhere produces a GR frame.** The compiler repo has zero GR references
   (clean slate — no Phase-5 remnants to salvage).

## 3. Architecture decision

**A persistent native worker, `blade-gr-render`, owned by the serve process.** One C++
binary built against `vendor/gr`, holding the only copy of the spec→GR translator, with two
entry modes over the same code:

- **one-shot** (tests/CI): plotly-figure JSON on stdin → PNG bytes on stdout.
- **persistent** (runtime): NDJSON request/response loop on stdin/stdout, spawned lazily by
  `blade ide serve`, pre-warmed with a throwaway render at spawn.

The **plotly trace JSON is the backend-neutral spec.** The panel already retains it per
entry (`entry.spec`); the worker consumes `{data:[trace], layout:{...}}` directly.
`meta.spec` stays reserved until the backends' specs actually diverge.

Why this shape wins:

- **The parity gate is untouched.** Program lanes keep emitting only plotly JSON;
  `DisplayFrame.fs`, its C++ mirror, and `tests/InterpDiff.fs` don't change. A GR render is
  a post-hoc transformation of already-emitted spec data, outside the byte-parity contract.
- **The 2.6 s GR cold start is amortized to zero.** Warm renders measured 33–350 ms — the
  toggle feels instant, and heatmap animation reaches ~15–25 fps. (Measured numbers in §7.)
- **PNG bytes are process-state-independent** (proven: pages-in-one-process vs separate
  processes are byte-identical), so a long-lived worker renders the same bytes as a fresh
  one. This is what makes a persistent worker *safe* — and it would not hold for SVG.
- **Crash isolation:** a GR fault kills the worker, not serve; respawn on next request.

### Rejected alternatives

- **Program-lane GR emission** (stdlib emits a second `image/png` frame, or native GR FFI):
  incompatible with the toggle — the backend choice would be baked in at run time, and the
  panel could never re-render after the program exits. Mechanically it's also the worst
  path: frame ids increment per `d.emit` call (`DisplayFrame.fs:157-160`), so two emissions
  become two *separate* panel entries, and fixing that touches both hand-written lane
  writers plus the differential gate. Full FFI would additionally need a new language
  surface, a P/Invoke shim for a large stateful C API, and a replacement verification
  strategy. Large effort, negative UX value.
- **Browser-side gr.js/WASM:** dead end. The vendored `lib/gr.js` (12.2 MB) exports only
  128 symbols — **no `contourf`**, no `nonuniformcellarray` — and would need
  `'wasm-unsafe-eval'` added to the panel's deliberately strict CSP. The raster round-trip
  costs 17–28 KB and ~150 ms; there is no case for it.

## 4. Components and changes

### 4.1 `blade-gr-render` (new; lives in `../Blade`, e.g. `tools/gr-render/`)

Lives beside the compiler so the translator, `stdlib/plot.blade`'s emitted spec shape, and
the serve verb version together. Single `main.cpp` + a vendored single-header JSON parser
(the spec is machine-generated, but user-supplied titles/labels flow through it — don't
hand-roll parsing).

**Translator scope (v1):** the five `plot.blade` figure types — contourf, contour, heatmap
(via `gr_cellarray` — there is no `gr_heatmap`), line (`gr_polyline`), scatter
(`gr_polymarker`) — plus axes/ticks (`gr_axes`), title/labels (`gr_text`/`gr_textext`),
colorbar (`gr_colorbar`), colormaps, and log axes (`gr_setscale`).

Non-obvious implementation facts (all verified, details in §7):

- **Build with `-static-libgcc -static-libstdc++`.** The documented plain `-lGR` recipe now
  crashes at load (`STATUS_ENTRYPOINT_NOT_FOUND`): the machine's MSYS2 UCRT64 GCC 15.2 is
  ABI-incompatible with the older runtime DLLs GR ships. Static-linking the C++ runtime
  removes the dependency entirely; only `libGR.dll` remains.
- **Set `GKS_WSTYPE=100` and unset `GR_DISPLAY` before the first GR call.** Otherwise GR's
  default Windows workstation is gksqt: it can spawn a lingering `gksqt.exe` Qt process
  over a localhost socket. With `GKS_WSTYPE=100` (null device), `gr_beginprint` output is
  unaffected and no Qt loads.
- **Exact pixel sizing** (cairo is hardwired to 600 dpi, truncates, and forces even
  widths): `gr_setwsviewport(0, (W+0.5)*0.0254/600, 0, (H+0.5)*0.0254/600)` plus an
  aspect-matched `gr_setwswindow` produces exact W×H. Render to a temp PNG via
  `gr_beginprint` and read it back (`mem://` is a silent no-op; the `!WxH@ptr.mem` buffer
  workstation works and is the no-temp-file alternative if wanted later).
- **`gr_colorbar()` paints into the current viewport and will overwrite the plot.** Bracket
  it: `gr_savestate()` → set a bar-strip viewport → `gr_colorbar()` → `gr_restorestate()`.
  Derive the exact geometry from GR.jl's usage.
- **Decimation is the worker's job, for contour paths only.** `gr_cellarray` already
  downsamples internally (2000² heatmap: ~57 ms — no decimation needed), but `gr_contourf`
  is O(grid) (2000²: ~1.1 s). Stride/`gr_interp2` contour input down to ~2× output pixels.
- **Colormap table:** Viridis=44, Plasma=46, Magma=47, Inferno=45; Greys≈2/18. Cividis and
  RdBu don't exist in GR — map them via `gr_setcolormapfromrgb`.

**Worker protocol (persistent mode):** one NDJSON request per line —
`{"id":N,"cmd":"render","spec":{...},"width":W,"height":H}` →
`{"id":N,"ok":true,"png":"<base64>"}` or `{"id":N,"ok":false,"error":"..."}`. Base64 at
panel resolution is 17–28 KB — negligible.

**Build/distribution (v1):** a build script in the helper dir compiling with
`g++ -I "$GRDIR/include" -L "$GRDIR/lib" -lGR -static-libgcc -static-libstdc++`, output
cached keyed by GR + compiler version. g++ is already the compiled lane's soft dependency;
a prebuilt per-platform exe is a later distribution refinement (and removes the
UCRT-vs-MSVCRT variable for good).

### 4.2 Serve verb (`../Blade/src/IdeServe.fs`)

New `cmd: "renderPlot"` arm in `handle` (dispatch at `IdeServe.fs:308-374`; the stateless
`surface` arm at `:364-371` is the shape to copy):

```
→ {"id":N, "cmd":"renderPlot", "spec":{...}, "plotId":"<meta.id>", "width":W, "height":H}
← {"id":N, "frame":{"v":1, "mime":"image/png", "encoding":"base64", "data":"...",
                    "meta":{"id":"<plotId>", "backend":"gr"}}}
```

Returning a complete **DisplayFrame** lets the extension reuse `decodeFrame` and
`display.publish` unchanged — the panel's merge-by-id then attaches the render to the
existing entry with no new client logic. The id is pinned from the request, which is what
sidesteps the per-emit ordinal problem entirely.

Serve owns the worker lifecycle: resolve `GRDIR` from its own env, **pre-validate**
`%GRDIR%\bin\libGR.dll` exists and prepend `%GRDIR%\bin` to the child's `PATH` (both
failure modes are otherwise *silent* crashes — access violation without `GRDIR`, DLL-not-
found without `PATH`), inject `GKS_WSTYPE=100`, spawn lazily, pre-warm, respawn on crash,
kill on shutdown. Old compilers answer `{"error":"unknown cmd 'renderPlot'"}` — the
documented capability probe — so the extension degrades gracefully (keep the GR button
disabled when the probe fails).

### 4.3 Protocol package (`../Blade/protocol` → re-vendor here)

- Add an **`env` key** to the client dependency contract, merged into the spawn options at
  `client.js:233` (today: no env, child inherits the extension host wholesale). Document at
  `client.js:56-71`, type it in `types/index.d.ts`.
- Add a **`renderPlot` encoder + client method** beside `serveProto.js:81` (`encodeEval`)
  and `client.js:434-440` (`evalCode`); response/request types in `types/serve.d.ts`.
- Version bump (0.19.2 → 0.20.0), `npm run vendor:protocol`, update the tarball pin here
  (`package.json:38-40`, `package-lock.json`). Blade-MCP re-vendors on its own schedule.

### 4.4 Extension (this repo)

- **Env resolution:** a helper beside `findCompiler` (`src/extension.js:71-74`) resolves
  the GR root — setting `blade.grPath` → `vendor/gr` in the workspace → fetch-vendor cache —
  and builds `{GRDIR, PATH: grBin + delimiter + PATH}`. Thread it through `serve.init` /
  `notebook.init` (`extension.js:2703-2713`) into the wrapper (`src/serve.js:40-42`) so
  every serve client gets it. (The REPL child `src/repl.js:90` doesn't need it in v1 —
  GR renders only happen inside serve.)
- **Toggle wiring:** flip `BACKENDS[gr].enabled` (`src/plots.js:43`). In the
  `msg.type === "backend"` branch (`:464-469`): if `renderFor(entry, "gr")` is missing and
  `entry.spec` is non-null, call the new serve method with `{spec, plotId: entry.id,
  width, height}`; route the returned frame through `display.publish`. Add a pending/
  spinner state to `postCurrent`/the webview `show` handler while the round-trip is in
  flight, and an unobtrusive "static render — toggle to plotly for interactivity" hint.
- **Expose the method:** re-export it through the singleton (`src/serve.js:63-80` currently
  exposes only `check`/`checkCells`).
- **Preflight:** if no GR install is found, keep the button disabled with a tooltip
  pointing at `npm run fetch-vendor` (or the setting) instead of failing on click.
- **Tests to flip:** `scripts/plots-test.js:265-266` (asserts the button is disabled) and
  `:316-317` (asserts the toggle message is ignored) invert; add a fake-serve fixture for
  the round-trip using the existing `deps.args` seam (`client.js:53,117-120`).

### 4.5 Packaging (this repo)

- Land `feat/vendor-packaging` (deps.json with the pinned win32 sha256, `fetch-vendor.js`
  stage-and-swap extraction, `.gitattributes` binary markers — GR ships `.ttf`/`.pfb` fonts
  that CRLF conversion would corrupt, and the plotly-CRLF bug it fixes is live on main
  today). **Note:** the branch predates the protocol-package migration, so its
  `package.json` hunks conflict — rebase/re-author rather than merge blindly.
- Add a **subset step** to fetch-vendor: the headless render set is `libGR.dll`,
  `libGKS.dll`, `cairoplugin.dll`, `libwinpthread-1.dll`, `fonts/`, `include/`, `lib/`
  (~28 MB; +`videoplugin.dll` → ~62 MB for animation). Qt (38.7 MB) is never loaded
  headless. Load-time DLLs resolve via `PATH`; plugins and fonts resolve via `GRDIR` — the
  subset tree must keep GR's directory shape.
- `.vscodeignore` already excludes `vendor/**`; nothing ships in the vsix. GR is
  reconstructed from the pinned release URL on demand. The three non-Windows sha256 pins
  stay `null` until those platforms are exercised.

## 5. Phases

**G0 — Packaging & env (this repo).** Land the vendor-packaging work (rebased), subset
extraction, `blade.grPath` + resolution helper + preflight. *Exit:* fresh clone →
`npm run fetch-vendor` → a validated ~28 MB GR tree; extension resolves it.

**G1 — The translator, headless (Blade repo).** `blade-gr-render` one-shot mode covering
all five plot types; build script with the static-link flags; golden PNG tests + a
no-gksqt-child assertion, gated on GR availability (skip cleanly like the g++-gated
suites). *Exit:* `blade-gr-render < fig.json > out.png` reproduces the panel's demo contour
byte-stably; goldens green. **This phase is the whole risk surface and lands with zero
changes to either program lane.**

**G2 — Wire it up (both repos).** Persistent worker mode; `renderPlot` in `IdeServe.fs`;
protocol env + method + version bump; re-vendor; enable the toggle + round-trip + spinner;
flip the two tests, add the fake-serve fixture. *Exit:* click GR on a live plot → PNG
appears in-place; toggle back instant; kill the worker mid-session → next toggle recovers.

**G3 — Animation & export (separable).** Video via the worker (`GKS_VIDEO_OPTS` `WxH@fps`;
`gr_updatews` per frame; mind `GKS_DISABLE_PAGE_SUFFIX`); publication PDF/SVG export
(explicitly *not* golden-tested — SVG has a `srand(time)` path-id counter, PDF a
CreationDate). Decide panel UX: discrete frames vs muxed mp4/webm.

**G4 — Big-grid story (needs the pre-existing decimation work).** GR's headroom beyond
1000² only matters if the spec reaches the panel: at ~20 bytes/sample a raw 2000² grid is
~80 MB of JSON — over the 32 MB frame cap. The already-planned stdlib server-side
decimation + `bdata` typed arrays is the enabler; GR work here is nil beyond §4.1's
contour decimation.

**Later / opportunistic:** prebuilt `blade-gr-render` per platform; Blade-MCP calling
`renderPlot` directly so agent clients get raster plots (today plotly frames degrade to
JSON text in MCP, while `image/png` becomes a real image block — GR quietly upgrades both
MCP and notebook surfaces); optional `Unit backend: 1` option marker in `plot.blade` for a
program-chosen default backend (stdlib-only change, precedent at `plot.blade:39-48`).

## 6. Test strategy

- **Golden PNGs** through the one-shot mode (byte-exact; fixed size via the §4.1 formula;
  `GKS_WSTYPE=100`). PNG output carries no timestamp chunks and is process-state-
  independent — same-machine determinism is proven. Treat goldens as **machine-pinned**
  until cross-machine reproducibility is tested (FreeType/libpng builds feed the bytes).
- **Hygiene assertion:** after a render batch, assert no `gksqt.exe` child and no stray
  `gks.png`/`gks.pdf` in cwd (the trigger for the observed stray gksqt spawn is
  unidentified; test the invariant, don't trust the env var).
- **Round-trip:** fake-serve fixture answering `renderPlot` (extension side); an
  `IdeServe.fs` test pinning the response wire bytes (precedent: `evalResponse` is public
  exactly so `tests/Test_Display.fs` can pin frame bytes).
- **Parity gate:** no changes; `blade test --interp` stays green by construction.

## 7. Empirical appendix (measured on this machine, 2026-08-15)

- **PNG determinism:** SHA256-identical across runs 2 s apart; chunk stream is
  `IHDR, bKGD, IDAT×n, IEND` (no `tIME`/`tEXt`/`pHYs`); pages-in-one-process vs separate
  processes byte-identical. SVG differs only in `clip\d+` ids; PDF only in
  `/CreationDate`; PS embeds a date. `gr_beginprint` formats: bmp, eps, jpeg, mov, mp4,
  webm, ogg, pdf, pgf, png, ps, svg, tiff, wmf, ppm.
- **Perf (800×800 PNG, warm / cold ≈ 2.6 s flat):** contourf 200² 89–172 ms, 1000²
  317–344 ms, 2000² ~1.1 s; heatmap via cellarray 200² ~35 ms, 2000² ~57 ms (O(output
  pixels), not O(grid)). Payloads: 12.9 KB @800px, 20.8 KB @1200px (+33% base64).
- **Env failure modes (all silent):** no `GRDIR` → `STATUS_ACCESS_VIOLATION`; DLLs not on
  `PATH` → `STATUS_DLL_NOT_FOUND`; `GKS_WSTYPE=png` leaks stray files into cwd (don't).
  `GKS_WSTYPE` is cached in a static — set env before the first GR call.
- **Toolchain:** MSYS2 UCRT64 g++ 15.2 + vendored runtime DLLs → `STATUS_ENTRYPOINT_NOT_
  FOUND`; fixed by `-static-libgcc -static-libstdc++`. Import lib `libGR.dll.a` → `-lGR`.
- **API notes:** `GR_COLORMAP_VIRIDIS = 44` (`gr.h:98`); no `gr_heatmap` symbol;
  `gr_reducepoints`/`gr_interp2`/`gr_setresamplemethod` exist for decimation;
  `gr_setscale` for log/flip axes; `gr_nonuniformcellarray` for irregular grids.
- **Known upstream bugs the worker will hit first:** `plot.blade` titles aren't
  JSON-escaped, and NaN/Inf serialize as invalid JSON tokens (`stdlib/plot.blade:30-32`).
  Fix in stdlib rather than teaching the worker's parser to forgive them.

## 8. Open questions

1. **Cross-machine PNG reproducibility** — unproven; may force per-machine goldens or a
   perceptual-diff tolerance for CI.
2. **gksqt spawn trigger** — observed once, not reproduced on the pure `beginprint` path;
   invariant-tested rather than understood.
3. **NaN semantics** — gap vs joined in `gr_polyline`, NaN in contour grids: needs visual
   diffing against plotly's behavior.
4. **Worker longevity** — 20-render runs show no drift; hundreds-of-renders memory behavior
   untested.
5. **`gr_colorbar` viewport bracket** — exact strip geometry/tick interaction to be derived
   from GR.jl.
6. **Animation transport** — discrete PNG frames into the panel vs muxed video file;
   whether ~40 ms/frame survives base64 + NDJSON + webview decode.
7. **Panel resolution handshake** — who picks W×H for a GR render (webview reports its
   pixel size in the request vs a fixed default with export-time re-render).
