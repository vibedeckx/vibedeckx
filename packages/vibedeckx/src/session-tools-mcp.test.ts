import { afterEach, describe, it, expect, vi } from "vitest";
import {
  CANONICAL_PROPOSE_SCHEDULE_TOOL,
  CANONICAL_PROPOSE_TASK_TOOL,
  PROPOSE_TASK_MAX_ITEMS,
  SESSION_TOOLS_MCP_PATH,
  canonicalizeSessionToolName,
  mintRemoteSessionToolsMcpConfig,
  mintSessionToolsMcpConfig,
  parseProposeScheduleArgs,
  parseProposeTaskArgs,
  parseProposeTaskUpdateArgs,
  parseSessionToolsMcpConfig,
  sessionToolsInstructions,
  sessionToolsSystemPromptHint,
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
    expect(result).toEqual({
      ok: true,
      value: { name: "Watch it", cron_expr: valid.cron_expr, run_type: "prompt", content: valid.prompt, timezone: "UTC" },
    });
  });

  it("derives a command run from the command field", () => {
    const result = parseProposeScheduleArgs({ name: "Nightly build", cron_expr: "0 9 * * *", command: "pnpm test" });
    expect(result).toEqual({
      ok: true,
      value: { name: "Nightly build", cron_expr: "0 9 * * *", run_type: "command", content: "pnpm test" },
    });
  });

  it("rejects a proposal that is both kinds at once, or neither", () => {
    // Two contents can contradict each other; one field decides the kind.
    expect(parseProposeScheduleArgs({ ...valid, command: "pnpm test" }).ok).toBe(false);
    expect(parseProposeScheduleArgs({ name: "x", cron_expr: "0 9 * * *" }).ok).toBe(false);
    expect(parseProposeScheduleArgs({ name: "x", cron_expr: "0 9 * * *", command: "   " }).ok).toBe(false);
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
    expect(parseProposeScheduleArgs({ name: "x", cron_expr: "0 9 * * *", command: "x".repeat(20_001) }).ok).toBe(false);
    expect(parseProposeScheduleArgs({ ...valid, name: "x".repeat(201) }).ok).toBe(false);
  });
});

describe("parseProposeTaskArgs", () => {
  const item = { title: " Cover remote path ", description: "Add the remote retention test" };

  it("accepts and trims items, defaulting priority to medium", () => {
    expect(parseProposeTaskArgs({ tasks: [item, { ...item, priority: "High" }] })).toEqual({
      ok: true,
      value: [
        { title: "Cover remote path", description: "Add the remote retention test", priority: "medium" },
        { title: "Cover remote path", description: "Add the remote retention test", priority: "high" },
      ],
    });
  });

  it("rejects an empty, missing or oversized list", () => {
    expect(parseProposeTaskArgs({}).ok).toBe(false);
    expect(parseProposeTaskArgs({ tasks: [] }).ok).toBe(false);
    expect(parseProposeTaskArgs({ tasks: Array(PROPOSE_TASK_MAX_ITEMS + 1).fill(item) }).ok).toBe(false);
  });

  it("rejects items without a title or description, or with an unknown priority", () => {
    expect(parseProposeTaskArgs({ tasks: [{ ...item, title: "  " }] }).ok).toBe(false);
    expect(parseProposeTaskArgs({ tasks: [{ title: "x" }] }).ok).toBe(false);
    expect(parseProposeTaskArgs({ tasks: ["x"] }).ok).toBe(false);
    expect(parseProposeTaskArgs({ tasks: [{ ...item, priority: "critical" }] }).ok).toBe(false);
    expect(parseProposeTaskArgs({ tasks: [item], parent_task_id: 42 }).ok).toBe(false);
    expect(parseProposeTaskArgs({ tasks: [item], parent_task_id: "task-1" }).ok).toBe(true);
  });

  it("caps field lengths", () => {
    expect(parseProposeTaskArgs({ tasks: [{ ...item, title: "x".repeat(201) }] }).ok).toBe(false);
    expect(parseProposeTaskArgs({ tasks: [{ ...item, description: "x".repeat(20_001) }] }).ok).toBe(false);
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

  it("maps propose_task's shapes onto its own canonical name", () => {
    for (const reported of ["propose_task", "vibedeckx.propose_task", "mcp__vibedeckx__propose_task"]) {
      expect(canonicalizeSessionToolName(reported), reported).toBe(CANONICAL_PROPOSE_TASK_TOOL);
    }
    expect(canonicalizeSessionToolName("propose_task", "vibedeckx")).toBe(CANONICAL_PROPOSE_TASK_TOOL);
    expect(canonicalizeSessionToolName("propose_task", "elsewhere")).toBe("propose_task");
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

  it("binds the token to the session and project, dropping the solo sentinel", async () => {
    const config = await mintSessionToolsMcpConfig(
      { storage }, { sessionId: "sess-1", projectId: "p1", userId: "local", baseUrl: "http://127.0.0.1:5173/" },
    );
    expect(config?.url).toBe(`http://127.0.0.1:5173${SESSION_TOOLS_MCP_PATH}`);
    const secret = await storage.settings.getOrCreate("session_tools_token_secret", () => "unused");
    expect(verifySessionToolsToken(secret, config!.token, Date.now()))
      .toEqual({ sessionId: "sess-1", projectId: "p1", userId: null });
  });

  it("mints nothing without a usable base URL, session or project", async () => {
    const mint = (over: Record<string, unknown>) => mintSessionToolsMcpConfig({ storage }, {
      sessionId: "s", projectId: "p", userId: "u", baseUrl: "http://127.0.0.1:1", ...over,
    });
    expect(await mint({ baseUrl: null })).toBeUndefined();
    expect(await mint({ baseUrl: "ftp://x" })).toBeUndefined();
    expect(await mint({ sessionId: "" })).toBeUndefined();
    expect(await mint({ projectId: "" })).toBeUndefined();
  });
});

describe("mintRemoteSessionToolsMcpConfig", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("points remote sessions at the public URL, and is off without one", async () => {
    const storage = storageStub();
    vi.stubEnv("VIBEDECKX_PUBLIC_URL", "");
    expect(await mintRemoteSessionToolsMcpConfig({ storage }, { sessionId: "remote-x", projectId: "p1", userId: "u" })).toBeUndefined();
    vi.stubEnv("VIBEDECKX_PUBLIC_URL", "https://app.example.com");
    const config = await mintRemoteSessionToolsMcpConfig({ storage }, { sessionId: "remote-x", projectId: "p1", userId: "u" });
    expect(config!.url).toBe(`https://app.example.com${SESSION_TOOLS_MCP_PATH}`);
    expect(await mintRemoteSessionToolsMcpConfig({ storage }, { sessionId: "remote-x", projectId: null, userId: "u" })).toBeUndefined();
  });
});

describe("parseSessionToolsMcpConfig", () => {
  it("accepts only a well-formed config, never a proposals-only flag from the wire", () => {
    expect(parseSessionToolsMcpConfig({ url: "https://h/api", token: "t", proposalsOnly: true })).toEqual({ url: "https://h/api", token: "t" });
    expect(parseSessionToolsMcpConfig({ url: "file:///x", token: "t" })).toBeUndefined();
    expect(parseSessionToolsMcpConfig({ url: "https://h", token: "" })).toBeUndefined();
    expect(parseSessionToolsMcpConfig("nope")).toBeUndefined();
  });
});

describe("parseProposeTaskUpdateArgs", () => {
  it("accepts partial updates and keeps only the given fields", () => {
    const parsed = parseProposeTaskUpdateArgs({
      updates: [{ task_id: " t1 ", status: "done" }, { task_id: "t2", title: " New ", priority: "high" }],
    });
    expect(parsed).toEqual({
      ok: true,
      value: [{ task_id: "t1", status: "done" }, { task_id: "t2", title: "New", priority: "high" }],
    });
  });

  it.each([
    [{}, "non-empty"],
    [{ updates: [] }, "non-empty"],
    [{ updates: Array.from({ length: 11 }, (_, i) => ({ task_id: `t${i}`, status: "done" })) }, "at most"],
    [{ updates: [{ status: "done" }] }, "task_id"],
    [{ updates: [{ task_id: "t1" }] }, "changes nothing"],
    [{ updates: [{ task_id: "t1", status: "closed" }] }, "status"],
    [{ updates: [{ task_id: "t1", priority: "p0" }] }, "priority"],
    [{ updates: [{ task_id: "t1", title: "  " }] }, "title"],
    [{ updates: [{ task_id: "t1", description: "" }] }, "description"],
    [{ updates: [{ task_id: "t1", status: "done" }, { task_id: "t1", title: "x" }] }, "more than once"],
  ])("rejects %j", (args, message) => {
    const parsed = parseProposeTaskUpdateArgs(args as Record<string, unknown>);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain(message);
  });
});

describe("instructions", () => {
  it("mention the task tools only when they are served", () => {
    expect(sessionToolsInstructions()).toContain("mcp__vibedeckx__list_tasks");
    expect(sessionToolsInstructions(true)).not.toContain("list_tasks");
    expect(sessionToolsInstructions(true)).toContain("propose_task");
    expect(sessionToolsSystemPromptHint(true)).not.toContain("propose_task_update");
  });
});
