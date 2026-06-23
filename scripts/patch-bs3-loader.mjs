#!/usr/bin/env node
// ─── better-sqlite3 multi-ABI loader patch ───────────────────────────
// better-sqlite3 loads its single native addon via
//   require('bindings')('better_sqlite3.node')
// which resolves ONE file (build/Release/better_sqlite3.node) baked
// against whatever Node ABI built it. That makes the shipped binary
// usable only on the exact Node major it was built with — a user on a
// different Node version gets "compiled against a different Node.js
// version (NODE_MODULE_VERSION ...)".
//
// node-pty avoids this by shipping prebuilds/<platform>/ and selecting
// at runtime. This patch makes better-sqlite3 do the same: it rewrites
// the loader to pick build/Release/better_sqlite3-<abi>.node based on
// the running process's ABI (process.versions.modules), with a fallback
// to the legacy single-file path and a clear error otherwise.
//
// It also rewrites the package's package.json so npm pack ships the
// per-ABI binaries (and keeps `bindings` for the fallback path).
//
// Usage: node scripts/patch-bs3-loader.mjs <better-sqlite3 package dir>
// Idempotent: re-running on an already-patched package is a no-op.
// ─────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';

const pkgDir = process.argv[2];
if (!pkgDir) {
  console.error('usage: patch-bs3-loader.mjs <better-sqlite3 package dir>');
  process.exit(1);
}

const MARKER = 'no bundled native binary for Node ABI';

// The exact expression better-sqlite3 uses to load its addon.
const TARGET = "require('bindings')('better_sqlite3.node')";

// Self-contained replacement expression (no external helper needed so
// placement is irrelevant). __dirname here is <pkg>/lib, so the binaries
// live at ../build/Release relative to it.
const REPLACEMENT =
  "(function(){var p=require('path'),a=process.versions.modules," +
  "f=p.join(__dirname,'..','build','Release','better_sqlite3-'+a+'.node');" +
  "try{return require(f)}catch(e){if(e&&e.code==='MODULE_NOT_FOUND'){" +
  "try{return require('bindings')('better_sqlite3.node')}catch(_){}" +
  "throw new Error('better-sqlite3: " + MARKER + " '+a+' (Node '+process.versions.node+', '+process.platform+'-'+process.arch+'). " +
  "This vibedeckx build bundles native binaries for specific Node versions; use a supported Node release (e.g. 22 or 24) or build from source.')}throw e}})()";

// ── 1. Patch the loader (lib/database.js) ──
const dbPath = path.join(pkgDir, 'lib', 'database.js');
let db = fs.readFileSync(dbPath, 'utf8');

if (db.includes(MARKER)) {
  console.log('    [bs3-loader] already patched (no-op)');
} else if (db.includes(TARGET)) {
  // Replace every occurrence (there is normally exactly one).
  db = db.split(TARGET).join(REPLACEMENT);
  fs.writeFileSync(dbPath, db);
  console.log('    [bs3-loader] patched lib/database.js for multi-ABI selection');
} else {
  console.error(
    `    [bs3-loader] FAIL: could not find the addon-load expression in ${dbPath}.\n` +
    '    better-sqlite3 may have changed its loader; update scripts/patch-bs3-loader.mjs.'
  );
  process.exit(1);
}

// ── 2. Rewrite package.json so npm pack ships the per-ABI binaries ──
const pkgJsonPath = path.join(pkgDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
delete pkg.scripts;
delete pkg.gypfile;
pkg.dependencies = { bindings: '*' }; // kept for the fallback require path
pkg.files = ['lib/', 'build/Release/'];
fs.writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2) + '\n');
console.log('    [bs3-loader] rewrote package.json (files -> build/Release/, scripts/gypfile removed)');
