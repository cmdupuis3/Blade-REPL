// GR runtime resolution and preflight for the plot panel's static backend.
//
// The GR experiments (docs/gr-graphics-plan.md §7) showed that a misconfigured
// GR environment fails *silently and catastrophically*: no GRDIR is an access
// violation with zero output, DLLs missing from PATH is a silent spawn failure.
// So nothing in this extension may invoke GR-adjacent processes on faith —
// resolution validates the tree up front and the serve spawn gets a fully
// composed environment, never "whatever the shell had".
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
 * Compose the child-process environment for anything that will load GR,
 * layered over `baseEnv` (normally process.env, never mutated):
 *
 *   GRDIR       — the install root; GKS plugins and fonts resolve through it,
 *   PATH        — `<grdir>/bin` prepended (load-time DLL resolution on
 *                 Windows; harmless elsewhere), preserving the existing PATH
 *                 key's case ("Path" on Windows) so the child sees one PATH,
 *   GKS_WSTYPE  — "100" (the null workstation): without it GR's Windows
 *                 default is gksqt and a stray Qt process can spawn,
 *   GR_DISPLAY  — removed, same reason.
 */
function grEnv(grdir, baseEnv) {
  const base = baseEnv || process.env;
  const env = Object.assign({}, base);
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "PATH";
  const bin = path.join(grdir, "bin");
  env[pathKey] = env[pathKey] ? bin + path.delimiter + env[pathKey] : bin;
  env.GRDIR = grdir;
  env.GKS_WSTYPE = "100";
  delete env.GR_DISPLAY;
  return env;
}

module.exports = { resolveGr, validateRoot, requiredFiles, grEnv };
