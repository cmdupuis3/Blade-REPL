// Hermetic tests for renderer/plotly-renderer.js — the notebook renderer that
// makes a chart draw IN THE CELL instead of degrading to the
// `[application/vnd.plotly.v1+json — title]` text summary.
//
// The renderer runs in VS Code's notebook OUTPUT WEBVIEW, not in the extension
// host, so scripts/vscode-mock.js is the wrong stub for it: what it needs is a
// browser. This file provides the smallest one that is still honest — the
// exact DOM surface the renderer touches (createElement / appendChild /
// textContent / style / addEventListener, plus getComputedStyle over VS Code's
// theme variables) and an OutputItem stub matching the renderer API's
// `{id, mime, data(), text(), json()}`. No jsdom, no new dependencies.
//
// What is NOT faked:
//   - The payloads. Both figures are produced by the REAL code that produces
//     them in the product: `plots._test.demoFrame()` → `notebook.assembleOutputs`
//     for the plotly mime, and `plots.mergeStreamFrame` → `streamFigure` →
//     `notebook.liveStreamOutputs` for the stream mime. The renderer is handed
//     the same BYTES a cell would hand it.
//   - The plotly URL. `import.meta.url` resolution runs for real; the resolved
//     href is checked to land on the 4.8 MB media/plotly.min.js that is really
//     on disk.
//   - The `import()` fallback. It is intercepted with `module.registerHooks`,
//     i.e. Node's own loader really resolves the renderer's dynamic import and
//     the hook substitutes a stub for the 4.8 MB payload. The import ATTEMPT is
//     therefore observed, not assumed. (Node < 22.15 has no registerHooks; the
//     fallback block then reports itself as skipped rather than passing.)
//
// What only a live VS Code session can observe is listed in README.md,
// "Verifying the renderer live".
//
// Added to `npm test` (see package.json) right after gr-test.js.

"use strict";

const fs = require("fs");
const path = require("path");
const nodeModule = require("module");
const { spawnSync } = require("child_process");
const { pathToFileURL, fileURLToPath } = require("url");

const vscodeMock = require("./vscode-mock");
vscodeMock.install();
const display = require("@blade-lang/ide-protocol").display;
const plots = require("../src/plots");
const nb = require("../src/notebook");
const _p = plots._test;

const ROOT = path.join(__dirname, "..");
const ENTRY = path.join(ROOT, "renderer", "plotly-renderer.js");
const ENTRY_URL = pathToFileURL(ENTRY).href;

let failures = 0;
let skipped = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.error(`FAIL ${name}`);
    if (detail !== undefined) console.error(`  ${JSON.stringify(detail)}`);
  }
}
function skip(name, why) {
  skipped++;
  console.log(`skip ${name} — ${why}`);
}

// --- The browser the renderer thinks it is running in -------------------------
//
// Deliberately minimal: every member here exists because plotly-renderer.js
// actually reaches for it. If the renderer grows a new DOM call this stub
// throws a plain TypeError and the test that exercises that path fails loudly,
// which is the intended failure mode — a stub that silently absorbs unknown
// calls would let the renderer rot.

class FakeElement {
  constructor(tagName, doc) {
    this.tagName = String(tagName).toUpperCase();
    this.doc = doc;
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.attributes = {};
    this._text = "";
    this._listeners = new Map();
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    if (this.doc && typeof this.doc.onAppend === "function") this.doc.onAppend(this, child);
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  /** Real DOM semantics: reading concatenates the subtree's text, writing
   *  DROPS every child first. The renderer relies on the second half
   *  (`element.textContent = ""` is how it clears a re-rendered cell). */
  get textContent() {
    return this._text + this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    for (const c of this.children) c.parentNode = null;
    this.children = [];
    this._text = String(v);
  }
  dispatch(type) {
    for (const fn of this._listeners.get(type) || []) fn({ type, target: this });
  }
}

/**
 * @param {object} opts
 *   scriptOutcome  "load" | "error" — what an injected <script> does, one tick
 *                  after it is appended (a real script load is asynchronous).
 *   onScriptLoad   called just before the "load" event, to install whatever
 *                  global the script would have defined.
 *   manual         hold the outcome instead: the test calls doc.fireScript(i,
 *                  outcome) itself, so work queued WHILE plotly is still
 *                  loading can be inspected.
 *   cssVars        VS Code theme variables getComputedStyle should report.
 */
function makeDom(opts) {
  const o = opts || {};
  const scripts = [];
  const fire = (entry, outcome) => {
    if (outcome === "load") {
      if (typeof o.onScriptLoad === "function") o.onScriptLoad();
      entry.el.dispatch("load");
    } else {
      entry.el.dispatch("error");
    }
  };
  const doc = {
    scripts,
    fireScript(i, outcome) {
      fire(scripts[i], outcome || o.scriptOutcome || "load");
    },
    onAppend(parent, child) {
      if (child.tagName !== "SCRIPT") return;
      const entry = { src: child.src, async: child.async, parent: parent.tagName, el: child };
      scripts.push(entry);
      if (o.manual) return;
      setImmediate(() => fire(entry, o.scriptOutcome || "load"));
    },
    createElement(tag) {
      return new FakeElement(tag, doc);
    },
  };
  doc.documentElement = new FakeElement("html", doc);
  doc.head = new FakeElement("head", doc);
  doc.body = new FakeElement("body", doc);
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);

  const cssVars = Object.assign(
    {
      "--vscode-editor-foreground": "#d4d4d4",
      "--vscode-panel-border": "#3c3c3c",
      "--vscode-font-family": "Segoe WPC, Segoe UI, sans-serif",
    },
    o.cssVars || {}
  );

  globalThis.document = doc;
  globalThis.getComputedStyle = (el) => {
    if (el !== doc.body) throw new Error("renderer read computed style of something other than document.body");
    return { getPropertyValue: (name) => cssVars[name] || "" };
  };
  return doc;
}

/** A recording plotly: what the renderer would have drawn. */
function fakePlotly(tag) {
  return {
    __tag: tag,
    newPlots: [],
    purges: [],
    newPlot(host, data, layout, config) {
      this.newPlots.push({ host, data, layout, config });
      return Promise.resolve(host);
    },
    purge(host) {
      this.purges.push(host);
    },
  };
}

/** The renderer API's OutputItem, over the REAL bytes a notebook cell carries.
 *  `json()` throws on malformed bytes exactly as VS Code's does. */
function outputItem(id, item) {
  const bytes = Uint8Array.from(item.data);
  return {
    id,
    mime: item.mime,
    metadata: item.metadata,
    data: () => bytes,
    text: () => Buffer.from(bytes).toString("utf8"),
    json: () => JSON.parse(Buffer.from(bytes).toString("utf8")),
  };
}

/** Let queued microtasks AND the setImmediate script-load tick run. */
function settle() {
  return new Promise((r) => setImmediate(() => setImmediate(r)));
}

// --- Loader interception for the import() fallback -----------------------------
//
// The renderer's fallback is `import(PLOTLY_URL)` — the same 4.8 MB UMD bundle.
// Letting Node really parse it would be slow and, since the bundle expects a
// browser, unpredictable. Node's own loader hooks let the import be resolved
// for real and the PAYLOAD be swapped, so the attempt is observable without the
// payload's cost. `plotlyImports` is the evidence.

const PLOTLY_FILE = path.join(ROOT, "media", "plotly.min.js");
const PLOTLY_FILE_URL = pathToFileURL(PLOTLY_FILE).href;
const plotlyImports = [];
let importOutcome = "ok"; // "ok" | "throw" | "no-global"
const hooksAvailable = typeof nodeModule.registerHooks === "function";
if (hooksAvailable) {
  nodeModule.registerHooks({
    load(url, context, nextLoad) {
      if (url.split("?")[0] !== PLOTLY_FILE_URL) return nextLoad(url, context);
      plotlyImports.push(url);
      if (importOutcome === "throw") {
        return { format: "module", shortCircuit: true, source: 'throw new Error("blocked by the test loader hook");' };
      }
      if (importOutcome === "no-global") {
        return { format: "module", shortCircuit: true, source: "export default {};" };
      }
      return {
        format: "module",
        shortCircuit: true,
        source:
          "globalThis.Plotly = { __tag: 'import-fallback', newPlots: [], purges: []," +
          " newPlot(h, d, l, c) { this.newPlots.push({ host: h, data: d, layout: l, config: c }); return Promise.resolve(h); }," +
          " purge(h) { this.purges.push(h); } };",
      };
    },
  });
}

/** A FRESH copy of the renderer module. The `plotlyPromise` memo is module
 *  state ("one load per output webview"), so each load-path case needs its own
 *  instance; a query string is what gets Node to make one. */
function freshRenderer(tag) {
  return import(`${ENTRY_URL}?case=${tag}`);
}

// --- 1. The contribution contract ---------------------------------------------
//
// Nothing else in the hermetic suite notices the manifest rotting, and a
// renderer that is not contributed (or not packaged) fails INVISIBLY: the cell
// quietly falls back to the text/plain summary.

async function testContribution() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const renderers = (pkg.contributes && pkg.contributes.notebookRenderers) || [];
  check("contract: exactly one notebook renderer contributed", renderers.length === 1, renderers.length);
  const r = renderers[0] || {};
  const mimes = r.mimeTypes || [];
  check("contract: exactly two mime types", mimes.length === 2, mimes);
  check("contract: the plotly mime is one of them", mimes.indexOf(display.PLOTLY_MIME) !== -1, mimes);
  check("contract: the stream mime is the other", mimes.indexOf(plots.STREAM_MIME) !== -1, mimes);
  check("contract: requiresMessaging never — this renderer never posts", r.requiresMessaging === "never", r.requiresMessaging);
  check("contract: entrypoint is the file under test", path.resolve(ROOT, r.entrypoint || "") === ENTRY, r.entrypoint);
  check("contract: the entrypoint exists", fs.existsSync(ENTRY));

  const syntax = spawnSync(process.execPath, ["--check", ENTRY], { encoding: "utf8" });
  check("contract: the entrypoint passes node --check", syntax.status === 0, syntax.stderr);

  // renderer/package.json is what lets NODE load this file as ESM (`node
  // --check`, and the imports below) without flipping the root package, whose
  // src/ is the CommonJS VS Code's extension host loads.
  const rpkg = JSON.parse(fs.readFileSync(path.join(ROOT, "renderer", "package.json"), "utf8"));
  check("contract: renderer/package.json marks the directory as ESM", rpkg.type === "module", rpkg.type);

  const mod = await import(ENTRY_URL);
  check("contract: importing it as ESM in Node succeeds", !!mod);
  check("contract: exports activate (the VS Code entrypoint contract)", typeof mod.activate === "function", Object.keys(mod));
  const api = mod.activate({});
  check("contract: activate returns renderOutputItem", api && typeof api.renderOutputItem === "function", api && Object.keys(api));
  check("contract: activate returns disposeOutputItem", api && typeof api.disposeOutputItem === "function", api && Object.keys(api));
  check("contract: its mime list matches the manifest", mod.mimeTypes.slice().sort().join(",") === mimes.slice().sort().join(","), [mod.mimeTypes, mimes]);

  // The asset URL, resolved for real off import.meta.url.
  const asset = mod.plotlyAssetUrl();
  check("contract: the plotly URL resolves off import.meta.url", asset === PLOTLY_FILE_URL, asset);
  check("contract: it names media/plotly.min.js", /\/media\/plotly\.min\.js$/.test(asset), asset);
  check("contract: no remote host in it", !/^https?:/.test(asset) && asset.indexOf("cdn.plot.ly") === -1, asset);
  const assetPath = fileURLToPath(asset);
  check("contract: that path is a real file on disk", fs.existsSync(assetPath), assetPath);
  check(
    "contract: and it is the real 4.8 MB bundle, not a placeholder",
    fs.existsSync(assetPath) && fs.statSync(assetPath).size > 1000000,
    fs.existsSync(assetPath) ? fs.statSync(assetPath).size : 0
  );

  // A renderer excluded from the .vsix fails exactly like one that was never
  // contributed, so the packaging exclusions are part of this contract.
  const ignores = fs
    .readFileSync(path.join(ROOT, ".vscodeignore"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && l[0] !== "#");
  const excludes = (dir) => ignores.some((g) => g === dir || g === `${dir}/**` || g === `${dir}/*`);
  check("contract: .vscodeignore does not exclude renderer/", !excludes("renderer"), ignores);
  check("contract: .vscodeignore does not exclude media/", !excludes("media"), ignores);
}

// --- 2. Rendering a real plotly-mime figure ------------------------------------

/** The bytes a cell carries for a finished figure: the demo contour (the same
 *  `{data, layout, config}` triple the compiler's `plot.*` emits — cf. the
 *  Blade corpus test `display/001_emit_frames.blade`) pushed through the real
 *  assembleOutputs. */
function plotlyCellOutput() {
  const outputs = nb._test.assembleOutputs({
    kept: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
    bindings: [],
    diagnostics: [],
    display: [_p.demoFrame()],
  });
  return outputs[0];
}

async function testRenderPlotlyFigure() {
  const P = fakePlotly("classic-script");
  delete globalThis.Plotly;
  const doc = makeDom({ scriptOutcome: "load", onScriptLoad: () => (globalThis.Plotly = P) });

  const mod = await freshRenderer("plotly");
  const api = mod.activate({});
  const out = plotlyCellOutput();
  check("plotly cell: the rich item is first, the text summary second",
    out.items[0].mime === display.PLOTLY_MIME && out.items[1].mime === "text/plain",
    out.items.map((i) => i.mime));
  check("plotly cell: the text summary is what a host WITHOUT this renderer shows",
    /^\[application\/vnd\.plotly\.v1\+json/.test(Buffer.from(out.items[1].data).toString("utf8")),
    Buffer.from(out.items[1].data).toString("utf8"));

  const element = doc.createElement("div");
  const item = outputItem("plotly-1", out.items[0]);
  let threw = null;
  try {
    api.renderOutputItem(item, element);
  } catch (e) {
    threw = e;
  }
  check("plotly: renderOutputItem does not throw", threw === null, threw && threw.message);
  check("plotly: it builds one host div into the element", element.children.length === 1 && element.children[0].tagName === "DIV", element.children.map((c) => c.tagName));
  const host = element.children[0];
  check("plotly: the host is full-width with a default height", host.style.width === "100%" && host.style.minHeight === "320px", host.style);

  // The script-loading branch, with the URL it actually resolved.
  check("plotly: it reached the classic-script branch", doc.scripts.length === 1, doc.scripts.length);
  const script = doc.scripts[0] || {};
  check("plotly: the script src is the RESOLVED plotly URL", script.src === mod.plotlyAssetUrl(), script.src);
  check("plotly: that URL's pathname is a file on disk", !!script.src && fs.existsSync(fileURLToPath(script.src)), script.src);
  check("plotly: injected into <head>, execution order preserved", script.parent === "HEAD" && script.async === false, [script.parent, script.async]);
  check("plotly: the classic path was enough — no import() fallback", plotlyImports.length === 0, plotlyImports);

  await settle();
  check("plotly: newPlot ran once, on the host div", P.newPlots.length === 1 && P.newPlots[0].host === host, P.newPlots.length);
  const drawn = P.newPlots[0] || {};
  check("plotly: the figure's traces are what got drawn",
    drawn.data && drawn.data.length === 1 && drawn.data[0].type === "contour" && drawn.data[0].colorscale === "Viridis",
    drawn.data && drawn.data[0] && drawn.data[0].type);
  check("plotly: the full 61x61 grid survives the JSON round trip",
    drawn.data[0].z.length === 61 && drawn.data[0].z[0].length === 61,
    drawn.data[0].z.length);
  check("plotly: the figure's own layout wins over the theme", drawn.layout.title.text === "sin(x)·cos(y)", drawn.layout.title);
  check("plotly: axis titles survive the per-axis merge", drawn.layout.xaxis.title.text === "x [m]" && drawn.layout.yaxis.title.text === "y [m]", [drawn.layout.xaxis, drawn.layout.yaxis]);
  check("plotly: theme colors come from VS Code's CSS variables", drawn.layout.font.color === "#d4d4d4", drawn.layout.font);
  check("plotly: the panel border becomes the grid color", drawn.layout.xaxis.gridcolor === "#3c3c3c", drawn.layout.xaxis);
  check("plotly: transparent paper so the cell's own background shows", drawn.layout.paper_bgcolor === "rgba(0,0,0,0)", drawn.layout.paper_bgcolor);
  check("plotly: responsive config, no plotly logo", drawn.config.responsive === true && drawn.config.displaylogo === false, drawn.config);
  check("plotly: the host div is still the element's only child", element.children.length === 1 && element.children[0] === host, element.children.length);

  return { mod, api, doc, P };
}

// --- 3. Rendering the stream mime the notebook actually produces ----------------

/** The bytes an EXECUTING cell carries mid-run: a channel accumulated by the
 *  real merge, turned into outputs by the real liveStreamOutputs. */
function streamCellOutput() {
  const acc = _p.newStreamAcc();
  _p.mergeStreamFrame(acc, { channel: "jet_k24", epoch: 0, x: [0, 1, 2], y: [2.0, 1.6, 1.4], title: "jet_k24 batch loss", xlabel: "step", ylabel: "loss" });
  _p.mergeStreamFrame(acc, { channel: "jet_k24", epoch: 1, x: [3, 4], y: [1.1, 0.9] });
  return nb._test.liveStreamOutputs(new Map([["jet_k24", acc]]))[0];
}

async function testRenderStreamFigure(ctx) {
  const { api, doc, P } = ctx;
  const out = streamCellOutput();
  check("stream cell: the stream mime is first, the text summary second",
    out.items[0].mime === plots.STREAM_MIME && out.items[1].mime === "text/plain",
    out.items.map((i) => i.mime));
  check("stream cell: the summary counts points, so a renderer-less host still shows progress",
    /5 points, streaming…\]$/.test(Buffer.from(out.items[1].data).toString("utf8")),
    Buffer.from(out.items[1].data).toString("utf8"));

  const element = doc.createElement("div");
  const before = P.newPlots.length;
  api.renderOutputItem(outputItem("stream-1", out.items[0]), element);
  await settle();
  check("stream: drawn without a second script injection (plotly is memoized)", doc.scripts.length === 1, doc.scripts.length);
  check("stream: newPlot ran for the stream item", P.newPlots.length === before + 1, P.newPlots.length - before);
  const drawn = P.newPlots[P.newPlots.length - 1];
  check("stream: one line trace over the accumulated series", drawn.data.length === 1 && drawn.data[0].x.join(",") === "0,1,2,3,4", drawn.data[0].x);
  check("stream: y in step", drawn.data[0].y.join(",") === "2,1.6,1.4,1.1,0.9", drawn.data[0].y);
  check("stream: the channel's title/labels survive the theme merge",
    drawn.layout.title.text === "jet_k24 batch loss" && drawn.layout.xaxis.title.text === "step" && drawn.layout.yaxis.title.text === "loss",
    drawn.layout.title);
  check("stream: theme grid color still merged into the axes", drawn.layout.xaxis.gridcolor === "#3c3c3c", drawn.layout.xaxis);
  check("stream: the epoch rules survive as layout shapes", (drawn.layout.shapes || []).length === 2, drawn.layout.shapes);
  check("stream: with their e<n> labels", (drawn.layout.annotations || []).map((a) => a.text).join(",") === "e0,e1", drawn.layout.annotations);

  // The repaint: an animating cell renders the SAME item id again ~2x a second.
  // The previous graph must be purged, not stranded, and the element must not
  // accumulate hosts.
  const host1 = element.children[0];
  const purgesBefore = P.purges.length;
  api.renderOutputItem(outputItem("stream-1", streamCellOutput().items[0]), element);
  await settle();
  check("repaint: the previous graph is purged", P.purges.length === purgesBefore + 1 && P.purges[P.purges.length - 1] === host1, P.purges.length - purgesBefore);
  check("repaint: the element holds exactly one host, not two", element.children.length === 1, element.children.length);
  check("repaint: the new host is a fresh div", element.children[0] !== host1);
  check("repaint: and it was drawn into", P.newPlots[P.newPlots.length - 1].host === element.children[0]);

  // disposeOutputItem, both arities (VS Code passes undefined to dispose all).
  const purges2 = P.purges.length;
  api.disposeOutputItem("stream-1");
  check("dispose: purges the named item's graph", P.purges.length === purges2 + 1, P.purges.length - purges2);
  api.disposeOutputItem("stream-1");
  check("dispose: purging an already-disposed id is a no-op", P.purges.length === purges2 + 1, P.purges.length - purges2);
  let threw = null;
  try {
    api.disposeOutputItem();
  } catch (e) {
    threw = e;
  }
  check("dispose: the no-argument form (dispose everything) is callable", threw === null, threw && threw.message);
}

// --- 4. The import() fallback --------------------------------------------------

async function testImportFallback() {
  if (!hooksAvailable) {
    skip("fallback: import() is attempted when the classic script errors", `node ${process.version} has no module.registerHooks`);
    return;
  }
  delete globalThis.Plotly;
  plotlyImports.length = 0;
  importOutcome = "ok";
  const doc = makeDom({ scriptOutcome: "error" });

  const mod = await freshRenderer("fallback");
  const api = mod.activate({});
  const element = doc.createElement("div");
  api.renderOutputItem(outputItem("fallback-1", plotlyCellOutput().items[0]), element);
  await settle();
  await settle();

  check("fallback: the classic script was tried first", doc.scripts.length === 1 && doc.scripts[0].src === mod.plotlyAssetUrl(), doc.scripts.length);
  check("fallback: import() was attempted after it errored", plotlyImports.length === 1, plotlyImports);
  check("fallback: at the SAME resolved plotly URL", plotlyImports[0] === mod.plotlyAssetUrl(), plotlyImports[0]);
  const P = globalThis.Plotly;
  check("fallback: the module's global is picked up", P && P.__tag === "import-fallback", P && P.__tag);
  check("fallback: and the chart is drawn, not an error", P && P.newPlots.length === 1 && P.newPlots[0].host === element.children[0], P && P.newPlots.length);
  check("fallback: no visible error surfaced in the cell", element.children.length === 1 && element.children[0].tagName === "DIV", element.children.map((c) => c.tagName));
}

/** Both paths gone — the cell must show something readable, not a blank div. */
async function testBothLoadPathsFail() {
  delete globalThis.Plotly;
  plotlyImports.length = 0;
  importOutcome = hooksAvailable ? "throw" : "ok";
  const doc = makeDom({ scriptOutcome: "error" });

  const mod = await freshRenderer("noplotly");
  const api = mod.activate({});
  const element = doc.createElement("div");
  let threw = null;
  try {
    api.renderOutputItem(outputItem("dead-1", plotlyCellOutput().items[0]), element);
  } catch (e) {
    threw = e;
  }
  await settle();
  await settle();
  check("no plotly: renderOutputItem still did not throw", threw === null, threw && threw.message);
  const pre = element.children[0];
  check("no plotly: the cell shows a visible <pre>, not an empty div", element.children.length === 1 && pre && pre.tagName === "PRE", element.children.map((c) => c.tagName));
  const text = pre ? pre.textContent : "";
  check("no plotly: it names the mime it failed on", text.indexOf(display.PLOTLY_MIME) !== -1, text.slice(0, 120));
  check("no plotly: it says it could not render", /could not render/.test(text), text.slice(0, 160));
  check("no plotly: the payload is shown so the data is not lost", text.indexOf('"type": "contour"') !== -1, text.slice(0, 400));
  check("no plotly: the dump is capped, not a 4 MB wall of JSON", text.length < 6000, text.length);

  // The failure is REMEMBERED for the life of the output webview (plotlyPromise
  // is "one load per webview"). That is deliberate: the asset is a local file,
  // so a failure means a systematic problem — a resource-root or CSP miss —
  // and re-injecting a script per output item would only multiply the console
  // noise. Recovery is a window reload, which is what README.md's live
  // checklist tells you to do.
  const scriptsAfterFirst = doc.scripts.length;
  const el2 = doc.createElement("div");
  api.renderOutputItem(outputItem("dead-2", plotlyCellOutput().items[0]), el2);
  await settle();
  await settle();
  check("no plotly: a second item does not re-inject the script", doc.scripts.length === scriptsAfterFirst, doc.scripts.length - scriptsAfterFirst);
  check("no plotly: it shows the same visible error rather than a blank cell", el2.children.length === 1 && el2.children[0].tagName === "PRE", el2.children.map((c) => c.tagName));
  importOutcome = "ok";
}

// --- 5. Failure modes ----------------------------------------------------------

async function testMalformedAndUnrecognized() {
  const P = fakePlotly("failure-modes");
  delete globalThis.Plotly;
  const doc = makeDom({ scriptOutcome: "load", onScriptLoad: () => (globalThis.Plotly = P) });
  const mod = await freshRenderer("failures");
  const api = mod.activate({});

  // (a) bytes that are not JSON at all — VS Code's OutputItem.json() throws
  //     here, and so does this stub.
  const element = doc.createElement("div");
  let threw = null;
  try {
    api.renderOutputItem(outputItem("bad-1", { mime: display.PLOTLY_MIME, data: Buffer.from('{"data":[{"type":"contour"', "utf8") }), element);
  } catch (e) {
    threw = e;
  }
  check("malformed: renderOutputItem does not throw", threw === null, threw && threw.message);
  const text = element.textContent;
  check("malformed: the cell shows a visible message", text.length > 0, text);
  check("malformed: it names the mime", text.indexOf(display.PLOTLY_MIME) !== -1, text);
  check("malformed: it says the output is not JSON", /output is not JSON/.test(text), text);
  check("malformed: nothing was drawn and no script was injected", doc.scripts.length === 0 && P.newPlots.length === 0, [doc.scripts.length, P.newPlots.length]);

  // (b) valid JSON with no figure in it — the payload must stay READABLE.
  const el2 = doc.createElement("div");
  api.renderOutputItem(outputItem("bad-2", { mime: plots.STREAM_MIME, data: Buffer.from(JSON.stringify({ nope: 1, deep: { a: [1, 2] } }), "utf8") }), el2);
  const pre = el2.children[0];
  check("unrecognized: a <pre> is appended", el2.children.length === 1 && pre.tagName === "PRE", el2.children.map((c) => c.tagName));
  check("unrecognized: it wraps rather than overflowing the cell", pre.style.whiteSpace === "pre-wrap", pre.style);
  check("unrecognized: it says there is no figure in the payload", /no figure in this payload/.test(pre.textContent), pre.textContent.slice(0, 120));
  check("unrecognized: and pretty-prints the JSON", /"nope": 1/.test(pre.textContent), pre.textContent.slice(0, 200));
  check("unrecognized: still no plotly load for a payload it cannot draw", doc.scripts.length === 0, doc.scripts.length);

  // (c) an empty-but-valid figure IS a figure — it draws (an empty chart is a
  //     legitimate first frame of a stream), and that is the only case that
  //     should reach plotly here.
  const el3 = doc.createElement("div");
  api.renderOutputItem(outputItem("empty-1", { mime: plots.STREAM_MIME, data: Buffer.from(JSON.stringify({ data: [], layout: {} }), "utf8") }), el3);
  await settle();
  check("empty figure: drawn rather than dumped as JSON", P.newPlots.length === 1 && P.newPlots[0].data.length === 0, P.newPlots.length);

  // (d) a raw wire chunk reaching a cell output directly (the renderer's
  //     documented tolerance) still becomes a chart.
  const el4 = doc.createElement("div");
  api.renderOutputItem(
    outputItem("raw-1", { mime: plots.STREAM_MIME, data: Buffer.from(JSON.stringify({ channel: "loss", epoch: 0, x: [0, 1], y: [3, 2], xlabel: "step" }), "utf8") }),
    el4
  );
  await settle();
  check("raw chunk: wrapped into a single-trace figure", P.newPlots.length === 2 && P.newPlots[1].data[0].y.join(",") === "3,2", P.newPlots.length);
  check("raw chunk: its label survives the theme merge", P.newPlots[1].layout.xaxis.title.text === "step", P.newPlots[1].layout.xaxis);
}

// --- 6. What a live streaming cell does to the load path -----------------------
//
// `examples/aspirin_moment_jet.bladenb` streams THREE channels at once, so a
// cell hands the webview three output items in the same frame — before plotly
// has finished loading — and then replaces all three ~2x a second. Both of the
// races that creates are load-path races, and both are invisible to any test
// that renders one item and waits.

async function testConcurrentItemsAndRaces() {
  const P = fakePlotly("concurrent");
  delete globalThis.Plotly;
  const doc = makeDom({ manual: true, onScriptLoad: () => (globalThis.Plotly = P) });
  const mod = await freshRenderer("concurrent");
  const api = mod.activate({});

  // Three channels, rendered back to back with plotly still in flight.
  const els = [];
  for (const ch of ["jet_pos", "jet_k2", "jet_k24"]) {
    const el = doc.createElement("div");
    els.push(el);
    api.renderOutputItem(outputItem(ch, streamCellOutput().items[0]), el);
  }
  check("concurrent: three items in flight share ONE plotly load", doc.scripts.length === 1, doc.scripts.length);
  check("concurrent: each item already has its host div", els.every((e) => e.children.length === 1 && e.children[0].tagName === "DIV"), els.map((e) => e.children.length));
  check("concurrent: nothing drawn before plotly arrives", P.newPlots.length === 0, P.newPlots.length);

  doc.fireScript(0, "load");
  await settle();
  check("concurrent: all three draw once the single load resolves", P.newPlots.length === 3, P.newPlots.length);
  check("concurrent: each into its OWN element's host", P.newPlots.every((n, i) => n.host === els[i].children[0]), P.newPlots.length);

  // The repaint race: the same item id re-rendered while its FIRST draw is
  // still waiting on the load. Only the live host may be drawn into — a stale
  // callback painting a detached div is a leak the cell never recovers.
  const P2 = fakePlotly("race");
  delete globalThis.Plotly;
  const doc2 = makeDom({ manual: true, onScriptLoad: () => (globalThis.Plotly = P2) });
  const mod2 = await freshRenderer("race");
  const api2 = mod2.activate({});
  const el = doc2.createElement("div");
  api2.renderOutputItem(outputItem("jet_k24", streamCellOutput().items[0]), el);
  const stale = el.children[0];
  api2.renderOutputItem(outputItem("jet_k24", streamCellOutput().items[0]), el);
  const live = el.children[0];
  check("race: the repaint replaced the host before the load resolved", stale !== live && el.children.length === 1, el.children.length);
  doc2.fireScript(0, "load");
  await settle();
  check("race: exactly one draw, into the live host", P2.newPlots.length === 1 && P2.newPlots[0].host === live, P2.newPlots.length);
  check("race: the stale host was never drawn into", !P2.newPlots.some((n) => n.host === stale));
}

/** A script that fires `load` but defines nothing — a truncated or
 *  content-blocked plotly. The cell must say so rather than sit blank. */
async function testScriptLoadsWithoutGlobal() {
  delete globalThis.Plotly;
  const doc = makeDom({ scriptOutcome: "load" }); // onScriptLoad absent: no global
  const mod = await freshRenderer("noglobal");
  const api = mod.activate({});
  const el = doc.createElement("div");
  api.renderOutputItem(outputItem("noglobal-1", plotlyCellOutput().items[0]), el);
  await settle();
  await settle();
  const pre = el.children[0];
  check("no global: the cell shows a visible <pre>", el.children.length === 1 && pre.tagName === "PRE", el.children.map((c) => c.tagName));
  check("no global: naming the missing global, not a generic failure", /exposed no Plotly global/.test(pre.textContent), pre.textContent.slice(0, 160));
}

// --- 7. The last three branches ------------------------------------------------
//
// Closing out the file: with these, every branch of loadPlotly, injectScript,
// figureFor, renderOutputItem and disposeOutputItem has been exercised.

async function testRemainingBranches() {
  // (a) plotly already on the page — injectScript short-circuits and no script
  //     element is created at all.
  const P = fakePlotly("preloaded");
  globalThis.Plotly = P;
  const doc = makeDom({ scriptOutcome: "load" });
  const mod = await freshRenderer("preloaded");
  const api = mod.activate({});
  const el = doc.createElement("div");
  api.renderOutputItem(outputItem("pre-1", plotlyCellOutput().items[0]), el);
  await settle();
  check("preloaded: an existing Plotly global is reused, no second <script>", doc.scripts.length === 0, doc.scripts.length);
  check("preloaded: and the chart is drawn", P.newPlots.length === 1 && P.newPlots[0].host === el.children[0], P.newPlots.length);

  // (b) a purge that throws — plotly does, on a div it never plotted — must not
  //     take the re-render down with it.
  const el2 = doc.createElement("div");
  api.renderOutputItem(outputItem("pre-2", plotlyCellOutput().items[0]), el2);
  await settle();
  P.purge = () => {
    throw new Error("no gd found");
  };
  let threw = null;
  try {
    api.renderOutputItem(outputItem("pre-2", plotlyCellOutput().items[0]), el2);
  } catch (e) {
    threw = e;
  }
  await settle();
  check("purge throws: the re-render survives it", threw === null, threw && threw.message);
  check("purge throws: and still redraws", P.newPlots.length === 3 && P.newPlots[2].host === el2.children[0], P.newPlots.length);

  // (c) disposeOutputItem() with no id purges EVERY chart the renderer holds.
  const purged = [];
  P.purge = (h) => purged.push(h);
  api.disposeOutputItem();
  check("dispose all: every live chart is purged", purged.length === 2, purged.length);
  api.disposeOutputItem();
  check("dispose all: a second sweep finds nothing left", purged.length === 2, purged.length);
}

// --- Run -----------------------------------------------------------------------

(async () => {
  await testContribution();
  const ctx = await testRenderPlotlyFigure();
  await testRenderStreamFigure(ctx);
  await testImportFallback();
  await testBothLoadPathsFail();
  await testMalformedAndUnrecognized();
  await testConcurrentItemsAndRaces();
  await testScriptLoadsWithoutGlobal();
  await testRemainingBranches();

  delete globalThis.document;
  delete globalThis.getComputedStyle;
  delete globalThis.Plotly;

  if (failures) {
    console.error(`\n${failures} renderer check(s) failed.`);
    process.exit(1);
  }
  console.log(
    `\nOK — the notebook renderer's contribution, both mime paths, both plotly load paths, and its visible fallbacks hold.${
      skipped ? ` (${skipped} skipped)` : ""
    }`
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
