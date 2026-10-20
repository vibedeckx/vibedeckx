import { EventEmitter } from "events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { killWindowsTree } from "./process-tree.js";

function fakeTaskkill() {
  const proc = new EventEmitter();
  const spawn = vi.fn(() => proc as never);
  return { proc, spawn };
}

describe("killWindowsTree", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns false without spawning taskkill when the root is already gone", () => {
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    });
    const { spawn } = fakeTaskkill();
    expect(killWindowsTree(4242, spawn)).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("walks the tree with taskkill /T /F and does not fall back on success", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const { proc, spawn } = fakeTaskkill();
    expect(killWindowsTree(4242, spawn)).toBe(true);
    expect(spawn).toHaveBeenCalledWith(
      expect.stringMatching(/taskkill(\.exe)?$/i),
      ["/pid", "4242", "/T", "/F"],
      expect.objectContaining({ windowsHide: true }),
    );
    proc.emit("exit", 0);
    expect(kill).toHaveBeenCalledTimes(1); // only the liveness probe
    expect(kill).toHaveBeenCalledWith(4242, 0);
  });

  it("falls back to terminating the root when taskkill fails to start", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { proc, spawn } = fakeTaskkill();
    killWindowsTree(4242, spawn);
    proc.emit("error", new Error("spawn ENOENT"));
    expect(kill).toHaveBeenLastCalledWith(4242);
  });

  it("falls back to terminating the root when taskkill exits non-zero", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { proc, spawn } = fakeTaskkill();
    killWindowsTree(4242, spawn);
    proc.emit("exit", 1);
    expect(kill).toHaveBeenLastCalledWith(4242);
  });

  it("does not fall back when taskkill reports the process already exited (128)", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const { proc, spawn } = fakeTaskkill();
    killWindowsTree(4242, spawn);
    proc.emit("exit", 128);
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("falls back only once when error and exit both fire", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { proc, spawn } = fakeTaskkill();
    killWindowsTree(4242, spawn);
    proc.emit("error", new Error("boom"));
    proc.emit("exit", 1);
    expect(kill).toHaveBeenCalledTimes(2); // probe + one fallback
  });
});
