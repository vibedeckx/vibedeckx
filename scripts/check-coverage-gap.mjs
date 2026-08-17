#!/usr/bin/env node
/**
 * Does the hub ever answer a subscriber's replay from a cache that cannot cover
 * what it asked for? That is the one condition that decides whether the deferred
 * per-socket authoritative backfill ("B2") needs to be built at all.
 *
 * The hub emits `COVERAGE GAP` when it happens and sends `Ready` anyway
 * (observe-only by design — withholding it without a backfill path would strand
 * the browser in its replay state). This script is the reader for that signal.
 *
 * Always prints the denominator. "0 gaps" is only evidence if replays were
 * actually observed; a rotated-away or unreadable log would otherwise read as
 * a clean bill of health.
 *
 *   node scripts/check-coverage-gap.mjs [logDir] [--days N]
 *
 * Exit 0: no gaps in range. Exit 1: gaps found (details on stdout).
 * Exit 2: nothing to measure — no replays seen at all.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const daysFlag = args.indexOf("--days");
const days = daysFlag >= 0 ? Number(args[daysFlag + 1]) : 7;
const logDir = args.find((arg) => !arg.startsWith("--") && arg !== String(days))
  ?? process.env.VIBEDECKX_HUB_LOG_DIR
  ?? "/src/vibedeckx-server/data/logs";

const cutoff = Date.now() - days * 86_400_000;
const sessionOf = (msg) => msg.match(/(?:GAP|for) (remote-[\w-]+)/)?.[1] ?? "unknown";

let replays = 0;
const gaps = [];
let files = 0;

for (const name of readdirSync(logDir).filter((n) => n.endsWith(".log"))) {
  const path = join(logDir, name);
  // Rotated files older than the window cannot contain in-range lines.
  if (statSync(path).mtimeMs < cutoff) continue;
  files++;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.includes("AgentWS")) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (!(entry.time >= cutoff)) continue;
    const msg = String(entry.msg ?? "");
    if (msg.includes("Replaying cached msgs")) replays++;
    else if (msg.includes("COVERAGE GAP")) gaps.push({ time: entry.time, session: sessionOf(msg), msg });
  }
}

const stamp = new Date().toISOString();
const scope = `${files} file(s), last ${days}d`;

if (gaps.length === 0) {
  const verdict = replays === 0
    ? `NO DATA — 0 cached replays observed (${scope}); check the log path`
    : `clean — 0 coverage gaps in ${replays} cached replays (${scope})`;
  console.log(`${stamp} ${verdict}`);
  process.exit(replays === 0 ? 2 : 0);
}

const bySession = new Map();
for (const gap of gaps) bySession.set(gap.session, (bySession.get(gap.session) ?? 0) + 1);
console.log(
  `${stamp} GAPS FOUND — ${gaps.length} coverage gap(s) across ${bySession.size} session(s) ` +
  `in ${replays} cached replays (${scope}). The hub served an unprovable Ready; B2 (per-socket ` +
  `authoritative backfill) is now justified — see remote-patch-cache.ts CacheCoverage.`,
);
for (const [session, count] of [...bySession].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${String(count).padStart(4)}x  ${session}`);
}
for (const gap of gaps.slice(0, 3)) {
  console.log(`  e.g. ${new Date(gap.time).toISOString()} ${gap.msg}`);
}
process.exit(1);
