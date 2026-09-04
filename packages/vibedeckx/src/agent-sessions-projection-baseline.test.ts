import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createSqliteStorage } from "./storage/sqlite.js";
import type { Storage } from "./storage/types.js";

/**
 * Projection baseline for the prepared-session lifecycle design
 * (docs/superpowers/specs/2026-08-31-prepared-agent-session-lifecycle-design.md
 * §12 Phase 0, §14.2).
 *
 * Phase 1 adds `lifecycle_state` to `agent_sessions`, after which every read
 * of that table is a projection that must be active-scoped — a single missed
 * one lets a pending row surface as a blue "New Session". This test freezes
 * the full set of `agentSessions.<method>(` call sites (production code only)
 * and the repository's method list, so the Phase 1 diff of this snapshot IS
 * the checklist of projections to migrate. Adding a call site or a repository
 * method updates the snapshot deliberately (`vitest -u`), never silently.
 */

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__snapshots__") continue;
      walk(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

function collectCallSites(): Record<string, string[]> {
  const byMethod = new Map<string, Set<string>>();
  const pattern = /\bagentSessions\.([A-Za-z_]\w*)\s*\(/g;
  for (const file of walk(SRC_DIR)) {
    const rel = path.relative(SRC_DIR, file).split(path.sep).join("/");
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(pattern)) {
      const method = match[1];
      if (!byMethod.has(method)) byMethod.set(method, new Set());
      byMethod.get(method)!.add(rel);
    }
  }
  return Object.fromEntries(
    [...byMethod.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([method, files]) => [method, [...files].sort()]),
  );
}

describe("agent_sessions projection baseline (lifecycle design Phase 0)", () => {
  let dir: string;
  let storage: Storage;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-projection-baseline-"));
    storage = await createSqliteStorage(path.join(dir, "db.sqlite"));
  });
  afterAll(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("freezes every production call site that reads or writes agent_sessions through the repository", () => {
    const sites = collectCallSites();
    // Sanity: the extraction must see the manager and the routes, or the
    // regex/walk broke and the snapshot below would freeze an empty baseline.
    expect(sites.getById).toContain("agent-session-manager.ts");
    expect(sites.getById).toContain("routes/agent-session-routes.ts");
    expect(sites).toMatchSnapshot();
  });

  it("freezes the agentSessions repository surface", () => {
    const methods = Object.keys(storage.agentSessions).sort();
    expect(methods).toContain("deleteIfEmpty");
    expect(methods).toMatchSnapshot();
  });

  it("names the list/latest/activity readers Phase 1 must scope to lifecycle_state = active", () => {
    // These are the projections the design (§6.1) says must go through
    // active-scoped repository entry points. Listed by name so a rename shows
    // up here as well as in the snapshot.
    const projectionReaders = [
      "getAll",
      "getProjectedByProjectId",
      "listByBranch",
      "listRecentActivityByProject",
      "listAttentionActivityByProject",
      "listFavoritedActivityByProject",
      "countRunningActivityByProject",
      "listRetentionCandidates",
      "listIdsByProject",
      "getActivityById",
    ];
    const methods = new Set(Object.keys(storage.agentSessions));
    for (const reader of projectionReaders) expect(methods.has(reader), reader).toBe(true);
  });
});
