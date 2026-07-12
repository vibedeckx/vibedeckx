import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { FRONTEND_RENDERED_TOOLS } from "./schema.js";

// packages/vibedeckx/src/protocol/claude-code/ -> repo root is five levels up
const AGENT_MESSAGE_TSX = new URL(
  "../../../../../apps/vibedeckx-ui/components/agent/agent-message.tsx",
  import.meta.url,
);

function extractFrontendToolNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const m of source.matchAll(/tool === "([A-Za-z]+)"/g)) {
    names.add(m[1]);
  }
  // taskToolLabels map keys: TodoWrite / TaskCreate / TaskUpdate / TaskList / TaskGet
  const mapBlock = source.match(/const taskToolLabels[\s\S]*?\n  \};/);
  if (mapBlock) {
    for (const m of mapBlock[0].matchAll(/^\s+([A-Za-z]+): \{ label:/gm)) {
      names.add(m[1]);
    }
  }
  return names;
}

describe("FRONTEND_RENDERED_TOOLS stays in sync with agent-message.tsx", () => {
  const source = readFileSync(AGENT_MESSAGE_TSX, "utf-8");
  const frontendNames = extractFrontendToolNames(source);

  it("extraction finds a plausible number of special-cased tools", () => {
    expect(frontendNames.size).toBeGreaterThanOrEqual(15);
  });

  it("every tool the frontend special-cases is in FRONTEND_RENDERED_TOOLS", () => {
    const known = new Set<string>(FRONTEND_RENDERED_TOOLS);
    const missing = [...frontendNames].filter((n) => !known.has(n));
    expect(missing, `add these to FRONTEND_RENDERED_TOOLS in schema.ts: ${missing.join(", ")}`).toEqual([]);
  });

  it("every FRONTEND_RENDERED_TOOLS entry still exists in the frontend source", () => {
    const stale = FRONTEND_RENDERED_TOOLS.filter((n) => !frontendNames.has(n));
    expect(stale, `these constants no longer match agent-message.tsx: ${stale.join(", ")}`).toEqual([]);
  });
});
