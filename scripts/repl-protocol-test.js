// Drives a REAL `blade repl` process through src/replProto.js — the same
// wire format and frame parsing src/repl.js uses — and asserts the
// interpreter-era contract: prompt framing, :paste submissions, typed value
// echoes, rebinding, error frames, :reset, and sub-second interpreter
// turnaround. Needs the compiler binary (BLADE_EXE env var, else the newest
// local build), so it is NOT part of the hermetic `npm test`; run it with
// `npm run test:repl` after compiler changes.

"use strict";

const cp = require("child_process");
const fs = require("fs");
const proto = require("../src/replProto");

function findExe() {
  if (process.env.BLADE_EXE) return process.env.BLADE_EXE;
  // Same candidates (and freshness rule) as findCompiler in src/extension.js.
  const candidates = [
    "C:\\Users\\cdupu\\Documents\\_blade-compiler\\bin\\Release\\net7.0\\Blade.exe",
    "C:\\Users\\cdupu\\Documents\\_blade-compiler\\bin\\Debug\\net7.0\\Blade.exe",
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
const proc = cp.spawn(exe, ["repl"], { windowsHide: true });
proc.stdout.setEncoding("utf8");
proc.stderr.setEncoding("utf8");

let stdoutBuf = "";
let stderrBuf = "";
let frameResolve = null;
proc.stdout.on("data", (chunk) => {
  stdoutBuf += chunk;
  if (frameResolve && proto.frameDone(stdoutBuf)) {
    const frame = proto.cleanFrame(stdoutBuf.slice(0, -proto.PROMPT.length));
    stdoutBuf = "";
    const r = frameResolve;
    frameResolve = null;
    // Same stderr grace the extension uses: give diagnostics on the other
    // pipe a beat to land before snapshotting them for this frame.
    setTimeout(() => {
      const err = stderrBuf;
      stderrBuf = "";
      r({ out: frame, err });
    }, 50);
  }
});
proc.stderr.on("data", (chunk) => (stderrBuf += chunk));
proc.on("error", (e) => {
  console.error(`spawn failed: ${e.message}`);
  process.exit(1);
});

function frame() {
  return new Promise((resolve) => (frameResolve = resolve));
}

async function submit(code, raw) {
  const done = frame();
  proc.stdin.write(raw ? code + "\n" : proto.wireFor(code));
  const t0 = Date.now();
  const f = await done;
  f.ms = Date.now() - t0;
  return f;
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
  console.error("FAIL global timeout (60s) — REPL hung");
  try {
    proc.kill();
  } catch {}
  process.exit(1);
}, 60000);

(async () => {
  const banner = await frame();
  check("banner frame", /Blade REPL/.test(banner.out), banner.out);

  const a = await submit("let a = 5");
  check("let echoes typed value", /a = Int64: 5/.test(a.out), JSON.stringify(a));
  check("let is not an error frame", !proto.isErrorFrame(a.out, a.err), a.err);
  check("let ran on the interpreter", !proto.fellBack(a.err), a.err);
  check(`let is fast (${a.ms} ms)`, a.ms < 5000, `${a.ms} ms`);

  const expr = await submit("a + 1");
  check("bare expression echoes", /Int64: 6/.test(expr.out), JSON.stringify(expr));
  check(
    "summarize(expr)",
    proto.summarize(expr.out, expr.err) === "Int64: 6",
    proto.summarize(expr.out, expr.err)
  );

  const multi = await submit("let b = 2\nlet c = a + b");
  check(
    "multi-line :paste echoes last binding",
    /c = Int64: 7/.test(multi.out),
    JSON.stringify(multi)
  );
  check(
    "continuation prompts stripped",
    !multi.out.includes(proto.CONT),
    JSON.stringify(multi.out)
  );

  const arr = await submit("let v = [1, 2, 3]");
  check("array echoes with tabbed type", /v = \[1, 2, 3\]/.test(arr.out), JSON.stringify(arr));
  check(
    "summarize joins value and type",
    /^v = \[1, 2, 3\] — Array/.test(proto.summarize(arr.out, arr.err)),
    proto.summarize(arr.out, arr.err)
  );

  const rebind = await submit("let a = 10");
  check("rebind recomputes", /a = Int64: 10/.test(rebind.out), JSON.stringify(rebind));

  const bad = await submit("let z = undefined_name_xyz");
  check("rejected snippet is an error frame", proto.isErrorFrame(bad.out, bad.err), JSON.stringify(bad));
  check(
    "error summary is a diagnostic line",
    proto.summarize(bad.out, bad.err).length > 0,
    proto.summarize(bad.out, bad.err)
  );

  const unbalanced = await submit("let w = [1,");
  check(
    "unbalanced brackets reject instead of hanging",
    proto.isErrorFrame(unbalanced.out, unbalanced.err),
    JSON.stringify(unbalanced)
  );

  const reset = await submit(":reset", true);
  check("reset acknowledges", /session cleared/.test(reset.out), JSON.stringify(reset));

  const gone = await submit("a");
  check("reset cleared the session", proto.isErrorFrame(gone.out, gone.err), JSON.stringify(gone));

  proc.stdin.write(":quit\n");
  const code = await new Promise((resolve) => proc.on("exit", resolve));
  check("clean exit on :quit", code === 0, `exit code ${code}`);

  clearTimeout(watchdog);
  if (failures) {
    console.error(`\n${failures} protocol check(s) failed.`);
    process.exit(1);
  }
  console.log("\nOK — repl protocol contract holds against the live compiler.");
})().catch((e) => {
  console.error(e);
  try {
    proc.kill();
  } catch {}
  process.exit(1);
});
