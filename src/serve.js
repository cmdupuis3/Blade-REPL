// Persistent `blade ide serve` client. Where src/repl.js hosts an interactive
// session (terminal, prompt sentinels, implicit lazy restart on next send),
// this module hosts a plain request/response data pipe: `Blade.exe ide
// serve` reads one JSON object per stdin line and writes one JSON object per
// stdout line, correlated by an integer "id" (src/serveProto.js owns that
// framing so scripts/serve-protocol-test.js can exercise it without VS Code).
// No pty, no echo, no :paste framing — cp.spawn straight to stdin/stdout.
//
// Two things repl.js does NOT need that this module does:
//   - A capability probe. Unlike `blade repl` (which has existed since before
//     the JSON IDE mode), `ide serve` may not exist on the compiler on
//     $PATH — the first check() lazily spawns the process and pings it; a
//     clean {ok:true} within PING_TIMEOUT_MS latches `available()` to "yes",
//     a spawn failure or ping timeout latches it to "no" for the rest of the
//     session (mirrors extension.js's existing `ideMode` probe philosophy —
//     don't hammer a compiler that doesn't have the subcommand).
//   - Explicit restart-with-backoff. A REPL session dying mid-edit is
//     unrecoverable anyway (the accumulated bindings are gone), so repl.js
//     just reports failure and waits for the user to start a new one. A
//     `serve` process dying is just a hiccup — it carries no state across
//     requests (Ide.fs resets its IDE side-channels per request) — so a
//     request timeout kills the process and the NEXT check() call respawns
//     it, subject to a backoff floor (500ms / 2s / 8s) so a wedged compiler
//     can't be respawned on every 300ms keystroke. After
//     MAX_ESTABLISHED_FAILURES consecutive failures once serve has proven
//     itself, we give up for the session exactly like the initial probe.
//
// Per-request timeouts are deliberately generous tier-dependent defaults
// (fast/full) since "full" runs monomorphization; callers (extension.js) may
// override per call.

"use strict";

const vscode = require("vscode");
const cp = require("child_process");
const proto = require("./serveProto");

// Injected by init(): { findCompiler, output } from extension.js.
let deps;

const PING_TIMEOUT_MS = 5000;
const DEFAULT_TIMEOUT_MS = { fast: 10000, full: 30000 };
const BACKOFF_MS = [500, 2000, 8000];
const MAX_ESTABLISHED_FAILURES = 3;

/** @type {import("child_process").ChildProcess | undefined} */
let proc;
let nextId = 1;
/** @type {Map<number, { resolve: (msg: object) => void, reject: (err: Error) => void }>} */
let pending = new Map();

// "unknown" until the first ping resolves or fails; then "yes" or "no".
let availability = "unknown";
// Has a ping EVER succeeded this session? Governs failure handling: the
// very first probe latches straight to "no" on any failure (one-shot,
// mirroring extension.js's existing ideMode probe); once serve has proven
// itself once, later failures get MAX_ESTABLISHED_FAILURES backoff retries
// before giving up the same way.
let established = false;
let consecutiveFailures = 0;
let nextSpawnAllowedAt = 0;
// Shares one spawn+ping handshake across concurrent check() calls that all
// land before the first probe resolves.
let handshake = null;

function log(line) {
  if (deps && deps.output) deps.output.appendLine(`[blade serve] ${line}`);
}

function workspaceRoot() {
  const ws = vscode.workspace.workspaceFolders;
  return ws && ws.length > 0 ? ws[0].uri.fsPath : undefined;
}

// --- Failure / backoff bookkeeping ------------------------------------------

function recordFailure(reason) {
  consecutiveFailures++;
  const giveUpAt = established ? MAX_ESTABLISHED_FAILURES : 1;
  if (consecutiveFailures >= giveUpAt) {
    availability = "no";
    log(`${reason} — giving up on 'ide serve' for this session (change blade.compilerPath to retry)`);
  } else {
    const backoff = BACKOFF_MS[Math.min(consecutiveFailures - 1, BACKOFF_MS.length - 1)];
    nextSpawnAllowedAt = Date.now() + backoff;
    log(`${reason} — retrying in ${backoff}ms (failure ${consecutiveFailures}/${giveUpAt})`);
  }
}

function recordSuccess() {
  established = true;
  availability = "yes";
  consecutiveFailures = 0;
}

// --- Process lifecycle -------------------------------------------------------

function rejectAllPending(reason) {
  const err = new Error(`blade ide serve: ${reason}`);
  for (const [, p] of pending) p.reject(err);
  pending.clear();
}

/** Kill the current process (if any) and reject everything in flight.
 *  `isFailure` runs the backoff/give-up bookkeeping; pass false for a
 *  deliberate dispose(), which is not a failure. Idempotent — a second call
 *  while already torn down is a no-op, so racing failure paths (e.g. a
 *  request timeout that kills the process right as it happens to exit on its
 *  own) can't double-count. */
function teardown(reason, isFailure) {
  if (!proc) return;
  const p = proc;
  proc = undefined;
  p.removeAllListeners();
  if (p.stdout) p.stdout.removeAllListeners();
  if (p.stderr) p.stderr.removeAllListeners();
  if (p.exitCode === null && p.signalCode === null) {
    try {
      p.kill();
    } catch (_) {
      /* already gone */
    }
  }
  rejectAllPending(reason);
  if (isFailure) recordFailure(reason);
}

function handleStdout(decoder, chunk) {
  const messages = decoder.push(chunk);
  for (const msg of messages) {
    const id = msg.id;
    if (id === undefined || id === null) {
      if (msg.error) log(`serve error (no id): ${msg.error}`);
      continue;
    }
    const p = pending.get(id);
    if (!p) continue; // already timed out, or an id we never sent — drop
    pending.delete(id);
    if (msg.error) p.reject(new Error(msg.error));
    else p.resolve(msg);
  }
}

function handleStderr(chunk) {
  // Free-form compiler logging — never parsed, just surfaced.
  const text = String(chunk).trimEnd();
  if (text) log(text);
}

/** Spawn the child and wire it up. Per-process closures (rather than reading
 *  the module-level `proc`/decoder from the listeners) so a stray event from
 *  an already-torn-down process can never be mistaken for the current one. */
function spawnProcess() {
  const exe = deps.findCompiler();
  const child = cp.spawn(exe, ["ide", "serve"], { cwd: workspaceRoot(), windowsHide: true });
  const decoder = proto.createDecoder();
  proc = child;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    if (proc !== child) return;
    handleStdout(decoder, chunk);
  });
  child.stderr.on("data", (chunk) => {
    if (proc !== child) return;
    handleStderr(chunk);
  });
  child.on("error", (e) => {
    if (proc !== child) return;
    teardown(`could not run '${exe} ide serve': ${e.message}`, true);
  });
  child.on("exit", (code, signal) => {
    if (proc !== child) return;
    teardown(`blade ide serve exited (code=${code}${signal ? `, signal=${signal}` : ""})`, true);
  });
}

/** Send one request, tracked by id, rejecting on `timeoutMs`. On timeout or a
 *  synchronous write failure, tears the process down (see teardown) — a
 *  wedged or broken pipe means every other in-flight request is equally
 *  dead, and the next check() call will respawn subject to backoff. An
 *  explicit `{"error": "..."}` response, by contrast, means the process is
 *  alive and answering correctly — that just rejects THIS request. */
function sendRequest(encode, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      pending.delete(id);
      const reason = `request ${id} timed out after ${timeoutMs}ms`;
      reject(new Error(`blade ide serve: ${reason}`));
      teardown(reason, true);
    }, timeoutMs);
    pending.set(id, {
      resolve: (msg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(msg);
      },
      reject: (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    });
    try {
      if (!proc) throw new Error("no active process");
      proc.stdin.write(encode(id));
    } catch (e) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pending.delete(id);
      reject(new Error(`blade ide serve: could not write request: ${e.message}`));
      teardown(`could not write request: ${e.message}`, true);
    }
  });
}

/** Spawn (if needed) and ping-probe the process, sharing one attempt across
 *  concurrent callers. */
function doHandshake() {
  return (async () => {
    try {
      spawnProcess();
    } catch (e) {
      recordFailure(`could not start 'ide serve': ${e.message}`);
      throw new Error("blade ide serve unavailable");
    }
    let msg;
    try {
      msg = await sendRequest((id) => proto.encodePing(id), PING_TIMEOUT_MS);
    } catch (e) {
      // A timeout or write failure already ran teardown()+recordFailure()
      // above; an explicit {error} response from a live process has not, so
      // cover that one remaining case here without double-counting.
      if (proc) teardown(`ping error: ${e.message}`, true);
      throw new Error("blade ide serve unavailable");
    }
    if (!msg || msg.ok !== true) {
      teardown("ping response missing ok:true", true);
      throw new Error("blade ide serve unavailable");
    }
    recordSuccess();
    log(`available — serve=${msg.serve}, version=${msg.version || "unknown"}`);
  })();
}

function ensureReady() {
  if (proc && availability === "yes") return Promise.resolve();
  if (availability === "no") return Promise.reject(new Error("blade ide serve unavailable"));
  if (handshake) return handshake;
  const now = Date.now();
  if (now < nextSpawnAllowedAt) {
    return Promise.reject(
      new Error(`blade ide serve: backing off for ${nextSpawnAllowedAt - now}ms`)
    );
  }
  const p = doHandshake();
  handshake = p;
  p.finally(() => {
    if (handshake === p) handshake = null;
  });
  return p;
}

// --- Public surface -----------------------------------------------------------

/** Tri-state capability: "unknown" (never probed), "yes", "no" (latched —
 *  see the module header). Synchronous — reflects the LAST probe/request
 *  outcome, does not itself trigger one. */
function available() {
  return availability;
}

/**
 * Check `source` (the live buffer text, not necessarily saved) at `tier`.
 * Lazily spawns and pings on first use. Resolves with the response payload
 * object (diagnostics/bindings/providers/deduced/calls/kernels, "id", and
 * "tier" echoed back — plus "concreteType" entries on "full" responses) or
 * rejects with an Error whose message explains why (unavailable, backing
 * off, timed out, or a protocol-level `{"error": "..."}` response).
 * @param {string} fileName absolute path (resolved provider-relative paths
 *   are the compiler's job — it chdirs to this file's directory per request)
 * @param {string} source full buffer text
 * @param {"fast"|"full"} tier
 * @param {number} [timeoutMs] default 10s (fast) / 30s (full)
 */
function check(fileName, source, tier, timeoutMs) {
  const t = tier === "full" ? "full" : "fast";
  const ms = timeoutMs || DEFAULT_TIMEOUT_MS[t];
  return ensureReady().then(() => {
    if (!proc) throw new Error("blade ide serve unavailable");
    return sendRequest((id) => proto.encodeCheck(id, t, fileName, source), ms);
  });
}

/** Tear down the current process (best-effort clean `shutdown` first) and
 *  reset ALL state so the next check() re-probes from scratch. Used both at
 *  extension deactivate() and whenever blade.compilerPath changes (the new
 *  compiler may or may not support 'ide serve'). Safe to call when nothing
 *  is running. */
function dispose() {
  if (proc) {
    try {
      proc.stdin.write(proto.encodeShutdown());
    } catch (_) {
      /* pipe already gone — the kill() in teardown() below covers it */
    }
  }
  teardown("blade ide serve disposed", false);
  availability = "unknown";
  established = false;
  consecutiveFailures = 0;
  nextSpawnAllowedAt = 0;
  handshake = null;
}

function init(context, dependencies) {
  deps = dependencies;
  context.subscriptions.push({ dispose: () => dispose() });
}

module.exports = { init, available, check, dispose };
