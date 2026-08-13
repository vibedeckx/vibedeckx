import { describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { attachRemoteProcessStream, type StreamMessage } from "./executor-stream-handlers.js";
import { VirtualWsAdapter } from "../virtual-ws-adapter.js";

/**
 * Which failures a browser may retry. A stream that ends in a non-retryable
 * error leaves the terminal dead until the item remounts, so anything that is
 * really about the transport — the process may still be alive on its worker —
 * has to carry the flag.
 */

const REMOTE_INFO = {
  remoteServerId: "server1",
  remoteProcessId: "p-remote",
  executorId: "e1",
  projectId: "proj1",
  branch: null,
  stoppedEmitted: false,
};

function makeFastify(opts: { connected: boolean; known?: boolean }) {
  const adapters: VirtualWsAdapter[] = [];
  const fastify = {
    remoteExecutorMap: new Map(opts.known === false ? [] : [["remote-p1", REMOTE_INFO]]),
    storage: {
      remoteExecutorProcesses: {
        getById: vi.fn(async () => undefined),
        markFinished: vi.fn(async () => undefined),
      },
    },
    reverseConnectManager: {
      isConnected: () => opts.connected,
      sendChannelData: vi.fn(),
      closeChannel: vi.fn(),
      setChannelAdapter: (_server: string, _channel: string, adapter: VirtualWsAdapter) => {
        adapters.push(adapter);
      },
      openVirtualChannel: vi.fn(),
    },
    eventBus: { emit: vi.fn() },
  } as unknown as FastifyInstance;
  return { fastify, adapters };
}

/** Attach and let the handler's async setup settle. */
async function attach(fastify: FastifyInstance) {
  const sent: StreamMessage[] = [];
  const handle = attachRemoteProcessStream(fastify, "remote-p1", (msg) => sent.push(msg), () => {});
  await new Promise((resolve) => setTimeout(resolve, 5));
  return { sent, handle };
}

const errors = (sent: StreamMessage[]) =>
  sent.filter((m): m is { type: "error"; message: string; retryable?: boolean } => m.type === "error");

describe("attachRemoteProcessStream error classification", () => {
  it("marks an offline tunnel retryable — the worker is expected back", async () => {
    const { fastify } = makeFastify({ connected: false });
    const { sent } = await attach(fastify);

    expect(errors(sent)).toEqual([
      expect.objectContaining({ message: expect.stringContaining("not reachable"), retryable: true }),
    ]);
  });

  it("marks a mid-stream channel error retryable — the process may still be alive", async () => {
    const { fastify, adapters } = makeFastify({ connected: true });
    const { sent } = await attach(fastify);
    expect(adapters).toHaveLength(1);

    adapters[0].emit("error", new Error("channel blew up"));

    expect(errors(sent)).toEqual([
      expect.objectContaining({ message: "Remote connection error", retryable: true }),
    ]);
  });

  it("leaves an unknown process authoritative — retrying can never find it", async () => {
    const { fastify } = makeFastify({ connected: true, known: false });
    const { sent } = await attach(fastify);

    expect(errors(sent)).toEqual([
      expect.objectContaining({ message: "Remote process not found" }),
    ]);
    expect(errors(sent)[0].retryable).toBeUndefined();
  });
});
