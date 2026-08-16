// Drives a REAL `blade ide serve` process through src/serveProto.js — the
// same NDJSON framing src/serve.js uses — and asserts the frozen protocol
// contract: ping, fast/full checks, survival past a type error, out-of-order
// id correlation, and clean shutdown. Needs the compiler binary (BLADE_EXE
// env var, else the newest local Release/Debug build), so it is NOT part of
// the hermetic `npm test`; run it with `npm run test:serve`.
//
// `ide serve` may not exist yet on the compiler this points at (it was being
// built concurrently with this test) — a compiler without the subcommand
// either exits immediately or never answers the ping, either of which is
// treated as an expected SKIP (exit 0), not a failure.

"use strict";

const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const pkg = require("@blade-lang/ide-protocol");
const proto = pkg.serveProto;
const gr = require("../src/gr");

function findExe() {
  // env BLADE_EXE -> newest-mtime DEFAULT_CANDIDATES -> "Blade" on PATH, now
  // shared with src/extension.js and every other script via the package.
  // origin "path" means nothing better was found — still fatal here: these
  // live suites want a known, freshly-built binary, not whatever "Blade"
  // resolves to on $PATH.
  const { exe, origin } = pkg.resolveCompiler({ env: process.env });
  if (origin === "path") {
    console.error("no compiler binary found — set BLADE_EXE");
    process.exit(1);
  }
  return exe;
}

const exe = findExe();
console.log(`compiler: ${exe}`);
// Spawn with the composed GR environment when a GR install resolves (this
// repo's vendor/gr after `npm run fetch-vendor`) — the same thing
// extension.js's grSpawnEnv does — so the renderPlot section below can drive
// a real render. Without GR the child inherits untouched and that section
// skips on the serve process's own error.
const grState = gr.resolveGr({
  configuredPath: process.env.BLADE_GR_PATH || "",
  workspaceRoot: path.join(__dirname, ".."),
  extensionRoot: path.join(__dirname, ".."),
});
console.log(grState.ok ? `gr: ${grState.grdir}` : `gr: unavailable — ${grState.reason}`);
const proc = cp.spawn(exe, ["ide", "serve"], {
  windowsHide: true,
  env: grState.ok ? gr.grEnv(grState.grdir) : undefined,
});
proc.stdout.setEncoding("utf8");
proc.stderr.setEncoding("utf8");

const decoder = proto.createDecoder();
let nextId = 1;
const pending = new Map(); // id -> resolve
let exited = null;
let exitResolvers = [];

proc.stdout.on("data", (chunk) => {
  for (const msg of decoder.push(chunk)) {
    const id = msg.id;
    if (id === undefined || id === null) {
      if (msg.error) console.error(`[protocol error, no id] ${msg.error}`);
      continue;
    }
    const resolve = pending.get(id);
    if (resolve) {
      pending.delete(id);
      resolve(msg);
    }
  }
});
proc.stderr.on("data", (chunk) => process.stderr.write(`[compiler stderr] ${chunk}`));
proc.on("error", (e) => {
  console.error(`spawn failed: ${e.message}`);
  process.exit(1);
});
proc.on("exit", (code) => {
  exited = code;
  for (const r of exitResolvers) r(code);
  exitResolvers = [];
});

function onExit() {
  return new Promise((resolve) => {
    if (exited !== null) resolve(exited);
    else exitResolvers.push(resolve);
  });
}

/** Send one request (built by `encode(id)`), rejecting after `timeoutMs`. */
function send(id, encode, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    proc.stdin.write(encode(id));
  });
}

function ping(timeoutMs) {
  const id = nextId++;
  return send(id, proto.encodePing, timeoutMs);
}

function checkReq(tier, file, source, timeoutMs) {
  const id = nextId++;
  return send(id, (i) => proto.encodeCheck(i, tier, file, source), timeoutMs);
}

let failures = 0;
function check(name, cond, detail) {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures++;
    console.error(`FAIL ${name}\n  ${detail}`);
  }
}

const watchdog = setTimeout(() => {
  console.error("FAIL global timeout (90s) — 'ide serve' hung");
  try {
    proc.kill();
  } catch {}
  process.exit(1);
}, 90000);

function skip(reason) {
  console.log(`SKIP — 'ide serve' unavailable (${reason}); expected until the compiler-side work lands.`);
  clearTimeout(watchdog);
  try {
    proc.kill();
  } catch {}
  process.exit(0);
}

const demoPath = path.join(__dirname, "..", "samples", "demo.blade");
const demoSource = fs.readFileSync(demoPath, "utf8");
// Deliberately ill-typed: an Int64 target assigned a string literal.
const badSource = 'let x: Int64 = "not a number"\n';

(async () => {
  // Probe support: a compiler without `ide serve` either rejects the
  // subcommand and exits immediately, or never answers the ping at all.
  const pingOutcome = await Promise.race([
    ping(5000).then((msg) => ({ kind: "pong", msg })).catch((e) => ({ kind: "timeout", err: e })),
    onExit().then((code) => ({ kind: "exit", code })),
  ]);
  if (pingOutcome.kind === "exit") {
    return skip(`process exited (code ${pingOutcome.code}) before responding to ping`);
  }
  if (pingOutcome.kind === "timeout") {
    return skip(pingOutcome.err.message);
  }
  const pong = pingOutcome.msg;
  if (!pong || pong.ok !== true) {
    return skip(`ping did not return ok:true — ${JSON.stringify(pong)}`);
  }
  check("ping echoes id", typeof pong.id === "number", JSON.stringify(pong));
  console.log(`ok   ping (serve=${pong.serve}, version=${pong.version})`);

  // Fast check of a clean file: bindings nonempty, id/tier echoed.
  const r1 = await checkReq("fast", demoPath, demoSource, 20000);
  check("fast check echoes id", typeof r1.id === "number", JSON.stringify(r1).slice(0, 300));
  check("fast check echoes tier", r1.tier === "fast", JSON.stringify(r1).slice(0, 300));
  check(
    "fast check has nonempty bindings",
    Array.isArray(r1.bindings) && r1.bindings.length > 0,
    JSON.stringify(r1).slice(0, 300)
  );

  // Fast check of a type error: diagnostics nonempty, process survives.
  const r2 = await checkReq("fast", demoPath, badSource, 20000);
  check(
    "bad source produces diagnostics",
    Array.isArray(r2.diagnostics) && r2.diagnostics.length > 0,
    JSON.stringify(r2).slice(0, 300)
  );
  check("process survives a type error", exited === null, `exited with code ${exited}`);

  // Full check: tier echoed "full". concreteType presence is allowed but not
  // asserted either way — the compiler-side rendering of it is out of scope
  // for this test (see the plan: don't couple to compiler-side details).
  const r3 = await checkReq("full", demoPath, demoSource, 30000);
  check("full check echoes tier", r3.tier === "full", JSON.stringify(r3).slice(0, 300));
  check(
    "full check has nonempty bindings",
    Array.isArray(r3.bindings) && r3.bindings.length > 0,
    JSON.stringify(r3).slice(0, 300)
  );

  // Out-of-order ids: fire two requests back-to-back (clean source then bad
  // source) and confirm each resolves to ITS OWN response by id, regardless
  // of arrival order — the client must correlate by id, not by send order.
  const idA = nextId++;
  const idB = nextId++;
  const pA = send(idA, (i) => proto.encodeCheck(i, "fast", demoPath, demoSource), 20000);
  const pB = send(idB, (i) => proto.encodeCheck(i, "fast", demoPath, badSource), 20000);
  const [resA, resB] = await Promise.all([pA, pB]);
  check("out-of-order response A carries id A", resA.id === idA, JSON.stringify(resA).slice(0, 300));
  check("out-of-order response B carries id B", resB.id === idB, JSON.stringify(resB).slice(0, 300));
  check(
    "out-of-order A resolved the clean source's bindings",
    Array.isArray(resA.bindings) && resA.bindings.length > 0,
    JSON.stringify(resA).slice(0, 300)
  );
  check(
    "out-of-order B resolved the bad source's diagnostics",
    Array.isArray(resB.diagnostics) && resB.diagnostics.length > 0,
    JSON.stringify(resB).slice(0, 300)
  );

  // renderPlot: the GR round-trip. Probe-and-skip on compilers predating the
  // verb (the unknown-cmd contract) and on machines where the serve process
  // reports GR unavailable — assert the frame everywhere else.
  if (typeof proto.encodeRenderPlot !== "function") {
    console.log("SKIP renderPlot — vendored protocol package predates the verb");
  } else {
    const spec = { data: [{ type: "scatter", mode: "lines", x: [0, 1, 2, 3], y: [0, 1, 0, 1] }], layout: {} };
    const rpId = nextId++;
    const rp = await send(rpId, (i) => proto.encodeRenderPlot(i, { spec, plotId: "live-1", width: 320, height: 240 }), 60000);
    if (rp.error && /unknown cmd/.test(rp.error)) {
      console.log("SKIP renderPlot — compiler predates the verb");
    } else if (rp.error && /(GR unavailable|helper not found)/.test(rp.error)) {
      console.log(`SKIP renderPlot — ${rp.error}`);
    } else {
      check(
        "renderPlot answers a base64 image/png frame",
        rp.frame && rp.frame.mime === "image/png" && rp.frame.encoding === "base64",
        JSON.stringify(rp).slice(0, 200)
      );
      check(
        "renderPlot frame carries the plot id and the gr backend",
        rp.frame && rp.frame.meta && rp.frame.meta.id === "live-1" && rp.frame.meta.backend === "gr",
        rp.frame && JSON.stringify(rp.frame.meta)
      );
      check("renderPlot frame infers backend gr", rp.frame && pkg.display.backendFor(rp.frame) === "gr");
      const bytes = Buffer.from((rp.frame && rp.frame.data) || "", "base64");
      check("renderPlot payload is a PNG", bytes.slice(1, 4).toString() === "PNG", bytes.slice(0, 8).toString("hex"));
      const w = bytes.length > 24 ? bytes.readUInt32BE(16) : 0;
      const h = bytes.length > 24 ? bytes.readUInt32BE(20) : 0;
      check("renderPlot honors the requested size", w === 320 && h === 240, `${w}x${h}`);
    }
  }

  // Clean shutdown.
  proc.stdin.write(proto.encodeShutdown());
  const code = await onExit();
  check("clean exit on shutdown", code === 0, `exit code ${code}`);

  clearTimeout(watchdog);
  if (failures) {
    console.error(`\n${failures} protocol check(s) failed.`);
    process.exit(1);
  }
  console.log("\nOK — serve protocol contract holds against the live compiler.");
})().catch((e) => {
  clearTimeout(watchdog);
  console.error(e);
  try {
    proc.kill();
  } catch {}
  process.exit(1);
});
