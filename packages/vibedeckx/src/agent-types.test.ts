import { describe, expect, it } from "vitest";
import { AGENT_CLI_COMMANDS, AGENT_TYPES, DEFAULT_AGENT_TYPE, invalidAgentTypeMessage, isAgentType, resolveAgentType } from "./agent-types.js";
import { resolveAgentCapabilities, type AgentProvider } from "./agent-provider.js";
import { getAllProviders, getProvider } from "./providers/index.js";

describe("agent type registry", () => {
  it("has a registered provider for every agent type, and vice versa", () => {
    const registered = getAllProviders().map((p) => p.getAgentType()).sort();
    expect(registered).toEqual([...AGENT_TYPES].sort());
  });

  it("lists each agent's CLI command", () => {
    expect(AGENT_CLI_COMMANDS).toEqual(expect.arrayContaining(["claude", "codex"]));
  });

  it("falls back to the default only when the type is absent", () => {
    expect(resolveAgentType(undefined)).toBe(DEFAULT_AGENT_TYPE);
    expect(resolveAgentType(null)).toBe(DEFAULT_AGENT_TYPE);
    expect(resolveAgentType("")).toBe(DEFAULT_AGENT_TYPE);
    expect(resolveAgentType("codex")).toBe("codex");
  });

  it("rejects unknown non-empty values instead of turning them into Claude", () => {
    expect(resolveAgentType("fx-unknown")).toBeNull();
    expect(resolveAgentType("toString")).toBeNull();
    expect(resolveAgentType(42)).toBeNull();
    expect(isAgentType("constructor")).toBe(false);
    expect(invalidAgentTypeMessage()).toBe(`agentType must be one of: ${AGENT_TYPES.join(", ")}`);
  });

  it("Claude Code and Codex keep full capabilities by default", () => {
    expect(resolveAgentCapabilities(getProvider("claude-code"))).toEqual({ planMode: true });
    expect(resolveAgentCapabilities(getProvider("codex"))).toEqual({ planMode: true });
  });

  it("an explicit capability declaration overrides the default", () => {
    const provider = { ...getProvider("codex"), getCapabilities: () => ({ planMode: false }) } as AgentProvider;
    expect(resolveAgentCapabilities(provider)).toEqual({ planMode: false });
  });
});
