// Hermetic tests for the display-frame pipeline: src/display.js's parsing and
// routing (the wire format in docs/display-frames.md), src/plots.js's history
// model, and the panel's generated HTML. No compiler, no VS Code host, no
// browser — the webview is the mock's recording panel (scripts/vscode-mock.js),
// so "what the panel was told to render" is an ordinary assertion.
//
// Added to `npm test` (see package.json) right after notebook-test.js.

"use strict";

const vscodeMock = require("./vscode-mock");
const mock = vscodeMock.install();
const display = require("@blade-lang/ide-protocol").display;
const plots = require("../src/plots");
const nb = require("../src/notebook");
const _p = plots._test;

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`ok   ${name}`);
  } else {
    failures++;
    console.error(`FAIL ${name}`);
    if (detail !== undefined) console.error(`  ${JSON.stringify(detail)}`);
  }
}

// A 1x1 transparent PNG — small enough to inline, real enough to base64-decode.
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function plotlyFrame(extra) {
  return Object.assign(
    {
      mime: display.PLOTLY_MIME,
      data: {
        data: [{ type: "contour", z: [[1, 2], [3, 4]] }],
        layout: { title: { text: "sin(x)·cos(y)" }, xaxis: { title: { text: "x [m]" } } },
      },
    },
    extra || {}
  );
}

function pngFrame(extra) {
  return Object.assign({ mime: display.PNG_MIME, data: PNG_B64 }, extra || {});
}

// --- 1. Frame parsing --------------------------------------------------------

function testValidPlotlyFrame() {
  const line = display.encodeReplLine(plotlyFrame());
  const res = display.scanReplOutput("x = 1\n" + line + "done\n");
  check("plotly frame: one frame decoded", res.frames.length === 1, res.frames.length);
  check("plotly frame: no errors", res.errors.length === 0, res.errors);
  check("plotly frame: stripped from text", res.text === "x = 1\ndone\n", JSON.stringify(res.text));
  const f = res.frames[0];
  check("plotly frame: mime", f.mime === display.PLOTLY_MIME, f.mime);
  check("plotly frame: encoding defaults to json", f.encoding === "json", f.encoding);
  check("plotly frame: version stamped", f.v === display.FRAME_VERSION, f.v);
  check("plotly frame: data survives", f.data.data[0].type === "contour", f.data);
  check("plotly frame: meta defaulted to {}", f.meta && Object.keys(f.meta).length === 0, f.meta);
}

function testValidPngFrame() {
  const line = display.encodeReplLine(pngFrame({ meta: { title: "GR render" } }));
  const res = display.scanReplOutput(line);
  check("png frame: decoded", res.frames.length === 1 && res.errors.length === 0, res);
  const f = res.frames[0];
  check("png frame: encoding inferred base64", f.encoding === "base64", f.encoding);
  check("png frame: data round-trips", f.data === PNG_B64, f.data.slice(0, 16));
  check(
    "png frame: base64 decodes to a PNG signature",
    Buffer.from(f.data, "base64").slice(1, 4).toString() === "PNG",
    Buffer.from(f.data, "base64").slice(0, 8).toString("hex")
  );
  check("png frame: backend inferred gr", display.backendFor(f) === "gr", display.backendFor(f));
  check("png frame: text emptied", res.text === "", JSON.stringify(res.text));
}

function testMalformedJsonDegradesToText() {
  const bad = display.SENTINEL + '{"mime":"image/png","data":' + "\n";
  const res = display.scanReplOutput("before\n" + bad + "after\n");
  check("malformed frame: no frames", res.frames.length === 0, res.frames);
  check("malformed frame: one reason", res.errors.length === 1, res.errors);
  check(
    "malformed frame: reason names the failure",
    /malformed display frame JSON/.test(res.errors[0]),
    res.errors[0]
  );
  check(
    "malformed frame: payload degrades to plain text",
    res.text === 'before\n{"mime":"image/png","data":\nafter\n',
    JSON.stringify(res.text)
  );
  check("malformed frame: sentinel never reaches the terminal", res.text.indexOf(display.SENTINEL) === -1, res.text);
}

function testValidationRejections() {
  const cases = [
    ["no mime", { data: {} }, /"mime" is missing/],
    ["mime not a mime type", { mime: "plotly", data: {} }, /not a mime type/],
    ["no data", { mime: "image/png" }, /"data" is missing/],
    ["json data must be an object", { mime: display.PLOTLY_MIME, data: "hi" }, /must be an inline JSON object/],
    ["base64 data must be a string", { mime: "image/png", data: { a: 1 } }, /must be a string/],
    ["base64 data must be base64", { mime: "image/png", data: "not base64!!" }, /is not base64/],
    ["bad encoding", { mime: "image/png", data: "AA==", encoding: "hex" }, /"encoding" must be one of/],
    ["meta must be an object", { mime: "image/png", data: "AA==", meta: [1] }, /"meta" is not a JSON object/],
    ["future version", { v: 99, mime: "image/png", data: "AA==" }, /newer than this extension/],
    ["array, not object", [1, 2, 3], /not a JSON object/],
  ];
  for (const [name, obj, re] of cases) {
    const res = display.decodeFrame(obj);
    check(`rejects ${name}`, res.ok === false && re.test(res.reason), res);
  }
  check("accepts an explicit v:1", display.decodeFrame({ v: 1, mime: "image/png", data: "AA==" }).ok === true);
  const html = display.decodeFrame({ mime: "text/html", data: "<b>hi</b>" });
  check("accepts text/* as utf8", html.ok === true && html.frame.encoding === "utf8", html);
}

function testOversizeRejected() {
  const huge = "x".repeat(display.MAX_FRAME_CHARS + 1);
  const res = display.parseFrameJson(huge);
  check("oversize frame rejected without parsing", res.ok === false && /over the/.test(res.reason), res.reason);
}

function testFramesFromEval() {
  const resp = {
    kept: true,
    display: [plotlyFrame(), { mime: "image/png" }, pngFrame()],
  };
  const res = display.framesFromEval(resp);
  check("eval display[]: two valid frames", res.frames.length === 2, res.frames.map((f) => f.mime));
  check("eval display[]: one rejection", res.errors.length === 1, res.errors);
  check("eval display[] absent is not an error", JSON.stringify(display.framesFromEval({ kept: true })) === '{"frames":[],"errors":[]}');
  const notArray = display.framesFromEval({ display: { mime: "image/png" } });
  check("eval display[] must be an array", notArray.errors.length === 1 && notArray.frames.length === 0, notArray);
}

function testDisplayEvents() {
  const ev = { event: "display", id: 7, frame: plotlyFrame() };
  check("event recognized", display.isEvent(ev) === true);
  check("response is not an event", display.isEvent({ id: 7, kept: true }) === false);
  const res = display.frameFromEvent(ev);
  check("event frame decodes", res.ok === true && res.frame.mime === display.PLOTLY_MIME, res);
  const bad = display.frameFromEvent({ event: "display", id: 7, frame: { mime: "image/png" } });
  check("event with a bad frame reports a reason", bad.ok === false, bad);
}

function testStreamScanner() {
  const scan = display.createStreamScanner();
  const line = display.encodeReplLine(pngFrame());
  const half = Math.floor(line.length / 2);
  const a = scan.push("hello\n" + line.slice(0, half));
  check("stream: complete text emitted immediately", a.text === "hello\n", JSON.stringify(a.text));
  check("stream: partial frame line withheld", a.frames.length === 0, a.frames);
  const b = scan.push(line.slice(half) + "blade> ");
  check("stream: frame completes on the next chunk", b.frames.length === 1, b.frames.length);
  check("stream: prompt is not withheld", b.text === "blade> ", JSON.stringify(b.text));

  // The prompt carries no newline and must never be held back waiting for one.
  const scan2 = display.createStreamScanner();
  check("stream: bare prompt passes straight through", scan2.push("blade> ").text === "blade> ");
}

function testRoutingHub() {
  const seen = [];
  const logs = [];
  display.setLogger((l) => logs.push(l));
  const sub = display.subscribe((f, origin) => seen.push({ mime: f.mime, origin }));
  const text = display.ingestReplText("a\n" + display.encodeReplLine(plotlyFrame()) + "b\n", "repl");
  check("hub: subscriber saw the frame", seen.length === 1 && seen[0].origin === "repl", seen);
  check("hub: cleaned text returned", text === "a\nb\n", JSON.stringify(text));
  display.ingestReplText(display.SENTINEL + "{oops\n", "repl");
  check("hub: rejection logged, not thrown", logs.some((l) => /malformed display frame JSON/.test(l)), logs);

  // A throwing subscriber must not take the channel down with it.
  const boom = display.subscribe(() => {
    throw new Error("boom");
  });
  display.ingestReplText(display.encodeReplLine(pngFrame()), "repl");
  check("hub: throwing subscriber is contained", logs.some((l) => /subscriber failed/.test(l)), logs.slice(-2));
  boom.dispose();
  sub.dispose();
  display.ingestReplText(display.encodeReplLine(pngFrame()), "repl");
  check("hub: dispose unsubscribes", seen.length === 2, seen.length);
  display.setLogger(null);
}

// --- 2. History model --------------------------------------------------------

function testHistoryAppendAndNavigate() {
  const h = _p.newHistory();
  check("empty history: cursor -1", h.cursor === -1 && _p.currentEntry(h) === undefined);
  check("empty history: navigate is a no-op", _p.navigate(h, 1) === -1);

  const a = _p.appendFrame(h, display.decodeFrame(plotlyFrame()).frame);
  const b = _p.appendFrame(h, display.decodeFrame(pngFrame()).frame);
  const c = _p.appendFrame(h, display.decodeFrame(plotlyFrame({ meta: { title: "third" } })).frame);
  check("append: three entries", h.entries.length === 3, h.entries.length);
  check("append: cursor follows the newest", h.cursor === 2, h.cursor);
  check("append: none merged", !a.merged && !b.merged && !c.merged);
  check("append: seq is 1-based arrival order", h.entries.map((e) => e.seq).join(",") === "1,2,3");
  check("append: title from the plotly layout", h.entries[0].title === "sin(x)·cos(y)", h.entries[0].title);
  check("append: title from meta wins", h.entries[2].title === "third", h.entries[2].title);
  check("append: untitled png falls back to Plot N", h.entries[1].title === "Plot 2", h.entries[1].title);
  check("append: per-backend renders", h.entries[0].renders.plotly && h.entries[1].renders.gr, Object.keys(h.entries[1].renders));

  check("navigate: back one", _p.navigate(h, -1) === 1);
  check("navigate: back again", _p.navigate(h, -1) === 0);
  check("navigate: clamps at the start", _p.navigate(h, -1) === 0);
  check("navigate: forward", _p.navigate(h, 1) === 1);
  check("navigate: clamps at the end", _p.navigate(h, 1) === 2 && _p.navigate(h, 1) === 2);
  check("navigate: currentEntry tracks the cursor", _p.currentEntry(h) === h.entries[2]);
}

function testHistoryAlternateRender() {
  const h = _p.newHistory();
  _p.appendFrame(h, display.decodeFrame(plotlyFrame({ meta: { id: "p1", spec: { kind: "contourf" } } })).frame);
  const merged = _p.appendFrame(h, display.decodeFrame(pngFrame({ meta: { id: "p1", backend: "gr" } })).frame);
  check("alternate render: history did not grow", h.entries.length === 1, h.entries.length);
  check("alternate render: reported as merged", merged.merged === true);
  const e = h.entries[0];
  check("alternate render: both renders retained", !!e.renders.plotly && !!e.renders.gr, Object.keys(e.renders));
  check("alternate render: original payload intact", e.renders.plotly.data.data[0].type === "contour");
  check("alternate render: backend-neutral spec retained", e.spec && e.spec.kind === "contourf", e.spec);
  check("alternate render: primary stays the first backend", e.primary === "plotly", e.primary);

  check("renderFor: picks the requested backend", _p.renderFor(e, "gr").mime === display.PNG_MIME);
  check("renderFor: falls back to primary", _p.renderFor(e, "nope").mime === display.PLOTLY_MIME);

  // A different id is a different plot, not an alternate render.
  _p.appendFrame(h, display.decodeFrame(pngFrame({ meta: { id: "p2" } })).frame);
  check("alternate render: distinct ids append", h.entries.length === 2, h.entries.length);
}

// --- 3. Panel HTML -----------------------------------------------------------

function testPanelHtml() {
  const html = _p.panelHtml({
    cspSource: "vscode-webview://abc",
    plotlyUri: "https://abc.vscode-cdn.net/media/plotly.min.js",
    nonce: "NONCE123",
  });
  const cspMatch = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
  check("html: CSP meta present", !!cspMatch);
  const csp = cspMatch ? cspMatch[1] : "";
  check("html: default-src 'none'", csp.indexOf("default-src 'none'") !== -1, csp);
  check("html: script-src is extension + nonce", /script-src vscode-webview:\/\/abc 'nonce-NONCE123'/.test(csp), csp);
  check("html: img-src allows data URIs", /img-src [^;]*data:/.test(csp), csp);
  check("html: style-src allows plotly's injected styles", /style-src [^;]*'unsafe-inline'/.test(csp), csp);
  check("html: no remote host in the CSP", !/https?:\/\//.test(csp), csp);
  check("html: no unsafe-eval", csp.indexOf("unsafe-eval") === -1, csp);
  check("html: connect-src blocked", csp.indexOf("connect-src 'none'") !== -1, csp);

  check(
    "html: plotly loaded from the extension bundle",
    html.indexOf('<script nonce="NONCE123" src="https://abc.vscode-cdn.net/media/plotly.min.js">') !== -1
  );
  check("html: no cdn.plot.ly", html.indexOf("cdn.plot.ly") === -1);
  check("html: every script tag is nonced", (html.match(/<script/g) || []).length === (html.match(/<script nonce="NONCE123"/g) || []).length);
  check("html: prev/next/position toolbar", /id="prev"/.test(html) && /id="next"/.test(html) && /id="pos"/.test(html));
  check("html: export buttons", /id="exportPng"/.test(html) && /id="exportSvg"/.test(html));
  check("html: plotly backend button enabled", /data-backend="plotly"(?![^>]*disabled)/.test(html));
  check("html: GR backend button disabled by default with a tooltip", /data-backend="gr" disabled title="GR — unavailable"/.test(html));
  check("html: theme variables drive the chrome", html.indexOf("var(--vscode-editor-background)") !== -1);
  check("html: webview script resizes plotly", html.indexOf("Plotly.Plots.resize") !== -1);
  check("html: webview script exports via plotly", html.indexOf("Plotly.downloadImage") !== -1);

  // backendState()'s entries flow into the HTML — an enabled GR renders as a
  // live button, and tooltips (which carry findGr's reasons, quotes included)
  // are attribute-escaped.
  const enabledHtml = _p.panelHtml({
    cspSource: "vscode-webview://abc",
    plotlyUri: "u",
    nonce: "N",
    backends: [
      { id: "plotly", label: "plotly", enabled: true, tooltip: "plotly — interactive (active)" },
      { id: "gr", label: "GR", enabled: true, tooltip: 'GR — static render "quoted"' },
    ],
  });
  check("html: GR button enabled when backendState says so", /data-backend="gr"(?![^>]*disabled)/.test(enabledHtml));
  check("html: tooltips are attribute-escaped", enabledHtml.indexOf("&quot;quoted&quot;") !== -1);
}

// --- 3b. Backend availability + spec fallback ---------------------------------

function testBackendState() {
  _p.setDeps({});
  let s = _p.backendState().find((b) => b.id === "gr");
  check("backendState: unwired deps → disabled with reason", !s.enabled && /not wired/.test(s.tooltip), s);

  _p.setDeps({
    renderPlot: () => Promise.resolve(),
    findGr: () => ({ ok: false, reason: "no GR installation found — run `npm run fetch-vendor`" }),
  });
  s = _p.backendState().find((b) => b.id === "gr");
  check("backendState: resolver says no → disabled, reason surfaced", !s.enabled && /fetch-vendor/.test(s.tooltip), s);

  _p.setDeps({ renderPlot: () => Promise.resolve(), findGr: () => ({ ok: true, grdir: "C:/gr" }) });
  s = _p.backendState().find((b) => b.id === "gr");
  check("backendState: wired + resolved → enabled", s.enabled === true, s);
  check("backendState: plotly is never touched", _p.backendState()[0].enabled === true);
}

function testSpecFor() {
  const hist = _p.newHistory();
  const pf = Object.assign(plotlyFrame(), { encoding: "json" });
  const r = _p.appendFrame(hist, pf);
  check("specFor: falls back to the retained plotly figure", _p.specFor(r.entry) === pf.data, typeof _p.specFor(r.entry));

  const withSpec = Object.assign(plotlyFrame({ meta: { id: "s1", spec: { neutral: true } } }), { encoding: "json" });
  const r2 = _p.appendFrame(hist, withSpec);
  check("specFor: a frame-carried meta.spec wins", _p.specFor(r2.entry) && _p.specFor(r2.entry).neutral === true);

  const imgOnly = _p.appendFrame(hist, Object.assign(pngFrame(), { encoding: "base64" }));
  check("specFor: image-only entry has no spec", _p.specFor(imgOnly.entry) === null);
}

// --- 4. End-to-end through the real panel -------------------------------------

function testDemoEndToEnd() {
  const logs = [];
  const context = { subscriptions: [], extensionUri: mock.Uri.file("C:/repo") };
  plots.init(context, { output: { appendLine: (l) => logs.push(l) } });

  return mock.commands.executeCommand("blade.plotDemo").then(() => {
    const panels = mock.window._webviewPanels;
    check("demo: a panel was created", panels.length === 1, panels.length);
    const panel = panels[0];
    check("demo: docked beside the editor", panel.viewColumn === mock.ViewColumn.Beside, panel.viewColumn);
    check("demo: scripts enabled", panel.options.enableScripts === true);
    check("demo: context retained when hidden", panel.options.retainContextWhenHidden === true);
    check(
      "demo: media/ is the only local resource root",
      panel.options.localResourceRoots.length === 1 && /\/media$/.test(panel.options.localResourceRoots[0].path),
      panel.options.localResourceRoots.map((u) => u.path)
    );
    check("demo: html references the bundled plotly", /media\/plotly\.min\.js/.test(panel.webview.html));
    check("demo: revealed without stealing focus", panel._revealed.length >= 1 && panel._revealed[0].preserveFocus === true, panel._revealed);
    check("demo: nothing posted before the webview is ready", panel._posted.length === 0, panel._posted);

    panel.webview._send({ type: "ready" });
    check("demo: show posted once ready", panel._posted.length === 1, panel._posted.length);
    const shown = panel._posted[0];
    check("demo: show carries the plotly frame", shown.type === "show" && shown.frame.mime === display.PLOTLY_MIME, shown.type);
    check("demo: contour trace with a viridis colorscale", shown.frame.data.data[0].type === "contour" && shown.frame.data.data[0].colorscale === "Viridis");
    check("demo: axis titles carry units", shown.frame.data.layout.xaxis.title.text === "x [m]", shown.frame.data.layout.xaxis);
    check("demo: position indicator 1 of 1", shown.index === 0 && shown.total === 1, shown);
    check("demo: plotly is the active backend", shown.backend === "plotly", shown.backend);

    // A second frame arriving through the SAME routing path appends and fronts.
    display.ingestReplText(display.encodeReplLine(pngFrame({ meta: { title: "second" } })), "repl");
    const second = panel._posted[panel._posted.length - 1];
    check("demo: second frame appended and shown", second.index === 1 && second.total === 2, second);
    check("demo: second frame is the png", second.frame.mime === display.PNG_MIME, second.frame.mime);

    panel.webview._send({ type: "nav", delta: -1 });
    const back = panel._posted[panel._posted.length - 1];
    check("demo: prev navigates back", back.index === 0 && back.total === 2, back);
    check("demo: prev re-shows the original payload", back.frame.mime === display.PLOTLY_MIME, back.frame.mime);

    const before = panel._posted.length;
    panel.webview._send({ type: "backend", backend: "gr" });
    check("demo: the disabled GR backend is ignored", panel._posted.length === before, panel._posted.length);

    panel.webview._send({ type: "error", message: "plotly failed to render this frame: nope" });
    check("demo: webview errors reach the output channel", logs.some((l) => /plotly failed to render/.test(l)), logs.slice(-1));

    plots.dispose();
    check("demo: dispose closes the panel", panel._disposed === true);
  });
}

// --- 4b. The GR round-trip through the real panel ------------------------------

/** Drives the whole toggle path with a fake serve: plotly frame arrives → GR
 *  toggle → pending note over the plotly fallback → fake renderPlot resolves
 *  an image/png frame with the same meta.id → it merges into the entry and is
 *  shown → toggling is instant both ways afterwards. Then the failure path:
 *  the plotly render stays up and the error arrives as a note. */
async function testGrRoundTrip() {
  const calls = [];
  const grDeps = {
    output: { appendLine: () => {} },
    findGr: () => ({ ok: true, grdir: "C:/fake/gr", source: "test" }),
    renderPlot: (args) => {
      calls.push(args);
      return Promise.resolve({
        frame: { v: 1, mime: "image/png", encoding: "base64", data: PNG_B64, meta: { id: args.plotId, backend: "gr" } },
      });
    },
  };
  _p.setDeps(grDeps);

  const entriesBefore = _p.history.entries.length;
  display.ingestReplText(display.encodeReplLine(plotlyFrame({ meta: { id: "rt1" } })), "repl");
  const panels = mock.window._webviewPanels;
  const panel = panels[panels.length - 1];
  check("gr rt: a fresh panel exists after the earlier dispose", !!panel && panel._disposed !== true);
  check("gr rt: GR button enabled in this panel's HTML", /data-backend="gr"(?![^>]*disabled)/.test(panel.webview.html));

  panel.webview._send({ type: "ready" });
  panel.webview._send({ type: "backend", backend: "gr", width: 1001, height: 601 });
  const types = panel._posted.map((m) => m.type);
  check("gr rt: fallback show first, then the pending note", types.indexOf("pending") > types.indexOf("show"), types);
  check("gr rt: renderPlot got the plotly figure as the spec", calls.length === 1 && calls[0].spec.data[0].type === "contour", calls[0] && Object.keys(calls[0]));
  check("gr rt: plotId is the entry id", calls[0].plotId === "rt1", calls[0].plotId);
  check("gr rt: dimensions clamped to even", calls[0].width === 1000 && calls[0].height === 600, [calls[0].width, calls[0].height]);

  await new Promise((r) => setImmediate(r));
  const shownGr = panel._posted[panel._posted.length - 1];
  check(
    "gr rt: the GR render is shown on arrival",
    shownGr.type === "show" && shownGr.frame.mime === display.PNG_MIME && shownGr.backend === "gr",
    shownGr.type + "/" + (shownGr.frame && shownGr.frame.mime)
  );
  check("gr rt: merged — the history did not grow", _p.history.entries.length === entriesBefore + 1, _p.history.entries.length - entriesBefore);
  const entry = _p.history.entries.find((e) => e.id === "rt1");
  check("gr rt: both renders cached on the one entry", !!(entry && entry.renders.plotly && entry.renders.gr), entry && Object.keys(entry.renders));

  panel.webview._send({ type: "backend", backend: "plotly" });
  const back = panel._posted[panel._posted.length - 1];
  check("gr rt: toggle back shows the cached plotly render", back.type === "show" && back.frame.mime === display.PLOTLY_MIME, back.frame && back.frame.mime);

  panel.webview._send({ type: "backend", backend: "gr" });
  check("gr rt: second GR toggle uses the cache — no new request", calls.length === 1, calls.length);
  const again = panel._posted[panel._posted.length - 1];
  check("gr rt: cached GR render shown instantly", again.type === "show" && again.frame.mime === display.PNG_MIME, again.frame && again.frame.mime);

  // Failure path — a fresh plot whose render request rejects.
  _p.setDeps(
    Object.assign({}, grDeps, { renderPlot: () => Promise.reject(new Error("GR unavailable: GRDIR not set")) })
  );
  display.ingestReplText(display.encodeReplLine(plotlyFrame({ meta: { id: "rt2" } })), "repl");
  panel.webview._send({ type: "backend", backend: "gr", width: 800, height: 600 });
  await new Promise((r) => setImmediate(r));
  const lastNote = panel._posted.filter((m) => m.type === "note").pop();
  check("gr rt: failure surfaces as a note", !!lastNote && /GR render failed: GR unavailable/.test(lastNote.message), lastNote);
  const entry2 = _p.history.entries.find((e) => e.id === "rt2");
  check("gr rt: a failed render caches nothing", !!entry2 && !entry2.renders.gr, entry2 && Object.keys(entry2.renders));

  plots.dispose();
}

// --- 4c. SVG/PDF export through the GR worker ----------------------------------

async function testGrExport() {
  const calls = [];
  _p.setDeps({
    output: { appendLine: () => {} },
    findGr: () => ({ ok: true, grdir: "C:/fake/gr", source: "test" }),
    renderPlot: (args) => {
      calls.push(args);
      const mime = args.format === "pdf" ? "application/pdf" : "image/svg+xml";
      return Promise.resolve({
        frame: { v: 1, mime, encoding: "base64", data: Buffer.from("<svg/>").toString("base64"), meta: { id: args.plotId, backend: "gr" } },
      });
    },
  });

  display.ingestReplText(display.encodeReplLine(plotlyFrame({ meta: { id: "ex1", title: "waves & spume" } })), "repl");
  const panels = mock.window._webviewPanels;
  const panel = panels[panels.length - 1];
  panel.webview._send({ type: "ready" });

  const entriesBefore = _p.history.entries.length;
  panel.webview._send({ type: "export", format: "svg", width: 900, height: 700 });
  await new Promise((r) => setImmediate(r));
  const exported = panel._posted.filter((m) => m.type === "exportData").pop();
  check("gr export: bytes posted back", !!exported && exported.mime === "image/svg+xml", exported && exported.mime);
  check("gr export: filename from a sanitized title", !!exported && exported.filename === "waves_spume.svg", exported && exported.filename);
  check("gr export: format forwarded to renderPlot", calls.length === 1 && calls[0].format === "svg", calls[0] && calls[0].format);
  check("gr export: not cached in history", _p.history.entries.length === entriesBefore, _p.history.entries.length - entriesBefore);

  panel.webview._send({ type: "export", format: "pdf", width: 900, height: 700 });
  await new Promise((r) => setImmediate(r));
  const pdf = panel._posted.filter((m) => m.type === "exportData").pop();
  check("gr export: pdf round-trip", !!pdf && pdf.mime === "application/pdf" && /\.pdf$/.test(pdf.filename), pdf && pdf.filename);

  // A spec-less entry (image-only, no plotly sibling) cannot export.
  display.ingestReplText(display.encodeReplLine(pngFrame({ meta: { title: "raster only" } })), "repl");
  panel.webview._send({ type: "export", format: "svg", width: 900, height: 700 });
  await new Promise((r) => setImmediate(r));
  const noteMsg = panel._posted.filter((m) => m.type === "note" && m.message).pop();
  check("gr export: spec-less entry surfaces a note", !!noteMsg && /no spec retained/.test(noteMsg.message), noteMsg);

  plots.dispose();
}

// --- 5. Notebook cell outputs -------------------------------------------------

function testNotebookDisplayOutputs() {
  const outputs = nb._test.assembleOutputs({
    kept: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
    bindings: [],
    diagnostics: [],
    display: [plotlyFrame(), pngFrame(), { mime: "image/png" }],
  });
  check("notebook: one output per valid frame plus the error text", outputs.length === 3, outputs.length);
  check("notebook: rich item first", outputs[0].items[0].mime === display.PLOTLY_MIME, outputs[0].items[0].mime);
  check("notebook: text/plain fallback second", outputs[0].items[1].mime === "text/plain", outputs[0].items[1].mime);
  check(
    "notebook: plotly payload survives as JSON",
    JSON.parse(Buffer.from(outputs[0].items[0].data).toString("utf8")).data[0].type === "contour"
  );
  check(
    "notebook: png decoded to bytes",
    outputs[1].items[0].mime === display.PNG_MIME && Buffer.from(outputs[1].items[0].data).slice(1, 4).toString() === "PNG"
  );
  check(
    "notebook: malformed frame degrades to a text output",
    outputs[2].items[0].mime === "text/plain" && /"data" is missing/.test(Buffer.from(outputs[2].items[0].data).toString("utf8")),
    Buffer.from(outputs[2].items[0].data).toString("utf8")
  );
}

// --- 6. Session replay and cell attribution (docs/display-frames.md §10) -----
//
// A Blade session re-runs every accumulated snippet, so a LATER cell's eval
// response can carry an EARLIER cell's frame replayed under the same stable
// `meta.id`. assembleOutputs' second argument (`seenFrameIds`, a Set the
// CALLER — src/notebook.js's per-notebook session state — owns) is what
// tells a replay apart from a genuinely new frame.

function testAssembleOutputsSuppressesReplayedIds() {
  const seenFrameIds = new Set();
  const withId = plotlyFrame({ meta: { id: "S1" } });
  const noId = pngFrame(); // no meta.id at all

  const first = nb._test.assembleOutputs(
    { kept: true, exitCode: 0, stdout: "", stderr: "", bindings: [], diagnostics: [], display: [withId] },
    seenFrameIds
  );
  check("replay: first sighting of an id is attached", first.length === 1 && first[0].items[0].mime === display.PLOTLY_MIME, first);
  check("replay: the id is recorded as seen", seenFrameIds.has("S1"), Array.from(seenFrameIds));

  // A later cell's response replays the SAME id (the session re-ran the
  // earlier cell) alongside a brand-new, id-less frame.
  const second = nb._test.assembleOutputs(
    { kept: true, exitCode: 0, stdout: "", stderr: "", bindings: [], diagnostics: [], display: [withId, noId] },
    seenFrameIds
  );
  check("replay: the replayed id is suppressed from the later cell's output", second.length === 1, second.length);
  check(
    "replay: a frame with no meta.id is never suppressed",
    second[0].items[0].mime === display.PNG_MIME,
    second[0].items[0].mime
  );

  // No seenFrameIds Set at all (assembleOutputs called outside a live
  // session) disables suppression entirely rather than throwing.
  const noState = nb._test.assembleOutputs(
    { kept: true, exitCode: 0, stdout: "", stderr: "", bindings: [], diagnostics: [], display: [withId] },
    undefined
  );
  check("replay: without a seenFrameIds Set, nothing is suppressed", noState.length === 1, noState.length);
}

function testReplayedFrameStillRoutesToPanel() {
  // End-to-end through applyEvalResult, the real integration point: a
  // display.subscribe listener stands in for the Blade Plots panel, and a
  // mock NotebookCellExecution stands in for the notebook's own output
  // surface. Panel routing must stay unconditional even for a suppressed id.
  const seen = [];
  const sub = display.subscribe((f) => seen.push(f.meta && f.meta.id));

  const controller = mock.notebooks.createNotebookController("t-replay", "blade-notebook", "Test");
  const state = { keptSources: [], needsReplay: false, seenFrameIds: new Set() };
  const meta = { id: "S1" };

  const exec0 = controller.createNotebookCellExecution({ document: vscodeMock.makeDoc("plot(x)", "cell0.blade") });
  const resp0 = {
    kept: true,
    exitCode: 0,
    stdout: "",
    stderr: "",
    bindings: [],
    diagnostics: [],
    display: [plotlyFrame({ meta })],
  };

  return nb._test.applyEvalResult(exec0, resp0, "plot(x)", state).then(() => {
    check("replay-to-panel: first eval attaches the frame to its own cell", exec0._outputs.length === 1, exec0._outputs.length);
    check("replay-to-panel: first eval routes to the panel", seen.length === 1 && seen[0] === "S1", seen);

    // A later cell's eval re-runs the whole session; the response replays
    // cell0's frame under the SAME id, plus its own binding.
    const exec1 = controller.createNotebookCellExecution({ document: vscodeMock.makeDoc("y = 2", "cell1.blade") });
    const resp1 = {
      kept: true,
      exitCode: 0,
      stdout: "",
      stderr: "",
      bindings: [{ name: "y", type: "Int64", value: "2" }],
      diagnostics: [],
      display: [plotlyFrame({ meta })],
    };
    return nb._test.applyEvalResult(exec1, resp1, "y = 2", state).then(() => {
      check(
        "replay-to-panel: the replayed frame is NOT attached to the later cell's output",
        !exec1._outputs.some((o) => o.items.some((it) => it.mime === display.PLOTLY_MIME)),
        exec1._outputs
      );
      check(
        "replay-to-panel: the later cell's own binding output still shows",
        exec1._outputs.some((o) => o.items.some((it) => it.mime === "text/plain" && Buffer.from(it.data).toString("utf8") === "y = 2 : Int64")),
        exec1._outputs
      );
      check(
        "replay-to-panel: the replay is STILL routed to the panel",
        seen.length === 2 && seen[1] === "S1",
        seen
      );

      sub.dispose();
    });
  });
}

// --- Run ------------------------------------------------------------------------

(async () => {
  testValidPlotlyFrame();
  testValidPngFrame();
  testMalformedJsonDegradesToText();
  testValidationRejections();
  testOversizeRejected();
  testFramesFromEval();
  testDisplayEvents();
  testStreamScanner();
  testRoutingHub();

  testHistoryAppendAndNavigate();
  testHistoryAlternateRender();

  testPanelHtml();
  testBackendState();
  testSpecFor();
  testNotebookDisplayOutputs();
  testAssembleOutputsSuppressesReplayedIds();
  await testReplayedFrameStillRoutesToPanel();

  await testDemoEndToEnd();
  await testGrRoundTrip();
  await testGrExport();

  if (failures) {
    console.error(`\n${failures} plot check(s) failed.`);
    process.exit(1);
  }
  console.log("\nOK — display-frame parsing, plot history, and panel HTML contract hold.");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
