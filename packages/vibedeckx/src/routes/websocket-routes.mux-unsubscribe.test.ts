import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@clerk/backend", () => ({ verifyToken: async () => ({ sub: "owner" }) }));

import websocketRoutes from "./websocket-routes.js";

/**
 * Tearing a stream down is asynchronous and — for a remote process — not
 * silent: `attachRemoteProcessStream` fabricates `finished` when the proxy
 * channel closes, because a closed channel is indistinguishable from a process
 * that exited. When the close was the client's own `unsubscribe`, that frame
 * used to land on the still-open mux socket, and the browser marked a
 * still-running remote executor as stopped (black Start button under live
 * output, while `/api/executor-processes/running` still listed it).
 *
 * These tests pin the contract at the seam: once a client unsubscribes, nothing
 * from that subscription reaches it again. A local process stands in for the
 * remote one — what matters is that the stream emits after cleanup.
 */
describe("executor mux unsubscribe", () => {
  let app: FastifyInstance | undefined;
  const sockets: WebSocket[] = [];

  /**
   * One entry per attached stream, in attach order. Emitting into an *earlier*
   * entry after a re-subscribe is how a late teardown of a dropped
   * subscription is modelled — the remote path fires its terminal callback
   * only after reading the process row, so it can land arbitrarily late.
   */
  const emits: Array<(msg: Record<string, unknown>) => void> = [];
  const emit = (msg: Record<string, unknown>) => emits[emits.length - 1]?.(msg);
  /** Index of every stream whose cleanup ran. */
  const cleanedStreams: number[] = [];
  let subscribeCalls = 0;

  async function build(options: {
    authEnabled: boolean;
    /** Gate the ownership check to model a subscribe that is still in flight. */
    ownershipGate?: Promise<void>;
  }) {
    const instance = Fastify({ logger: false });
    instance.decorate("authEnabled", options.authEnabled);
    instance.decorate("storage", {
      projects: {
        getById: async () => {
          await options.ownershipGate;
          return { id: "proj1" };
        },
      },
      executorProcesses: { getById: async () => undefined },
      executors: { getById: async () => undefined },
    } as never);
    instance.decorate("processManager", {
      getProcessProjectId: () => "proj1",
      isPtyProcess: () => false,
      getLogs: () => [{ type: "stdout", data: "hello" }],
      isRunning: () => true,
      subscribe: (_processId: string, cb: (msg: Record<string, unknown>) => void) => {
        subscribeCalls += 1;
        const index = emits.push(cb) - 1;
        // Cleanup deliberately does not stop the callback: the remote path's
        // cleanup is likewise just a channel close, with the fabricated frame
        // arriving after it.
        return () => { cleanedStreams.push(index); };
      },
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

  function connect(instance: FastifyInstance, query = ""): WebSocket {
    const socket = new WebSocket(
      `${instance.listeningOrigin.replace("http", "ws")}/api/executor-logs/stream?projectId=proj1${query}`,
    );
    sockets.push(socket);
    return socket;
  }

  /** Collects every frame the server sends, in order. */
  function collect(socket: WebSocket): Array<Record<string, unknown>> {
    const frames: Array<Record<string, unknown>> = [];
    socket.on("message", (raw: WebSocket.RawData) =>
      frames.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    return frames;
  }

  /**
   * Resolve once the route handler is actually listening: the handler awaits
   * authentication before it registers its `message` listener, and `ws` drops
   * frames that arrive with no listener attached. Sending straight after `open`
   * would race that window and silently deliver nothing.
   */
  const attached = async (socket: WebSocket) => {
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    await settle();
  };

  /** Let queued frames and the server's async subscribe path settle. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

  afterEach(async () => {
    for (const socket of sockets) socket.close();
    sockets.length = 0;
    emits.length = 0;
    cleanedStreams.length = 0;
    subscribeCalls = 0;
    await app?.close();
    app = undefined;
  });

  it("delivers nothing after the client unsubscribes", async () => {
    app = await build({ authEnabled: false });
    const socket = connect(app);
    const frames = collect(socket);
    await attached(socket);

    socket.send(JSON.stringify({ type: "subscribe", processId: "p1" }));
    await settle();
    expect(frames.map((f) => f.type)).toEqual(["init", "stdout", "history_end"]);

    socket.send(JSON.stringify({ type: "unsubscribe", processId: "p1" }));
    await settle();
    frames.length = 0;

    // The teardown's late frame — this is the fabricated `finished` in the
    // remote case, and it must not reach the browser.
    emit({ type: "finished", exitCode: 0 });
    await settle();

    expect(frames).toEqual([]);
  });

  it("keeps a re-subscription intact when the dropped stream terminates late", async () => {
    app = await build({ authEnabled: false });
    const socket = connect(app);
    const frames = collect(socket);
    await attached(socket);

    socket.send(JSON.stringify({ type: "subscribe", processId: "p1" }));
    await settle();
    socket.send(JSON.stringify({ type: "unsubscribe", processId: "p1" }));
    await settle();

    // Straight back — an executor item that unmounts and remounts on a view
    // switch. The dropped stream's teardown is still in flight.
    socket.send(JSON.stringify({ type: "subscribe", processId: "p1" }));
    await settle();
    expect(emits).toHaveLength(2);
    frames.length = 0;

    // The dropped stream terminates now. It must not evict or tear down the
    // subscription that took its slot.
    emits[0]({ type: "finished", exitCode: 0 });
    await settle();

    expect(frames).toEqual([]);
    expect(cleanedStreams).not.toContain(1);

    // …and the live one must still be registered, so dropping it detaches it:
    // otherwise its own teardown frame reaches the browser and stops a running
    // executor, which is the whole defect.
    socket.send(JSON.stringify({ type: "unsubscribe", processId: "p1" }));
    await settle();
    frames.length = 0;

    emits[1]({ type: "finished", exitCode: 0 });
    await settle();

    expect(frames).toEqual([]);
  });

  it("does not attach a stream when unsubscribe overtakes a pending subscribe", async () => {
    let openGate = () => {};
    const ownershipGate = new Promise<void>((resolve) => { openGate = () => resolve(); });
    app = await build({ authEnabled: true, ownershipGate });

    const socket = connect(app, "&token=valid");
    const frames = collect(socket);
    await attached(socket);

    socket.send(JSON.stringify({ type: "subscribe", processId: "p1" }));
    socket.send(JSON.stringify({ type: "unsubscribe", processId: "p1" }));
    await settle();

    openGate();
    await settle();

    expect(subscribeCalls).toBe(0);
    expect(frames).toEqual([]);
  });

  it("still streams a subscription the client kept", async () => {
    app = await build({ authEnabled: false });
    const socket = connect(app);
    const frames = collect(socket);
    await attached(socket);

    socket.send(JSON.stringify({ type: "subscribe", processId: "p1" }));
    await settle();
    frames.length = 0;

    emit({ type: "finished", exitCode: 0 });
    await settle();

    expect(frames).toEqual([{ processId: "p1", type: "finished", exitCode: 0 }]);
  });
});
