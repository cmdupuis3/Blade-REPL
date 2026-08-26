// Notebook renderer for Blade's plot outputs — the piece that makes a chart
// draw IN THE CELL instead of degrading to the `[application/vnd.plotly.v1+json
// — title]` text summary src/notebook.js also attaches.
//
// Two mime types, one renderer (package.json → contributes.notebookRenderers):
//
//   application/vnd.plotly.v1+json           a finished plotly figure
//                                            {data, layout, config?}
//   application/vnd.blade.plotstream.v1+json a LIVE plot stream's accumulated
//                                            figure, repainted while the cell
//                                            runs (src/notebook.js's
//                                            liveStreamOutputs)
//
// Both are drawn the same way; the stream mime exists as a separate type so a
// live chunk-driven chart is never mistaken for the cell's persistent output
// (see src/notebook.js's assembleOutputs filter). The stream item this
// renderer is handed carries an ACCUMULATED FIGURE — the extension owns the
// merge — but a raw wire chunk (`{channel, epoch, x, y, …}`) is accepted too
// and wrapped into a single-trace figure, so the renderer stays correct if a
// raw stream frame ever reaches a cell output directly.
//
// ES MODULE, by contract: VS Code loads a renderer entrypoint as a module
// inside the notebook OUTPUT webview and calls the exported `activate`.
//
// OFFLINE, by contract: the webview runs under a CSP with no remote hosts.
// The only script this file pulls in is the extension's OWN, already-shipped
// media/plotly.min.js (the same file the Blade Plots panel loads), addressed
// RELATIVE TO `import.meta.url` — i.e. the exact origin VS Code already served
// this module from, so it needs no CSP allowance this module did not already
// have, and no second 4.8 MB copy of plotly in the repo or the .vsix. Nothing
// here fetches, evals, or reaches the network.

/** The extension's bundled plotly, as an absolute URL in whatever scheme the
 *  host served this module from (`https://file+.vscode-resource…` on desktop,
 *  `vscode-webview://…` in some hosts) — never a CDN. */
const PLOTLY_URL = new URL("../media/plotly.min.js", import.meta.url).href;

const PLOTLY_MIME = "application/vnd.plotly.v1+json";
const STREAM_MIME = "application/vnd.blade.plotstream.v1+json";

/** Height a chart gets when the cell does not constrain it. */
const DEFAULT_HEIGHT = 320;

/** @type {Promise<any> | null} memoized — one load per output webview. */
let plotlyPromise = null;

/**
 * Load the bundled plotly and resolve its global.
 *
 * Primary path is a CLASSIC `<script>` tag: plotly ships as a UMD bundle whose
 * factory ends in `window.Plotly = Plotly`, and a classic script is exactly
 * how media/plotly.min.js is already proven to load in this extension's own
 * webview (src/plots.js's panelHtml). Fallback is a dynamic `import()` of the
 * same URL — plotly's UMD wrapper falls through to the global assignment when
 * no CommonJS/AMD loader is present, which is the case in an ES module too —
 * so a host that blocks injected script elements but permits module imports
 * (it must: it just imported THIS file) still gets a chart.
 */
function loadPlotly() {
  if (plotlyPromise) return plotlyPromise;
  plotlyPromise = injectScript(PLOTLY_URL)
    .catch(() => import(/* webpackIgnore: true */ PLOTLY_URL))
    .then(() => {
      const P = globalThis.Plotly;
      if (!P || typeof P.newPlot !== "function") throw new Error("plotly loaded but exposed no Plotly global");
      return P;
    });
  return plotlyPromise;
}

function injectScript(src) {
  return new Promise((resolve, reject) => {
    if (globalThis.Plotly && typeof globalThis.Plotly.newPlot === "function") return resolve();
    const el = document.createElement("script");
    el.src = src;
    el.async = false;
    el.addEventListener("load", () => resolve());
    el.addEventListener("error", () => reject(new Error(`could not load ${src}`)));
    (document.head || document.documentElement).appendChild(el);
  });
}

// --- Payload → plotly figure (pure) ---------------------------------------------

/** Does this look like a plotly figure rather than a wire chunk? */
function isFigure(p) {
  return !!p && typeof p === "object" && Array.isArray(p.data);
}

/**
 * The `{data, layout, config}` triple to draw for one output item's JSON.
 * Accepts a plotly figure, an accumulated stream figure (identical shape), or
 * a raw stream wire chunk `{channel, epoch, x, y, title, xlabel, ylabel}`.
 * Never throws: an unrecognizable payload yields an empty figure and the
 * caller shows the JSON instead.
 */
export function figureFor(payload) {
  if (isFigure(payload)) {
    return {
      data: payload.data,
      layout: payload.layout && typeof payload.layout === "object" ? payload.layout : {},
      config: payload.config && typeof payload.config === "object" ? payload.config : {},
      ok: true,
    };
  }
  if (payload && typeof payload === "object" && (Array.isArray(payload.x) || Array.isArray(payload.y))) {
    const x = Array.isArray(payload.x) ? payload.x : [];
    const y = Array.isArray(payload.y) ? payload.y : [];
    const n = Math.min(x.length, y.length);
    const layout = {
      xaxis: { title: { text: payload.xlabel || "" } },
      yaxis: { title: { text: payload.ylabel || "" } },
      showlegend: false,
    };
    if (payload.title) layout.title = { text: payload.title };
    return {
      data: [{ type: "scatter", mode: "lines", name: payload.channel || "series", x: x.slice(0, n), y: y.slice(0, n) }],
      layout,
      config: {},
      ok: true,
    };
  }
  return { data: [], layout: {}, config: {}, ok: false };
}

/** Theme-derived layout, same rule the Blade Plots panel uses: colors come
 *  from VS Code's own CSS variables (available in the notebook output webview
 *  too), and whatever the figure states explicitly wins over them. */
function themeLayout() {
  const cs = getComputedStyle(document.body);
  const val = (name, fallback) => (cs.getPropertyValue(name) || "").trim() || fallback;
  const fg = val("--vscode-editor-foreground", "#cccccc");
  const grid = val("--vscode-panel-border", "");
  const layout = {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { color: fg, family: val("--vscode-font-family", "sans-serif") },
    margin: { l: 60, r: 20, t: 40, b: 50 },
  };
  if (grid) {
    layout.xaxis = { gridcolor: grid, zerolinecolor: grid };
    layout.yaxis = { gridcolor: grid, zerolinecolor: grid };
  }
  return layout;
}

/** Shallow merge with per-axis/font merging — the figure's own keys win. */
export function mergeLayout(base, over) {
  const out = Object.assign({}, base, over || {});
  out.font = Object.assign({}, base.font, (over && over.font) || {});
  out.xaxis = Object.assign({}, base.xaxis, (over && over.xaxis) || {});
  out.yaxis = Object.assign({}, base.yaxis, (over && over.yaxis) || {});
  return out;
}

// --- The renderer ------------------------------------------------------------------

/** VS Code's notebook renderer entrypoint. */
export function activate(_context) {
  /** output item id -> the div plotly owns, so disposeOutputItem can purge it
   *  (a notebook that scrolls a long way otherwise leaks graph state). */
  const charts = new Map();

  function purge(id) {
    const host = charts.get(id);
    if (!host) return;
    charts.delete(id);
    const P = globalThis.Plotly;
    if (P && typeof P.purge === "function") {
      try {
        P.purge(host);
      } catch (_) {
        /* already gone */
      }
    }
  }

  return {
    renderOutputItem(outputItem, element) {
      purge(outputItem.id);
      element.textContent = "";

      let payload;
      try {
        payload = outputItem.json();
      } catch (e) {
        element.textContent = `[${outputItem.mime}] output is not JSON: ${(e && e.message) || e}`;
        return;
      }

      const fig = figureFor(payload);
      if (!fig.ok) {
        const pre = document.createElement("pre");
        pre.style.whiteSpace = "pre-wrap";
        pre.textContent = `[${outputItem.mime} — no figure in this payload]\n\n${JSON.stringify(payload, null, 2)}`;
        element.appendChild(pre);
        return;
      }

      const host = document.createElement("div");
      host.style.width = "100%";
      host.style.minHeight = `${DEFAULT_HEIGHT}px`;
      element.appendChild(host);
      charts.set(outputItem.id, host);

      loadPlotly()
        .then((Plotly) => {
          // The element may have been re-rendered (or the cell cleared) while
          // plotly was loading — draw only if this is still the live host.
          if (charts.get(outputItem.id) !== host) return;
          const config = Object.assign({ responsive: true, displaylogo: false }, fig.config);
          return Plotly.newPlot(host, fig.data, mergeLayout(themeLayout(), fig.layout), config);
        })
        .catch((e) => {
          const pre = document.createElement("pre");
          pre.style.whiteSpace = "pre-wrap";
          pre.textContent =
            `[${outputItem.mime}] could not render: ${(e && e.message) || e}\n\n` +
            JSON.stringify(payload, null, 2).slice(0, 4000);
          element.textContent = "";
          element.appendChild(pre);
        });
    },

    disposeOutputItem(id) {
      if (id === undefined) {
        for (const key of Array.from(charts.keys())) purge(key);
        return;
      }
      purge(id);
    },
  };
}

// Named exports the hermetic renderer test drives (scripts/plots-test.js) —
// everything above that does NOT need a DOM.
export const mimeTypes = [PLOTLY_MIME, STREAM_MIME];
export const plotlyAssetUrl = () => PLOTLY_URL;
