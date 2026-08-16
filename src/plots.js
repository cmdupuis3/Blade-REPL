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

// Injected by init(): { output, findGr, renderPlot } from extension.js.
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

/**
 * Append `frame` to `hist`, or merge it into the entry it re-renders.
 *
 * Merge rule: a frame whose `meta.id` matches an existing entry's id is an
 * ALTERNATE RENDER of that plot (the GR round-trip the plan describes) — it
 * lands in that entry's `renders` under its backend and the history does not
 * grow. Everything else appends and becomes the current entry.
 *
 * @returns {{entry: object, index: number, merged: boolean}}
 */
function appendFrame(hist, frame) {
  const backend = display.backendFor(frame);
  const meta = frame.meta || {};
  const id = typeof meta.id === "string" && meta.id ? meta.id : null;

  if (id) {
    const idx = hist.entries.findIndex((e) => e.id === id);
    if (idx >= 0) {
      const entry = hist.entries[idx];
      entry.renders[backend] = frame;
      if (meta.spec !== undefined) entry.spec = meta.spec;
      hist.cursor = idx;
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
  return entry.renders[backend] || entry.renders[entry.primary] || Object.values(entry.renders)[0];
}

/** The backend-neutral spec for a re-render round-trip: a frame-carried
 *  meta.spec when one exists (reserved in the wire spec, unused today), else
 *  the retained plotly figure object itself. Null when the entry has neither
 *  (e.g. a GR-only image with no plotly sibling — nothing to re-render from). */
function specFor(entry) {
  if (!entry) return null;
  if (entry.spec !== null && entry.spec !== undefined) return entry.spec;
  const p = entry.renders.plotly;
  return p && p.mime === display.PLOTLY_MIME && p.encoding === "json" ? p.data : null;
}

// --- Panel state ---------------------------------------------------------------

const history = newHistory();
let backend = "plotly";
/** @type {vscode.WebviewPanel | undefined} */
let panel;
let webviewReady = false;
let pendingShow = false; // a show() that landed before the webview said "ready"

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
    "  var elNote = document.getElementById('note');",
    "  var elStage = document.getElementById('stage');",
    "  var current = null;   // {frame, title, index, total}",
    "  var plotted = false;  // is elPlot holding a live plotly graph?",
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
    "    var config = Object.assign({ responsive: true, displaylogo: false }, spec.config || {});",
    "    showOnly(elPlot);",
    "    var call = plotted ? Plotly.react : Plotly.newPlot;",
    "    return call(elPlot, traces, layout, config).then(function () { plotted = true; });",
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
    "    api.postMessage({ type: 'error', message: 'this plot cannot be exported as ' + format });",
    "  }",
    "",
    "  elPrev.addEventListener('click', function () { api.postMessage({ type: 'nav', delta: -1 }); });",
    "  elNext.addEventListener('click', function () { api.postMessage({ type: 'nav', delta: 1 }); });",
    "  elPng.addEventListener('click', function () { exportAs('png'); });",
    "  elSvg.addEventListener('click', function () { exportAs('svg'); });",
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
    "      elPos.textContent = (msg.index + 1) + ' / ' + msg.total;",
    "      elTitle.textContent = msg.title || '';",
    "      elPrev.disabled = msg.index <= 0;",
    "      elNext.disabled = msg.index >= msg.total - 1;",
    "      elPng.disabled = false;",
    "      elSvg.disabled = !(msg.frame.mime === '" + display.PLOTLY_MIME + "');",
    "      Array.prototype.forEach.call(document.querySelectorAll('.backend'), function (b) {",
    "        b.classList.toggle('active', b.getAttribute('data-backend') === msg.backend);",
    "      });",
    "      setNote(null);",
    "      render();",
    "    } else if (msg.type === 'pending') {",
    "      setNote(msg.message || 'rendering\\u2026');",
    "    } else if (msg.type === 'note') {",
    "      setNote(msg.message || '');",
    "    } else if (msg.type === 'empty') {",
    "      current = null; elPos.textContent = '0 / 0'; elTitle.textContent = '';",
    "      elPrev.disabled = true; elNext.disabled = true; elPng.disabled = true; elSvg.disabled = true;",
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
    panel.webview.postMessage({ type: "empty" });
    return;
  }
  const frame = renderFor(entry, backend);
  panel.webview.postMessage({
    type: "show",
    frame,
    title: entry.title,
    index: history.cursor,
    total: history.entries.length,
    backend,
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

/** display.subscribe() handler: every routed frame lands here. */
function onFrame(frame, origin) {
  const res = appendFrame(history, frame);
  log(`${res.merged ? "merged" : "added"} ${frame.mime} from ${origin} — ${res.entry.title} (${history.entries.length} in history)`);
  ensurePanel();
  panel.reveal(vscode.ViewColumn.Beside, true);
  postCurrent();
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
  if (panel) {
    panel.dispose();
    panel = undefined;
  }
  webviewReady = false;
}

module.exports = { init, dispose };

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
  setDeps: (d) => {
    deps = d;
  },
};
