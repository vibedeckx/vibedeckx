import { describe, expect, it } from "vitest";
import { getAgentMetadata, supportsPlanMode } from "./agent-metadata";

describe("agent metadata", () => {
  it("preserves existing message names and accent colours", () => {
    expect(getAgentMetadata("claude-code")).toMatchObject({ messageName: "Claude", accentText: "text-violet-500" });
    expect(getAgentMetadata("codex")).toMatchObject({ messageName: "Codex", accentText: "text-green-500" });
  });
  it("uses the server name and neutral colours for unknown providers", () => {
    expect(getAgentMetadata("third", [{ type: "third", displayName: "Third Agent", available: true }])).toMatchObject({
      displayName: "Third Agent", messageName: "Third Agent", accentText: "text-muted-foreground", branchAccent: "bg-muted text-muted-foreground",
    });
    expect(getAgentMetadata("uninstalled").displayName).toBe("uninstalled");
    expect(getAgentMetadata("constructor").messageName).toBe("constructor");
  });
  it("honours plan support and keeps older providers compatible", () => {
    expect(supportsPlanMode({ type: "third", displayName: "Third Agent", available: true, capabilities: { planMode: false } })).toBe(false);
    expect(supportsPlanMode({ type: "codex", displayName: "Codex", available: true })).toBe(true);
  });
});
