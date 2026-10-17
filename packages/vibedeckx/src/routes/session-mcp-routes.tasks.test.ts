import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";
import { getSessionToolsSecret, signSessionToolsToken } from "../utils/session-tools-token.js";
import { getCrossRemoteSecret, signCrossRemoteToken } from "../utils/cross-remote-token.js";
import {
  GET_TASK_TOOL,
  LIST_TASKS_TOOL,
  PROPOSE_SCHEDULE_TOOL,
  PROPOSE_TASK_TOOL,
  PROPOSE_TASK_UPDATE_TOOL,
  SESSION_TOOLS_MCP_PATH,
} from "../session-tools-mcp.js";
import sessionMcpRoutes from "./session-mcp-routes.js";

describe("session MCP endpoint: project tasks", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let dir: string;
  let secret: string;
  let alive: boolean;
  let remoteSessions: Map<string, unknown>;

  const rpc = (token: string | null, body: unknown) =>
    app.inject({
      method: "POST",
      url: SESSION_TOOLS_MCP_PATH,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      payload: body as object,
    });

  const call = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const res = await rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    expect(res.statusCode).toBe(200);
    const result = res.json().result as { content: Array<{ text: string }>; isError?: boolean };
    return { text: result.content[0].text, isError: result.isError === true };
  };

  const tokenFor = (opts: { sessionId?: string; projectId?: string; userId?: string | null } = {}) =>
    signSessionToolsToken(secret, {
      sessionId: opts.sessionId ?? "sess-1",
      projectId: opts.projectId ?? "project-1",
      userId: opts.userId === undefined ? "user-1" : opts.userId,
    }, Date.now());

  const build = async (opts: { worker?: boolean } = {}) => {
    await app?.close();
    app = Fastify();
    app.decorate("storage", storage);
    app.decorate("agentSessionManager", { getSessionProcessAlive: () => alive } as never);
    app.decorate("remoteSessionMap", remoteSessions as never);
    app.decorate("isReverseConnectWorker", opts.worker === true);
    await app.register(sessionMcpRoutes);
    await app.ready();
  };

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-taskmcp-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    secret = await getSessionToolsSecret(storage);
    alive = true;
    remoteSessions = new Map();

    await storage.projects.create({ id: "project-1", name: "Mine", path: "/tmp/mine" }, "user-1");
    await storage.projects.create({ id: "project-2", name: "Other", path: "/tmp/other" }, "user-1");
    await storage.tasks.create({ id: "t-open", project_id: "project-1", title: "Open task", description: "Do the thing" });
    await storage.tasks.create({ id: "t-child", project_id: "project-1", title: "Child", description: "Sub", parent_id: "t-open", status: "in_progress" });
    await storage.tasks.create({ id: "t-done", project_id: "project-1", title: "Finished", description: "Done already", status: "done" });
    await storage.tasks.create({ id: "t-foreign", project_id: "project-2", title: "Elsewhere", description: "Not yours" });

    await build();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("authentication", () => {
    const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };

    it("rejects a missing, forged or expired token", async () => {
      expect((await rpc(null, list)).statusCode).toBe(401);
      const forged = signSessionToolsToken("wrong", { sessionId: "sess-1", projectId: "project-1", userId: "user-1" }, Date.now());
      expect((await rpc(forged, list)).statusCode).toBe(401);
      const expired = signSessionToolsToken(secret, { sessionId: "sess-1", projectId: "project-1", userId: "user-1" }, Date.now() - 1, 1);
      expect((await rpc(expired, list)).statusCode).toBe(401);
    });

    it("rejects a cross-remote token — the audiences never overlap", async () => {
      const other = signCrossRemoteToken(
        await getCrossRemoteSecret(storage), { userId: "user-1", sessionId: "sess-1", sourceRemoteServerId: null }, Date.now(),
      );
      expect((await rpc(other, list)).statusCode).toBe(401);
    });

    it("rejects a token whose session is gone", async () => {
      alive = false;
      expect((await rpc(tokenFor(), list)).statusCode).toBe(401);
    });

    it("accepts a remote session only while the hub still maps it", async () => {
      const token = tokenFor({ sessionId: "remote-srv-project-1-abc" });
      alive = false;
      expect((await rpc(token, list)).statusCode).toBe(401);
      remoteSessions.set("remote-srv-project-1-abc", {});
      expect((await rpc(token, list)).statusCode).toBe(200);
    });

    it("rejects a token for a project its user no longer owns", async () => {
      expect((await rpc(tokenFor({ userId: "user-2" }), list)).statusCode).toBe(401);
    });

    it("states the task tools in the server instructions", async () => {
      const init = (await rpc(tokenFor(), { jsonrpc: "2.0", id: 1, method: "initialize" })).json().result;
      expect(init.instructions).toContain("mcp__vibedeckx__list_tasks");
      expect(init.instructions).toContain("mcp__vibedeckx__propose_task_update");
    });
  });

  describe("list_tasks", () => {
    it("lists open tasks of the token's project by default", async () => {
      const { text, isError } = await call(tokenFor(), LIST_TASKS_TOOL);
      expect(isError).toBe(false);
      const ids = JSON.parse(text).tasks.map((t: { id: string }) => t.id);
      expect(ids.sort()).toEqual(["t-child", "t-open"]);
    });

    it("filters by status and query", async () => {
      expect(JSON.parse((await call(tokenFor(), LIST_TASKS_TOOL, { status: "all" })).text).tasks).toHaveLength(3);
      expect(JSON.parse((await call(tokenFor(), LIST_TASKS_TOOL, { status: "done" })).text).tasks[0].id).toBe("t-done");
      const found = JSON.parse((await call(tokenFor(), LIST_TASKS_TOOL, { status: "all", query: "finish" })).text).tasks;
      expect(found.map((t: { id: string }) => t.id)).toEqual(["t-done"]);
    });

    it("rejects an unknown status or a bad offset", async () => {
      expect((await call(tokenFor(), LIST_TASKS_TOOL, { status: "bogus" })).isError).toBe(true);
      expect((await call(tokenFor(), LIST_TASKS_TOOL, { offset: -1 })).isError).toBe(true);
      expect((await call(tokenFor(), LIST_TASKS_TOOL, { offset: 1.5 })).isError).toBe(true);
    });

    it("pages past 50 matches until every task is read once", async () => {
      for (let i = 0; i < 120; i++) {
        await storage.tasks.create({ id: `bulk-${String(i).padStart(3, "0")}`, project_id: "project-1", title: `Bulk ${i}`, description: "x" });
      }
      const seen: string[] = [];
      let offset: number | undefined;
      let pages = 0;
      do {
        const page = JSON.parse((await call(tokenFor(), LIST_TASKS_TOOL, offset === undefined ? {} : { offset })).text);
        seen.push(...page.tasks.map((t: { id: string }) => t.id));
        offset = page.next_offset;
        pages++;
      } while (offset !== undefined);
      expect(pages).toBe(3);
      expect(seen).toHaveLength(122);
      expect(new Set(seen).size).toBe(122);
    });

    it("marks tasks proposed from this session", async () => {
      await storage.tasks.create({
        id: "t-mine", project_id: "project-1", title: "Mine", description: "x",
        source: { session_id: "sess-1", tool_use_id: "toolu_1", item_index: 0 },
      });
      const tasks = JSON.parse((await call(tokenFor(), LIST_TASKS_TOOL)).text).tasks;
      expect(tasks.find((t: { id: string }) => t.id === "t-mine").proposed_in_this_session).toBe(true);
      expect(tasks.find((t: { id: string }) => t.id === "t-open").proposed_in_this_session).toBeUndefined();
    });
  });

  describe("get_task", () => {
    it("returns the full task with parent and sub-tasks", async () => {
      const parent = JSON.parse((await call(tokenFor(), GET_TASK_TOOL, { task_id: "t-open" })).text);
      expect(parent).toMatchObject({ id: "t-open", description: "Do the thing", parent: null });
      expect(parent.subtasks).toEqual([{ id: "t-child", title: "Child", status: "in_progress" }]);
      const child = JSON.parse((await call(tokenFor(), GET_TASK_TOOL, { task_id: "t-child" })).text);
      expect(child.parent).toEqual({ id: "t-open", title: "Open task" });
    });

    it("never reaches another project's task", async () => {
      const { text, isError } = await call(tokenFor(), GET_TASK_TOOL, { task_id: "t-foreign" });
      expect(isError).toBe(true);
      expect(text).not.toContain("Not yours");
    });
  });

  describe("propose_task_update", () => {
    it("acknowledges a valid proposal without changing anything", async () => {
      const { text, isError } = await call(tokenFor(), PROPOSE_TASK_UPDATE_TOOL, {
        updates: [{ task_id: "t-open", status: "done" }, { task_id: "t-child", title: "Renamed" }],
      });
      expect(isError).toBe(false);
      expect(text).toContain("PROPOSED");
      expect((await storage.tasks.getById("t-open"))!.status).toBe("todo");
      expect((await storage.tasks.getById("t-child"))!.title).toBe("Child");
    });

    it("rejects a proposal in which no entry changes anything", async () => {
      expect((await call(tokenFor(), PROPOSE_TASK_UPDATE_TOOL, { updates: [{ task_id: "nope", status: "done" }] })).isError).toBe(true);
      expect((await call(tokenFor(), PROPOSE_TASK_UPDATE_TOOL, { updates: [{ task_id: "t-foreign", status: "done" }] })).isError).toBe(true);
      const { text, isError } = await call(tokenFor(), PROPOSE_TASK_UPDATE_TOOL, {
        updates: [{ task_id: "t-done", status: "done" }],
      });
      expect(isError).toBe(true);
      expect(text).toContain("already");
    });

    it("keeps the valid entries of a mixed batch and reports the skipped ones", async () => {
      // The card shows the valid row as applicable, so the tool must not
      // tell the agent the whole proposal failed.
      const { text, isError } = await call(tokenFor(), PROPOSE_TASK_UPDATE_TOOL, {
        updates: [{ task_id: "t-open", status: "done" }, { task_id: "nope", status: "done" }, { task_id: "t-done", status: "done" }],
      });
      expect(isError).toBe(false);
      expect(text).toContain("PROPOSED");
      expect(text).toContain("updates[1]: task nope not found");
      expect(text).toContain("updates[2]: task t-done already has these values");
      expect(text).not.toContain("updates[0]");
    });

    it("rejects a malformed proposal", async () => {
      expect((await call(tokenFor(), PROPOSE_TASK_UPDATE_TOOL, { updates: [{ task_id: "t-open" }] })).isError).toBe(true);
      expect((await call(tokenFor(), PROPOSE_TASK_UPDATE_TOOL, { updates: [{ task_id: "t-open", status: "closed" }] })).isError).toBe(true);
    });
  });
  describe("propose_task with the project's tasks at hand", () => {
    const proposeTask = (args: Record<string, unknown>) => call(tokenFor(), PROPOSE_TASK_TOOL, args);

    it("acknowledges plainly when the parent exists and nothing looks duplicated", async () => {
      const { text, isError } = await proposeTask({ tasks: [{ title: "Brand new", description: "x" }], parent_task_id: "t-open" });
      expect(isError).toBe(false);
      expect(text).not.toContain("Note:");
    });

    it("notes a parent outside the project instead of failing — the card files without one", async () => {
      for (const parent of ["nope", "t-foreign"]) {
        const { text, isError } = await proposeTask({ tasks: [{ title: "Brand new", description: "x" }], parent_task_id: parent });
        expect(isError, parent).toBe(false);
        expect(text).toContain(`parent_task_id ${parent} is not a task of this project`);
      }
    });

    it("notes a title that matches an existing task", async () => {
      const { text, isError } = await proposeTask({ tasks: [{ title: " open TASK ", description: "x" }] });
      expect(isError).toBe(false);
      expect(text).toContain("same title as existing task t-open");
    });
  });

  describe("on a reverse-connect worker", () => {
    beforeEach(async () => { await build({ worker: true }); });

    it("serves only the two proposals, without consulting its own projects", async () => {
      const token = tokenFor({ projectId: "worker-path-project" });
      const tools = (await rpc(token, { jsonrpc: "2.0", id: 1, method: "tools/list" })).json().result.tools;
      expect(tools.map((t: { name: string }) => t.name)).toEqual([PROPOSE_SCHEDULE_TOOL, PROPOSE_TASK_TOOL]);
      const init = (await rpc(token, { jsonrpc: "2.0", id: 1, method: "initialize" })).json().result;
      expect(init.instructions).not.toContain("list_tasks");

      expect((await call(token, LIST_TASKS_TOOL)).isError).toBe(true);
      const proposed = await call(token, PROPOSE_TASK_TOOL, { tasks: [{ title: "Open task", description: "x" }], parent_task_id: "nope" });
      expect(proposed.isError).toBe(false);
      expect(proposed.text).not.toContain("Note:");
    });
  });
});
