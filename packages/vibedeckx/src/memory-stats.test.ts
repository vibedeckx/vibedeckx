import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { ConversationPatch } from "./conversation-patch.js";
import { collectMemoryStats, MemoryStatsReporter } from "./memory-stats.js";
import { ProcessManager } from "./process-manager.js";
import { RemotePatchCache } from "./remote-patch-cache.js";

vi.mock("@clerk/fastify", () => ({ getAuth: () => ({ userId: "u1" }), clerkClient: {} }));

const frame = (index: number) => JSON.stringify({
  JsonPatch: ConversationPatch.addEntry(index, { type: "assistant", content: "text", timestamp: 1 }),
});

type PrivateManager = {
  processes: Map<string, { logs: unknown[] }>;
  appendLog: (processId: string, rp: unknown, msg: unknown) => void;
};

/**
 * Seed the process map without spawning. Entries go in through the real
 * appendLog so the byte accounting under test is the production one rather
 * than something this helper made up.
 */
function seedProcess(pm: ProcessManager, id: string, chunks: string[], isTerminal = false) {
  const priv = pm as unknown as PrivateManager;
  priv.processes.set(id, {
    process: { killed: true, exitCode: 0 },
    isPty: false,
    isTerminal,
    name: id,
    logs: [],
    logBytes: 0,
    pending: null,
    pendingTimer: null,
    trimmed: false,
    subscribers: new Set(),
    executorId: "e1",
    projectId: "p1",
    projectPath: "/repo",
    branch: null,
    skipDb: false,
  } as never);
  for (const data of chunks) appendRaw(pm, id, { type: "pty", data });
}

/** Append one already-formed entry through the production path. */
function appendRaw(pm: ProcessManager, id: string, msg: Record<string, unknown>) {
  const priv = pm as unknown as PrivateManager;
  priv.appendLog(id, priv.processes.get(id), msg);
}

describe("ProcessManager.logBufferStats", () => {
  it("reports zeroes with nothing running — the expected SaaS hub reading", () => {
    expect(new ProcessManager(null as never).logBufferStats()).toEqual({
      processes: 0,
      running: 0,
      terminals: 0,
      log_entries: 0,
      approx_bytes: 0,
      max_process_approx_bytes: 0,
    });
  });

  it("sums chunk payloads and surfaces the worst single process", () => {
    const pm = new ProcessManager(null as never);
    seedProcess(pm, "small", ["ab", "cd"]);
    seedProcess(pm, "big", ["x".repeat(100)], true);

    expect(pm.logBufferStats()).toMatchObject({
      processes: 2,
      terminals: 1,
      log_entries: 3,
      approx_bytes: 104,
      max_process_approx_bytes: 100,
    });
  });

  it("counts a bare finished marker as an entry with no payload", () => {
    const pm = new ProcessManager(null as never);
    seedProcess(pm, "p", ["ab"]);
    appendRaw(pm, "p", { type: "finished", exitCode: 0 });

    expect(pm.logBufferStats()).toMatchObject({ log_entries: 2, approx_bytes: 2 });
  });

  it("counts finalResult, which prompt executors attach to the finished marker", () => {
    const pm = new ProcessManager(null as never);
    seedProcess(pm, "p", ["ab"]);
    // consumeFinalResultFile reads the agent's last message whole, uncapped —
    // ignoring it would hide the largest single item in the buffer.
    appendRaw(pm, "p", { type: "finished", exitCode: 0, finalResult: "r".repeat(500) });

    expect(pm.logBufferStats()).toMatchObject({
      log_entries: 2,
      approx_bytes: 502,
      max_process_approx_bytes: 502,
    });
  });
});

describe("collectMemoryStats", () => {
  it("combines process memory with both in-memory holders", () => {
    const cache = new RemotePatchCache();
    cache.appendMessage("s1", frame(0), true);
    const pm = new ProcessManager(null as never);
    seedProcess(pm, "p", ["hello"]);

    const snapshot = collectMemoryStats({ remotePatchCache: cache, processManager: pm });

    expect(snapshot.process.rss).toBeGreaterThan(0);
    expect(snapshot.process.heap_used).toBeGreaterThan(0);
    expect(snapshot.patch_cache).toMatchObject({ sessions: 1, approx_bytes: frame(0).length });
    expect(snapshot.process_manager).toMatchObject({ processes: 1, approx_bytes: 5 });
  });

  it("names no session, server or user — the endpoint spans tenants", () => {
    const cache = new RemotePatchCache();
    cache.appendMessage("session-secret", frame(0), true);
    const snapshot = collectMemoryStats({
      remotePatchCache: cache,
      processManager: new ProcessManager(null as never),
    });

    expect(JSON.stringify(snapshot)).not.toContain("session-secret");
  });
});

describe("MemoryStatsReporter", () => {
  it("emits on each interval and stops on close", () => {
    vi.useFakeTimers();
    const cache = new RemotePatchCache();
    const reporter = new MemoryStatsReporter(
      { remotePatchCache: cache, processManager: new ProcessManager(null as never) },
      { intervalMs: 1000 },
    );
    const spy = vi.spyOn(reporter, "report");

    reporter.start();
    vi.advanceTimersByTime(2500);
    expect(spy).toHaveBeenCalledTimes(2);

    reporter.close();
    vi.advanceTimersByTime(5000);
    expect(spy).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("does not arm a timer when the interval is disabled", () => {
    const reporter = new MemoryStatsReporter(
      {
        remotePatchCache: new RemotePatchCache(),
        processManager: new ProcessManager(null as never),
      },
      { intervalMs: 0 },
    );
    const spy = vi.spyOn(reporter, "report");
    vi.useFakeTimers();
    reporter.start();
    vi.advanceTimersByTime(60_000);
    expect(spy).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("GET /api/admin/memory-stats", () => {
  let app: FastifyInstance;

  async function makeApp(authEnabled: boolean) {
    const { default: workerStatsRoutes } = await import("./routes/worker-stats-routes.js");
    app = Fastify();
    app.decorate("authEnabled", authEnabled);
    app.decorate("remotePatchCache", new RemotePatchCache());
    app.decorate("processManager", new ProcessManager(null as never));
    app.decorate("storage", {} as never);
    app.decorate("reverseConnectManager", { isConnected: () => false } as never);
    app.decorate("remoteSessionMap", new Map());
    await app.register(workerStatsRoutes);
  }

  afterEach(async () => { await app?.close(); });

  it("serves the operator in a solo no-auth deployment", async () => {
    await makeApp(false);
    const response = await app.inject({ method: "GET", url: "/api/admin/memory-stats" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      patch_cache: { sessions: 0 },
      process_manager: { processes: 0 },
    });
  });

  it("hides the endpoint from an authenticated tenant rather than 403ing", async () => {
    await makeApp(true);
    const response = await app.inject({ method: "GET", url: "/api/admin/memory-stats" });

    expect(response.statusCode).toBe(404);
  });
});
