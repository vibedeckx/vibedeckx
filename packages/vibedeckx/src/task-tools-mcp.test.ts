import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mintRemoteTaskToolsMcpConfig,
  mintTaskToolsMcpConfig,
  parseProposeTaskUpdateArgs,
  parseTaskToolsMcpConfig,
  TASK_TOOLS_MCP_PATH,
} from "./task-tools-mcp.js";
import { verifyTaskToolsToken } from "./utils/task-tools-token.js";

const storage = {
  storage: { settings: { getOrCreate: async (_key: string, make: () => string) => (secret ??= make()) } },
} as never;
let secret: string | undefined;

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

describe("minting", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("binds the token to the session and project, dropping the solo sentinel", async () => {
    const config = await mintTaskToolsMcpConfig(storage, {
      sessionId: "s1", projectId: "p1", userId: "local", baseUrl: "http://127.0.0.1:5173/",
    });
    expect(config!.url).toBe(`http://127.0.0.1:5173${TASK_TOOLS_MCP_PATH}`);
    expect(verifyTaskToolsToken(secret!, config!.token, Date.now()))
      .toEqual({ sessionId: "s1", projectId: "p1", userId: null });
  });

  it("offers nothing without a usable base URL", async () => {
    expect(await mintTaskToolsMcpConfig(storage, { sessionId: "s1", projectId: "p1", userId: "u", baseUrl: null })).toBeUndefined();
    expect(await mintTaskToolsMcpConfig(storage, { sessionId: "s1", projectId: "p1", userId: "u", baseUrl: "ftp://x" })).toBeUndefined();
  });

  it("points remote sessions at the public URL, and is off without one", async () => {
    vi.stubEnv("VIBEDECKX_PUBLIC_URL", "");
    expect(await mintRemoteTaskToolsMcpConfig(storage, { sessionId: "remote-x", projectId: "p1", userId: "u" })).toBeUndefined();
    vi.stubEnv("VIBEDECKX_PUBLIC_URL", "https://app.example.com");
    const config = await mintRemoteTaskToolsMcpConfig(storage, { sessionId: "remote-x", projectId: "p1", userId: "u" });
    expect(config!.url).toBe(`https://app.example.com${TASK_TOOLS_MCP_PATH}`);
  });

  it("parses only a well-formed config from a request body", () => {
    expect(parseTaskToolsMcpConfig({ url: "https://h/api", token: "t" })).toEqual({ url: "https://h/api", token: "t" });
    expect(parseTaskToolsMcpConfig({ url: "file:///x", token: "t" })).toBeUndefined();
    expect(parseTaskToolsMcpConfig({ url: "https://h", token: "" })).toBeUndefined();
    expect(parseTaskToolsMcpConfig("nope")).toBeUndefined();
  });
});
