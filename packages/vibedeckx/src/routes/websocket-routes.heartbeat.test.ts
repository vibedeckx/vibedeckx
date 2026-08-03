import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

const attached = vi.hoisted(() => [] as Array<{ label: string; keepalive?: boolean }>);
vi.mock("../utils/ws-heartbeat.js", () => ({
  attachWsHeartbeat: (_socket: unknown, opts: { label: string; keepalive?: boolean }) => {
    attached.push(opts);
    return () => {};
  },
}));

import websocketRoutes from "./websocket-routes.js";

/**
 * The `{ keepalive }` frame is application-level traffic on a stream whose
 * clients do not tolerate unknown shapes: Project Chat throws on one and fails
 * the socket, the executor mux dereferences `.data.length`, the single-process
 * stream appends it to the terminal. Only `use-agent-session` recognises it (it
 * needs an observable frame to reset its silence watchdog), so exactly one
 * endpoint may opt in. Asserting the wiring keeps a future endpoint from
 * enabling it by accident — the protocol-level ping/pong liveness that actually
 * reaps dead sockets is unconditional and unaffected.
 */
describe("WebSocket heartbeat wiring", () => {
  let app: FastifyInstance | undefined;
  const sockets: WebSocket[] = [];

  async function build(): Promise<FastifyInstance> {
    const instance = Fastify({ logger: false });
    instance.decorate("authEnabled", false);
    instance.decorate("storage", {
      // Owned by the connecting principal, so the handler reaches its heartbeat.
      projects: { getById: async () => ({ id: "project-1" }) },
      agentSessions: { getById: async () => ({ id: "local-session", project_id: "project-1" }) },
      executorProcesses: { getById: async () => undefined },
      executors: { getById: async () => undefined },
    } as never);
    instance.decorate("processManager", {
      getProcessProjectId: () => "remote",
      isPtyProcess: () => true,
      getLogs: () => [],
      isRunning: () => true,
      subscribe: () => () => {},
      handleInput: vi.fn(),
    } as never);
    instance.decorate("agentSessionManager", { subscribe: () => () => {} } as never);
    instance.decorate("reverseConnectManager", { setStatusChangeHandler: vi.fn() } as never);
    instance.decorate("remoteSessionMap", new Map());
    instance.decorate("remotePatchCache", {} as never);
    instance.decorate("remoteExecutorMap", new Map());
    await instance.register(fastifyWebsocket);
    await instance.register(websocketRoutes);
    await instance.listen({ host: "127.0.0.1", port: 0 });
    return instance;
  }

  /** Connect and wait until the route handler has run far enough to arm its heartbeat. */
  async function connect(instance: FastifyInstance, path: string): Promise<void> {
    const socket = new WebSocket(`${instance.listeningOrigin.replace("http", "ws")}${path}`);
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    await vi.waitFor(() => expect(attached.length).toBeGreaterThan(0));
  }

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    sockets.length = 0;
    attached.length = 0;
    await app?.close();
    app = undefined;
  });

  it("opts the agent-session stream into keepalive frames", async () => {
    app = await build();
    await connect(app, "/api/agent-sessions/local-session/stream");
    expect(attached).toHaveLength(1);
    expect(attached[0]).toMatchObject({ keepalive: true });
  });

  it("leaves executor log streams on protocol-level heartbeat only", async () => {
    app = await build();
    await connect(app, "/api/executor-processes/terminal-1/logs");
    expect(attached).toHaveLength(1);
    expect(attached[0].keepalive ?? false).toBe(false);
  });

  it("leaves the multiplexed executor stream on protocol-level heartbeat only", async () => {
    app = await build();
    await connect(app, "/api/executor-logs/stream");
    expect(attached).toHaveLength(1);
    expect(attached[0].keepalive ?? false).toBe(false);
  });
});
