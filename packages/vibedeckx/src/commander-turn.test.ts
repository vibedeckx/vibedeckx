import { describe, expect, it } from "vitest";
import { PendingRegistry } from "./commander-turn.js";

describe("PendingRegistry", () => {
  it("owes a registered item until it settles, exactly once", () => {
    const registry = new PendingRegistry();
    registry.register({ kind: "executor", id: "op-1", label: "build" });
    expect(registry.hasOpen()).toBe(true);
    expect(registry.settle("executor", "op-1", "failed")?.outcome).toBe("failed");
    expect(registry.settle("executor", "op-1", "completed")).toBeNull();
    expect(registry.hasOpen()).toBe(false);
  });

  it("returns the open item for a repeated registration", () => {
    const registry = new PendingRegistry();
    const first = registry.register({ kind: "executor", id: "op-1", label: "build" }, 1);
    expect(registry.register({ kind: "executor", id: "op-1", label: "other" }, 2)).toBe(first);
    expect(registry.open()).toHaveLength(1);
  });

  it("starts a new item when a settled id is registered again", () => {
    const registry = new PendingRegistry();
    registry.register({ kind: "terminal_watch", id: "t1", label: "terminal" }, 1);
    registry.settle("terminal_watch", "t1", "completed");
    const again = registry.register({ kind: "terminal_watch", id: "t1", label: "terminal" }, 5);
    expect(again).toMatchObject({ outcome: null, registeredAt: 5 });
    expect(registry.isOpen("terminal_watch", "t1")).toBe(true);
  });

  it("keeps ids of different kinds apart", () => {
    const registry = new PendingRegistry();
    registry.register({ kind: "spawn", id: "call-1", label: "spawn" });
    registry.register({ kind: "agent_dispatch", id: "call-1", label: "reply" });
    registry.settle("spawn", "call-1", "completed");
    expect(registry.open().map((item) => item.kind)).toEqual(["agent_dispatch"]);
  });

  it("ignores outcomes for ids it never saw", () => {
    expect(new PendingRegistry().settle("executor", "nope", "completed")).toBeNull();
  });

  it("forgets one kind without touching the others", () => {
    const registry = new PendingRegistry();
    registry.register({ kind: "executor", id: "op-1", label: "build" });
    registry.register({ kind: "terminal_watch", id: "t1", label: "terminal" });
    registry.forget("executor");
    expect(registry.open().map((item) => item.kind)).toEqual(["terminal_watch"]);
    expect(registry.settle("executor", "op-1", "completed")).toBeNull();
  });

  it("forgets the oldest settled items first, never an open one", () => {
    const registry = new PendingRegistry();
    registry.register({ kind: "executor", id: "keep", label: "long run" });
    for (let i = 0; i < 250; i++) {
      registry.register({ kind: "executor", id: `op-${i}`, label: "run" });
      registry.settle("executor", `op-${i}`, "completed");
    }
    expect(registry.isOpen("executor", "keep")).toBe(true);
    // op-0 was pruned, so registering it again is a fresh item rather than a no-op.
    expect(registry.settle("executor", "op-0", "failed")).toBeNull();
    expect(registry.settle("executor", "op-249", "failed")).toBeNull();
  });

  it("lists open items past their deadline, never settled or deadline-free ones", () => {
    const registry = new PendingRegistry();
    registry.register({ kind: "agent_dispatch", id: "late", label: "reply", deadlineAt: 100 });
    registry.register({ kind: "agent_dispatch", id: "answered", label: "reply", deadlineAt: 100 });
    registry.register({ kind: "spawn", id: "early", label: "spawn", deadlineAt: 500 });
    registry.register({ kind: "executor", id: "run", label: "run" });
    registry.settle("agent_dispatch", "answered", "completed");
    expect(registry.overdue(200).map((item) => item.id)).toEqual(["late"]);
    expect(registry.overdue(500).map((item) => item.id)).toEqual(["late", "early"]);
  });
});

