import { describe, expect, it, vi } from "vitest";
import { EventBus, type GlobalEvent } from "./event-bus.js";
import { RemoteExecutorMonitor } from "./remote-executor-monitor.js";
import type { ReverseConnectManager } from "./reverse-connect-manager.js";
import type { RemoteExecutorInfo } from "./server-types.js";
import type { Storage } from "./storage/types.js";
import type { VirtualWsAdapter } from "./virtual-ws-adapter.js";

function createHarness(initiallyConnected = true) {
  let connected = initiallyConnected;
  let statusHandler: ((remoteServerId: string, status: "online" | "offline") => void) | undefined;
  const adapters: VirtualWsAdapter[] = [];
  const openedPaths: string[] = [];
  const markFinished = vi.fn(async () => {});

  const reverseConnectManager = {
    setStatusChangeHandler: vi.fn((handler) => { statusHandler = handler; }),
    isConnected: vi.fn((serverId: string) => connected && serverId === "server-1"),
    sendChannelData: vi.fn(),
    closeChannel: vi.fn(),
    setChannelAdapter: vi.fn((_serverId, _channelId, adapter: VirtualWsAdapter) => {
      adapters.push(adapter);
    }),
    openVirtualChannel: vi.fn((_serverId, _channelId, path: string) => {
      openedPaths.push(path);
    }),
  } as unknown as ReverseConnectManager;

  const eventBus = new EventBus();
  const events: GlobalEvent[] = [];
  eventBus.subscribe((event) => events.push(event));

  const storage = {
    remoteExecutorProcesses: { markFinished },
  } as unknown as Storage;

  const localProcessId = "remote-executor-remote-process";
  const info: RemoteExecutorInfo = {
    remoteServerId: "server-1",
    remoteProcessId: "remote-process",
    executorId: "executor-1",
    projectId: "project-1",
  };
  const remoteExecutorMap = new Map([[localProcessId, info]]);
  const monitor = new RemoteExecutorMonitor(
    reverseConnectManager,
    eventBus,
    storage,
    remoteExecutorMap,
  );

  return {
    adapters,
    events,
    info,
    localProcessId,
    markFinished,
    monitor,
    openedPaths,
    remoteExecutorMap,
    reconnect() {
      connected = true;
      statusHandler?.("server-1", "online");
    },
  };
}

describe("RemoteExecutorMonitor", () => {
  it("keeps its watch intent across a transport close and observes replayed completion after reconnect", async () => {
    const h = createHarness();

    h.monitor.watch(h.localProcessId, h.info);
    expect(h.openedPaths).toEqual(["/api/executor-processes/remote-process/logs"]);

    // A control-connection outage closes the virtual channel without proving
    // that the process ended.
    h.adapters[0].deliverClose(1001, "Control connection closed");
    h.reconnect();

    expect(h.openedPaths).toHaveLength(2);
    h.adapters[1].deliverMessage(JSON.stringify({ type: "pty", data: "done\r\n" }));
    h.adapters[1].deliverMessage(JSON.stringify({ type: "finished", exitCode: 0 }));
    await Promise.resolve();

    expect(h.events).toContainEqual({
      type: "executor:stopped",
      projectId: "project-1",
      executorId: "executor-1",
      processId: h.localProcessId,
      exitCode: 0,
      target: "server-1",
      tailOutput: "done\r\n",
      finalResult: undefined,
    });
    expect(h.remoteExecutorMap.has(h.localProcessId)).toBe(false);
    expect(h.markFinished).toHaveBeenCalledWith(h.localProcessId, 0);

    // Completion removes the watch intent, so later reconnects cannot create a
    // duplicate monitor or duplicate stopped event.
    h.reconnect();
    expect(h.openedPaths).toHaveLength(2);
  });

  it("defers a watch created while offline and attaches it when the server comes online", () => {
    const h = createHarness(false);

    h.monitor.watch(h.localProcessId, h.info);
    expect(h.openedPaths).toEqual([]);

    h.reconnect();
    expect(h.openedPaths).toEqual(["/api/executor-processes/remote-process/logs"]);
  });

  it("treats a process missing from the worker as killed instead of successful", async () => {
    const h = createHarness();

    h.monitor.watch(h.localProcessId, h.info);
    h.adapters[0].deliverMessage(JSON.stringify({ type: "error", message: "Process not found" }));
    h.adapters[0].deliverMessage(JSON.stringify({ type: "finished", exitCode: null }));
    await Promise.resolve();

    expect(h.events).toContainEqual({
      type: "executor:stopped",
      projectId: "project-1",
      executorId: "executor-1",
      processId: h.localProcessId,
      exitCode: 1,
      target: "server-1",
      tailOutput: "",
      finalResult: undefined,
    });
    expect(h.markFinished).toHaveBeenCalledWith(h.localProcessId, undefined, "killed");
    expect(h.remoteExecutorMap.has(h.localProcessId)).toBe(false);
  });
});
