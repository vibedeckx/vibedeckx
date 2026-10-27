import { describe, expect, it } from "vitest";
import { AgentDispatchLedger, CommanderOperationLedger, isOperationInFlight } from "./commander-operations.js";

const op = (id: string, processId: string, chatSessionId = "chat-1") => ({
  id, kind: "executor" as const, chatSessionId, planId: null, stepId: null,
  executorId: "e1", executorName: "build", target: "local", processId,
});

describe("CommanderOperationLedger", () => {
  it("returns the existing record for a re-delivered registration", () => {
    const ledger = new CommanderOperationLedger();
    expect(ledger.register(op("call-1", "p1")).created).toBe(true);
    const again = ledger.register(op("call-1", "p-other"));
    expect(again.created).toBe(false);
    expect(again.operation.processId).toBe("p1");
  });

  it("matches a finish once, then reports duplicates, and never matches unknown processes", () => {
    const ledger = new CommanderOperationLedger();
    ledger.register(op("call-1", "p1"));
    expect(ledger.finishExecutor("p1", 0)).toMatchObject({ kind: "matched", operation: { id: "call-1", exitCode: 0 } });
    expect(ledger.finishExecutor("p1", 1)).toMatchObject({ kind: "duplicate", operation: { exitCode: 0 } });
    expect(ledger.finishExecutor("manual", 0)).toEqual({ kind: "unmatched" });
  });

  it("keeps a finish that arrived before the start answered", () => {
    const ledger = new CommanderOperationLedger();
    ledger.register(op("call-1", "p1"));
    ledger.finishExecutor("p1", 2);
    ledger.settleStart("call-1", "started");
    expect(ledger.get("call-1")).toMatchObject({ status: "finished", exitCode: 2 });
  });

  it("confirms an unknown start out of band", () => {
    const ledger = new CommanderOperationLedger();
    ledger.register(op("call-1", "p1"));
    ledger.settleStart("call-1", "start_unknown");
    ledger.markStarted("p1");
    expect(ledger.get("call-1")?.status).toBe("started");
  });

  it("releases the identity of a rejected start", () => {
    const ledger = new CommanderOperationLedger();
    ledger.register(op("call-1", "p1"));
    ledger.settleStart("call-1", "rejected");
    expect(ledger.finishExecutor("p1", 0)).toEqual({ kind: "unmatched" });
  });

  it("follows a rebound process identity", () => {
    const ledger = new CommanderOperationLedger();
    ledger.register(op("call-1", "requested"));
    ledger.rebindProcess("call-1", "actual");
    expect(ledger.finishExecutor("requested", 0)).toEqual({ kind: "unmatched" });
    expect(ledger.finishExecutor("actual", 0).kind).toBe("matched");
  });

  it("forgets a reset session's operations so their events become unmatched", () => {
    const ledger = new CommanderOperationLedger();
    ledger.register(op("call-1", "p1", "chat-1"));
    ledger.register(op("call-2", "p2", "chat-2"));
    ledger.forgetSession("chat-1");
    expect(ledger.finishExecutor("p1", 0)).toEqual({ kind: "unmatched" });
    expect(ledger.finishExecutor("p2", 0).kind).toBe("matched");
  });

  it("bounds settled history but never drops a running operation", () => {
    const ledger = new CommanderOperationLedger();
    ledger.register(op("running", "p-running"));
    for (let i = 0; i < 520; i++) {
      ledger.register(op(`call-${i}`, `p-${i}`));
      ledger.finishExecutor(`p-${i}`, 0);
    }
    expect(ledger.get("call-0")).toBeUndefined();
    expect(ledger.get("call-519")).toBeDefined();
    expect(ledger.finishExecutor("p-running", 0).kind).toBe("matched");
  });
});

describe("CommanderOperationLedger in-flight queries", () => {
  it("lists a chat's unsettled operations and the latest one per plan step", () => {
    const ledger = new CommanderOperationLedger();
    const base = { kind: "executor" as const, chatSessionId: "chat", planId: "plan", executorId: "e1", executorName: "build", target: "local" };
    ledger.register({ ...base, id: "op-1", stepId: "build", processId: "p1" });
    ledger.register({ ...base, id: "op-2", stepId: "build", processId: "p2" });
    ledger.register({ ...base, id: "other", chatSessionId: "elsewhere", stepId: null, processId: "p3" });
    expect(ledger.inFlight("chat").map((operation) => operation.id)).toEqual(["op-1", "op-2"]);
    expect(ledger.allInFlight()).toHaveLength(3);
    expect(ledger.latestForStep("chat", "plan", "build")?.id).toBe("op-2");
    expect(ledger.latestForStep("chat", "plan", "test")).toBeUndefined();

    ledger.finishExecutor("p2", 0);
    ledger.settleStart("op-1", "rejected");
    expect(ledger.inFlight("chat")).toEqual([]);
    expect(isOperationInFlight(ledger.latestForStep("chat", "plan", "build")!)).toBe(false);
    expect(ledger.allInFlight().map((operation) => operation.id)).toEqual(["other"]);
  });
});

describe("CommanderOperationLedger unknown starts", () => {
  it("finds this chat's unknown start and hands its identity over", () => {
    const ledger = new CommanderOperationLedger();
    ledger.register(op("call-1", "p1"));
    ledger.settleStart("call-1", "start_unknown");
    expect(ledger.findUnknownStart("chat-2", "e1", "local")).toBeUndefined();
    expect(ledger.findUnknownStart("chat-1", "e1", "local")?.id).toBe("call-1");

    ledger.supersede("call-1");
    ledger.register(op("call-2", "p1"));
    expect(ledger.findUnknownStart("chat-1", "e1", "local")).toBeUndefined();
    expect(ledger.finishExecutor("p1", 0)).toMatchObject({ kind: "matched", operation: { id: "call-2" } });
  });
});

describe("AgentDispatchLedger", () => {
  const dispatch = (id: string, afterEntryIndex: number, chatSessionId = "chat-1") =>
    ({ id, chatSessionId, agentSessionId: "agent-1", afterEntryIndex });

  it("credits a turn end to the dispatch that opened it, once", () => {
    const ledger = new AgentDispatchLedger<string>();
    ledger.register(dispatch("d1", -1));
    expect(ledger.finishTurn("agent-1", 5, "c1")).toMatchObject({ kind: "matched", dispatch: { id: "d1" } });
    expect(ledger.finishTurn("agent-1", 5, "c1")).toMatchObject({ kind: "duplicate", dispatch: { id: "d1" } });
  });

  it("a repeated completion of the previous task neither consumes nor steals the next dispatch", () => {
    const ledger = new AgentDispatchLedger<string>();
    ledger.register(dispatch("d1", -1));
    ledger.finishTurn("agent-1", 5, "c1");
    ledger.register(dispatch("d2", ledger.lastTurnEndOf("agent-1")));
    expect(ledger.finishTurn("agent-1", 5, "c1").kind).toBe("duplicate");
    expect(ledger.finishTurn("agent-1", 9, "c2")).toMatchObject({ kind: "matched", dispatch: { id: "d2" } });
  });

  it("a never-seen completion from before the dispatch is not attributed to it", () => {
    const ledger = new AgentDispatchLedger<string>();
    ledger.register(dispatch("d2", 7));
    expect(ledger.finishTurn("agent-1", 5, "late").kind).toBe("unmatched");
    expect(ledger.finishTurn("agent-1", 9, "c2").kind).toBe("matched");
  });

  it("a turn the user started after the task settled is not the commander's", () => {
    const ledger = new AgentDispatchLedger<string>();
    ledger.register(dispatch("d1", -1));
    ledger.finishTurn("agent-1", 5, "c1");
    expect(ledger.finishTurn("agent-1", 9, "user").kind).toBe("unmatched");
  });

  it("does not attribute a completion without a turn-end index", () => {
    const ledger = new AgentDispatchLedger<string>();
    ledger.register(dispatch("d1", -1));
    expect(ledger.finishTurn("agent-1", undefined, "c").kind).toBe("unmatched");
  });

  it("hands a completion that outran registration to the dispatch it follows", () => {
    const ledger = new AgentDispatchLedger<string>();
    ledger.finishTurn("agent-1", 3, "early");
    expect(ledger.register(dispatch("d1", 1))).toBe("early");
    expect(ledger.finishTurn("agent-1", 3, "early").kind).toBe("duplicate");
    const other = new AgentDispatchLedger<string>();
    other.finishTurn("agent-1", 3, "old");
    expect(other.register(dispatch("d1", 3))).toBeNull();
  });

  it("reports whether a chat still has a pending dispatch", () => {
    const ledger = new AgentDispatchLedger<string>();
    expect(ledger.hasPending("chat")).toBe(false);
    ledger.register({ id: "d1", chatSessionId: "chat", agentSessionId: "agent", afterEntryIndex: 2 });
    expect(ledger.hasPending("chat")).toBe(true);
    expect(ledger.hasPending("other")).toBe(false);
    ledger.finishTurn("agent", 5, "done");
    expect(ledger.hasPending("chat")).toBe(false);
  });

  it("a cancelled or forgotten dispatch owns nothing", () => {
    const ledger = new AgentDispatchLedger<string>();
    ledger.register(dispatch("d1", -1));
    ledger.cancel("agent-1", "d1");
    expect(ledger.finishTurn("agent-1", 5, "c").kind).toBe("unmatched");
    ledger.register(dispatch("d2", 5));
    ledger.forgetChat("chat-1");
    expect(ledger.finishTurn("agent-1", 9, "c").kind).toBe("unmatched");
  });
});
