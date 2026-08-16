# Blade display frames — wire format

Status: normative for Phase 5 of [plotting-and-units-plan.md](plotting-and-units-plan.md).
Written to be implemented from this document alone.

A **display frame** is one rich, MIME-typed output produced by evaluated Blade
code — a plot, an image, anything that is not stdout text. Frames travel
alongside `stdout`/`stderr` on the channels the compiler already speaks; the
extension routes them to the **Blade Plots** panel and (for notebooks) to cell
outputs.

Reference implementation of the reader: [`src/display.js`](../src/display.js) —
the only parser, shared by every channel. Tests:
[`scripts/plots-test.js`](../scripts/plots-test.js).

---

## 1. The frame object

Every channel carries the same JSON object.

```json
{
  "v": 1,
  "mime": "application/vnd.plotly.v1+json",
  "encoding": "json",
  "data": { "data": [ … ], "layout": { … } },
  "meta": { "id": "p17", "title": "sin(x)·cos(y)", "backend": "plotly" }
}
```

| field | required | type | meaning |
|---|---|---|---|
| `v` | no (default `1`) | number | Envelope version. A reader rejects `v` **greater** than the version it knows. |
| `mime` | **yes** | string | `type/subtype`, matching `^[A-Za-z0-9][A-Za-z0-9.+_-]*/[A-Za-z0-9][A-Za-z0-9.+_-]*$`. |
| `encoding` | no (inferred) | `"json"` \| `"utf8"` \| `"base64"` | How `data` is carried. |
| `data` | **yes** | per `encoding` | The payload. Never `null`. |
| `meta` | no (default `{}`) | object | Non-payload hints (§4). Never an array. |

Unknown top-level fields are **ignored**, not rejected — that is the extension
point for additive changes that do not need a `v` bump.

### Encodings

`encoding` may be omitted; it is then inferred from `mime`:

| mime | inferred `encoding` | `data` JSON type |
|---|---|---|
| `application/json` or `*+json` | `json` | object or array — **inline JSON**, not a string |
| `text/*` | `utf8` | string |
| anything else | `base64` | string, `[A-Za-z0-9+/=\s]+` |

Stating `encoding` explicitly is always allowed and is recommended for anything
outside these three families. A `base64` payload carries **no** `data:` URI
prefix and no `;base64,` marker — just the base64 body. Embedded whitespace is
tolerated (the reader strips it) but should not be emitted.

### Required mime types

An implementation must be able to emit at least these two.

**`application/vnd.plotly.v1+json`** — `encoding: "json"`. `data` is a plotly
figure:

```json
{ "data": [ <trace>, … ], "layout": { … }, "config": { … } }
```

`data.data` and `data.layout` are passed straight to `Plotly.newPlot`/
`Plotly.react`; `data.config` is merged over the panel's defaults
(`responsive: true`, `displaylogo: false`). The panel overlays theme-derived
`paper_bgcolor`/`plot_bgcolor`/`font` **underneath** the frame's own `layout`,
so anything the frame states explicitly wins. Do not set `paper_bgcolor` or
`font.color` unless the plot genuinely requires a fixed palette — leaving them
out is what makes plots readable in both light and dark themes.

**`image/png`** — `encoding: "base64"`. The GR path (offscreen render →
`gr_beginprint` PNG → base64). Rendered as an `<img>`; other `image/*` subtypes
work identically.

Any other mime is accepted and shown as text in the panel with a
`[<mime> — no renderer in this panel]` banner. That is the graceful path for a
future `image/svg+xml`, `text/html`, etc. — no protocol change needed, only a
panel renderer.

---

## 2. Channel: `blade ide serve` — the `display` array (baseline)

**This is the required mechanism.** `ide serve` already speaks NDJSON with one
JSON object per line ([`src/serveProto.js`](../src/serveProto.js)), and an
`eval` response is already a structured object with `stdout`, `stderr`,
`bindings`, `diagnostics`. Frames are one more field:

```jsonc
{"id": 12, "kept": true, "exitCode": 0, "lane": "interp", "elapsedMs": 41,
 "stdout": "", "stderr": "", "bindings": [], "diagnostics": [],
 "display": [ {"mime": "application/vnd.plotly.v1+json", "data": { … }} ]}
```

- `display` is an **array of frame objects**, in production order.
- The field is **optional**. Its absence is not an error and is not
  distinguishable from an empty array — every compiler that predates display
  frames is already conformant.
- Frames belong to the submission that produced them. There is no correlation
  field: array position is the order.

Why this and not a side channel: the eval response is the one place the
extension already knows "this submission is finished, here is everything it
produced". Adding a field is backward-compatible in both directions (old
extension ignores it; old compiler omits it), needs no new framing, and
inherits the existing id correlation, timeouts and teardown for free.

The notebook path is the same channel — [`src/notebook.js`](../src/notebook.js)
turns each frame into a `NotebookCellOutput` whose first item is
`NotebookCellOutputItem(data, mime)` and whose second is a `text/plain`
summary, so a cell degrades to text where no renderer is contributed.

## 3. Channel: `blade ide serve` — streamed frames (optional)

A submission that runs for a while (an animation loop, a sweep) may want to
show plots as it goes rather than at the end. For that, and only that, the
compiler may write an **out-of-band event line**:

```jsonc
{"event": "display", "id": 12, "frame": {"mime": "image/png", "data": "iVBOR…"}}
```

Rules, which the reader enforces:

- **A line carrying `"event"` is never a response.** It may repeat the
  in-flight request's `id` (and should, for provenance), and the reader must
  not settle that request with it — [`src/serve.js`](../src/serve.js) checks
  for `event` *before* the pending-id lookup. Responses must therefore never
  carry an `event` field.
- Unknown `event` values are logged and dropped, never errors. That keeps a
  newer compiler's events from breaking an older extension.
- A frame delivered as an event **must not** be repeated in the terminal
  response's `display` array — it would appear twice.

This mechanism is optional. Implement §2 first; §3 only when a real streaming
use case exists.

## 4. Channel: `blade repl` — the sentinel line

`blade repl` is a terminal-shaped protocol: prompt sentinels frame submissions
and everything else on stdout is free text ([`src/replProto.js`](../src/replProto.js)).
There is no JSON envelope to extend, so a frame is **one line, prefixed by a
sentinel**:

```
<0x01> b l a d e - d i s p l a y <0x01> <compact JSON frame> <0x0A>
```

- The sentinel is exactly **15 bytes**: `0x01`, the ASCII text
  `blade-display`, `0x01`. In a JS/F# string literal:
  `"\u0001blade-display\u0001"`.
- The JSON follows immediately, on the **same line**, compact (no pretty
  printing), and is terminated by a single `\n`. `\r\n` is tolerated.
- The sentinel must be at **column 0**. If the current output column is not 0
  (a `print` without a trailing newline), the runtime must emit a `\n` first.
- Frames go on **stdout only**. stderr is never scanned.

Why SOH (`0x01`) delimiters rather than a plain-text marker: `JSON.stringify`
and every conforming JSON encoder escape control characters inside strings as
`\u0001`, so a frame's own payload can never contain a raw sentinel and can
never re-open a frame. Ordinary Blade program output does not begin with SOH.
The result is a prefix that needs no escaping scheme at all.

Why a line marker rather than an ANSI/OSC escape: the REPL's own framing —
prompt detection, `cleanFrame`, `summarize` — is already line-oriented, and the
extension strips frame lines before writing to the pseudoterminal, so terminal
invisibility buys nothing.

Interaction with prompt framing: `blade>` / `  ... ` prompts are written
without a trailing newline and are *not* frame lines, so the reader's streaming
scanner (`createStreamScanner`) emits them immediately; only a partial line
that starts with — or could still become — the sentinel is withheld. A frame
line therefore never delays a prompt, and a prompt never truncates a frame.

### Worked example

```
blade> plot.contourf(x, y, z, 20: levels, viridis: cmap)
<0x01>blade-display<0x01>{"v":1,"mime":"application/vnd.plotly.v1+json","data":{"data":[{"type":"contour","x":[0,0.1],"y":[0,0.1],"z":[[0,0.1],[0.1,0.2]],"colorscale":"Viridis","contours":{"start":-1,"end":1,"size":0.1}}],"layout":{"xaxis":{"title":{"text":"x [m]"}},"yaxis":{"title":{"text":"y [m]"}}}},"meta":{"id":"p17","title":"sin(x)·cos(y)","backend":"plotly"}}
it = Plot — plot.Figure
blade>
```

The extension shows `it = Plot — plot.Figure` in the terminal and inline
decoration, and draws the contour in the panel. The frame line itself never
reaches the terminal.

---

## 5. `meta`

All optional, all ignorable. `meta` is metadata *about* the frame; it never
affects how `data` is decoded.

| key | type | used for |
|---|---|---|
| `id` | string | **Plot identity.** Two frames with the same `id` are two renders of the *same* plot: the second lands in the existing history entry as an alternate render instead of appending a new plot. This is how a GR PNG for a plot already shown via plotly attaches to it. Ids are per-session and opaque. |
| `title` | string | History entry label / export filename. Falls back to `layout.title` for plotly frames, then `Plot N`. |
| `backend` | string | Which backend produced this render — `"plotly"`, `"gr"`. Defaults: the plotly mime ⇒ `plotly`; any `image/*` ⇒ `gr` (the static-render lane). Set it explicitly when that inference is wrong. |
| `preferredBackend` | string | Which backend the **program** wants shown (stdlib's `backend` option slot). A *hint about presentation*, distinct from `backend` above, which is a *fact about this payload* — the viewer keys its per-plot render cache on `backend`, so a plotly payload claiming `backend: "gr"` would be filed as the GR render and would suppress the real one. On a hinted frame the panel switches to that backend and renders eagerly; it ignores the hint when that backend is unavailable, and stops honoring it once the user works the toggle by hand. Omit the key entirely when the program has no preference. |
| `spec` | object | The **backend-neutral plot spec**. Retained per history entry so a later backend switch can ask the compiler to re-render the same plot. Reserved — the extension stores it and does not interpret it. |

Everything else in `meta` is carried through untouched (notebook outputs get it
as output metadata under `blade`).

---

## 6. Size

One frame is one line / one JSON value; it is fully buffered before it can be
parsed. Budget accordingly.

- **Target ≤ 8 MB** of JSON text per frame.
- **Hard limit 32 MB** (`display.MAX_FRAME_CHARS`). A frame above it is
  rejected as malformed *before* `JSON.parse`, so an accidental full-resolution
  dump cannot take the extension host down.
- A raw `Float64` grid serialized as JSON numbers costs roughly 20 bytes per
  sample: a 1000² contour is ~20 MB. **Decimate server-side** to display
  resolution before serializing — the plan already calls for this, and the
  crossover where plotly gets sluggish (a few hundred² for SVG contours) is
  well below the size limit anyway.
- For grids that stay large, prefer plotly's binary typed arrays over JSON
  numbers: `{"bdata": "<base64>", "dtype": "f8", "shape": "60,60"}` in place of
  a nested numeric array. This stays inside `encoding: "json"` (it is part of
  the plotly figure, not the frame envelope) and is ~4× smaller.
- base64 costs 33% over raw bytes; a 492 KB GR PNG is ~656 KB on the wire,
  which is fine.

---

## 7. Error behavior

A malformed frame is a **compiler bug that must not cost the user their REPL
session**. Nothing here throws, and nothing here is silently swallowed.

| condition | reader behavior |
|---|---|
| Sentinel line whose JSON does not parse | The payload text (sentinel stripped) stays in the terminal transcript as plain text. Reason logged to the "Blade" output channel. No frame. |
| Frame fails validation (missing/ bad `mime`, missing `data`, wrong `data` type for `encoding`, non-base64 base64, `meta` not an object) | Same as above on the REPL channel. On the notebook channel, the reasons become a `text/plain` cell output so the failure is visible where the plot should have been. On the serve event channel, logged and dropped. |
| `v` greater than the reader knows | Treated as malformed, with a reason naming the version and telling the user to update the extension. |
| Frame text over the hard limit | Rejected before parsing, with a reason naming the size. |
| `display` present but not an array | Whole array ignored, one reason logged. |
| Unknown `event` value on the serve channel | Logged, dropped. |
| Valid frame the panel cannot draw (plotly throws, unknown mime) | Panel shows the payload as text with a banner; the panel and the session stay alive; the message is logged. |
| Extra unknown fields on the frame | Ignored. |

Rejections are per frame: one bad frame in a `display` array does not discard
the good ones.

Two invariants worth restating, because they are what "never break the REPL"
actually means in code:

1. The text channel is **never** silently reduced. Anything that is not a
   valid frame stays in the text the user sees.
2. Frame handling is downstream of, and cannot influence, submission framing.
   Prompt detection, `kept`/`exitCode`, diagnostics and inline decorations are
   computed exactly as they are today.

---

## 8. Versioning

- `v` covers the **envelope**, not the payload. New mime types, new `meta`
  keys, and new top-level fields do not bump it.
- Bump `v` only for a change that would make an existing reader misinterpret a
  frame (renaming `data`, changing an encoding's meaning).
- A reader must accept `v` less than or equal to its own and reject greater.
  There is no negotiation handshake: `ide serve`'s `ping` response already
  carries `version`, and frames are self-describing.

---

## 9. Compiler-side checklist

1. Serialize a plot to a frame object: `{mime, data}` at minimum; add
   `meta.id` (stable per plot value), `meta.title`, `meta.backend`, and
   `meta.spec` if the backend-neutral spec is available.
2. `ide serve` `eval`: collect the submission's frames and put them in the
   response's `display` array. **Ship this first** — the notebook and the panel
   both light up from it.
3. `blade repl`: write each frame as a sentinel line on stdout, at column 0,
   compact JSON, one `\n`, flushed before the next prompt.
4. Never emit a frame on stderr, never split one across lines, never
   pretty-print.
5. Decimate before serializing; prefer plotly binary arrays for large grids.
6. Do not put frames in both `display` and an event line for the same plot.
7. Emit a `\n` before the sentinel when the current stdout column is not 0.
8. `display.emit`'s `mime` and `meta` arguments are **string literals**,
   resolved at elaboration time (a malformed or non-literal value is a
   compile error, BL5300). Only `data` is a runtime expression. This is what
   keeps frame assembly a pure concatenation in both execution lanes.
9. Payload text passes through as **UTF-8 in both lanes, unescaped above
   0x7F**. Both writers must emit UTF-8; `\uXXXX` escaping of non-ASCII is
   not performed and readers must not require it.

## 10. Session replay and cell attribution

A REPL/notebook session re-runs every accumulated snippet, so an eval
response's `display` array reports **every frame the run produced** — a
non-plotting cell's response can carry earlier cells' frames. `meta.id` is
deliberately stable across replays (`<SessionTag><ordinal>`, ordinal reset
per run) so consumers can tell replayed frames from new ones:

- **Panel**: merge by `meta.id` (an already-seen id updates the existing
  history entry rather than appending).
- **Notebook cell outputs**: a frame whose `meta.id` was already seen in
  this session belongs to an earlier cell — skip it for the current cell's
  outputs, but still route it to the panel.
