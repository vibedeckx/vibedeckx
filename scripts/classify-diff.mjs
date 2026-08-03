#!/usr/bin/env node
// Classifies a diff's files into server/worker impact buckets.
// See docs/server-worker-compat-design.md §3.3. Fast signal only — the
// enforcing check is the capability-registry reconciliation test
// (reverse-connect-capabilities.test.ts).
//
// Usage: node scripts/classify-diff.mjs [base-ref]   (default: origin/main)
// Exit code is always 0: wire-contract hits warn, they don't block.

import { execFileSync } from "node:child_process";

// Rule table — first match wins, top to bottom. Keep in sync with the bucket
// table in docs/server-worker-compat-design.md §3.3.
const RULES = [
  // Wire contract: anything defining the tunnel protocol or its call surface.
  { bucket: "wire-contract", test: (f) =>
      /packages\/vibedeckx\/src\/(routes\/)?reverse-connect-[^/]*\.ts$/.test(f) ||
      f === "packages/vibedeckx/src/utils/remote-proxy.ts" ||
      f === "packages/vibedeckx/src/virtual-ws-adapter.ts" },
  // Server-only: the worker runs API-only and never serves the UI.
  { bucket: "server-only", test: (f) => f.startsWith("apps/vibedeckx-ui/") },
  // Docs, CI, scripts and other non-runtime files.
  { bucket: "non-runtime", test: (f) =>
      f.startsWith("docs/") || f.startsWith("scripts/") || f.startsWith(".github/") ||
      f.startsWith(".dev/") || /\.(md|test\.ts)$/.test(f) },
  // Everything else in the shared package: proxy call sites, providers,
  // session/process managers — file location cannot answer the semantic
  // question, so it all lands in gray for registry + e2e + human review.
  { bucket: "gray", test: (f) => f.startsWith("packages/") },
  { bucket: "non-runtime", test: () => true },
];

const baseRef = process.argv[2] ?? "origin/main";
let files;
try {
  // Diff the working tree against the merge base so uncommitted local work is
  // included; on a clean CI checkout this equals `git diff base...HEAD`.
  const mergeBase = execFileSync("git", ["merge-base", baseRef, "HEAD"], { encoding: "utf8" }).trim();
  const tracked = execFileSync("git", ["diff", "--name-only", mergeBase], { encoding: "utf8" });
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { encoding: "utf8" });
  files = [...new Set(`${tracked}\n${untracked}`.split("\n").filter(Boolean))];
} catch (err) {
  console.error(`classify-diff: git diff against '${baseRef}' failed: ${err.message}`);
  process.exit(1);
}

if (files.length === 0) {
  console.log(`classify-diff: no changes vs ${baseRef}`);
  process.exit(0);
}

const buckets = new Map();
for (const file of files) {
  const bucket = RULES.find((r) => r.test(file)).bucket;
  if (!buckets.has(bucket)) buckets.set(bucket, []);
  buckets.get(bucket).push(file);
}

const order = ["wire-contract", "gray", "server-only", "non-runtime"];
for (const bucket of order) {
  for (const file of buckets.get(bucket) ?? []) {
    console.log(`${bucket.padEnd(14)}${file}`);
  }
}

console.log("");
const verdict = [];
if (buckets.has("wire-contract")) {
  verdict.push(
    "wire-contract touched — tunnel protocol change: the capability registry must reflect it (§3.1);",
    "additive → server can ship alone; renamed/removed → deprecation flow required."
  );
}
if (buckets.has("gray")) {
  verdict.push("gray files touched — worker-reachable code: review whether the change must reach workers (npm release) or is server-only.");
}
if (!buckets.has("wire-contract") && !buckets.has("gray")) {
  verdict.push("server-only / non-runtime — safe to deploy the server alone; no worker release needed.");
}
console.log(`verdict: ${verdict.join("\n         ")}`);
