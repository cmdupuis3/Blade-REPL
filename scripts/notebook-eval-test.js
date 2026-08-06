// Drives a REAL `blade ide serve` process's "eval"/"resetSession" commands
// DIRECTLY through src/serveProto.js (no notebook UI, no src/notebook.js
// involved) — modeled on scripts/serve-protocol-test.js, same BLADE_EXE /
// newest-mtime Debug-Release discovery, same hand-rolled check()/watchdog
// shape. This is the session-semantics contract from the plan's frozen
// protocol: let-binding eval with a typed value, bare-expression echo,
// rebind-in-place, resetSession, a rejected snippet leaving the session
// usable, and isolation between two independently-named sessions.
//
// The compiler-side `eval` command was being built CONCURRENTLY with this
// extension-side work, against the SAME frozen protocol spec. A compiler
// that doesn't understand "eval" yet answers with the generic
// {"id","error":"..."} shape (unknown cmd) instead of rejecting the
// connection — that, or the subcommand/binary not existing at all, is an
// expected SKIP (exit 0), not a failure. Needs the compiler binary
// (BLADE_EXE env var, else the newest local Release/Debug build), so this is
// NOT part of the hermetic `npm test`; run it with `npm run test:nb`.

"use strict";

const cp = require("child_process");
const fs = require("fs");
const path = require("path");
const proto = require("../src/serveProto");
// sessionSource is pure (no vscode APIs at runtime) but notebook.js still
// unconditionally `require("vscode")`s at module load — install the mock
// purely so that require succeeds, exactly like scripts/notebook-test.js
// does for the same reason. Nothing below touches any vscode-mock object.
require("./vscode-mock").install();
const nbSessionSource = require("../src/notebook")._test.sessionSource;

function findExe() {
  if (process.env.BLADE_EXE) return process.env.BLADE_EXE;
  // Same candidates (and freshness rule) as findExe in scripts/serve-protocol-test.js
  // and findCompiler in src/extension.js.
  const candidates = [
    "C:\\Users\\cdupu\\Documents\\GitHub\\Blade\\bin\\Release\\net7.0\\Blade.exe",
    "C:\\Users\\cdupu\\Documents\\GitHub\\Blade\\bin\\Debug\\net7.0\\Blade.exe",
  ];
  let best;
  for (const c of candidates) {
    try {
      const mtime = fs.statSync(c).mtimeMs;
      if (!best || mtime > best.mtime) best = { path: c, mtime };
    } catch {
      /* candidate doesn't exist */
    }
  }
  if (!best) {
    console.error("no compiler binary found — set BLADE_EXE");
    process.exit(1);
  }
  return best.path;
}

const exe = findExe();
console.log(`compiler: ${exe}`);
const proc = cp.spawn(exe, ["ide", "serve"], { windowsHide: true });
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

function evalReq(session, source, cwd, timeoutMs) {
  const id = nextId++;
  return send(id, (i) => proto.encodeEval(i, session, source, cwd), timeoutMs);
}

function resetReq(session, timeoutMs) {
  const id = nextId++;
  return send(id, (i) => proto.encodeResetSession(i, session), timeoutMs);
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
  console.log(`SKIP — 'ide serve' eval unavailable (${reason}); expected until the compiler-side work lands.`);
  clearTimeout(watchdog);
  try {
    proc.kill();
  } catch {}
  process.exit(0);
}

const EVAL_TIMEOUT_MS = 30000;

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
  console.log(`ok   ping (serve=${pong.serve}, version=${pong.version})`);

  // First eval call doubles as the "does this compiler support eval at all"
  // probe: an old compiler answers with the generic {"error":...} shape.
  const probe = await evalReq("probe-session", "let probe_x: Int64 = 1", undefined, EVAL_TIMEOUT_MS);
  if (probe && probe.error !== undefined) {
    return skip(`eval answered with a protocol error (old compiler): ${probe.error}`);
  }
  check("eval echoes id", typeof probe.id === "number", JSON.stringify(probe).slice(0, 300));
  check("eval sets kept:true for a well-typed let", probe.kept === true, JSON.stringify(probe).slice(0, 300));
  check(
    "eval reports the interpreter lane (no g++ needed for a plain let)",
    probe.lane === "interp",
    JSON.stringify(probe).slice(0, 300)
  );

  // --- 1. Let-binding eval with a typed value ---------------------------------

  const sess = "notebook-eval-test-session";
  const r1 = await evalReq(sess, "let x: Int64 = 41", undefined, EVAL_TIMEOUT_MS);
  check("let-binding: kept", r1.kept === true, JSON.stringify(r1).slice(0, 300));
  const xBinding = (r1.bindings || []).find((b) => b.name === "x");
  check("let-binding: bindings[] carries x", !!xBinding, JSON.stringify(r1.bindings));
  check("let-binding: x's type is Int64", xBinding && xBinding.type === "Int64", xBinding);
  check("let-binding: x's value is 41", xBinding && xBinding.value === "41", xBinding);

  // --- 2. Bare expression echo (name:"") --------------------------------------

  const r2 = await evalReq(sess, "x + 1", undefined, EVAL_TIMEOUT_MS);
  check("bare expr: kept", r2.kept === true, JSON.stringify(r2).slice(0, 300));
  check("bare expr: exactly one binding", (r2.bindings || []).length === 1, r2.bindings);
  const echo = (r2.bindings || [])[0];
  check("bare expr: echo binding has name \"\"", echo && echo.name === "", echo);
  check("bare expr: echo value is 42", echo && echo.value === "42", echo);

  // --- 3. Rebind-in-place ------------------------------------------------------

  const r3 = await evalReq(sess, "let x: Int64 = 100", undefined, EVAL_TIMEOUT_MS);
  check("rebind: kept", r3.kept === true, JSON.stringify(r3).slice(0, 300));
  const r4 = await evalReq(sess, "x", undefined, EVAL_TIMEOUT_MS);
  const rebindEcho = (r4.bindings || [])[0];
  check(
    "rebind-in-place: re-evaluating x sees the REBOUND value (100), not the original (41)",
    rebindEcho && rebindEcho.value === "100",
    rebindEcho
  );

  // --- 4. Rejected snippet leaves the session usable --------------------------

  const r5 = await evalReq(sess, 'let y: Int64 = "not a number"', undefined, EVAL_TIMEOUT_MS);
  check("rejected snippet: kept:false", r5.kept === false, JSON.stringify(r5).slice(0, 300));
  check(
    "rejected snippet: nonempty diagnostics",
    Array.isArray(r5.diagnostics) && r5.diagnostics.length > 0,
    JSON.stringify(r5).slice(0, 300)
  );
  check("process survives a rejected snippet", exited === null, `exited with code ${exited}`);
  const r6 = await evalReq(sess, "x", undefined, EVAL_TIMEOUT_MS);
  check(
    "session still usable after a rejection: x is still bound (100), y never got in",
    r6.kept === true && (r6.bindings || [])[0] && (r6.bindings || [])[0].value === "100",
    JSON.stringify(r6).slice(0, 300)
  );

  // --- 5. resetSession ----------------------------------------------------------

  const reset = await resetReq(sess, 10000);
  check("resetSession acknowledges", reset && reset.ok === true, JSON.stringify(reset));
  const r7 = await evalReq(sess, "x", undefined, EVAL_TIMEOUT_MS);
  check(
    "after resetSession, x is no longer bound (session forgot everything)",
    r7.kept === false,
    JSON.stringify(r7).slice(0, 300)
  );

  // --- 6. Session isolation between two independently-named sessions ---------

  const sessA = "notebook-eval-test-session-A";
  const sessB = "notebook-eval-test-session-B";
  await evalReq(sessA, "let iso: Int64 = 1", undefined, EVAL_TIMEOUT_MS);
  await evalReq(sessB, "let iso: Int64 = 2", undefined, EVAL_TIMEOUT_MS);
  const isoA = await evalReq(sessA, "iso", undefined, EVAL_TIMEOUT_MS);
  const isoB = await evalReq(sessB, "iso", undefined, EVAL_TIMEOUT_MS);
  check(
    "session isolation: session A's iso is 1, unaffected by session B",
    isoA.kept === true && (isoA.bindings || [])[0] && (isoA.bindings || [])[0].value === "1",
    JSON.stringify(isoA).slice(0, 300)
  );
  check(
    "session isolation: session B's iso is 2, unaffected by session A",
    isoB.kept === true && (isoB.bindings || [])[0] && (isoB.bindings || [])[0].value === "2",
    JSON.stringify(isoB).slice(0, 300)
  );

  // --- 7. Two-cell session source through serve.check's fast tier (N3) ------
  //
  // Proves the CONCATENATION path (src/notebook.js's sessionSource) against
  // the real compiler: two "cells" joined into one source, checked with a
  // single fast-tier `check` request (exactly what runNotebookCheck sends),
  // and both cells' bindings coming back at the line each cell's own window
  // says it should. The remap-fan-out LOGIC itself (windows -> per-cell
  // payload) is covered hermetically, against canned payloads, in
  // scripts/notebook-test.js — this only needs to show the compiler agrees
  // with sessionSource's own line bookkeeping.
  const nbCells = [
    { kind: "code", text: "let helper: Int64 = 41" },
    { kind: "code", text: "let answer: Int64 = helper + 1" },
  ];
  const { source: sessionSrc, windows: cellWindows } = nbSessionSource(nbCells);
  // Any directory that exists is enough — a plain check with no data-provider
  // reads never touches the file itself, "file" only anchors the per-request chdir.
  const checkFile = path.join(__dirname, "..", "samples", "demo.blade");
  const checkResp = await checkReq("fast", checkFile, sessionSrc, EVAL_TIMEOUT_MS);
  check("session-source check echoes tier \"fast\"", checkResp.tier === "fast", JSON.stringify(checkResp).slice(0, 300));
  check(
    "session-source check has no diagnostics (cell 1 resolves cell 0's binding)",
    (checkResp.diagnostics || []).length === 0,
    JSON.stringify(checkResp.diagnostics)
  );
  const helperBinding = (checkResp.bindings || []).find((b) => b.name === "helper");
  const answerBinding = (checkResp.bindings || []).find((b) => b.name === "answer");
  check("concatenated check returns a binding for cell 0's 'helper'", !!helperBinding, JSON.stringify(checkResp.bindings));
  check("concatenated check returns a binding for cell 1's 'answer'", !!answerBinding, JSON.stringify(checkResp.bindings));
  check(
    "helper's reported line falls inside cell 0's sessionSource window",
    !!helperBinding && helperBinding.line >= cellWindows[0].startLine && helperBinding.line <= cellWindows[0].endLine,
    { helperBinding, window: cellWindows[0] }
  );
  check(
    "answer's reported line falls inside cell 1's sessionSource window",
    !!answerBinding && answerBinding.line >= cellWindows[1].startLine && answerBinding.line <= cellWindows[1].endLine,
    { answerBinding, window: cellWindows[1] }
  );

  // Clean shutdown.
  proc.stdin.write(proto.encodeShutdown());
  const code = await onExit();
  check("clean exit on shutdown", code === 0, `exit code ${code}`);

  clearTimeout(watchdog);
  if (failures) {
    console.error(`\n${failures} notebook-eval check(s) failed.`);
    process.exit(1);
  }
  console.log("\nOK — notebook eval session semantics hold against the live compiler.");
})().catch((e) => {
  clearTimeout(watchdog);
  console.error(e);
  try {
    proc.kill();
  } catch {}
  process.exit(1);
});
