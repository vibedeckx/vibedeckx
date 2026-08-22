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
    expect(ledger.successResult(P1, 0)).toEqual({ kind: "commit", payload: P1 });
  });

  it("defers (no commit) while background tasks are still running, keeping the result parked", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted({ taskId: "a" }, 0);
    expect(ledger.successResult(P1, 0)).toEqual({ kind: "cancel" });
    expect(ledger.pendingTaskCount).toBe(1);
    // The result stays parked: Codex never auto-resumes the main thread
    // after a fire-and-forget subagent, so the last task finishing must be
    // able to commit this result — discarding it would wedge the session.
    expect(ledger.hasPendingCompletion).toBe(true);
  });

  it("codex fire-and-forget: last task finishing schedules the parked result (no resume ever comes)", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted({ taskId: "sub-thread-1" }, 0);
    const parked = ledger.successResult(P1, 0); // main turn ends while subagent runs
    expect(parked).toEqual({ kind: "cancel" });
    const action = ledger.taskFinished("sub-thread-1", 0);
    const gen = generationOf(action);
    expect(ledger.graceElapsed(gen)).toEqual({ kind: "commit", payload: P1 });
  });

  it("a parked result is superseded by resume activity (claude path unaffected)", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted({ taskId: "a" }, 0);
    ledger.successResult(P1, 0); // parked, task a still running
    const g1 = generationOf(ledger.taskFinished("a", 0)); // schedules parked P1
    expect(ledger.noteTurnActivity()).toEqual({ kind: "cancel" }); // resume init beats the grace
    expect(ledger.graceElapsed(g1)).toEqual({ kind: "none" });
    const g2 = generationOf(ledger.successResult(P2, 0));
    expect(ledger.graceElapsed(g2)).toEqual({ kind: "commit", payload: P2 });
  });

  it("a new task starting while a result is scheduled parks it again until the set empties", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted({ taskId: "a" }, 0);
    ledger.successResult(P1, 0);
    const g1 = generationOf(ledger.taskFinished("a", 0)); // scheduled
    expect(ledger.taskStarted({ taskId: "b" }, 0)).toEqual({ kind: "cancel" }); // parked again, kept
    expect(ledger.graceElapsed(g1)).toEqual({ kind: "none" });
    const g2 = generationOf(ledger.taskFinished("b", 0));
    expect(ledger.graceElapsed(g2)).toEqual({ kind: "commit", payload: P1 });
  });

  it("an emptying task snapshot schedules the parked result", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskListChanged([{ taskId: "sub-1" }], 0);
    ledger.successResult(P1, 0);
    const gen = generationOf(ledger.taskListChanged([], 0));
    expect(ledger.graceElapsed(gen)).toEqual({ kind: "commit", payload: P1 });
  });

  it("holds the result for grace when background tasks ran this turn (race sequence)", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted({ taskId: "a" }, 0);
    ledger.taskStarted({ taskId: "b" }, 0);
    ledger.taskFinished("a", 0);
    ledger.taskFinished("b", 0);
    const action = ledger.successResult(P1, 0);
    const gen = generationOf(action);
    expect(ledger.hasPendingCompletion).toBe(true);
    expect(ledger.graceElapsed(gen)).toEqual({ kind: "commit", payload: P1 });
    // Commit is one-shot.
    expect(ledger.graceElapsed(gen)).toEqual({ kind: "none" });
  });

  it("supersedes intermediate results: only the last result of a resume chain commits", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted({ taskId: "a" }, 0);
    ledger.taskStarted({ taskId: "b" }, 0);
    ledger.taskFinished("a", 0);
    ledger.taskFinished("b", 0);
    const g1 = generationOf(ledger.successResult(P1, 0));
    // Auto-resume turn for task a starts streaming.
    expect(ledger.noteTurnActivity()).toEqual({ kind: "cancel" });
    const g2 = generationOf(ledger.successResult(P2, 0));
    expect(ledger.noteTurnActivity()).toEqual({ kind: "cancel" });
    const g3 = generationOf(ledger.successResult(P3, 0));

    expect(ledger.graceElapsed(g1)).toEqual({ kind: "none" });
    expect(ledger.graceElapsed(g2)).toEqual({ kind: "none" });
    expect(ledger.graceElapsed(g3)).toEqual({ kind: "commit", payload: P3 });
  });

  it("in-turn consumption: single result after tasks finished mid-turn commits after grace", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted({ taskId: "agent" }, 0);
    ledger.taskStarted({ taskId: "bash" }, 0);
    ledger.taskFinished("agent", 0);
    ledger.taskFinished("bash", 0);
    const gen = generationOf(ledger.successResult(P1, 0));
    expect(ledger.graceElapsed(gen)).toEqual({ kind: "commit", payload: P1 });
  });

  it("tracks task_id restart cycles via the live set", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted({ taskId: "a" }, 0);
    ledger.taskFinished("a", 0);
    ledger.taskStarted({ taskId: "a" }, 0); // same id restarts (subagent resumed by its own nested task)
    expect(ledger.pendingTaskCount).toBe(1);
    expect(ledger.successResult(P1, 0)).toEqual({ kind: "cancel" }); // still deferred
    ledger.taskFinished("a", 0);
    expect(ledger.successResult(P2, 0).kind).toBe("schedule");
  });

  it("task events during grace re-arm the timer instead of cancelling (no wedge)", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted({ taskId: "a" }, 0);
    ledger.taskFinished("a", 0);
    const g1 = generationOf(ledger.successResult(P1, 0));
    // An orphaned nested-task notification arrives with no resume behind it.
    const rearm = ledger.taskFinished("orphan", 0);
    const g2 = generationOf(rearm);
    expect(g2).not.toBe(g1);
    expect(ledger.graceElapsed(g1)).toEqual({ kind: "none" });
    expect(ledger.graceElapsed(g2)).toEqual({ kind: "commit", payload: P1 });
  });

  it("taskListChanged replaces the live set (authoritative snapshot)", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted({ taskId: "stale" }, 0);
    ledger.taskListChanged([{ taskId: "a" }, { taskId: "b" }], 0);
    expect(ledger.pendingTaskCount).toBe(2);
    ledger.taskListChanged([], 0);
    expect(ledger.pendingTaskCount).toBe(0);
    expect(ledger.successResult(P1, 0).kind).toBe("schedule"); // saw background activity
  });

  // The descriptors the UI renders. The harness pushes a full snapshot on
  // every change, so the ledger — not the client — has to be the thing that
  // remembers when each task first appeared.
  it("exposes task descriptors, and startedAt survives snapshot resyncs", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted({ taskId: "a", taskType: "local_bash", description: "run the build" }, 1_000);
    ledger.taskListChanged([{ taskId: "a", taskType: "local_bash", description: "run the build" }], 9_000);
    ledger.taskListChanged(
      [
        { taskId: "a", taskType: "local_bash", description: "run the build" },
        { taskId: "b", taskType: "local_agent", description: "a subagent" },
      ],
      9_000,
    );
    expect(ledger.backgroundTasks).toEqual([
      { taskId: "a", taskType: "local_bash", description: "run the build", startedAt: 1_000 },
      { taskId: "b", taskType: "local_agent", description: "a subagent", startedAt: 9_000 },
    ]);
  });

  // A Bash-tool command promoted to the background by a timeout is announced
  // by task_started (which carries the description) and only later appears in
  // a snapshot — which may omit it. Neither event alone is complete.
  it("merges labels across events rather than letting a later one blank them", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted({ taskId: "a", taskType: "local_bash", description: "wait for build" }, 1_000);
    ledger.taskListChanged([{ taskId: "a" }], 5_000);
    expect(ledger.backgroundTasks).toEqual([
      { taskId: "a", taskType: "local_bash", description: "wait for build", startedAt: 1_000 },
    ]);
  });

  it("drops descriptors as tasks finish, and reports an empty set when idle", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted({ taskId: "a", description: "one" }, 0);
    ledger.taskStarted({ taskId: "b", description: "two" }, 0);
    ledger.taskFinished("a", 0);
    expect(ledger.backgroundTasks.map((t) => t.taskId)).toEqual(["b"]);
    ledger.reset();
    expect(ledger.backgroundTasks).toEqual([]);
  });

  // The bound that makes a wedge temporary. Parking bets on an auto-resume
  // that a never-finishing task never triggers, so the bet needs a deadline.
  it("gives a parked completion a deadline, counted from when it parked", () => {
    const ledger = new TurnCompletionLedger(1_000);
    ledger.taskStarted({ taskId: "a" }, 5_000);
    expect(ledger.parkDeadlineAt).toBeNull(); // nothing parked yet
    ledger.successResult(P1, 9_000);
    expect(ledger.parkDeadlineAt).toBe(10_000);
  });

  // Task churn while parked must not push the deadline out, or a session that
  // keeps spawning tasks would never reach it.
  it("does not extend the deadline as other tasks come and go", () => {
    const ledger = new TurnCompletionLedger(1_000);
    ledger.taskStarted({ taskId: "a" }, 0);
    ledger.successResult(P1, 0);
    ledger.taskStarted({ taskId: "b" }, 500);
    ledger.taskFinished("b", 800);
    expect(ledger.parkDeadlineAt).toBe(1_000);
  });

  // A task appearing after the result parks the candidate through rearmIfHeld
  // rather than successResult — that path needs a deadline just as much.
  it("bounds a completion parked by a task that started after the result", () => {
    const ledger = new TurnCompletionLedger(1_000);
    ledger.taskStarted({ taskId: "a" }, 0);
    ledger.taskFinished("a", 0);
    ledger.successResult(P1, 100); // empty ledger → scheduled, not parked
    ledger.taskStarted({ taskId: "b" }, 300); // now parked
    expect(ledger.parkDeadlineAt).toBe(1_300);
  });

  it("commits the ORIGINAL payload when the deadline elapses", () => {
    const ledger = new TurnCompletionLedger(1_000);
    ledger.taskStarted({ taskId: "a" }, 0);
    ledger.successResult(P1, 0);
    expect(ledger.parkDeadlineElapsed()).toEqual({ kind: "commit", payload: P1 });
    expect(ledger.parkDeadlineAt).toBeNull();
    expect(ledger.hasPendingCompletion).toBe(false);
    // The task outlived the turn; it is still live and still reported.
    expect(ledger.backgroundTasks.map((t) => t.taskId)).toEqual(["a"]);
  });

  // Vouching restores the original behavior for that task alone: keep waiting
  // for it, let the auto-resume close the turn.
  it("lifts the deadline only once every live task is vouched for", () => {
    const ledger = new TurnCompletionLedger(1_000);
    ledger.taskStarted({ taskId: "a" }, 0);
    ledger.taskStarted({ taskId: "b" }, 0);
    ledger.successResult(P1, 0);
    ledger.sanction("a");
    expect(ledger.parkDeadlineAt).toBe(1_000);
    ledger.sanction("b");
    expect(ledger.parkDeadlineAt).toBeNull();
    expect(ledger.backgroundTasks.map((t) => t.sanctioned)).toEqual([true, true]);
  });

  // Vouching is per task, not per session: a task that ends takes its
  // exemption with it, so a recycled id can't inherit someone else's.
  it("drops a vouch when the task ends", () => {
    const ledger = new TurnCompletionLedger(1_000);
    ledger.taskStarted({ taskId: "a" }, 0);
    ledger.successResult(P1, 0);
    ledger.sanction("a");
    ledger.taskListChanged([], 500);
    ledger.taskStarted({ taskId: "a" }, 700);
    expect(ledger.backgroundTasks.map((t) => t.sanctioned)).toEqual([undefined]);
    expect(ledger.parkDeadlineAt).toBe(1_000);
  });

  // Live tasks shield the session from reclamation — hibernating would kill a
  // real build and the auto-resume that reads it. But an unbounded shield is
  // how one stuck shell pins a resident slot forever, so the deadline lifts it.
  it("stops shielding the session once the deadline judged a task anomalous", () => {
    const ledger = new TurnCompletionLedger(1_000);
    expect(ledger.backgroundTasksProtectSession).toBe(false); // nothing running

    ledger.taskStarted({ taskId: "a" }, 0);
    ledger.successResult(P1, 0);
    expect(ledger.backgroundTasksProtectSession).toBe(true);

    ledger.parkDeadlineElapsed();
    expect(ledger.backgroundTasksProtectSession).toBe(false);

    // Vouching restores the shield along with the waiting it protects.
    ledger.sanction("a");
    expect(ledger.backgroundTasksProtectSession).toBe(true);
  });

  // The next turn must start from a clean slate: its own tasks get their own
  // deadline, and until that expires they shield the session again.
  it("restores the shield when a new turn starts", () => {
    const ledger = new TurnCompletionLedger(1_000);
    ledger.taskStarted({ taskId: "a" }, 0);
    ledger.successResult(P1, 0);
    ledger.parkDeadlineElapsed();
    expect(ledger.backgroundTasksProtectSession).toBe(false);

    ledger.noteTurnActivity(); // auto-resume, or the user sending a message
    expect(ledger.backgroundTasksProtectSession).toBe(true);
  });

  it("error result discards the held completion", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted({ taskId: "a" }, 0);
    ledger.taskFinished("a", 0);
    const gen = generationOf(ledger.successResult(P1, 0));
    expect(ledger.errorResult()).toEqual({ kind: "cancel" });
    expect(ledger.graceElapsed(gen)).toEqual({ kind: "none" });
  });

  it("clean process exit commits the held completion immediately", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted({ taskId: "a" }, 0);
    ledger.taskFinished("a", 0);
    const gen = generationOf(ledger.successResult(P1, 0));
    expect(ledger.processExited(0)).toEqual({ kind: "commit", payload: P1 });
    expect(ledger.graceElapsed(gen)).toEqual({ kind: "none" });
  });

  it("non-zero process exit discards the held completion", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted({ taskId: "a" }, 0);
    ledger.taskFinished("a", 0);
    const gen = generationOf(ledger.successResult(P1, 0));
    expect(ledger.processExited(1)).toEqual({ kind: "cancel" });
    expect(ledger.graceElapsed(gen)).toEqual({ kind: "none" });
  });

  it("clean exit without a held completion just clears state", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted({ taskId: "a" }, 0);
    expect(ledger.processExited(0)).toEqual({ kind: "cancel" });
    expect(ledger.pendingTaskCount).toBe(0);
  });

  it("background flag survives a commit: a premature grace commit must not fast-path the chain's later results", () => {
    // Live-observed failure: the resume turn's first stream event lags a full
    // LLM roundtrip behind the intermediate result, so the grace can fire
    // early. If that commit cleared the background flag, every later result
    // of the chain would commit instantly — three chimes instead of one.
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted({ taskId: "a" }, 0);
    ledger.taskFinished("a", 0);
    const g1 = generationOf(ledger.successResult(P1, 0));
    expect(ledger.graceElapsed(g1)).toEqual({ kind: "commit", payload: P1 }); // premature
    ledger.noteTurnActivity(); // resume turn finally streams
    expect(ledger.successResult(P2, 0).kind).toBe("schedule"); // still held, not instant
  });

  it("a new user turn resets the background flag: its plain result commits immediately", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted({ taskId: "a" }, 0);
    ledger.taskFinished("a", 0);
    const gen = generationOf(ledger.successResult(P1, 0));
    expect(ledger.graceElapsed(gen).kind).toBe("commit");
    ledger.userTurnStarted();
    expect(ledger.successResult(P2, 0)).toEqual({ kind: "commit", payload: P2 });
  });

  it("userTurnStarted discards a held completion (user moved on)", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted({ taskId: "a" }, 0);
    ledger.taskFinished("a", 0);
    const gen = generationOf(ledger.successResult(P1, 0));
    expect(ledger.userTurnStarted()).toEqual({ kind: "cancel" });
    expect(ledger.graceElapsed(gen)).toEqual({ kind: "none" });
  });

  it("noteTurnActivity without a held completion is a no-op", () => {
    const ledger = new TurnCompletionLedger();
    expect(ledger.noteTurnActivity()).toEqual({ kind: "none" });
  });

  it("reset clears tasks, held completion, and the background flag", () => {
    const ledger = new TurnCompletionLedger();
    ledger.taskStarted({ taskId: "a" }, 0);
    ledger.taskFinished("a", 0);
    const gen = generationOf(ledger.successResult(P1, 0));
    ledger.reset();
    expect(ledger.pendingTaskCount).toBe(0);
    expect(ledger.hasPendingCompletion).toBe(false);
    expect(ledger.graceElapsed(gen)).toEqual({ kind: "none" });
    expect(ledger.successResult(P2, 0)).toEqual({ kind: "commit", payload: P2 });
  });
});
