import { describe, it, expect } from "vitest";
import {
  CANONICAL_PROPOSE_SCHEDULE_TOOL,
  SESSION_TOOLS_MCP_PATH,
  canonicalizeSessionToolName,
  mintSessionToolsMcpConfig,
  parseProposeScheduleArgs,
} from "./session-tools-mcp.js";
import { verifySessionToolsToken } from "./utils/session-tools-token.js";

const storageStub = () => {
  const values = new Map<string, string>();
  return {
    settings: {
      getOrCreate: async (key: string, create: () => string) => {
        if (!values.has(key)) values.set(key, create());
        return values.get(key)!;
      },
    },
  } as never;
};

describe("parseProposeScheduleArgs", () => {
  const valid = { name: "Watch it", cron_expr: "0 9 * * *", prompt: "check the thing" };

  it("accepts and trims a valid proposal", () => {
    const result = parseProposeScheduleArgs({ ...valid, name: "  Watch it  ", timezone: " UTC " });
    expect(result).toEqual({ ok: true, value: { ...valid, timezone: "UTC" } });
  });

  it("omits timezone when not supplied — the card falls back to the browser's", () => {
    const result = parseProposeScheduleArgs(valid);
    expect(result.ok && result.value.timezone).toBeUndefined();
  });

  it("rejects missing or blank required fields", () => {
    for (const args of [{}, { ...valid, name: "  " }, { ...valid, cron_expr: "" }, { ...valid, prompt: "  " }]) {
      expect(parseProposeScheduleArgs(args).ok).toBe(false);
    }
  });

  it("rejects non-string fields rather than coercing them", () => {
    expect(parseProposeScheduleArgs({ ...valid, name: 42 }).ok).toBe(false);
    expect(parseProposeScheduleArgs({ ...valid, prompt: { a: 1 } }).ok).toBe(false);
  });

  it("caps field lengths", () => {
    expect(parseProposeScheduleArgs({ ...valid, prompt: "x".repeat(20_001) }).ok).toBe(false);
    expect(parseProposeScheduleArgs({ ...valid, name: "x".repeat(201) }).ok).toBe(false);
  });
});

describe("canonicalizeSessionToolName", () => {
  it("maps every shape the CLIs are known to report onto one name", () => {
    for (const reported of [
      "propose_schedule",
      "vibedeckx.propose_schedule",
      "vibedeckx/propose_schedule",
      "vibedeckx__propose_schedule",
      "vibedeckx-propose_schedule",
      "mcp__vibedeckx__propose_schedule",
      "  Propose_Schedule  ",
    ]) {
      expect(canonicalizeSessionToolName(reported), reported).toBe(CANONICAL_PROPOSE_SCHEDULE_TOOL);
    }
  });

  it("leaves other tools alone, including a same-named tool from another server", () => {
    for (const other of ["Bash", "mcp__cross-remote__remote_bash", "mcp__other__propose_schedule"]) {
      expect(canonicalizeSessionToolName(other), other).toBe(other);
    }
  });

  it("defers to the reporting server when the provider names one (codex)", () => {
    expect(canonicalizeSessionToolName("propose_schedule", "vibedeckx")).toBe(CANONICAL_PROPOSE_SCHEDULE_TOOL);
    // Another MCP server may legitimately expose a tool by the same bare name.
    expect(canonicalizeSessionToolName("propose_schedule", "some-other-server")).toBe("propose_schedule");
  });
});

describe("mintSessionToolsMcpConfig", () => {
  const storage = storageStub();

  it("mints a loopback URL and a token that verifies for that session", async () => {
    const config = await mintSessionToolsMcpConfig(
      { storage }, { sessionId: "sess-1", origin: "http://127.0.0.1:5173" },
    );
    expect(config?.url).toBe(`http://127.0.0.1:5173${SESSION_TOOLS_MCP_PATH}`);
    const secret = await storage.settings.getOrCreate("session_tools_token_secret", () => "unused");
    expect(verifySessionToolsToken(secret, config!.token, Date.now())).toEqual({ sessionId: "sess-1" });
  });

  it("mints nothing without an origin, or under local TLS", async () => {
    // https on loopback can't pass hostname verification against a public cert;
    // the tool is simply not offered rather than offered broken.
    expect(await mintSessionToolsMcpConfig({ storage }, { sessionId: "s", origin: null })).toBeUndefined();
    expect(await mintSessionToolsMcpConfig({ storage }, { sessionId: "s", origin: "https://127.0.0.1:443" })).toBeUndefined();
    expect(await mintSessionToolsMcpConfig({ storage }, { sessionId: "", origin: "http://127.0.0.1:1" })).toBeUndefined();
  });
});
