import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/backend", () => ({ verifyToken: async () => ({ sub: "intruder" }) }));

import websocketRoutes from "./websocket-routes.js";

/**
 * The reverse-connect worker runs with auth disabled and streams its process
 * logs back to the front server over a tunnelled WebSocket to
 * `/api/executor-processes/:id/logs`. Those processes are provider-owned: a
 * worker-side terminal or an executor driven entirely from the front server has
 * no `projects` row on the worker to be owned by. Scoping the solo principal to
 * the `local` tenant therefore closes the tunnel with "Forbidden" the moment it
 * attaches, and the front server turns that close into a fabricated `finished`.
 */
describe("executor-process log WebSocket ownership", () => {
  let app: FastifyInstance | undefined;
  const sockets: WebSocket[] = [];

  async function build(options: { authEnabled: boolean; projectId: string | null }) {
    const instance = Fastify({ logger: false });
    instance.decorate("authEnabled", options.authEnabled);
    instance.decorate("storage", {
      // No project matches — mirrors a provider-owned process on the worker.
      projects: { getById: async () => undefined },
      executorProcesses: { getById: async () => undefined },
      executors: { getById: async () => undefined },
    } as never);
    instance.decorate("processManager", {
      getProcessProjectId: () => options.projectId,
      isPtyProcess: () => true,
      getLogs: () => [{ type: "stdout", data: "hello" }],
      isRunning: () => true,
      subscribe: () => () => {},
      handleInput: vi.fn(),
    } as never);
    instance.decorate("reverseConnectManager", { setStatusChangeHandler: vi.fn() } as never);
    instance.decorate("remoteSessionMap", new Map());
    instance.decorate("remotePatchCache", {} as never);
    instance.decorate("remoteExecutorMap", new Map());
    await instance.register(fastifyWebsocket);
    await instance.register(websocketRoutes);
    await instance.listen({ host: "127.0.0.1", port: 0 });
    return instance;
  }

  function firstMessage(socket: WebSocket): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      socket.once("message", (raw: WebSocket.RawData) =>
        resolve(JSON.parse(raw.toString()) as Record<string, unknown>));
      socket.once("error", reject);
    });
  }

  function connect(instance: FastifyInstance, processId: string, query = ""): WebSocket {
    const socket = new WebSocket(
      `${instance.listeningOrigin.replace("http", "ws")}/api/executor-processes/${processId}/logs${query}`,
    );
    sockets.push(socket);
    return socket;
  }

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    sockets.length = 0;
    await app?.close();
    app = undefined;
  });

  it("streams a provider-owned process to the solo principal", async () => {
    app = await build({ authEnabled: false, projectId: "remote" });

    const message = await firstMessage(connect(app, "terminal-1"));

    expect(message).toEqual({ type: "init", isPty: true });
  });

  it("still refuses a process an authenticated user does not own", async () => {
    app = await build({ authEnabled: true, projectId: "someone-elses-project" });

    const message = await firstMessage(connect(app, "terminal-1", "?token=stolen"));

    expect(message).toEqual({ error: "Forbidden" });
  });
});
