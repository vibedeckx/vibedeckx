import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProcessManager, type LogMessage } from "./process-manager.js";

/**
 * The log buffer is bounded by bytes, not just entry count: a chunk is whatever
 * one read returned, so 5000 of them can be hundreds of MB on a user's machine.
 * These tests pin the budget, the coalescing that keeps entry overhead down,
 * and the ordering invariant coalescing could otherwise break.
 */

type PrivateManager = {
  processes: Map<string, PrivateProcess>;
  appendOutput: (id: string, rp: unknown, type: string, data: string) => void;
  appendFinished: (id: string, rp: unknown, msg: LogMessage) => void;
  flushPending: (id: string, rp: unknown) => void;
};
type PrivateProcess = {
  logs: LogMessage[];
  logBytes: number;
  pending: { type: string; data: string } | null;
  subscribers: Set<(msg: LogMessage) => void>;
};

const MAX_BYTES = 4 * 1024 * 1024;

function makeManager() {
  const pm = new ProcessManager(null as never);
  const priv = pm as unknown as PrivateManager;
  priv.processes.set("p1", {
    process: { killed: false, exitCode: null },
    isPty: true,
    isTerminal: false,
    name: "p1",
    logs: [],
    logBytes: 0,
    pending: null,
    pendingTimer: null,
    trimmed: false,
    subscribers: new Set(),
    executorId: "e1",
    projectId: "proj1",
    projectPath: "/repo",
    branch: null,
    skipDb: true,
  } as never);
  const rp = priv.processes.get("p1")!;
  return {
    pm,
    rp,
    out: (data: string, type = "pty") => priv.appendOutput("p1", rp, type, data),
    finish: (msg: LogMessage) => priv.appendFinished("p1", rp, msg),
    flush: () => priv.flushPending("p1", rp),
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("log buffer coalescing", () => {
  it("merges same-type chunks inside the window into one entry", () => {
    const { rp, out } = makeManager();

    out("a"); out("b"); out("c");
    expect(rp.logs).toHaveLength(0); // still buffered
    vi.advanceTimersByTime(20);

    expect(rp.logs).toEqual([{ type: "pty", data: "abc" }]);
    expect(rp.logBytes).toBe(3);
  });

  it("never merges across types, so stdout/stderr interleaving survives", () => {
    const { rp, out } = makeManager();

    out("to-stdout", "stdout");
    out("to-stderr", "stderr");
    out("more-stdout", "stdout");
    vi.advanceTimersByTime(20);

    expect(rp.logs).toEqual([
      { type: "stdout", data: "to-stdout" },
      { type: "stderr", data: "to-stderr" },
      { type: "stdout", data: "more-stdout" },
    ]);
  });

  it("delivers each coalesced entry to subscribers exactly once", () => {
    const { rp, out } = makeManager();
    const seen: LogMessage[] = [];
    rp.subscribers.add((msg) => seen.push(msg));

    out("x"); out("y");
    vi.advanceTimersByTime(20);
    out("z");
    vi.advanceTimersByTime(20);

    expect(seen).toEqual([
      { type: "pty", data: "xy" },
      { type: "pty", data: "z" },
    ]);
  });

  it("flushes buffered output before the finished marker", () => {
    const { rp, out, finish } = makeManager();

    out("tail output");
    finish({ type: "finished", exitCode: 0 }); // no timer advance

    // Ordering is what isRunning() reads: finished must be last.
    expect(rp.logs).toEqual([
      { type: "pty", data: "tail output" },
      { type: "finished", exitCode: 0 },
    ]);
    expect(rp.logs[rp.logs.length - 1].type).toBe("finished");
  });

  it("flushes buffered output before replay, so getLogs is complete", () => {
    const { pm, out } = makeManager();

    out("not yet flushed");

    expect(pm.getLogs("p1")).toEqual([{ type: "pty", data: "not yet flushed" }]);
  });
});

describe("output arriving after the exit marker", () => {
  it("keeps the finished marker last, so a dead process is not reported Running", () => {
    const { pm, rp, out, finish, flush } = makeManager();

    out("before exit");
    finish({ type: "finished", exitCode: 0 });
    // node-pty delivers buffered output after onExit — the case the drain
    // mechanism in startPtyProcess exists for.
    out("late chunk");
    flush();

    expect(rp.logs).toEqual([
      { type: "pty", data: "before exit" },
      { type: "pty", data: "late chunk" },
      { type: "finished", exitCode: 0 },
    ]);
    expect(pm.isRunning("p1")).toBe(false);
  });

  it("still delivers the late chunk live, in arrival order", () => {
    const { rp, out, finish, flush } = makeManager();
    const seen: LogMessage[] = [];
    rp.subscribers.add((msg) => seen.push(msg));

    out("before exit");
    finish({ type: "finished", exitCode: 0 });
    out("late chunk");
    flush();

    // Subscribers see events as they happen; only the replay buffer is
    // reordered so the marker stays terminal.
    expect(seen.map((m) => m.type)).toEqual(["pty", "finished", "pty"]);
  });

  it("keeps the marker last across several late chunks", () => {
    const { pm, rp, out, finish, flush } = makeManager();

    finish({ type: "finished", exitCode: 3 });
    for (const chunk of ["a", "b", "c"]) { out(chunk); flush(); }

    expect(rp.logs.map((l) => (l as { data?: string }).data ?? l.type))
      .toEqual(["a", "b", "c", "finished"]);
    expect(pm.isRunning("p1")).toBe(false);
  });
});

describe("log buffer budget", () => {
  it("caps total bytes and keeps the newest output", () => {
    const { rp, out, flush } = makeManager();

    // 8 MB in 1 MB entries, over the 4 MB cap.
    for (let i = 0; i < 8; i++) {
      out(`${i}`.repeat(1024 * 1024));
      flush();
    }

    expect(rp.logBytes).toBeLessThanOrEqual(MAX_BYTES);
    const kept = rp.logs.map((l) => (l as { data: string }).data[0]);
    expect(kept[kept.length - 1]).toBe("7"); // newest survives
    expect(kept).not.toContain("0"); // oldest dropped
  });

  it("keeps logBytes exactly equal to the payload it still holds", () => {
    const { rp, out, flush } = makeManager();

    for (let i = 0; i < 12; i++) {
      out("z".repeat(512 * 1024));
      flush();
    }

    const actual = rp.logs.reduce((sum, l) => sum + ((l as { data?: string }).data?.length ?? 0), 0);
    expect(rp.logBytes).toBe(actual);
  });

  it("still caps entry count for tiny chunks that never approach the byte cap", () => {
    const { rp, out, flush } = makeManager();

    for (let i = 0; i < 5200; i++) {
      out("x");
      flush(); // force one entry each, defeating coalescing
    }

    expect(rp.logs.length).toBeLessThanOrEqual(5000);
    expect(rp.logBytes).toBe(rp.logs.length);
  });

  it("counts an uncapped finalResult against the budget", () => {
    const { rp, finish } = makeManager();

    finish({ type: "finished", exitCode: 0, finalResult: "r".repeat(1000) });

    expect(rp.logBytes).toBe(1000);
  });

  it("keeps a finished marker whose finalResult alone busts the budget", () => {
    const { pm, rp, out, finish, flush } = makeManager();
    out("earlier output");
    flush();

    // An agent report larger than the whole buffer budget. Trimming to fit
    // would empty the buffer, and isRunning() reads "no finished entry" as
    // "still running" — pinning a dead process to Running.
    finish({ type: "finished", exitCode: 0, finalResult: "r".repeat(MAX_BYTES + 1024) });

    expect(rp.logs).toHaveLength(1);
    expect(rp.logs[0].type).toBe("finished");
    expect((rp.logs[0] as { finalResult?: string }).finalResult).toHaveLength(MAX_BYTES + 1024);
    expect(pm.isRunning("p1")).toBe(false);
  });

  it("keeps a single output chunk larger than the whole budget", () => {
    const { rp, out, flush } = makeManager();
    out("older");
    flush();

    out("X".repeat(MAX_BYTES + 1024));
    flush();

    expect(rp.logs).toHaveLength(1);
    expect((rp.logs[0] as { data: string }).data[0]).toBe("X"); // newest survives
    expect(rp.logBytes).toBe(MAX_BYTES + 1024);
  });

  it("flushes a coalesced chunk once it grows past the frame budget", () => {
    const { rp, out } = makeManager();

    // 12 × 64KB inside one 8ms window: must not become one 768KB entry.
    for (let i = 0; i < 12; i++) out("y".repeat(64 * 1024));

    expect(rp.logs.length).toBeGreaterThan(1);
    for (const log of rp.logs) {
      expect((log as { data: string }).data.length).toBeLessThanOrEqual(128 * 1024);
    }
    vi.advanceTimersByTime(20);
    const total = rp.logs.reduce((sum, l) => sum + (l as { data: string }).data.length, 0);
    expect(total).toBe(12 * 64 * 1024); // nothing lost to the split
  });
});
