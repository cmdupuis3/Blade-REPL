# Zoom-to-recompute: re-evaluating a figure from a pan/zoom gesture

The plot panel's plotly zoom stretches samples that already exist. For a
computed view — the worked example is `Blade/examples/mandelbrot.bladenb` —
the samples themselves are a function of a *camera* (center + half-width held
in session bindings), and the honest response to a zoom is to **recompute**:
new bounds, new grid, full resolution at every depth.

## The contract

A program opts a figure in with two `plot.heatmap` slots (stdlib
`plot.blade`):

```blade
plot.contourf(xs, ys, z, 24: levels,
    "mandelbrot-view": plotid,            // stable meta.id -> re-emits REPLACE
    "cam_cx,cam_cy,cam_r": camera)        // the bindings that position the view
```

- `plotid` routes the frame through `display.emit_id`: every frame sharing
  the id merges into ONE panel entry (`appendFrame`'s merge rule), so a
  recomputed frame replaces its predecessor instead of appending.
- `camera` names three session bindings — center-x, center-y, half-width, in
  that order — and travels in the figure **layout**
  (`"blade_camera":{"bindings":"cam_cx,cam_cy,cam_r"}`). It cannot ride the
  frame meta: `display.emit`'s meta must be a string literal (BL5700), while
  the layout is runtime-built JSON. A viewer that does not know the key
  ignores one extra layout entry.

## The flow

1. **Webview** (`plots.js` webview script, `attachZoom`): one
   `plotly_relayout` listener. A gesture is recognized by the four explicit
   range keys (`xaxis.range[0]` … `yaxis.range[1]`) arriving together —
   programmatic relayouts (theme, epoch markers, autorange) carry other keys
   and fall through. If the current figure's layout has `blade_camera`, the
   ranges are posted to the host as `{type:"zoom", xr, yr}`.
2. **Host** (`plots.js` `handleZoom`): parse the contract
   (`cameraFromSpec`), turn ranges into camera values (`zoomCamera`: center
   of selection; half-width = the larger half-span, since the canvas is
   square), and call `deps.onPlotZoom`. One recompute per plot at a time
   (`zoomInflight`); a gesture during a recompute is dropped with a note —
   the serve session is serial anyway and the next gesture carries the
   newest camera.
3. **Notebook** (`notebook.js` `onPlotZoom`): the load-bearing design choice —
   the gesture performs *the same edit the user would make by hand*. It

   - looks up which notebook cell emitted the plot (`zoomTargets`, recorded
     from every eval's camera-carrying frames),
   - finds the cell whose text defines the first camera binding, rewrites its
     `let <name> = <value>` lines with the gesture's values
     (`rewriteCameraSource`; values printed as shortest round-trip Float64,
     `bladeFloat`), via an ordinary `WorkspaceEdit`,
   - re-runs the camera cell and then the emitting cell through the ordinary
     `executeCell` path.

   The re-run rebinds the names in the session (a rebind is just another
   `let`; the session splices by name), recomputes the frame, and re-emits it
   under the stable id — the panel merge closes the loop. Because the cell
   TEXT was edited, the notebook is never lying about what the picture
   shows, re-running the camera cell by hand does not snap back, and the
   whole interaction is replayable from the file.

## Deliberate limits (v1)

- **One recompute per plot at a time**, gestures in between dropped with a
  note. No cancellation exists server-side (the interpreter has no hook; see
  interruptHandler), so superseding would mean killing the process.
- **Double-click autorange is ignored** — it reports `autorange:true`, not
  ranges. Zoom-out is a hand edit of the camera cell (or a future toolbar
  button remembering the initial camera).
- **Latency is the cell's honest cost** (seconds in the interpreter lane at
  the Mandelbrot notebook's sizes). Making it fluid is a compiled/JIT-lane
  question, not a wiring question.
- **The recompute can refuse**: past the interpreter's step budget the cell
  fails (BL8005), the panel keeps the previous frame, and the note says why.
  The Mandelbrot notebook sizes its view (256², capped auto-kmax) to stay
  inside the budget until roughly the Float64 floor at r ≈ 10⁻¹⁴, which is
  where recomputation stops yielding new structure anyway. Beyond THAT is
  perturbation-theory territory (high-precision reference orbit + Float64
  deltas) — a Blade-side notebook, not an extension feature.
