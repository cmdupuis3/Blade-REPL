// Drives a REAL `blade ide serve` process's "eval"/"resetSession"/"checkCells"
// commands DIRECTLY through src/serveProto.js (no notebook UI, no
// src/notebook.js involved) — modeled on scripts/serve-protocol-test.js, same
// BLADE_EXE / newest-mtime Debug-Release discovery, same hand-rolled check()/
// watchdog shape. This is the session-semantics contract from the plan's
// frozen protocol: let-binding eval with a typed value, bare-expression echo,
// rebind-in-place, resetSession, a rejected snippet leaving the session
// usable, isolation between two independently-named sessions, and the
// compiler-side cell assembly (`checkCells`) the extension's notebook
// checking rides on.
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

function checkCellsReq(tier, file, cells, timeoutMs) {
  const id = nextId++;
  return send(id, (i) => proto.encodeCheckCells(i, tier, file, cells), timeoutMs);
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

  // --- 3b. Rebind referencing a LATER binding (dependency-ordered splice) -----
  //
  // Split one cell into two after the fact: the session already holds
  // `pairs`, then `xloop` joins AFTER it, then `pairs` is rebound to
  // reference `xloop`. An in-place splice would put the use above the
  // definition in the flat session file ("Unbound variable: xloop" — the
  // demo.bladenb regression); the engine must place the rebind after its
  // last later dependency instead.
  const dep = "notebook-eval-test-session-dep";
  await evalReq(dep, "let base: Int64 = 2", undefined, EVAL_TIMEOUT_MS);
  await evalReq(dep, "let pairs: Int64 = base * 10", undefined, EVAL_TIMEOUT_MS);
  await evalReq(dep, "let xloop: Int64 = 7", undefined, EVAL_TIMEOUT_MS);
  const depRebind = await evalReq(dep, "let pairs: Int64 = xloop + 1", undefined, EVAL_TIMEOUT_MS);
  check(
    "rebind referencing a later binding: kept (moved after its dependency, not spliced in place)",
    depRebind.kept === true,
    JSON.stringify(depRebind).slice(0, 300)
  );
  const depEcho = await evalReq(dep, "pairs", undefined, EVAL_TIMEOUT_MS);
  check(
    "rebind referencing a later binding: pairs now reads the dependency (8)",
    depEcho.kept === true && (depEcho.bindings || [])[0] && (depEcho.bindings || [])[0].value === "8",
    JSON.stringify(depEcho).slice(0, 300)
  );

  // --- 3c. |> compute of an eager value still echoes ---------------------------
  //
  // `reduce(xs, (+))` is eager; piping it through `compute` is a no-op that
  // must NOT silence the echo (the demo.bladenb empty-value regression).
  const cmp = "notebook-eval-test-session-compute";
  await evalReq(cmp, "let xs = [1.0, 2.0, 3.0]", undefined, EVAL_TIMEOUT_MS);
  const cmpEcho = await evalReq(cmp, "reduce(xs, (+)) |> compute", undefined, EVAL_TIMEOUT_MS);
  const cmpBinding = (cmpEcho.bindings || [])[0];
  check(
    "reduce |> compute: kept with a bare-expression echo",
    cmpEcho.kept === true && !!cmpBinding && cmpBinding.name === "",
    JSON.stringify(cmpEcho).slice(0, 300)
  );
  check(
    "reduce |> compute: echoes the reduced value (6), not an empty string",
    !!cmpBinding && cmpBinding.value === "6" && cmpBinding.type === "Float64",
    cmpBinding
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

  // --- 7. Two-cell notebook check through `checkCells` (N3) -----------------
  //
  // The exact request src/notebook.js's runNotebookCheck sends: the ordered
  // code-cell sources in, one fast-tier check of the compiler's OWN assembled
  // session source back, plus a `windows` entry per cell saying where that
  // cell's text landed. Notebook checking has no fallback path anymore, so an
  // "unknown cmd" here is a FAILURE, not a skip. The remap-fan-out LOGIC
  // itself (windows -> per-cell payload) is covered hermetically, against
  // canned payloads, in scripts/notebook-test.js — this only needs to show
  // that the compiler's windows really do bracket the bindings it reports.
  const nbCells = ["let helper: Int64 = 41", "let answer: Int64 = helper + 1"];
  // Any directory that exists is enough — a check with no data-provider reads
  // never touches the file itself, "file" only anchors the per-request chdir.
  const checkFile = path.join(__dirname, "..", "samples", "demo.blade");
  const cellsResp = (await checkCellsReq("fast", checkFile, nbCells, EVAL_TIMEOUT_MS)) || {};
  check(
    "checkCells is supported (notebook checking requires it — no fallback)",
    cellsResp.error === undefined,
    JSON.stringify(cellsResp).slice(0, 300)
  );
  check("checkCells echoes tier \"fast\"", cellsResp.tier === "fast", JSON.stringify(cellsResp).slice(0, 300));
  check(
    "checkCells has no diagnostics (cell 1 resolves cell 0's binding)",
    (cellsResp.diagnostics || []).length === 0,
    JSON.stringify(cellsResp.diagnostics)
  );
  const cellWindows = cellsResp.windows || [];
  check("checkCells returns one window per input cell", cellWindows.length === nbCells.length, JSON.stringify(cellWindows));
  const helperBinding = (cellsResp.bindings || []).find((b) => b.name === "helper");
  const answerBinding = (cellsResp.bindings || []).find((b) => b.name === "answer");
  check("checkCells returns a binding for cell 0's 'helper'", !!helperBinding, JSON.stringify(cellsResp.bindings));
  check("checkCells returns a binding for cell 1's 'answer'", !!answerBinding, JSON.stringify(cellsResp.bindings));
  check(
    "helper's reported line falls inside cell 0's window",
    !!helperBinding && !!cellWindows[0] && helperBinding.line >= cellWindows[0].startLine && helperBinding.line <= cellWindows[0].endLine,
    { helperBinding, window: cellWindows[0] }
  );
  check(
    "answer's reported line falls inside cell 1's window",
    !!answerBinding && !!cellWindows[1] && answerBinding.line >= cellWindows[1].startLine && answerBinding.line <= cellWindows[1].endLine,
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
