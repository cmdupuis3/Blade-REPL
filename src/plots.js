// "Blade Plots" — a WebviewPanel docked beside the editor that renders the
// display frames src/display.js routes (julia-vscode's plot-navigator shape:
// one panel, a history of every plot the session produced, prev/next through
// it). The panel subscribes to display.subscribe(); it never talks to the
// compiler and never parses a wire format, so a frame from `blade repl`, from
// a notebook cell, and from the plot demo take the identical path here.
//
// Two hard constraints shape this file:
//
//   - Webviews are OFFLINE. plotly.min.js ships in media/ and loads through
//     webview.asWebviewUri under a CSP with no remote hosts. The only other
//     script is this file's own inline bootstrap, admitted by nonce.
//     plotly 3.7.0 needs neither 'unsafe-eval' nor network access: its single
//     `new Function` is webpack's globalThis probe, unreachable in Chromium.
//   - The history model is EXTENSION-side (newHistory/appendFrame/navigate
//     below), not webview-side. The webview is a dumb renderer told what to
//     show, so the navigation and merge rules are plain functions
//     scripts/plots-test.js can drive without a browser.
//
// Live plot streams (plan-equivariant-nn-notebooks.md §4) ride the same hub:
// a `application/vnd.blade.plotstream.v1+json` frame is ONE CHUNK of a named
// channel's series, merged extension-side into an accumulator on the channel's
// history entry (`entry.stream`) and handed to the webview as an ordinary
// plotly figure. The webview extends the live trace instead of re-plotting it,
// and bursts are coalesced into one postMessage per ~100 ms.
//
// Backends: plotly renders in-webview; GR renders via one round-trip to the
// warm serve process (deps.renderPlot, wired by extension.js) and lands as an
// image/png frame carrying the same meta.id, so it attaches to the existing
// entry as an alternate render rather than appending a duplicate plot. The GR
// button's enablement is computed per panel build (backendState): it needs
// both the round-trip wiring and a resolvable GR install (deps.findGr).
// `entry.spec` retains a frame's meta.spec when one is present; today no
// frame carries one, so the retained plotly figure itself is the
// backend-neutral spec the round-trip sends (specFor).

"use strict";

const vscode = require("vscode");
const path = require("path");
const display = require("@blade-lang/ide-protocol").display;

// Injected by init(): { output, findGr, renderPlot, onPlotZoom } from
// extension.js. onPlotZoom is the zoom-to-recompute hook (wired to the
// notebook module); when absent, a zoom on a camera-carrying figure gets a
// "not wired" note and nothing else.
let deps;

const VIEW_TYPE = "bladePlots";
const PANEL_TITLE = "Blade Plots";

/** Backends the toolbar offers. This is the static fallback shape (what
 *  headless tests see with no deps wired); GR's EFFECTIVE enablement comes
 *  from backendState() below, evaluated when the panel HTML is built and on
 *  every toggle message. */
const BACKENDS = [
  { id: "plotly", label: "plotly", enabled: true, tooltip: "plotly — interactive (active)" },
  { id: "gr", label: "GR", enabled: false, tooltip: "GR — unavailable" },
];

/** The toolbar's effective backend entries. GR is enabled only when the serve
 *  round-trip is wired (deps.renderPlot) AND the resolver finds a usable GR
 *  install right now (deps.findGr — re-evaluated so a fetch-vendor run or a
 *  blade.grPath change is picked up on the next panel build). The tooltip
 *  carries the reason when disabled — the button explains itself. */
function backendState() {
  return BACKENDS.map((b) => {
    if (b.id !== "gr") return b;
    if (!deps || typeof deps.renderPlot !== "function" || typeof deps.findGr !== "function") {
      return { id: "gr", label: "GR", enabled: false, tooltip: "GR — unavailable: render round-trip not wired" };
    }
    const g = deps.findGr();
    return g && g.ok
      ? { id: "gr", label: "GR", enabled: true, tooltip: "GR — static render (rendered by the serve process)" }
      : { id: "gr", label: "GR", enabled: false, tooltip: `GR — unavailable: ${(g && g.reason) || "no GR install found"}` };
  });
}

// --- History model (pure) ------------------------------------------------------

function newHistory() {
  return { entries: [], cursor: -1, seq: 0 };
}

/** A plotly frame's own title, when it has one, else `Plot N`. */
function titleFor(frame, seq) {
  const meta = frame.meta || {};
  if (typeof meta.title === "string" && meta.title.trim()) return meta.title.trim();
  const layout = frame.mime === display.PLOTLY_MIME && frame.data ? frame.data.layout : undefined;
  const t = layout && layout.title;
  if (typeof t === "string" && t.trim()) return t.trim();
  if (t && typeof t.text === "string" && t.text.trim()) return t.text.trim();
  return `Plot ${seq}`;
}

// --- Live plot streams (pure) --------------------------------------------------
//
// Wire contract (frozen — the compiler side implements the same text, see
// ../Blade/docs/plans/plan-equivariant-nn-notebooks.md §4):
//
//   mime  application/vnd.blade.plotstream.v1+json   (inline JSON, §1's +json rule)
//   data  {channel, epoch, x[], y[], title, xlabel, ylabel}   epoch -1 = unmarked
//   meta  {id: "<channel>", stream: true, backend: "plotly"}
//
// `meta.id` IS the channel name and is stable across calls AND session
// replays, so it is the merge key on both sides. One frame is a CHUNK, not a
// figure: the accumulated series lives here (newStreamAcc/mergeStreamFrame)
// and the figure is derived from it on demand (streamFigure).

const STREAM_MIME = "application/vnd.blade.plotstream.v1+json";

/** Drawn-point budget per trace. Past this the FIGURE is built with a stride
 *  so plotly never holds more than ~this many points; the accumulator keeps
 *  every raw sample (decimation is a drawing decision, not a data one). */
const STREAM_DRAW_LIMIT = 20000;

/** Epoch markers drawn at once. A 500-epoch run would otherwise put 500
 *  shapes AND 500 annotations in one layout; markers are strided the same way
 *  points are. */
const STREAM_MAX_MARKS = 60;

/** Log one line per this many frames of a channel (plus always the first).
 *  A per-batch training stream emits thousands. */
const STREAM_LOG_EVERY = 25;

function isStreamFrame(frame) {
  return !!frame && frame.mime === STREAM_MIME;
}

/** A channel's accumulated series. `runs` counts run boundaries (see
 *  mergeStreamFrame) — it is part of the webview's resync key, so a replay
 *  can never be mistaken for a continuation of what is already drawn. */
function newStreamAcc() {
  return {
    channel: "",
    title: "",
    xlabel: "",
    ylabel: "",
    x: [],
    y: [],
    boundaries: [], // [{x, epoch}] — where each epoch started, in x coordinates
    lastEpoch: null,
    lastChunk: null, // signature of the last merged chunk (idempotency, below)
    runs: 0,
    frames: 0,
  };
}

/** Cheap identity of one chunk: enough to recognize the SAME chunk delivered
 *  twice without hashing the whole payload. */
function chunkSignature(x, y, epoch) {
  return [x.length, x[0], x[x.length - 1], y[0], y[y.length - 1], epoch].join("|");
}

/**
 * Merge one stream frame's `data` into `acc`.
 *
 * Three rules, in order:
 *
 *  - **Idempotent.** A chunk identical to the one merged immediately before is
 *    dropped. In the serve lane the compiler skips buffering sink-forwarded
 *    stream frames, so a frame is not supposed to arrive twice at all; this
 *    makes a double delivery a no-op instead of a doubled series. (It only
 *    catches an ADJACENT repeat — the panel does not keep a hash of every
 *    chunk ever seen.)
 *  - **Run boundary resets.** A Blade session re-runs every accumulated
 *    snippet, so an earlier cell's `plot.stream` calls are re-emitted verbatim
 *    under the same stable `meta.id` on every later eval. A chunk that starts
 *    at or before the accumulated series' FIRST x, or whose epoch went
 *    backwards, is that replay starting over: the accumulator is emptied and
 *    rebuilt, so a replayed run redraws identically instead of appending a
 *    second copy of itself. (Nothing out-of-band announces a run boundary —
 *    see the report/README: the signal is in the data.)
 *  - **Append.** x/y are concatenated; a ragged chunk is truncated to the
 *    shorter of the two rather than padded.
 *
 * @returns {{appended: number, reset: boolean, skipped: boolean}}
 */
function mergeStreamFrame(acc, data) {
  const d = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const x = Array.isArray(d.x) ? d.x : [];
  const y = Array.isArray(d.y) ? d.y : [];
  const n = Math.min(x.length, y.length);
  const epoch = typeof d.epoch === "number" && isFinite(d.epoch) ? d.epoch : -1;

  const sig = n > 0 ? chunkSignature(x, y, epoch) : null;
  if (sig !== null && acc.lastChunk === sig) return { appended: 0, reset: false, skipped: true };

  // Label fields are carried whenever provided — they may only appear on the
  // first chunk, or change mid-run; last one wins.
  if (typeof d.channel === "string" && d.channel) acc.channel = d.channel;
  if (typeof d.title === "string" && d.title) acc.title = d.title;
  if (typeof d.xlabel === "string" && d.xlabel) acc.xlabel = d.xlabel;
  if (typeof d.ylabel === "string" && d.ylabel) acc.ylabel = d.ylabel;

  let reset = false;
  const restarted =
    (n > 0 && acc.x.length > 0 && x[0] <= acc.x[0]) ||
    (epoch >= 0 && acc.lastEpoch !== null && epoch < acc.lastEpoch);
  if (restarted) {
    acc.x = [];
    acc.y = [];
    acc.boundaries = [];
    acc.lastEpoch = null;
    acc.runs++;
    reset = true;
  }

  if (epoch >= 0 && epoch !== acc.lastEpoch) {
    // The boundary is recorded at the x position the new epoch STARTS at, so
    // the marker lands on the first sample of that epoch (the very first
    // marked chunk therefore marks the start of the plot — that is the epoch
    // the program asked to have marked, not an artifact).
    acc.boundaries.push({ x: n > 0 ? x[0] : acc.x.length, epoch });
    acc.lastEpoch = epoch;
  }

  for (let i = 0; i < n; i++) {
    acc.x.push(x[i]);
    acc.y.push(y[i]);
  }
  if (sig !== null) acc.lastChunk = sig;
  acc.frames++;
  return { appended: n, reset, skipped: false };
}

/** Draw every `stride`-th sample. Stride 1 is a plain copy. */
function strideSample(arr, stride) {
  if (stride <= 1) return arr.slice();
  const out = [];
  for (let i = 0; i < arr.length; i += stride) out.push(arr[i]);
  return out;
}

/** The stride the DRAWN trace uses for `n` accumulated points. Recomputed on
 *  every post: it only changes when n crosses a multiple of the limit, which
 *  is exactly when the webview needs a full redraw rather than an extend. */
function streamStride(n) {
  return Math.max(1, Math.ceil(n / STREAM_DRAW_LIMIT));
}

/** Epoch markers as plotly layout pieces: a paper-height dotted vertical line
 *  plus a small label. Neutral grey so both themes read it. */
function streamMarks(acc) {
  const b = acc.boundaries;
  const stride = Math.max(1, Math.ceil(b.length / STREAM_MAX_MARKS));
  const marks = strideSample(b, stride);
  return {
    shapes: marks.map((m) => ({
      type: "line",
      xref: "x",
      yref: "paper",
      x0: m.x,
      x1: m.x,
      y0: 0,
      y1: 1,
      line: { color: "rgba(128,128,128,0.55)", width: 1, dash: "dot" },
      layer: "below",
    })),
    annotations: marks.map((m) => ({
      x: m.x,
      xref: "x",
      y: 1,
      yref: "paper",
      yanchor: "bottom",
      text: `e${m.epoch}`,
      showarrow: false,
      font: { size: 10, color: "rgba(128,128,128,0.9)" },
    })),
  };
}

/** The plotly figure for an accumulated stream. `uirevision` is the channel,
 *  so a user's zoom/pan survives every incremental update. */
function streamFigure(acc) {
  const stride = streamStride(acc.x.length);
  const marks = streamMarks(acc);
  const layout = {
    xaxis: { title: { text: acc.xlabel || "" } },
    yaxis: { title: { text: acc.ylabel || "" } },
    shapes: marks.shapes,
    annotations: marks.annotations,
    uirevision: acc.channel || "stream",
    showlegend: false,
  };
  if (acc.title) layout.title = { text: acc.title };
  return {
    data: [
      {
        type: "scatter",
        mode: "lines",
        name: acc.channel || "series",
        x: strideSample(acc.x, stride),
        y: strideSample(acc.y, stride),
      },
    ],
    layout,
  };
}

/** The plotly frame a stream entry renders as, rebuilt only when the
 *  accumulator actually moved (`{n, runs}` is the whole cache key — a reset
 *  bumps `runs`, so "same length, different run" is not a cache hit). */
function streamRenderFrame(entry) {
  const acc = entry.stream;
  const built = entry._streamBuilt;
  if (built && built.n === acc.x.length && built.runs === acc.runs && entry.renders.plotly) {
    return entry.renders.plotly;
  }
  const frame = {
    v: display.FRAME_VERSION,
    mime: display.PLOTLY_MIME,
    encoding: "json",
    data: streamFigure(acc),
    meta: { id: entry.id, backend: "plotly", stream: true },
  };
  entry.renders.plotly = frame;
  entry._streamBuilt = { n: acc.x.length, runs: acc.runs };
  return frame;
}

/** A stream entry's label: the program's title, else the channel name, else
 *  the usual `Plot N`. Recomputed per frame — a title may arrive late. */
function streamTitle(acc, seq) {
  return acc.title || acc.channel || `Plot ${seq}`;
}

/** Merge one stream frame into `hist` by `meta.id` (the channel name), or
 *  open the channel's entry on its first frame. Never appends a second entry
 *  for a channel, and never builds a figure — see streamRenderFrame. */
function appendStreamFrame(hist, frame) {
  const meta = frame.meta || {};
  const data = frame.data && typeof frame.data === "object" ? frame.data : {};
  const id =
    (typeof meta.id === "string" && meta.id) ||
    (typeof data.channel === "string" && data.channel) ||
    "stream";

  let idx = hist.entries.findIndex((e) => e.id === id);
  let merged = true;
  let entry;
  if (idx < 0) {
    const seq = ++hist.seq;
    entry = {
      id,
      seq,
      title: `Plot ${seq}`,
      receivedAt: Date.now(),
      primary: "plotly",
      prefer: null,
      renders: {},
      spec: null,
      stream: newStreamAcc(),
    };
    hist.entries.push(entry);
    idx = hist.entries.length - 1;
    merged = false;
  } else {
    entry = hist.entries[idx];
    // An id shared with a non-stream plot: the stream takes over that entry
    // rather than opening a rival one under the same identity.
    if (!entry.stream) entry.stream = newStreamAcc();
  }

  const res = mergeStreamFrame(entry.stream, data);
  entry.title = streamTitle(entry.stream, entry.seq);
  hist.cursor = idx;
  return { entry, index: idx, merged, stream: res };
}

/**
 * Append `frame` to `hist`, or merge it into the entry it re-renders.
 *
 * Merge rule: a frame whose `meta.id` matches an existing entry's id is an
 * ALTERNATE RENDER of that plot (the GR round-trip the plan describes) — it
 * lands in that entry's `renders` under its backend and the history does not
 * grow. Everything else appends and becomes the current entry.
 *
 * A STREAM frame is merged by the same key but on different terms — it is a
 * chunk of a series, not a render of a figure — see appendStreamFrame.
 *
 * @returns {{entry: object, index: number, merged: boolean}}
 */
function appendFrame(hist, frame) {
  if (isStreamFrame(frame)) return appendStreamFrame(hist, frame);
  const backend = display.backendFor(frame);
  const meta = frame.meta || {};
  const id = typeof meta.id === "string" && meta.id ? meta.id : null;
  // `meta.backend` says which backend PRODUCED this frame; `preferredBackend`
  // is the program asking for a different one to be shown (stdlib's `backend`
  // option slot). Deliberately separate keys: stamping backend:"gr" on a
  // plotly payload would file it as the GR render and suppress the real one.
  const prefer = BACKENDS.some((b) => b.id === meta.preferredBackend) ? meta.preferredBackend : null;

  if (id) {
    const idx = hist.entries.findIndex((e) => e.id === id);
    if (idx >= 0) {
      const entry = hist.entries[idx];
      entry.renders[backend] = frame;
      if (meta.spec !== undefined) entry.spec = meta.spec;
      // A re-render never revokes the original request, only restates it.
      if (prefer) entry.prefer = prefer;
      // A MERGE does not move the cursor. A Blade session re-runs every
      // accumulated snippet, so one cell eval re-emits EVERY earlier plot;
      // if each replayed frame stole focus, the panel would end every eval
      // showing whichever plot happened to re-emit last -- during a
      // zoom-to-recompute, that was reliably some other figure entirely.
      // The updated render is retained either way; onFrame repaints when
      // the merged entry is the one on screen.
      return { entry, index: idx, merged: true };
    }
  }

  const seq = ++hist.seq;
  const entry = {
    id: id || `plot-${seq}`,
    seq,
    title: titleFor(frame, seq),
    receivedAt: Date.now(),
    primary: backend,
    prefer,
    renders: { [backend]: frame },
    spec: meta.spec === undefined ? null : meta.spec,
  };
  hist.entries.push(entry);
  hist.cursor = hist.entries.length - 1;
  return { entry, index: hist.cursor, merged: false };
}

/** Move the cursor by `delta`, clamped to the history. Returns the new cursor
 *  (-1 when the history is empty). */
function navigate(hist, delta) {
  if (hist.entries.length === 0) {
    hist.cursor = -1;
    return -1;
  }
  const next = Math.min(hist.entries.length - 1, Math.max(0, hist.cursor + delta));
  hist.cursor = next;
  return next;
}

function currentEntry(hist) {
  return hist.cursor >= 0 && hist.cursor < hist.entries.length ? hist.entries[hist.cursor] : undefined;
}

/** The frame an entry should render on `backend`: that backend's render when
 *  it exists, otherwise the entry's primary (a plotly-only plot stays visible
 *  with GR selected, and vice versa — a blank pane on toggle is never the
 *  right answer). */
function renderFor(entry, backend) {
  if (!entry) return undefined;
  // A stream entry's plotly render is DERIVED from the accumulator, so it is
  // built (and cached) here rather than stored on arrival — the alternative
  // is rebuilding the whole figure on every chunk of a burst.
  if (entry.stream && (backend === "plotly" || !entry.renders[backend])) return streamRenderFrame(entry);
  return entry.renders[backend] || entry.renders[entry.primary] || Object.values(entry.renders)[0];
}

/** The backend-neutral spec for a re-render round-trip: a frame-carried
 *  meta.spec when one exists (reserved in the wire spec, unused today), else
 *  the retained plotly figure object itself. Null when the entry has neither
 *  (e.g. a GR-only image with no plotly sibling — nothing to re-render from). */
function specFor(entry) {
  if (!entry) return null;
  if (entry.spec !== null && entry.spec !== undefined) return entry.spec;
  if (entry.stream) return streamRenderFrame(entry).data;
  const p = entry.renders.plotly;
  return p && p.mime === display.PLOTLY_MIME && p.encoding === "json" ? p.data : null;
}

// --- Panel state ---------------------------------------------------------------

const history = newHistory();
let backend = "plotly";
/** Set once the user clicks a backend button. A program's `preferredBackend`
 *  hint auto-switches the panel only until then: the program's request is
 *  worth honoring, but silently overriding a human's explicit choice on every
 *  subsequent plot is not. */
let userPinnedBackend = false;
/** @type {vscode.WebviewPanel | undefined} */
let panel;
let webviewReady = false;
let pendingShow = false; // a show() that landed before the webview said "ready"

/** What the webview currently holds for a live stream:
 *  `{id, count, stride, runs}` — the number of accumulated points it has been
 *  told about, the stride those were drawn at, and which run they belong to.
 *  A faithful mirror (the webview only ever does what it is told, and messages
 *  are ordered), so no round-trip is needed to decide extend-vs-redraw.
 *  Null whenever the webview is not holding a stream. */
let liveStream = null;
/** Trailing coalesce window for stream posts. A burst of chunks collapses
 *  into ONE postMessage per window (≤10 fps at the default). */
let streamCoalesceMs = 100;
let streamTimer = null;

function log(line) {
  if (deps && deps.output) deps.output.appendLine(`[plots] ${line}`);
}

function extensionUri() {
  if (deps && deps.extensionUri) return deps.extensionUri;
  return vscode.Uri.file(path.join(__dirname, ".."));
}

function joinUri(base, ...parts) {
  if (vscode.Uri.joinPath) return vscode.Uri.joinPath(base, ...parts);
  return vscode.Uri.file(path.join(base.fsPath, ...parts));
}

function nonceString() {
  let s = "";
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
  return s;
}

/**
 * The panel document. Pure string work over `{cspSource, plotlyUri, nonce}`
 * so scripts/plots-test.js can assert the CSP and the bundled-plotly
 * reference without a webview host.
 *
 * CSP: `default-src 'none'` with no remote host anywhere — scripts come from
 * the extension's own resource root (plotly) or carry the nonce (the
 * bootstrap); `style-src 'unsafe-inline'` because plotly injects its own
 * <style> elements at runtime; `img-src data:` because an image/png frame is
 * a data URI and plotly's PNG export builds one.
 */
function panelHtml(opts) {
  const csp = [
    "default-src 'none'",
    `img-src ${opts.cspSource} data: blob:`,
    `script-src ${opts.cspSource} 'nonce-${opts.nonce}'`,
    `style-src ${opts.cspSource} 'unsafe-inline'`,
    `font-src ${opts.cspSource}`,
    "connect-src 'none'",
  ].join("; ");

  const attr = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const backendButtons = (opts.backends || BACKENDS).map(
    (b) =>
      `<button class="backend${b.id === backend ? " active" : ""}" data-backend="${b.id}"` +
      `${b.enabled ? "" : " disabled"} title="${attr(b.tooltip)}">${b.label}</button>`
  ).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${PANEL_TITLE}</title>
<style>
  html, body { height: 100%; margin: 0; padding: 0; }
  body {
    display: flex; flex-direction: column;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
  #bar {
    display: flex; align-items: center; gap: 4px;
    padding: 4px 8px; flex: 0 0 auto;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  }
  #bar button {
    font-family: inherit; font-size: inherit;
    color: var(--vscode-button-secondaryForeground, var(--vscode-editor-foreground));
    background: var(--vscode-button-secondaryBackground, transparent);
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 2px; padding: 2px 8px; cursor: pointer;
  }
  #bar button:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
  #bar button:disabled { opacity: 0.45; cursor: default; }
  #bar button.active {
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border-color: var(--vscode-button-background);
  }
  .sep { width: 1px; height: 16px; background: var(--vscode-panel-border, transparent); margin: 0 4px; }
  #pos { opacity: 0.8; min-width: 5em; text-align: center; font-variant-numeric: tabular-nums; }
  #title { margin-left: auto; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #stage { flex: 1 1 auto; position: relative; overflow: auto; min-height: 0; }
  #note {
    position: absolute; top: 8px; right: 12px; z-index: 5;
    padding: 2px 10px; border-radius: 3px; opacity: 0.9;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border, transparent);
  }
  #plot { width: 100%; height: 100%; }
  #img { display: block; max-width: 100%; margin: 0 auto; }
  #fallback { padding: 12px; white-space: pre-wrap; word-break: break-word; font-family: var(--vscode-editor-font-family, monospace); }
  #empty { padding: 24px; opacity: 0.7; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
  <div id="bar">
    <button id="prev" title="Previous plot" disabled>&#9664;</button>
    <span id="pos">0 / 0</span>
    <button id="next" title="Next plot" disabled>&#9654;</button>
    <span class="sep"></span>
    ${backendButtons}
    <span class="sep"></span>
    <button id="exportPng" title="Export PNG" disabled>PNG</button>
    <button id="exportSvg" title="Export SVG" disabled>SVG</button>
    <button id="exportPdf" title="Export PDF (GR renders)" disabled>PDF</button>
    <span id="title"></span>
  </div>
  <div id="stage">
    <div id="note" hidden></div>
    <div id="empty">No plots yet. Evaluate something that plots, or run <b>Blade: Plot Demo</b>.</div>
    <div id="plot" hidden></div>
    <img id="img" hidden alt="plot">
    <pre id="fallback" hidden></pre>
  </div>
  <script nonce="${opts.nonce}" src="${opts.plotlyUri}"></script>
  <script nonce="${opts.nonce}">
${webviewScript()}
  </script>
</body>
</html>`;
}

/** The webview's own logic. Kept as plain concatenated JS (no template
 *  literals) so nothing here collides with the host template's `${}`. */
function webviewScript() {
  return [
    "(function () {",
    "  'use strict';",
    "  var api = acquireVsCodeApi();",
    "  var elPrev = document.getElementById('prev');",
    "  var elNext = document.getElementById('next');",
    "  var elPos = document.getElementById('pos');",
    "  var elTitle = document.getElementById('title');",
    "  var elEmpty = document.getElementById('empty');",
    "  var elPlot = document.getElementById('plot');",
    "  var elImg = document.getElementById('img');",
    "  var elFallback = document.getElementById('fallback');",
    "  var elPng = document.getElementById('exportPng');",
    "  var elSvg = document.getElementById('exportSvg');",
    "  var elPdf = document.getElementById('exportPdf');",
    "  var elNote = document.getElementById('note');",
    "  var elStage = document.getElementById('stage');",
    "  var current = null;   // {frame, title, index, total}",
    "  var plotted = false;  // is elPlot holding a live plotly graph?",
    "  var zoomHooked = false; // plotly_relayout listener attached to elPlot?",
    // Which live stream channel elPlot is currently holding, if any. Set by
    // every 'show'; an incoming 'streamAppend' for a DIFFERENT id is ignored
    // (the host re-syncs with a full 'show' — it tracks this same value).
    "  var streamId = null;",
    "",
    "  function setNote(text) {",
    "    elNote.hidden = !text;",
    "    elNote.textContent = text || '';",
    "  }",
    "",
    // Theme: plotly gets its colors from the same CSS variables the panel
    // chrome uses, so a dark theme never gets a white plot rectangle.
    "  function themeLayout() {",
    "    var cs = getComputedStyle(document.body);",
    "    var fg = (cs.getPropertyValue('--vscode-editor-foreground') || '').trim() || '#cccccc';",
    "    var font = (cs.getPropertyValue('--vscode-font-family') || '').trim() || 'sans-serif';",
    "    var grid = (cs.getPropertyValue('--vscode-panel-border') || '').trim();",
    "    var l = {",
    "      paper_bgcolor: 'rgba(0,0,0,0)',",
    "      plot_bgcolor: 'rgba(0,0,0,0)',",
    "      font: { color: fg, family: font },",
    "      margin: { l: 60, r: 20, t: 40, b: 50 }",
    "    };",
    "    if (grid) { l.xaxis = { gridcolor: grid, zerolinecolor: grid }; l.yaxis = { gridcolor: grid, zerolinecolor: grid }; }",
    "    return l;",
    "  }",
    "",
    "  function mergeLayout(base, over) {",
    "    var out = Object.assign({}, base, over || {});",
    "    out.font = Object.assign({}, base.font, (over && over.font) || {});",
    "    out.xaxis = Object.assign({}, base.xaxis, (over && over.xaxis) || {});",
    "    out.yaxis = Object.assign({}, base.yaxis, (over && over.yaxis) || {});",
    "    return out;",
    "  }",
    "",
    "  function showOnly(el) {",
    "    elEmpty.hidden = el !== elEmpty;",
    "    elPlot.hidden = el !== elPlot;",
    "    elImg.hidden = el !== elImg;",
    "    elFallback.hidden = el !== elFallback;",
    "  }",
    "",
    "  function fail(message) {",
    "    showOnly(elFallback);",
    "    elFallback.textContent = message;",
    "    api.postMessage({ type: 'error', message: message });",
    "  }",
    "",
    "  function renderPlotly(frame) {",
    "    var spec = frame.data || {};",
    "    var traces = spec.data || [];",
    "    var layout = mergeLayout(themeLayout(), spec.layout);",
    "    var config = Object.assign({ responsive: true, displaylogo: false, scrollZoom: true }, spec.config || {});",
    "    showOnly(elPlot);",
    "    var call = plotted ? Plotly.react : Plotly.newPlot;",
    "    return call(elPlot, traces, layout, config).then(function () { plotted = true; attachZoom(); });",
    "  }",
    "",
    // Zoom-to-recompute (docs/plot-zoom-reeval.md): a zoom on a figure whose
    // layout carries a `blade_camera` contract is reported to the host, which
    // maps it back onto the camera bindings and re-evaluates. Only a gesture
    // qualifies: the four explicit range keys appear together exactly when
    // plotly resolves a user zoom/pan; programmatic relayouts (theme, epoch
    // markers, autorange resets) carry other keys and fall through.
    //
    // DEBOUNCED: wheel zoom (scrollZoom above) fires one relayout per tick,
    // and a recompute costs seconds — so the LATEST ranges are held until
    // ZOOM_SETTLE_MS pass without another tick, i.e. until the user stops
    // scrolling, and only then does one gesture reach the host. A drag-zoom
    // fires once and simply pays the settle delay.
    // Attached once — plotly keeps the listener across Plotly.react calls.
    "  var ZOOM_SETTLE_MS = 450;",
    "  var zoomTimer = null;",
    "  var zoomLatest = null;",
    "  var noCameraSaid = false;",
    "  function attachZoom() {",
    "    if (zoomHooked || typeof elPlot.on !== 'function') return;",
    "    zoomHooked = true;",
    "    elPlot.on('plotly_relayout', function (e) {",
    "      if (!e) return;",
    "      var x0 = e['xaxis.range[0]'], x1 = e['xaxis.range[1]'];",
    "      var y0 = e['yaxis.range[0]'], y1 = e['yaxis.range[1]'];",
    "      if (x0 === undefined || x1 === undefined || y0 === undefined || y1 === undefined) return;",
    "      var lay = current && current.frame && current.frame.data && current.frame.data.layout;",
    "      if (!lay || !lay.blade_camera) {",
    "        if (!noCameraSaid) { noCameraSaid = true; api.postMessage({ type: 'zoomNoCamera' }); }",
    "        return;",
    "      }",
    "      noCameraSaid = false;",
    "      zoomLatest = { type: 'zoom', xr: [Number(x0), Number(x1)], yr: [Number(y0), Number(y1)] };",
    "      if (zoomTimer) clearTimeout(zoomTimer);",
    "      zoomTimer = setTimeout(function () {",
    "        zoomTimer = null;",
    "        if (zoomLatest) { api.postMessage(zoomLatest); zoomLatest = null; }",
    "      }, ZOOM_SETTLE_MS);",
    "    });",
    "  }",
    "",
    // Incremental append for a live stream: extendTraces pushes the new
    // points onto trace 0 in place (no re-layout, no re-parse of the whole
    // series), and one relayout refreshes the epoch markers. The host only
    // ever sends points at the stride the current figure was drawn with, so
    // the trace stays aligned with what a full redraw would produce.
    "  function extendStream(msg) {",
    "    if (!plotted || elPlot.hidden || streamId === null || msg.id !== streamId) return;",
    "    try {",
    "      if (msg.x && msg.x.length) {",
    "        Plotly.extendTraces(elPlot, { x: [msg.x], y: [msg.y] }, [0]);",
    // Keep the retained frame in step with the DOM: a theme switch re-renders
    // from current.frame, which would otherwise snap back to the last full
    // show and drop everything appended since.
    "        var tr = current && current.frame && current.frame.data && current.frame.data.data && current.frame.data.data[0];",
    "        if (tr && tr.x && tr.x.push) {",
    "          for (var i = 0; i < msg.x.length; i++) { tr.x.push(msg.x[i]); tr.y.push(msg.y[i]); }",
    "        }",
    "      }",
    "      var lay = { shapes: msg.shapes || [], annotations: msg.annotations || [] };",
    "      Plotly.relayout(elPlot, lay);",
    "      if (current && current.frame && current.frame.data && current.frame.data.layout) {",
    "        current.frame.data.layout.shapes = lay.shapes;",
    "        current.frame.data.layout.annotations = lay.annotations;",
    "      }",
    "    } catch (e) {",
    "      fail('could not extend this plot: ' + (e && e.message));",
    "    }",
    "  }",
    "",
    "  function renderImage(frame) {",
    "    showOnly(elImg);",
    "    elImg.src = 'data:' + frame.mime + ';base64,' + String(frame.data).replace(/\\s+/g, '');",
    "  }",
    "",
    "  function renderText(frame) {",
    "    showOnly(elFallback);",
    "    var body = frame.encoding === 'json' ? JSON.stringify(frame.data, null, 2) : String(frame.data);",
    "    elFallback.textContent = '[' + frame.mime + ' — no renderer in this panel]\\n\\n' + body;",
    "  }",
    "",
    "  function render() {",
    "    if (!current) { showOnly(elEmpty); return; }",
    "    var frame = current.frame;",
    "    try {",
    "      if (frame.mime === '" + display.PLOTLY_MIME + "') {",
    "        renderPlotly(frame).catch(function (e) { fail('plotly failed to render this frame: ' + (e && e.message)); });",
    "      } else if (/^image\\//.test(frame.mime) && frame.encoding === 'base64') {",
    "        renderImage(frame);",
    "      } else {",
    "        renderText(frame);",
    "      }",
    "    } catch (e) {",
    "      fail('could not render ' + frame.mime + ': ' + (e && e.message));",
    "    }",
    "  }",
    "",
    "  function isPlotly() { return !!current && current.frame.mime === '" + display.PLOTLY_MIME + "'; }",
    "",
    "  function download(href, name) {",
    "    var a = document.createElement('a');",
    "    a.href = href; a.download = name;",
    "    document.body.appendChild(a); a.click(); a.remove();",
    "  }",
    "",
    "  function fileBase() {",
    "    var t = (current && current.title) || 'plot';",
    "    return t.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'plot';",
    "  }",
    "",
    "  function exportAs(format) {",
    "    if (!current) return;",
    "    if (isPlotly() && plotted) {",
    "      Plotly.downloadImage(elPlot, { format: format, filename: fileBase(), width: elPlot.clientWidth || 900, height: elPlot.clientHeight || 600 })",
    "        .catch(function (e) { fail('export failed: ' + (e && e.message)); });",
    "      return;",
    "    }",
    "    if (format === 'png' && /^image\\//.test(current.frame.mime)) {",
    "      download('data:' + current.frame.mime + ';base64,' + String(current.frame.data).replace(/\\s+/g, ''), fileBase() + '.png');",
    "      return;",
    "    }",
    // SVG/PDF of a GR render: the host re-renders the retained spec in the
    // requested format through the serve worker and posts the bytes back.
    "    if ((format === 'svg' || format === 'pdf') && /^image\\//.test(current.frame.mime)) {",
    "      api.postMessage({ type: 'export', format: format, width: elStage.clientWidth, height: elStage.clientHeight });",
    "      return;",
    "    }",
    "    api.postMessage({ type: 'error', message: 'this plot cannot be exported as ' + format });",
    "  }",
    "",
    "  elPrev.addEventListener('click', function () { api.postMessage({ type: 'nav', delta: -1 }); });",
    "  elNext.addEventListener('click', function () { api.postMessage({ type: 'nav', delta: 1 }); });",
    "  elPng.addEventListener('click', function () { exportAs('png'); });",
    "  elSvg.addEventListener('click', function () { exportAs('svg'); });",
    "  elPdf.addEventListener('click', function () { exportAs('pdf'); });",
    "  Array.prototype.forEach.call(document.querySelectorAll('.backend'), function (b) {",
    "    b.addEventListener('click', function () {",
    "      if (b.disabled) return;",
    // The stage size rides along so a GR render comes back at the pixels
    // this panel will actually display.
    "      api.postMessage({ type: 'backend', backend: b.getAttribute('data-backend'),",
    "                        width: elStage.clientWidth, height: elStage.clientHeight });",
    "    });",
    "  });",
    "",
    "  window.addEventListener('message', function (ev) {",
    "    var msg = ev.data || {};",
    "    if (msg.type === 'show') {",
    "      current = { frame: msg.frame, title: msg.title, index: msg.index, total: msg.total };",
    "      streamId = msg.streamId || null;",
    "      elPos.textContent = (msg.index + 1) + ' / ' + msg.total;",
    "      elTitle.textContent = msg.title || '';",
    "      elPrev.disabled = msg.index <= 0;",
    "      elNext.disabled = msg.index >= msg.total - 1;",
    "      elPng.disabled = false;",
    "      var isImg = /^image\\//.test(msg.frame.mime);",
    "      elSvg.disabled = !(msg.frame.mime === '" + display.PLOTLY_MIME + "' || isImg);",
    "      elPdf.disabled = !isImg;",
    "      Array.prototype.forEach.call(document.querySelectorAll('.backend'), function (b) {",
    "        b.classList.toggle('active', b.getAttribute('data-backend') === msg.backend);",
    "      });",
    "      setNote(null);",
    "      render();",
    "    } else if (msg.type === 'streamAppend') {",
    "      extendStream(msg);",
    "    } else if (msg.type === 'pending') {",
    "      setNote(msg.message || 'rendering\\u2026');",
    "    } else if (msg.type === 'note') {",
    "      setNote(msg.message || '');",
    "    } else if (msg.type === 'exportData') {",
    "      download('data:' + msg.mime + ';base64,' + msg.data, msg.filename);",
    "    } else if (msg.type === 'empty') {",
    "      current = null; streamId = null; elPos.textContent = '0 / 0'; elTitle.textContent = '';",
    "      elPrev.disabled = true; elNext.disabled = true; elPng.disabled = true; elSvg.disabled = true; elPdf.disabled = true;",
    "      setNote(null);",
    "      showOnly(elEmpty);",
    "    }",
    "  });",
    "",
    // Relayout on panel resize and on theme switches (VS Code restyles the
    // body; plotly's colors were baked in at render time).
    "  function resize() { if (plotted && !elPlot.hidden) Plotly.Plots.resize(elPlot); }",
    "  window.addEventListener('resize', resize);",
    "  if (window.ResizeObserver) new ResizeObserver(resize).observe(document.getElementById('stage'));",
    "  new MutationObserver(function () { if (isPlotly()) render(); })",
    "    .observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });",
    "",
    "  api.postMessage({ type: 'ready' });",
    "}());",
  ].join("\n");
}

// --- Panel lifecycle ------------------------------------------------------------

function postCurrent() {
  if (!panel || !webviewReady) {
    pendingShow = true;
    return;
  }
  const entry = currentEntry(history);
  if (!entry) {
    liveStream = null;
    panel.webview.postMessage({ type: "empty" });
    return;
  }
  const frame = renderFor(entry, backend);
  // A full `show` of a stream entry is also the resync point: after it, the
  // webview holds exactly this many points at this stride, so the next post
  // can be an extend.
  liveStream =
    entry.stream && frame && frame.mime === display.PLOTLY_MIME
      ? { id: entry.id, count: entry.stream.x.length, stride: streamStride(entry.stream.x.length), runs: entry.stream.runs }
      : null;
  panel.webview.postMessage({
    type: "show",
    frame,
    title: entry.title,
    index: history.cursor,
    total: history.entries.length,
    backend,
    streamId: liveStream ? liveStream.id : null,
  });
}

// --- Stream posting: trailing coalesce + incremental extend --------------------

/** Schedule a post of whatever the current stream has accumulated. TRAILING:
 *  the first chunk of a burst arms the timer and every chunk that lands inside
 *  the window rides it, so N chunks in 100 ms cost exactly one postMessage. */
function scheduleStreamPost() {
  if (streamTimer) return;
  if (streamCoalesceMs <= 0) {
    flushStreamPost();
    return;
  }
  streamTimer = setTimeout(() => {
    streamTimer = null;
    flushStreamPost();
  }, streamCoalesceMs);
}

/** Post the pending stream update now (the timer's body; also the hook
 *  hermetic tests drive instead of waiting on a real timer). */
function flushStreamPost() {
  if (streamTimer) {
    clearTimeout(streamTimer);
    streamTimer = null;
  }
  const entry = currentEntry(history);
  if (!entry) return;
  if (!entry.stream) {
    postCurrent();
    return;
  }
  if (!panel || !webviewReady) {
    pendingShow = true;
    return;
  }
  const acc = entry.stream;
  const stride = streamStride(acc.x.length);
  // Extend only when the webview is provably holding the SAME run of the SAME
  // channel at the SAME stride, with something new to add. Everything else —
  // a first frame, a replay's reset, crossing the decimation threshold, the
  // user having navigated elsewhere — is a full redraw.
  const canExtend =
    liveStream &&
    liveStream.id === entry.id &&
    liveStream.runs === acc.runs &&
    liveStream.stride === stride &&
    liveStream.count < acc.x.length &&
    backend === "plotly";
  if (!canExtend) {
    postCurrent();
    return;
  }
  const x = [];
  const y = [];
  // Same phase as strideSample (indices 0, stride, 2·stride, …), so an
  // extended trace stays aligned with the one a redraw would produce.
  for (let i = liveStream.count; i < acc.x.length; i++) {
    if (i % stride === 0) {
      x.push(acc.x[i]);
      y.push(acc.y[i]);
    }
  }
  liveStream.count = acc.x.length;
  const marks = streamMarks(acc);
  panel.webview.postMessage({
    type: "streamAppend",
    id: entry.id,
    x,
    y,
    shapes: marks.shapes,
    annotations: marks.annotations,
    points: acc.x.length,
  });
}

// --- The GR round-trip ---------------------------------------------------------

/** Entry ids with a render request in the air — a second toggle while one is
 *  pending must not queue a duplicate. */
const grInflight = new Set();

/** Clamp a webview-reported dimension to a sane render size and force it
 *  even: GR's cairo raster cannot produce odd widths, so an odd request
 *  would come back one pixel off. */
function renderDim(v, fallback) {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return fallback;
  return Math.max(320, Math.min(2400, 2 * Math.floor(n / 2)));
}

/** A transient status line the webview shows without giving up the current
 *  render (unlike fail(), which replaces the plot with text). */
function note(message) {
  log(message);
  if (panel && webviewReady) panel.webview.postMessage({ type: "note", message });
}

// --- Zoom-to-recompute (docs/plot-zoom-reeval.md) ------------------------------

/** The camera contract a spec carries, or null: `layout.blade_camera` with a
 *  `bindings` string naming exactly three session bindings — center-x,
 *  center-y, half-width, in that order (stdlib plot.blade's `camera` slot). */
function cameraFromSpec(spec) {
  const cam = spec && spec.layout && spec.layout.blade_camera;
  if (!cam || typeof cam.bindings !== "string") return null;
  const names = cam.bindings.split(",").map((s) => s.trim());
  if (names.length !== 3 || names.some((n) => !/^[A-Za-z_]\w*$/.test(n))) return null;
  return { bindings: names };
}

/** A zoom gesture's ranges → the camera values that reproduce it: center of
 *  the selection, half-width the LARGER half-span (the canvas is square, so
 *  the larger span is the one that keeps the whole selection in frame). */
function zoomCamera(xr, yr) {
  const nums = [xr && xr[0], xr && xr[1], yr && yr[0], yr && yr[1]].map(Number);
  if (nums.some((v) => !isFinite(v))) return null;
  const [x0, x1, y0, y1] = nums;
  const r = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / 2;
  if (!(r > 0)) return null;
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, r };
}

/** Plot ids whose zoom re-evaluation is still running: one at a time per
 *  plot. A gesture arriving DURING a recompute is not dropped — the latest
 *  one is held (zoomPending) and fired when the current recompute settles,
 *  so continuous scrolling converges on the final camera with at most one
 *  extra recompute. Intermediate gestures are superseded, never queued. */
const zoomInflight = new Set();
const zoomPending = new Map();
/** One-shot focus latch: holds the camera a gesture asked for while its
 *  recompute is in flight, and is consumed by the frame that actually SHOWS
 *  that window. Field report that forced the latch: with several plots
 *  carrying the contract, every replayed camera frame at end-of-eval stole
 *  focus back, so a zoom on the view ended selected on the overview,
 *  repainted at default axes.
 *
 *  Why the window and not simply the first arrival: a recompute re-emits
 *  EVERY camera-carrying plot in the notebook -- the overview, all 18 dive
 *  frames, the view -- and their order is the program's, not the gesture's.
 *  With the camera cell last (which is what makes a gesture cheap) the view
 *  is emitted last, so 'first' is reliably the wrong plot. The answer is the
 *  one whose axis spans the window that was requested, whatever its id --
 *  which also keeps working for a zoom on the overview, whose answer
 *  legitimately arrives under the view's id. */
const zoomFocus = { armed: null };

/** Does this figure show the window `cam` asked for? Compares the x axis's
 *  own samples: centre and span, to within a few percent, because a decimated
 *  axis stops one sample short of the exact half-span. */
function frameShowsWindow(frame, cam) {
  const traces = frame && frame.data && frame.data.data;
  const xs = traces && traces[0] && traces[0].x;
  if (!Array.isArray(xs) || xs.length < 2) return false;
  const lo = Number(xs[0]);
  const hi = Number(xs[xs.length - 1]);
  if (!isFinite(lo) || !isFinite(hi) || !isFinite(cam.r) || cam.r <= 0) return false;
  const span = Math.abs(hi - lo);
  return (
    Math.abs((lo + hi) / 2 - cam.cx) < cam.r * 0.05 &&
    Math.abs(span - 2 * cam.r) < cam.r * 0.1
  );
}

/** One zoom gesture from the webview: map it onto the current entry's camera
 *  contract and hand it to the re-evaluation hook (deps.onPlotZoom — wired to
 *  the notebook module, which rewrites the camera cell and re-runs it). This
 *  function owns the plumbing and the notes; what "re-evaluate" means belongs
 *  wholly to the hook. */
function handleZoom(msg) {
  const entry = currentEntry(history);
  if (!entry) return;
  const camera = cameraFromSpec(specFor(entry));
  if (!camera) return; // a zoom on an ordinary figure is plotly's own affair
  if (!deps || typeof deps.onPlotZoom !== "function") {
    note("zoom-to-recompute: no re-evaluation hook wired");
    return;
  }
  const cam = zoomCamera(msg.xr, msg.yr);
  if (!cam) return;
  if (zoomInflight.has(entry.id)) {
    zoomPending.set(entry.id, cam);
    note("zoom-to-recompute: still recomputing — latest gesture will follow");
    return;
  }
  runZoom(entry.id, camera.bindings, cam);
}

/** Fire one recompute; when it settles, fire the latest gesture that arrived
 *  while it ran (if any). The chain is at most as long as the user kept
 *  zooming, and each link supersedes everything before it. */
function runZoom(plotId, bindings, cam) {
  zoomInflight.add(plotId);
  zoomFocus.armed = cam;
  note(`recomputing ${plotId} at r = ${cam.r.toExponential(3)}…`);
  const settle = (message) => {
    zoomInflight.delete(plotId);
    zoomFocus.armed = null;
    const next = zoomPending.get(plotId);
    if (next) {
      zoomPending.delete(plotId);
      runZoom(plotId, bindings, next);
    } else {
      note(message);
    }
  };
  Promise.resolve(deps.onPlotZoom({ plotId, bindings, cx: cam.cx, cy: cam.cy, r: cam.r }))
    .then(() => settle(""))
    .catch((e) => settle(`zoom-to-recompute failed: ${(e && e.message) || e}`));
}

/** Ask the warm serve process to render `entry`'s spec with GR. The response
 *  frame re-enters through display.publish, so the ordinary onFrame →
 *  appendFrame path merges it into this entry by meta.id and re-posts — no
 *  bespoke delivery. On failure the current (plotly) render stays up and the
 *  webview gets a note. */
function requestGrRender(entry, width, height) {
  const spec = specFor(entry);
  if (!spec) {
    note(`GR: nothing to render — no spec retained for "${entry.title}"`);
    return;
  }
  if (grInflight.has(entry.id)) return;
  grInflight.add(entry.id);
  if (panel && webviewReady) {
    panel.webview.postMessage({ type: "pending", backend: "gr", message: "rendering with GR…" });
  }
  deps
    .renderPlot({
      spec,
      plotId: entry.id,
      width: renderDim(width, 800),
      height: renderDim(height, 600),
    })
    .then((resp) => {
      grInflight.delete(entry.id);
      const frame = resp && resp.frame;
      if (!frame || typeof frame.data !== "string") throw new Error("serve returned no frame");
      display.publish(frame, "gr-render");
    })
    .catch((e) => {
      grInflight.delete(entry.id);
      note(`GR render failed: ${(e && e.message) || e}`);
    });
}

/** Publication export via the GR worker: re-render the current entry's spec
 *  in the requested format and hand the bytes to the webview to save. Not
 *  cached in history — an export is a file, not an alternate render. */
function requestGrExport(format, width, height) {
  const entry = currentEntry(history);
  const spec = specFor(entry);
  if (!entry || !spec) {
    note("export: no spec retained for this plot");
    return;
  }
  if (!deps || typeof deps.renderPlot !== "function") {
    note("export: GR round-trip not wired");
    return;
  }
  note(`exporting as ${format.toUpperCase()}…`);
  deps
    .renderPlot({
      spec,
      plotId: entry.id,
      width: renderDim(width, 800),
      height: renderDim(height, 600),
      format,
    })
    .then((resp) => {
      const frame = resp && resp.frame;
      if (!frame || typeof frame.data !== "string") throw new Error("serve returned no frame");
      const safe = entry.title.replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 60) || "plot";
      if (panel && webviewReady) {
        panel.webview.postMessage({ type: "exportData", mime: frame.mime, data: frame.data, filename: `${safe}.${format}` });
        panel.webview.postMessage({ type: "note", message: "" });
      }
    })
    .catch((e) => note(`export failed: ${(e && e.message) || e}`));
}

function onWebviewMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "ready") {
    webviewReady = true;
    if (pendingShow || history.entries.length > 0) {
      pendingShow = false;
      postCurrent();
    }
    return;
  }
  if (msg.type === "nav") {
    navigate(history, msg.delta === -1 ? -1 : 1);
    postCurrent();
    return;
  }
  if (msg.type === "backend") {
    const b = backendState().find((x) => x.id === msg.backend);
    if (!b || !b.enabled) return; // disabled here even if un-greyed in a stale webview
    backend = b.id;
    userPinnedBackend = true;
    // Show the fallback render for the new backend FIRST, then flag the
    // pending round-trip — 'show' clears the webview's note, so the order
    // keeps "rendering with GR…" visible over the plotly fallback.
    postCurrent();
    const entry = currentEntry(history);
    if (b.id === "gr" && entry && !entry.renders.gr) {
      requestGrRender(entry, msg.width, msg.height);
    }
    return;
  }
  if (msg.type === "export") {
    requestGrExport(msg.format === "pdf" ? "pdf" : "svg", msg.width, msg.height);
    return;
  }
  if (msg.type === "zoom") {
    handleZoom(msg);
    return;
  }
  if (msg.type === "error") {
    log(String(msg.message));
  }
}

/** Create the panel (beside the editor) or reveal the existing one. Reveal is
 *  always preserveFocus:true — a plot arriving mid-edit must not steal the
 *  cursor out of the file being typed in. */
function ensurePanel() {
  if (panel) return panel;
  const media = joinUri(extensionUri(), "media");
  panel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    PANEL_TITLE,
    { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
    {
      enableScripts: true,
      // The history lives here, but a reloaded webview would lose plotly's
      // DOM and the current render; retaining context keeps toggling tabs
      // free rather than re-posting on every visibility change.
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    }
  );
  webviewReady = false;
  const plotlyUri = panel.webview.asWebviewUri(joinUri(media, "plotly.min.js"));
  panel.webview.html = panelHtml({
    cspSource: panel.webview.cspSource,
    plotlyUri: String(plotlyUri),
    nonce: nonceString(),
    backends: backendState(),
  });
  panel.webview.onDidReceiveMessage(onWebviewMessage);
  panel.onDidDispose(() => {
    panel = undefined;
    webviewReady = false;
  });
  return panel;
}

/** A stream channel's log line, throttled: the first frame, then every
 *  STREAM_LOG_EVERY-th one, plus every run boundary and every dropped
 *  duplicate (both rare and both worth seeing). A per-batch training stream
 *  emits thousands of chunks — logging each one is its own performance bug. */
function logStream(entry, res, origin) {
  const acc = entry.stream;
  if (res.stream.skipped) {
    log(`stream ${entry.id}: duplicate chunk from ${origin} ignored (${acc.x.length} points)`);
    return;
  }
  if (res.stream.reset) {
    log(`stream ${entry.id}: run boundary from ${origin} — accumulator reset (run ${acc.runs})`);
  }
  if (acc.frames === 1 || acc.frames % STREAM_LOG_EVERY === 0) {
    log(
      `stream ${entry.id} from ${origin} — ${acc.frames} frame(s), ${acc.x.length} points, ` +
        `epoch ${acc.lastEpoch === null ? "—" : acc.lastEpoch} (${history.entries.length} in history)`
    );
  }
}

/** display.subscribe() handler: every routed frame lands here. */
function onFrame(frame, origin) {
  const res = appendFrame(history, frame);

  // Stream chunks take the throttled path: the panel is revealed on a
  // channel's FIRST frame only (a mid-edit chunk must not keep fronting the
  // panel), logging is sampled, and the repost is coalesced. A stream frame
  // is plotly-only by contract (`meta.backend: "plotly"`), so none of the GR
  // preference handling below applies to it.
  if (isStreamFrame(frame)) {
    logStream(res.entry, res, origin);
    ensurePanel();
    if (!res.merged) panel.reveal(vscode.ViewColumn.Beside, true);
    scheduleStreamPost();
    return;
  }

  log(`${res.merged ? "merged" : "added"} ${frame.mime} from ${origin} — ${res.entry.title} (${history.entries.length} in history)`);
  // A background merge (a replayed frame updating an entry that is not on
  // screen) is bookkeeping, not an event: no reveal, no repaint, no backend
  // switching -- EXCEPT while a zoom recompute is in flight: the
  // camera-carrying frame that arrives then is the ANSWER to the user's
  // gesture (possibly under a different id than the plot they gestured on --
  // a dive frame re-aims the camera, the view answers), and it takes focus.
  {
    const lay = frame.data && frame.data.layout;
    if (zoomFocus.armed && lay && lay.blade_camera
        && frameShowsWindow(frame, zoomFocus.armed)) {
      // The gesture's answer. Consume the latch WHEREVER it lands -- when
      // the user zoomed the plot they were already viewing, the answer
      // merges into the CURRENT entry, and leaving the latch armed handed
      // focus to the next replayed camera frame instead (field symptoms:
      // zooming the view ended selected on the overview, repainted at its
      // default axes).
      zoomFocus.armed = null;
      history.cursor = res.index;
    } else if (res.merged && res.index !== history.cursor) {
      // Background merge: bookkeeping, not an event.
      return;
    }
  }
  ensurePanel();
  panel.reveal(vscode.ViewColumn.Beside, true);

  // Honor a program-stated backend preference: switch the panel to it and
  // render eagerly. Silently ignored when that backend is unavailable (a
  // viewer without GR just keeps showing plotly — the hint is not a demand)
  // or once the user has taken manual control of the toggle.
  const entry = res.entry;
  const wants = entry.prefer;
  if (wants && !userPinnedBackend && wants !== backend) {
    const target = backendState().find((b) => b.id === wants);
    if (target && target.enabled) {
      backend = wants;
      log(`honoring preferredBackend=${wants} for ${entry.title}`);
    }
  }
  postCurrent();
  if (backend === "gr" && entry.prefer === "gr" && !entry.renders.gr) {
    // Eager render at the default size — no webview measurement is available
    // on this path (the frame arrived on its own, not from a toggle click).
    requestGrRender(entry);
  }
}

/** blade.plotDemo: build a contour frame, encode it on the REPL wire, and
 *  feed it back through display.ingestReplText — the demo therefore exercises
 *  sentinel framing, JSON decode, validation, routing and rendering, i.e. the
 *  whole path a compiler-produced frame will take, with no compiler. */
function demoFrame() {
  const n = 61;
  const x = [];
  const y = [];
  for (let i = 0; i < n; i++) {
    x.push((2 * Math.PI * i) / (n - 1));
    y.push((2 * Math.PI * i) / (n - 1));
  }
  const z = y.map((yv) => x.map((xv) => Math.sin(xv) * Math.cos(yv)));
  return {
    mime: display.PLOTLY_MIME,
    encoding: "json",
    data: {
      data: [
        {
          type: "contour",
          x,
          y,
          z,
          colorscale: "Viridis",
          contours: { start: -1, end: 1, size: 0.1, coloring: "fill" },
          line: { width: 0.5 },
          colorbar: { title: { text: "u [m s⁻¹]", side: "right" } },
        },
      ],
      layout: {
        title: { text: "sin(x)·cos(y)" },
        xaxis: { title: { text: "x [m]" }, constrain: "domain" },
        yaxis: { title: { text: "y [m]" }, scaleanchor: "x" },
      },
      config: { displaylogo: false },
    },
    meta: { title: "sin(x)·cos(y)", backend: "plotly", source: "blade.plotDemo" },
  };
}

function commandPlotDemo() {
  display.ingestReplText(display.encodeReplLine(demoFrame()), "demo");
}

function init(context, dependencies) {
  deps = Object.assign({ extensionUri: context && context.extensionUri }, dependencies || {});
  display.setLogger((line) => {
    if (deps.output) deps.output.appendLine(line);
  });
  context.subscriptions.push(
    display.subscribe(onFrame),
    vscode.commands.registerCommand("blade.plotDemo", commandPlotDemo),
    { dispose: () => dispose() }
  );
}

function dispose() {
  if (streamTimer) {
    clearTimeout(streamTimer);
    streamTimer = null;
  }
  liveStream = null;
  if (panel) {
    panel.dispose();
    panel = undefined;
  }
  webviewReady = false;
  // Closing the panel ends the session the toggle belonged to: the next one
  // opens on the default backend and is free to honor a program preference
  // again.
  backend = "plotly";
  userPinnedBackend = false;
}

// The stream primitives are part of the module's REAL surface, not just its
// test surface: src/notebook.js animates an executing cell from the same
// accumulator/figure pair so the cell and the panel can never disagree about
// what a channel's series is.
module.exports = {
  init,
  dispose,
  STREAM_MIME,
  isStreamFrame,
  newStreamAcc,
  mergeStreamFrame,
  streamFigure,
};

// Headless test surface (scripts/, not used by VS Code).
module.exports._test = {
  BACKENDS,
  backendState,
  newHistory,
  appendFrame,
  navigate,
  currentEntry,
  renderFor,
  specFor,
  titleFor,
  panelHtml,
  webviewScript,
  demoFrame,
  commandPlotDemo,
  history,
  // Zoom-to-recompute.
  cameraFromSpec,
  zoomCamera,
  handleZoom,
  zoomInflight,
  zoomFocus,
  // Streams.
  STREAM_MIME,
  STREAM_DRAW_LIMIT,
  STREAM_MAX_MARKS,
  isStreamFrame,
  newStreamAcc,
  mergeStreamFrame,
  chunkSignature,
  strideSample,
  streamStride,
  streamMarks,
  streamFigure,
  streamRenderFrame,
  appendStreamFrame,
  flushStreamPost,
  setCoalesceMs: (ms) => {
    streamCoalesceMs = ms;
  },
  coalesceMs: () => streamCoalesceMs,
  liveStream: () => liveStream,
  setDeps: (d) => {
    deps = d;
  },
};
