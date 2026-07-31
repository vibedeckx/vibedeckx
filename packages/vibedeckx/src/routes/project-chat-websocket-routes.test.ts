import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ userId: "user-1" as string | null }));
vi.mock("./ws-authz.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./ws-authz.js")>();
  return {
    ...original,
    authenticateWs: vi.fn(async () => ({ userId: auth.userId })),
  };
});

import websocketRoutes from "./websocket-routes.js";
import { ProjectChatManager, type ProjectChatModelRunner } from "../project-chat-manager.js";
import { createSqliteStorage } from "../storage/sqlite.js";
import type { Storage } from "../storage/types.js";

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { cleanup(); reject(error); };
    const onMessage = (raw: WebSocket.RawData) => {
      cleanup();
      resolve(JSON.parse(raw.toString()) as Record<string, unknown>);
    };
    const cleanup = () => {
      socket.off("error", onError);
      socket.off("message", onMessage);
    };
    socket.on("error", onError);
    socket.on("message", onMessage);
  });
}

describe("Project Chat WebSocket route", () => {
  let app: FastifyInstance;
  let storage: Storage;
  let manager: ProjectChatManager;
  let dir: string;
  let baseUrl: string;
  const sockets: WebSocket[] = [];

  async function build(projectChatManager: ProjectChatManager = manager) {
    const instance = Fastify({ logger: false });
    instance.decorate("authEnabled", true);
    instance.decorate("storage", storage);
    instance.decorate("projectChatManager", projectChatManager);
    instance.decorate("reverseConnectManager", { setStatusChangeHandler: vi.fn() } as never);
    instance.decorate("remoteSessionMap", new Map());
    instance.decorate("remotePatchCache", {} as never);
    await instance.register(fastifyWebsocket);
    await instance.register(websocketRoutes);
    await instance.listen({ host: "127.0.0.1", port: 0 });
    return instance;
  }

  async function connect(threadId: string) {
    const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/api/project-chat/threads/${threadId}/stream?token=test`);
    sockets.push(socket);
    const firstMessage = nextMessage(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return { socket, firstMessage };
  }

  beforeEach(async () => {
    auth.userId = "user-1";
    dir = mkdtempSync(path.join(tmpdir(), "vdx-project-chat-ws-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "project-1", name: "One", path: "/tmp/one" }, "user-1");
    await storage.projectChatThreads.create({
      id: "thread-1", project_id: "project-1", user_id: "user-1", title: "Status",
    });
    const runner: ProjectChatModelRunner = {
      async *run() { yield { type: "assistant", content: "live reply" }; },
    };
    manager = new ProjectChatManager(storage, runner);
    app = await build();
    baseUrl = app.listeningOrigin;
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.terminate();
    await app.close();
    await manager.shutdown();
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sends a complete authorized snapshot before persisted live messages", async () => {
    await storage.projectChatMessages.append({
      id: "existing", thread_id: "thread-1", project_id: "project-1", user_id: "user-1",
      sequence: 1, type: "user", content: "existing",
    });
    const { socket, firstMessage } = await connect("thread-1");

    const initial = await firstMessage;
    expect(initial.type).toBe("project_chat_snapshot");
    expect(initial.snapshot).toMatchObject({
      identity: { projectId: "project-1", threadId: "thread-1", userId: "user-1" },
      messages: [expect.objectContaining({ sequence: 1, content: "existing" })],
      status: "idle",
    });

    const liveFrames: Array<Record<string, unknown>> = [];
    socket.on("message", (raw) => liveFrames.push(JSON.parse(raw.toString())));
    await manager.sendMessage("thread-1", "user-1", "new question");
    await vi.waitFor(() => {
      expect(liveFrames.filter((frame) => frame.type === "project_chat_message")).toHaveLength(3);
    });

    for (const frame of liveFrames.filter((item) => item.type === "project_chat_message")) {
      const message = frame.message as { sequence: number };
      const persisted = await storage.projectChatMessages.listByThread("thread-1", "project-1", "user-1");
      expect(persisted.some((item) => item.sequence === message.sequence)).toBe(true);
    }
  });

  it("does not disclose or subscribe a foreign thread", async () => {
    auth.userId = "user-2";
    const { socket, firstMessage } = await connect("thread-1");

    await expect(firstMessage).resolves.toEqual({ error: "Thread not found" });
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  });

  it("unsubscribes when the socket closes", async () => {
    const cleanup = vi.fn();
    const fakeManager = {
      openThread: vi.fn().mockResolvedValue({
        identity: { projectId: "project-1", threadId: "thread-1", userId: "user-1" },
        thread: await storage.projectChatThreads.getOwnedById("thread-1", "user-1"),
        messages: [], status: "idle", queueLength: 0,
      }),
      subscribe: vi.fn((_threadId: string, socket: WebSocket) => {
        socket.send(JSON.stringify({ type: "project_chat_snapshot", snapshot: {} }));
        return cleanup;
      }),
    };
    await app.close();
    app = await build(fakeManager as never);
    baseUrl = app.listeningOrigin;
    const { socket, firstMessage } = await connect("thread-1");
    await firstMessage;

    socket.close();
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));

    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledOnce());
  });
});
