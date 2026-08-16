// Persistent `blade ide serve` client — thin VS Code adapter over the shared
// @blade-lang/ide-protocol package. All protocol framing (NDJSON encode/
// decode), process lifecycle (spawn/ping/backoff/teardown), and display-frame
// routing now live in the package (protocol/client.js — this file's former
// content, moved verbatim into @blade-lang/ide-protocol's createClient) so
// Blade-MCP can reuse the identical client. This module's only remaining job
// is the one VS Code touchpoint the package must not depend on: resolving
// the workspace root for a spawned process's cwd — plus hosting the
// extension-wide DEFAULT client (init/available/check/checkCells/dispose)
// that extension.js's fast/slow check clocks share.
//
// src/notebook.js calls createClient() directly for its OWN, per-notebook
// process (see that module's header for why — a slow g++-fallback eval must
// not stall the shared client's typing-time checks). The `createClient`
// exported here is NOT the package's raw export: it injects
// `cwd: workspaceRoot` (the FUNCTION, re-resolved on every spawn — same
// pattern as `dependencies.findCompiler`, which the package already
// re-invokes per respawn so a `blade.compilerPath` change is picked up
// without a client restart) so every caller gets the workspace-relative cwd
// this extension has always used, without repeating that plumbing at each
// call site.

"use strict";

const vscode = require("vscode");
const pkg = require("@blade-lang/ide-protocol");

function workspaceRoot() {
  const ws = vscode.workspace.workspaceFolders;
  return ws && ws.length > 0 ? ws[0].uri.fsPath : undefined;
}

/**
 * Build one `ide serve` client — see @blade-lang/ide-protocol's createClient
 * for the full behavior (spawn, ping probe, id correlation, timeouts,
 * backoff, dispose; unchanged from when that logic lived in this file:
 * `{ available, check, checkCells, eval, resetSession, dispose }`). This
 * wrapper only adds `cwd`, resolved fresh on every spawn.
 */
function createClient(dependencies, label) {
  return pkg.createClient(Object.assign({}, dependencies, { cwd: workspaceRoot }), label);
}

// --- Default singleton (extension.js's fast/slow check clocks) --------------

/** @type {ReturnType<typeof createClient> | undefined} */
let defaultClient;

/** Tear down the current process (best-effort clean `shutdown` first) and
 *  reset ALL state so the next check() re-probes from scratch. Used both at
 *  extension deactivate() and whenever blade.compilerPath changes (the new
 *  compiler may or may not support 'ide serve'). Safe to call when nothing
 *  is running. */
function dispose() {
  if (defaultClient) defaultClient.dispose();
}

function init(context, dependencies) {
  defaultClient = createClient(dependencies);
  context.subscriptions.push({ dispose: () => dispose() });
}

function available() {
  return defaultClient ? defaultClient.available() : "unknown";
}

function check(fileName, source, tier, timeoutMs) {
  if (!defaultClient) return Promise.reject(new Error("blade ide serve: init() not called"));
  return defaultClient.check(fileName, source, tier, timeoutMs);
}

/** Notebook checking rides the DEFAULT client too (src/notebook.js's
 *  runNotebookCheck) — a stateless check like any other; see the module
 *  header for why it must NOT go through a notebook's dedicated eval client. */
function checkCells(fileName, cells, tier, timeoutMs) {
  if (!defaultClient) return Promise.reject(new Error("blade ide serve: init() not called"));
  return defaultClient.checkCells(fileName, cells, tier, timeoutMs);
}

module.exports = { init, available, check, checkCells, dispose, createClient };
