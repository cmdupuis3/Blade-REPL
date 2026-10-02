// GR runtime resolution and preflight for the plot panel's static backend.
//
// The GR experiments (docs/gr-graphics-plan.md §7) showed that a misconfigured
// GR environment fails *silently and catastrophically*: no GRDIR is an access
// violation with zero output, DLLs missing from PATH is a silent spawn failure.
// So nothing in this extension may invoke GR-adjacent processes on faith —
// resolution validates the tree up front and the serve spawn is told where GR
// is (GRDIR) explicitly, never left with "whatever the shell had". The
// compiler composes its GR worker's environment from that; this module must
// not do it for the serve process itself (see grEnv for why).
//
// This module is pure data-in/data-out (no vscode import): the extension host
// passes the configured setting and the roots to probe; tests pass fakes.
// Resolution precedence mirrors blade.compilerPath's shape:
//
//   1. the `blade.grPath` setting — explicit wins, and an explicitly
//      configured-but-broken path is an error, not a fall-through (a user who
//      pointed at a tree wants to hear that it is missing cairoplugin.dll,
//      not have the extension quietly use a different GR),
//   2. `<workspaceRoot>/vendor/gr` (a Blade checkout opened as the workspace),
//   3. `<extensionRoot>/vendor/gr` (this repo run under F5 / installed dev
//      builds; populated by `npm run fetch-vendor`).

"use strict";

const path = require("path");
const fs = require("fs");

// Per-platform relative paths that must exist under a GR root for the headless
// render path to work. win32 mirrors the `keep` list in deps.json and is the
// verified set; the other platforms are best-effort until they are exercised
// (same policy as their null sha256 pins in deps.json) — presence of the
// shared library and fonts is the minimum any GR tree needs.
const REQUIRED = {
  win32: ["bin/libGR.dll", "bin/libGKS.dll", "bin/cairoplugin.dll", "fonts"],
  linux: ["lib/libGR.so", "fonts"],
  darwin: ["lib/libGR.dylib", "fonts"],
};

/** Which files a GR root must contain on `platform` (defaults to this one). */
function requiredFiles(platform) {
  return REQUIRED[platform || process.platform] || ["fonts"];
}

/** { ok: true } or { ok: false, missing: [relPath, ...] }. */
function validateRoot(root, opts) {
  const o = opts || {};
  const exists = o.exists || fs.existsSync;
  if (!root || !exists(root)) return { ok: false, missing: ["<root>"] };
  const missing = requiredFiles(o.platform).filter(
    (rel) => !exists(path.join(root, rel))
  );
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

/**
 * Resolve a usable GR installation root.
 *
 * opts: {
 *   configuredPath,   // the blade.grPath setting ("" when unset)
 *   workspaceRoot,    // fsPath of the first workspace folder, or undefined
 *   extensionRoot,    // context.extensionUri.fsPath
 *   platform, exists, // test seams
 * }
 *
 * Returns { ok: true, grdir, source } with source ∈ "setting" | "workspace" |
 * "extension", or { ok: false, reason } with a message ready for a tooltip.
 */
function resolveGr(opts) {
  const o = opts || {};
  const configured = (o.configuredPath || "").trim();

  if (configured) {
    const v = validateRoot(configured, o);
    if (v.ok) return { ok: true, grdir: configured, source: "setting" };
    return {
      ok: false,
      reason:
        `blade.grPath is set to "${configured}" but it is not a usable GR ` +
        `installation (missing: ${v.missing.join(", ")})`,
    };
  }

  const candidates = [
    { root: o.workspaceRoot && path.join(o.workspaceRoot, "vendor", "gr"), source: "workspace" },
    { root: o.extensionRoot && path.join(o.extensionRoot, "vendor", "gr"), source: "extension" },
  ];
  for (const c of candidates) {
    if (c.root && validateRoot(c.root, o).ok) {
      return { ok: true, grdir: c.root, source: c.source };
    }
  }
  return {
    ok: false,
    reason:
      "no GR installation found — run `npm run fetch-vendor` in the extension " +
      "checkout, or point blade.grPath at a GR root (a directory containing " +
      "bin/ and fonts/)",
  };
}

/**
 * Compose the environment of the `ide serve` child so the compiler can find
 * GR, layered over `baseEnv` (normally process.env, never mutated):
 *
 *   GRDIR       — the install root. This is the ONE thing the compiler needs
 *                 from us: its `renderPlot` reads it, validates `<GRDIR>/bin`,
 *                 and composes its GR worker's environment itself (GRDIR, the
 *                 bin dir on the WORKER's PATH, the null workstation),
 *   GKS_WSTYPE  — "100" (the null workstation): without it GR's Windows
 *                 default is gksqt and a stray Qt process can spawn,
 *   GR_DISPLAY  — removed, same reason.
 *
 * PATH IS DELIBERATELY LEFT ALONE. `<grdir>/bin` must NOT be put on the serve
 * process's PATH: a GR distribution bundles its own libstdc++-6.dll,
 * libgcc_s_seh-1.dll and libwinpthread-1.dll, and ahead of the toolchain's
 * they are what g++'s own executables load. g++ then exits 1 with no output —
 * so every cell that needed the compiled fallback lane (a provider write, an
 * interpreter-unsupported form) failed with "Compilation failed (exit 1) with
 * no output", on exactly the machines where plots worked. The worker gets
 * GR's bin dir from the compiler; the serve process, which never loads GR,
 * keeps the PATH it was given.
 */
function grEnv(grdir, baseEnv) {
  const base = baseEnv || process.env;
  const env = Object.assign({}, base);
  env.GRDIR = grdir;
  env.GKS_WSTYPE = "100";
  delete env.GR_DISPLAY;
  return env;
}

module.exports = { resolveGr, validateRoot, requiredFiles, grEnv };
