import { describe, expect, it } from "vitest";
import { TurnCompletionLedger, type CompletionAction } from "./turn-completion.js";

/**
 * Pure state machine for "when is a Claude Code turn really finished?".
 * Event orderings mirror real stream-json captures from Claude Code 2.1.205
 * (protocol/claude-code/__fixtures__/*.jsonl):
 *  - race:    two fast subagents finish before the first result, then two
 *             auto-resume turns each emit their own result (3 results total)
 *  - in-turn: notifications consumed mid-turn produce a single result and
 *             no auto-resume
 *  - restart: the same task_id legitimately cycles started→finished twice
 */

const P1 = { duration_ms: 100, cost_usd: 0.01, input_tokens: 10, output_tokens: 1 };
const P2 = { duration_ms: 200, cost_usd: 0.02, input_tokens: 20, output_tokens: 2 };
const P3 = { duration_ms: 300, cost_usd: 0.03, input_tokens: 30, output_tokens: 3 };

function generationOf(action: CompletionAction): number {
  expect(action.kind).toBe("schedule");
  return (action as { kind: "schedule"; generation: number }).generation;
}

describe("TurnCompletionLedger", () => {
  it("commits immediately on a plain turn with no background activity", () => {
    const ledger = new TurnCompletionLedger();
    expect(ledger.successResult(P1)).toEqual({ kind: "commit", payload: P1 });
  });

  it("defers (no commit) while background tasks are still running", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted("a");
    expect(ledger.successResult(P1)).toEqual({ kind: "cancel" });
    expect(ledger.pendingTaskCount).toBe(1);
    expect(ledger.hasPendingCompletion).toBe(false);
  });

  it("holds the result for grace when background tasks ran this turn (race sequence)", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted("a");
    ledger.taskStarted("b");
    ledger.taskFinished("a");
    ledger.taskFinished("b");
    const action = ledger.successResult(P1);
    const gen = generationOf(action);
    expect(ledger.hasPendingCompletion).toBe(true);
    expect(ledger.graceElapsed(gen)).toEqual({ kind: "commit", payload: P1 });
    // Commit is one-shot.
    expect(ledger.graceElapsed(gen)).toEqual({ kind: "none" });
  });

  it("supersedes intermediate results: only the last result of a resume chain commits", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted("a");
    ledger.taskStarted("b");
    ledger.taskFinished("a");
    ledger.taskFinished("b");
    const g1 = generationOf(ledger.successResult(P1));
    // Auto-resume turn for task a starts streaming.
    expect(ledger.noteTurnActivity()).toEqual({ kind: "cancel" });
    const g2 = generationOf(ledger.successResult(P2));
    expect(ledger.noteTurnActivity()).toEqual({ kind: "cancel" });
    const g3 = generationOf(ledger.successResult(P3));

    expect(ledger.graceElapsed(g1)).toEqual({ kind: "none" });
    expect(ledger.graceElapsed(g2)).toEqual({ kind: "none" });
    expect(ledger.graceElapsed(g3)).toEqual({ kind: "commit", payload: P3 });
  });

  it("in-turn consumption: single result after tasks finished mid-turn commits after grace", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted("agent");
    ledger.taskStarted("bash");
    ledger.taskFinished("agent");
    ledger.taskFinished("bash");
    const gen = generationOf(ledger.successResult(P1));
    expect(ledger.graceElapsed(gen)).toEqual({ kind: "commit", payload: P1 });
  });

  it("tracks task_id restart cycles via the live set", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted("a");
    ledger.taskFinished("a");
    ledger.taskStarted("a"); // same id restarts (subagent resumed by its own nested task)
    expect(ledger.pendingTaskCount).toBe(1);
    expect(ledger.successResult(P1)).toEqual({ kind: "cancel" }); // still deferred
    ledger.taskFinished("a");
    expect(ledger.successResult(P2).kind).toBe("schedule");
  });

  it("task events during grace re-arm the timer instead of cancelling (no wedge)", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted("a");
    ledger.taskFinished("a");
    const g1 = generationOf(ledger.successResult(P1));
    // An orphaned nested-task notification arrives with no resume behind it.
    const rearm = ledger.taskFinished("orphan");
    const g2 = generationOf(rearm);
    expect(g2).not.toBe(g1);
    expect(ledger.graceElapsed(g1)).toEqual({ kind: "none" });
    expect(ledger.graceElapsed(g2)).toEqual({ kind: "commit", payload: P1 });
  });

  it("taskListChanged replaces the live set (authoritative snapshot)", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted("stale");
    ledger.taskListChanged(["a", "b"]);
    expect(ledger.pendingTaskCount).toBe(2);
    ledger.taskListChanged([]);
    expect(ledger.pendingTaskCount).toBe(0);
    expect(ledger.successResult(P1).kind).toBe("schedule"); // saw background activity
  });

  it("error result discards the held completion", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted("a");
    ledger.taskFinished("a");
    const gen = generationOf(ledger.successResult(P1));
    expect(ledger.errorResult()).toEqual({ kind: "cancel" });
    expect(ledger.graceElapsed(gen)).toEqual({ kind: "none" });
  });

  it("clean process exit commits the held completion immediately", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted("a");
    ledger.taskFinished("a");
    const gen = generationOf(ledger.successResult(P1));
    expect(ledger.processExited(0)).toEqual({ kind: "commit", payload: P1 });
    expect(ledger.graceElapsed(gen)).toEqual({ kind: "none" });
  });

  it("non-zero process exit discards the held completion", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted("a");
    ledger.taskFinished("a");
    const gen = generationOf(ledger.successResult(P1));
    expect(ledger.processExited(1)).toEqual({ kind: "cancel" });
    expect(ledger.graceElapsed(gen)).toEqual({ kind: "none" });
  });

  it("clean exit without a held completion just clears state", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted("a");
    expect(ledger.processExited(0)).toEqual({ kind: "cancel" });
    expect(ledger.pendingTaskCount).toBe(0);
  });

  it("background flag survives a commit: a premature grace commit must not fast-path the chain's later results", () => {
    // Live-observed failure: the resume turn's first stream event lags a full
    // LLM roundtrip behind the intermediate result, so the grace can fire
    // early. If that commit cleared the background flag, every later result
    // of the chain would commit instantly — three chimes instead of one.
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted("a");
    ledger.taskFinished("a");
    const g1 = generationOf(ledger.successResult(P1));
    expect(ledger.graceElapsed(g1)).toEqual({ kind: "commit", payload: P1 }); // premature
    ledger.noteTurnActivity(); // resume turn finally streams
    expect(ledger.successResult(P2).kind).toBe("schedule"); // still held, not instant
  });

  it("a new user turn resets the background flag: its plain result commits immediately", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted("a");
    ledger.taskFinished("a");
    const gen = generationOf(ledger.successResult(P1));
    expect(ledger.graceElapsed(gen).kind).toBe("commit");
    ledger.userTurnStarted();
    expect(ledger.successResult(P2)).toEqual({ kind: "commit", payload: P2 });
  });

  it("userTurnStarted discards a held completion (user moved on)", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted("a");
    ledger.taskFinished("a");
    const gen = generationOf(ledger.successResult(P1));
    expect(ledger.userTurnStarted()).toEqual({ kind: "cancel" });
    expect(ledger.graceElapsed(gen)).toEqual({ kind: "none" });
  });

  it("noteTurnActivity without a held completion is a no-op", () => {
    const ledger = new TurnCompletionLedger();
    expect(ledger.noteTurnActivity()).toEqual({ kind: "none" });
  });

  it("reset clears tasks, held completion, and the background flag", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted("a");
    ledger.taskFinished("a");
    const gen = generationOf(ledger.successResult(P1));
    ledger.reset();
    expect(ledger.pendingTaskCount).toBe(0);
    expect(ledger.hasPendingCompletion).toBe(false);
    expect(ledger.graceElapsed(gen)).toEqual({ kind: "none" });
    expect(ledger.successResult(P2)).toEqual({ kind: "commit", payload: P2 });
  });
});
