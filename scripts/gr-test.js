// Hermetic tests for src/gr.js — GR root resolution precedence, the
// explicit-setting-never-falls-through rule, and grEnv's environment
// composition. No real GR tree, no VS Code host: the filesystem is a Set of
// paths behind the `exists` seam.
//
// Added to `npm test` (see package.json) right after plots-test.js.

"use strict";

const path = require("path");
const gr = require("../src/gr");

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

// A fake win32 filesystem: a valid GR tree is its root plus every REQUIRED
// path under it. Paths are joined with the host separator (src/gr.js uses
// path.join), so build the set the same way.
function fakeTree(root) {
  const s = new Set([root]);
  for (const rel of gr.requiredFiles("win32")) {
    s.add(path.join(root, ...rel.split("/")));
  }
  return s;
}
function existsIn(...sets) {
  return (p) => sets.some((s) => s.has(p));
}

const WS = path.join("C:", "proj");
const EXT = path.join("C:", "ext");
const CUSTOM = path.join("D:", "gr-custom");
const wsGr = path.join(WS, "vendor", "gr");
const extGr = path.join(EXT, "vendor", "gr");

// --- 1. Resolution precedence ------------------------------------------------

{
  const r = gr.resolveGr({
    configuredPath: CUSTOM,
    workspaceRoot: WS,
    extensionRoot: EXT,
    platform: "win32",
    exists: existsIn(fakeTree(CUSTOM), fakeTree(wsGr), fakeTree(extGr)),
  });
  check("setting wins over both fallbacks", r.ok && r.grdir === CUSTOM && r.source === "setting", r);
}

{
  const r = gr.resolveGr({
    configuredPath: "",
    workspaceRoot: WS,
    extensionRoot: EXT,
    platform: "win32",
    exists: existsIn(fakeTree(wsGr), fakeTree(extGr)),
  });
  check("workspace vendor/gr beats extension vendor/gr", r.ok && r.grdir === wsGr && r.source === "workspace", r);
}

{
  const r = gr.resolveGr({
    configuredPath: "",
    workspaceRoot: WS,
    extensionRoot: EXT,
    platform: "win32",
    exists: existsIn(fakeTree(extGr)),
  });
  check("extension vendor/gr is the last fallback", r.ok && r.grdir === extGr && r.source === "extension", r);
}

{
  const r = gr.resolveGr({
    configuredPath: "",
    workspaceRoot: undefined,
    extensionRoot: EXT,
    platform: "win32",
    exists: existsIn(fakeTree(extGr)),
  });
  check("no workspace folder is fine", r.ok && r.grdir === extGr, r);
}

// --- 2. Broken trees ---------------------------------------------------------

{
  // Everything but cairoplugin.dll — the render plugin a naive "is libGR
  // there" check would miss.
  const partial = fakeTree(wsGr);
  partial.delete(path.join(wsGr, "bin", "cairoplugin.dll"));
  const r = gr.resolveGr({
    configuredPath: "",
    workspaceRoot: WS,
    extensionRoot: EXT,
    platform: "win32",
    exists: existsIn(partial, fakeTree(extGr)),
  });
  check("incomplete workspace tree falls through to extension", r.ok && r.grdir === extGr, r);
}

{
  const r = gr.resolveGr({
    configuredPath: CUSTOM,
    workspaceRoot: WS,
    extensionRoot: EXT,
    platform: "win32",
    // CUSTOM root exists but is empty; both fallbacks are fully valid.
    exists: existsIn(new Set([CUSTOM]), fakeTree(wsGr), fakeTree(extGr)),
  });
  check("broken explicit setting errors instead of falling through", !r.ok, r);
  check(
    "…and the error names the setting and what is missing",
    !r.ok && /blade\.grPath/.test(r.reason) && /libGR\.dll/.test(r.reason),
    r.reason
  );
}

{
  const r = gr.resolveGr({
    configuredPath: "",
    workspaceRoot: WS,
    extensionRoot: EXT,
    platform: "win32",
    exists: () => false,
  });
  check("nothing found: not ok", !r.ok, r);
  check("…and the reason points at fetch-vendor", !r.ok && /fetch-vendor/.test(r.reason), r.reason);
}

// --- 3. validateRoot ---------------------------------------------------------

{
  const v = gr.validateRoot(wsGr, { platform: "win32", exists: existsIn(fakeTree(wsGr)) });
  check("validateRoot: complete tree ok", v.ok, v);
  const miss = fakeTree(wsGr);
  miss.delete(path.join(wsGr, "fonts"));
  const v2 = gr.validateRoot(wsGr, { platform: "win32", exists: existsIn(miss) });
  check("validateRoot: reports the missing path", !v2.ok && v2.missing.join() === "fonts", v2);
  const v3 = gr.validateRoot(path.join("C:", "nope"), { platform: "win32", exists: () => false });
  check("validateRoot: absent root", !v3.ok && v3.missing.join() === "<root>", v3);
}

// --- 4. grEnv ----------------------------------------------------------------

{
  // Windows-style base env: PATH key is "Path", and a stray GR_DISPLAY.
  const base = { Path: "C:\\Windows\\System32", GR_DISPLAY: "localhost:8002", HOME: "C:\\me" };
  const env = gr.grEnv(CUSTOM, base);
  const bin = path.join(CUSTOM, "bin");
  check("grEnv: GRDIR set", env.GRDIR === CUSTOM, env.GRDIR);
  check("grEnv: bin prepended on the existing Path key", env.Path === bin + path.delimiter + "C:\\Windows\\System32", env.Path);
  check("grEnv: no duplicate PATH key introduced", !("PATH" in env), Object.keys(env));
  check("grEnv: null workstation pinned", env.GKS_WSTYPE === "100", env.GKS_WSTYPE);
  check("grEnv: GR_DISPLAY removed", !("GR_DISPLAY" in env), env.GR_DISPLAY);
  check("grEnv: unrelated vars survive", env.HOME === "C:\\me", env.HOME);
  check("grEnv: base env not mutated", base.GR_DISPLAY === "localhost:8002" && base.Path === "C:\\Windows\\System32", base);
}

{
  const env = gr.grEnv(CUSTOM, { NOPATH: "1" });
  check("grEnv: PATH created when base has none", env.PATH === path.join(CUSTOM, "bin"), env.PATH);
}

// -----------------------------------------------------------------------------

if (failures) {
  console.error(`\n${failures} gr check(s) failed.`);
  process.exit(1);
}
console.log("\nOK — GR resolution precedence, preflight, and env composition hold.");
