import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * Enforces state-storage-and-migration.md §6.1 rule 4: production code may
 * touch `agent_session_entries` ONLY through the storage layer
 * (`getEntries` / `upsertEntry` / `deleteEntries` / ...), never with direct
 * SQL that names the table — including binding an FTS index to it with
 * `content=agent_session_entries`.
 *
 * This rule is the load-bearing wall of the decision to leave the
 * entries-to-files migration (plan doc §7) suspended: as long as every
 * consumer goes through the repository interface, the storage medium remains
 * an implementation detail of that layer and the suspension accrues no
 * hidden interest. A new call site outside `src/storage/` would silently
 * grow the future switching cost — this test turns that into a red build.
 */
describe("entries interface discipline (§6.1 rule 4)", () => {
  it("names agent_session_entries only inside src/storage/", () => {
    const srcRoot = fileURLToPath(new URL("..", import.meta.url));
    const offenders: string[] = [];

    for (const entry of readdirSync(srcRoot, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      // Tests may stage raw rows deliberately (e.g. the cascade guard test).
      if (entry.name.endsWith(".test.ts")) continue;
      const filePath = path.join(entry.parentPath, entry.name);
      const relative = path.relative(srcRoot, filePath);
      if (relative.startsWith("storage" + path.sep)) continue;
      if (readFileSync(filePath, "utf-8").includes("agent_session_entries")) {
        offenders.push(relative);
      }
    }

    expect(offenders, [
      "Direct references to agent_session_entries outside src/storage/ are not allowed.",
      "Go through storage.agentSessions (getEntries/upsertEntry/...) instead — see",
      "docs/state-storage-and-migration.md §6.1 rule 4 for why this boundary is load-bearing.",
    ].join(" ")).toEqual([]);
  });
});
