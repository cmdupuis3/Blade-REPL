// Reconstructs the vendored graphics packages listed in deps.json, so a fresh
// clone can get to a working plotting setup with one command. Run with:
//
//   node scripts/fetch-vendor.js            (fetch whatever is missing)
//   node scripts/fetch-vendor.js --check    (verify only, no network, exit 1 on drift)
//   node scripts/fetch-vendor.js --force    (re-fetch and re-extract regardless)
//
// or `npm run fetch-vendor`. Zero dependencies: node builtins plus the system
// `tar`, which ships on Windows 10+ (bsdtar in System32), Linux and macOS.
//
// Two shapes of dependency, distinguished by "kind" in deps.json:
//
//   file    - a single tracked file (plotly.min.js). It is committed because
//             VS Code webviews are offline and it has to be in the .vsix, so
//             the normal outcome here is "verify the hash and do nothing".
//   tarball - a per-platform archive extracted into a gitignored directory
//             (GR). The archive is kept next to the extraction so a re-extract
//             costs no network.

"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");
const DEPS_FILE = path.join(root, "deps.json");
const MAX_REDIRECTS = 10;

// deps.json pins one asset per `${process.platform}-${process.arch}`.
const PLATFORM_KEY = `${process.platform}-${process.arch}`;

// ---------------------------------------------------------------- utilities

function fail(msg) {
  console.error(`fetch-vendor: ${msg}`);
  process.exit(1);
}

function exists(p) {
  return fs.existsSync(p);
}

function mb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1);
}

// Paths handed to tar are made repo-relative and forward-slashed, and tar is
// run with cwd=root. Both halves matter on Windows, where `tar` may resolve to
// either bsdtar (System32) or GNU tar (git-bash, MSYS2): GNU tar reads an
// absolute "C:/..." as a *remote* host:path spec and dies with "Cannot connect
// to C: resolve failed", while backslashes confuse the -C argument. A relative
// forward-slashed path has no colon and is unambiguous to both.
function tarPath(abs) {
  return path.relative(root, abs).replace(/\\/g, "/");
}

function runTar(args, opts) {
  return execFileSync("tar", args, Object.assign({ cwd: root }, opts));
}

function hashFile(abs) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(abs);
    s.on("error", reject);
    s.on("data", (c) => h.update(c));
    s.on("end", () => resolve(h.digest("hex")));
  });
}

// GET with redirect following. GitHub release downloads always bounce to
// release-assets.githubusercontent.com, so this is not optional.
function httpsGet(url, redirectsLeft) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "user-agent": "blade-repl-fetch-vendor", accept: "*/*" } },
      (res) => {
        const code = res.statusCode;
        if (code >= 300 && code < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            reject(new Error(`too many redirects following ${url}`));
            return;
          }
          const next = new URL(res.headers.location, url).toString();
          resolve(httpsGet(next, redirectsLeft - 1));
          return;
        }
        if (code !== 200) {
          res.resume();
          reject(new Error(`HTTP ${code} for ${url}`));
          return;
        }
        resolve(res);
      }
    );
    req.on("error", reject);
  });
}

// Downloads to `${destAbs}.part`, hashing as the bytes stream past, and leaves
// the partial file in place for the caller to verify and then rename.
async function downloadToPart(url, destAbs, label) {
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  const part = `${destAbs}.part`;
  fs.rmSync(part, { force: true });

  const res = await httpsGet(url, MAX_REDIRECTS);
  const total = Number(res.headers["content-length"] || 0);
  const hash = crypto.createHash("sha256");
  const out = fs.createWriteStream(part);
  let seen = 0;
  let lastPct = -10;

  await new Promise((resolve, reject) => {
    res.on("data", (chunk) => {
      hash.update(chunk);
      seen += chunk.length;
      if (total && process.stdout.isTTY) {
        const pct = Math.floor((seen * 100) / total);
        if (pct >= lastPct + 10) {
          lastPct = pct;
          process.stdout.write(`\r    ${label}: ${pct}% (${mb(seen)}/${mb(total)} MB)`);
        }
      }
    });
    res.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
    res.pipe(out);
  });

  if (lastPct >= 0) process.stdout.write("\n");
  return { part, sha256: hash.digest("hex"), bytes: seen };
}

// Compares a computed hash against the pin. A null pin is "not pinned yet":
// warn, print the value so it can be pasted into deps.json, and continue.
function checkPin(name, expected, actual) {
  if (expected === null || expected === undefined) {
    console.log(`  ! ${name}: no sha256 pinned in deps.json`);
    console.log(`    computed sha256: ${actual}`);
    console.log(`    paste that into deps.json to pin this asset`);
    return "unpinned";
  }
  return expected.toLowerCase() === actual.toLowerCase() ? "match" : "mismatch";
}

// ---------------------------------------------------------------- tar layout

function tarEntries(tarball) {
  const out = runTar(["-tzf", tarPath(tarball)], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

// The single directory every entry sits under, or null if the archive is flat
// or has several roots. GR's tarballs are all rooted at "gr/", but the point
// of asking is that the extraction lands at dest regardless of the root's name.
function singleTopLevel(entries) {
  const tops = new Set(
    entries
      .map((e) => e.replace(/^\.\//, "").split("/")[0])
      .filter((s) => s.length > 0)
  );
  if (tops.size !== 1) return null;
  const only = [...tops][0];
  // A lone top-level *file* is not a root to strip.
  const isDir = entries.some((e) => e.replace(/^\.\//, "").startsWith(`${only}/`));
  return isDir ? only : null;
}

// Extracts into a staging directory beside dest, then swaps it into place, so
// an interrupted or failing extraction never leaves a half-populated dest.
function extractTo(tarball, destAbs, stripTopLevel) {
  const parent = path.dirname(destAbs);
  fs.mkdirSync(parent, { recursive: true });

  const staging = path.join(parent, `.fetch-vendor-staging-${process.pid}`);
  const backup = `${destAbs}.old-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  try {
    runTar(["-xzf", tarPath(tarball), "-C", tarPath(staging)], {
      stdio: ["ignore", "ignore", "inherit"],
    });

    let src = staging;
    if (stripTopLevel) {
      const top = singleTopLevel(tarEntries(tarball));
      const candidate = top ? path.join(staging, top) : null;
      if (candidate && exists(candidate) && fs.statSync(candidate).isDirectory()) {
        src = candidate;
      }
    }

    if (exists(destAbs)) fs.renameSync(destAbs, backup);
    try {
      fs.renameSync(src, destAbs);
    } catch (err) {
      if (exists(backup)) fs.renameSync(backup, destAbs);
      throw err;
    }
    fs.rmSync(backup, { recursive: true, force: true });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------- dependencies

async function handleFile(dep, mode) {
  const destAbs = path.join(root, dep.dest);

  if (exists(destAbs)) {
    const actual = await hashFile(destAbs);
    const verdict = checkPin(dep.name, dep.sha256, actual);
    if (verdict === "mismatch") {
      console.log(`  x ${dep.dest} hash does not match deps.json`);
      console.log(`    expected ${dep.sha256}`);
      console.log(`    actual   ${actual}`);
      return "MISMATCH";
    }
    if (mode !== "force") {
      console.log(
        verdict === "unpinned"
          ? `  - ${dep.dest} present (hash not pinned)`
          : `  - ${dep.dest} present, sha256 verified`
      );
      return "ok";
    }
  } else if (mode === "check") {
    console.log(`  x ${dep.dest} is missing`);
    return "MISSING";
  }

  if (mode === "check") return "ok";

  console.log(`  > downloading ${dep.url}`);
  const got = await downloadToPart(dep.url, destAbs, dep.name);
  const verdict = checkPin(dep.name, dep.sha256, got.sha256);
  if (verdict === "mismatch") {
    fs.rmSync(got.part, { force: true });
    console.log(`  x downloaded bytes do not match the pin`);
    console.log(`    expected ${dep.sha256}`);
    console.log(`    actual   ${got.sha256}`);
    return "MISMATCH";
  }
  fs.rmSync(destAbs, { force: true });
  fs.renameSync(got.part, destAbs);
  console.log(`  + ${dep.dest} (${mb(got.bytes)} MB)`);
  return "fetched";
}

async function handleTarball(dep, mode) {
  const destAbs = path.join(root, dep.dest);
  const asset = (dep.assets || {})[PLATFORM_KEY];

  if (!asset) {
    const known = Object.keys(dep.assets || {}).join(", ");
    console.log(`  ! ${dep.name}: no asset pinned for ${PLATFORM_KEY} (have: ${known})`);
    return "skipped";
  }

  const expectDirs = dep.expect || [];
  const missingDirs = expectDirs.filter((d) => !exists(path.join(destAbs, d)));

  if (mode === "check") {
    if (!exists(destAbs)) {
      console.log(`  x ${dep.dest} is missing -- run \`npm run fetch-vendor\``);
      return "MISSING";
    }
    if (missingDirs.length > 0) {
      console.log(`  x ${dep.dest} is incomplete, missing: ${missingDirs.join(", ")}`);
      return "MISMATCH";
    }
    console.log(`  - ${dep.dest} present (${expectDirs.join("/ ")}/ all found)`);
    // The archive is disposable once extracted, so its absence is fine; if it
    // is still around, it is cheap to notice that it drifted from the pin.
    const cached = path.join(root, path.dirname(dep.dest), asset.asset);
    if (exists(cached)) {
      const actual = await hashFile(cached);
      const verdict = checkPin(`${dep.name} (${asset.asset})`, asset.sha256, actual);
      if (verdict === "mismatch") {
        console.log(`  x cached ${asset.asset} hash does not match deps.json`);
        console.log(`    expected ${asset.sha256}`);
        console.log(`    actual   ${actual}`);
        return "MISMATCH";
      }
      if (verdict === "match") console.log(`  - cached ${asset.asset} sha256 verified`);
    }
    return "ok";
  }

  if (exists(destAbs) && missingDirs.length === 0 && mode !== "force") {
    console.log(`  - ${dep.dest} present (${expectDirs.join("/ ")}/ all found)`);
    return "skipped";
  }

  // The archive lives beside the extraction, so a --force re-extract, or a
  // re-extract after deleting dest, costs no network.
  const tarball = path.join(root, path.dirname(dep.dest), asset.asset);
  let haveTarball = false;

  if (exists(tarball)) {
    const actual = await hashFile(tarball);
    const verdict = checkPin(`${dep.name} (${asset.asset})`, asset.sha256, actual);
    if (verdict === "mismatch") {
      console.log(`  ! local ${asset.asset} hash does not match the pin, re-downloading`);
      console.log(`    expected ${asset.sha256}`);
      console.log(`    actual   ${actual}`);
    } else {
      console.log(`  - reusing local ${asset.asset} (${mb(fs.statSync(tarball).size)} MB)`);
      haveTarball = true;
    }
  }

  if (!haveTarball) {
    console.log(`  > downloading ${asset.url}`);
    const got = await downloadToPart(asset.url, tarball, dep.name);
    const verdict = checkPin(`${dep.name} (${asset.asset})`, asset.sha256, got.sha256);
    if (verdict === "mismatch") {
      fs.rmSync(got.part, { force: true });
      console.log(`  x downloaded bytes do not match the pin`);
      console.log(`    expected ${asset.sha256}`);
      console.log(`    actual   ${got.sha256}`);
      return "MISMATCH";
    }
    fs.rmSync(tarball, { force: true });
    fs.renameSync(got.part, tarball);
    console.log(`  + ${path.relative(root, tarball)} (${mb(got.bytes)} MB)`);
  }

  console.log(`  > extracting into ${dep.dest}/`);
  extractTo(tarball, destAbs, dep.stripTopLevel !== false);

  const stillMissing = expectDirs.filter((d) => !exists(path.join(destAbs, d)));
  if (stillMissing.length > 0) {
    console.log(`  x ${dep.dest} is missing after extraction: ${stillMissing.join(", ")}`);
    return "MISMATCH";
  }
  console.log(`  + ${dep.dest}/ (${expectDirs.join("/ ")}/ all present)`);
  if (dep.runtime) console.log(`    runtime: ${dep.runtime}`);
  return "fetched";
}

// --------------------------------------------------------------------- main

async function main(argv) {
  const args = argv.slice(2);
  for (const a of args) {
    if (a === "-h" || a === "--help") {
      console.log("usage: node scripts/fetch-vendor.js [--check | --force]");
      return 0;
    }
    if (a !== "--check" && a !== "--force") fail(`unknown argument ${a}`);
  }
  const mode = args.includes("--check") ? "check" : args.includes("--force") ? "force" : "fetch";

  if (!exists(DEPS_FILE)) fail(`deps.json not found at ${DEPS_FILE}`);
  let deps;
  try {
    deps = JSON.parse(fs.readFileSync(DEPS_FILE, "utf8"));
  } catch (err) {
    fail(`deps.json is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(deps.dependencies)) fail("deps.json has no \"dependencies\" array");

  console.log(`fetch-vendor: mode=${mode} platform=${PLATFORM_KEY}`);

  const results = [];
  for (const dep of deps.dependencies) {
    console.log(`\n${dep.name} ${dep.version}`);
    let status;
    try {
      if (dep.kind === "tarball") status = await handleTarball(dep, mode);
      else status = await handleFile(dep, mode);
    } catch (err) {
      console.log(`  x ${dep.name}: ${err.message}`);
      status = "ERROR";
    }
    results.push({ name: dep.name, status });
  }

  console.log("\nsummary");
  const width = Math.max(...results.map((r) => r.name.length));
  for (const r of results) console.log(`  ${r.name.padEnd(width)}  ${r.status}`);

  const bad = results.filter((r) => r.status !== "ok" && r.status !== "fetched" && r.status !== "skipped");
  if (bad.length > 0) {
    console.log(`\n${bad.length} dependency/dependencies need attention`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  main(process.argv).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err && err.stack ? err.stack : err);
      process.exit(1);
    }
  );
}

module.exports = { singleTopLevel };
