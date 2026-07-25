import { describe, expect, it } from "vitest";
import { AgentSessionManager } from "./agent-session-manager.js";
import { EventBus, type GlobalEvent } from "./event-bus.js";
import { reviewerTurnEndOutcomeFromRemotePatch } from "./routes/remote-status-bridge.js";
import { ConversationPatch } from "./conversation-patch.js";
import type { AgentMessage } from "./agent-types.js";
import type { Storage } from "./storage/types.js";

/**
 * Front-side branch:activity bridging for the remote (front+worker) review
 * path. The front never subscribes to the worker's event bus: it reconstructs a
 * remote session's branch:activity from its own outbound sends + the session-WS
 * `taskCompleted` frame, gated through `BranchActivityDedupe`. A worker-spawned
 * reviewer breaks that: its `working` is produced worker-side (never bridged),
 * and the branch is already sitting at the source's `completed`, so the
 * reviewer's terminal `completed` is a no-op transition the dedupe drops — no
 * completion notification. The fix seeds `working` at registration, then
 * reconciles the terminal `completed` from the reviewer's `turn_end` entry
 * (which IS replayed, unlike `taskCompleted`) — success-gated by the turn_end
 * outcome so failed/interrupted reviews don't ding.
 */

const PROJECT = "p1";
const BRANCH = "feat";
const REVIEWER = "remote-srv1-p1-rev1";

function harness() {
  const mgr = new AgentSessionManager({} as unknown as Storage);
  const bus = new EventBus();
  mgr.setEventBus(bus);
  const branchEvents: Array<Extract<GlobalEvent, { type: "branch:activity" }>> = [];
  bus.subscribe((e) => {
    if (e.type === "branch:activity") branchEvents.push(e);
  });
  return { mgr, branchEvents };
}

/** A raw session-WS frame for a `turn_end` stop-point entry with the given outcome. */
function turnEndFrame(outcome: string, index = 7): string {
  const entry = { type: "turn_end", timestamp: 1, durationMs: 10, outcome } as unknown as AgentMessage;
  return JSON.stringify({ JsonPatch: ConversationPatch.addEntry(index, entry) });
}

describe("remote reviewer completion bridging", () => {
  it("REGRESSION: a second `completed` on an already-`completed` branch is deduped (the bug)", () => {
    const { mgr, branchEvents } = harness();
    mgr.emitBranchActivityIfChanged(PROJECT, BRANCH, { activity: "completed", since: 1 });
    mgr.emitBranchActivityIfChanged(PROJECT, BRANCH, { activity: "completed", since: 2, sessionId: REVIEWER });
    expect(branchEvents.map((e) => e.activity)).toEqual(["completed"]);
  });

  it("seeding `working` at registration makes the reviewer's terminal `completed` a real transition", () => {
    const { mgr, branchEvents } = harness();
    mgr.emitBranchActivityIfChanged(PROJECT, BRANCH, { activity: "completed", since: 1 });
    mgr.emitBranchActivityIfChanged(PROJECT, BRANCH, { activity: "working", since: 2, sessionId: REVIEWER });
    mgr.emitBranchActivityIfChanged(PROJECT, BRANCH, { activity: "completed", since: 3, sessionId: REVIEWER });
    expect(branchEvents.map((e) => e.activity)).toEqual(["completed", "working", "completed"]);
    expect(branchEvents.at(-1)!.sessionId).toBe(REVIEWER); // mapped local id, not worker's raw id
  });

  describe("reconcileRemoteReviewerTurnEnd (turn_end fallback)", () => {
    it("no-ops for a session that was never marked a reviewer", () => {
      const { mgr, branchEvents } = harness();
      mgr.emitBranchActivityIfChanged(PROJECT, BRANCH, { activity: "working", since: 1, sessionId: REVIEWER });
      expect(mgr.reconcileRemoteReviewerTurnEnd(PROJECT, BRANCH, REVIEWER, "completed")).toBeNull();
      expect(branchEvents.map((e) => e.activity)).toEqual(["working"]);
    });

    it("derives `completed` from a `completed` turn_end when taskCompleted never bridged", () => {
      const { mgr, branchEvents } = harness();
      mgr.emitBranchActivityIfChanged(PROJECT, BRANCH, { activity: "working", since: 1, sessionId: REVIEWER });
      mgr.markRemoteReviewerForReconcile(REVIEWER);
      const out = mgr.reconcileRemoteReviewerTurnEnd(PROJECT, BRANCH, REVIEWER, "completed");
      expect(out?.activity).toBe("completed");
      expect(branchEvents.map((e) => e.activity)).toEqual(["working", "completed"]);
      expect(branchEvents.at(-1)!.sessionId).toBe(REVIEWER);
    });

    it.each(["failed", "stopped", "process_exit"])(
      "does NOT ding on a `%s` turn_end — a failed/interrupted review must stay silent",
      (outcome) => {
        const { mgr, branchEvents } = harness();
        mgr.emitBranchActivityIfChanged(PROJECT, BRANCH, { activity: "working", since: 1, sessionId: REVIEWER });
        mgr.markRemoteReviewerForReconcile(REVIEWER);
        expect(mgr.reconcileRemoteReviewerTurnEnd(PROJECT, BRANCH, REVIEWER, outcome)).toBeNull();
        expect(branchEvents.map((e) => e.activity)).toEqual(["working"]);
      },
    );

    it("consumes the marker on any terminal turn_end (no unbounded growth / re-fire)", () => {
      const { mgr, branchEvents } = harness();
      mgr.emitBranchActivityIfChanged(PROJECT, BRANCH, { activity: "working", since: 1, sessionId: REVIEWER });
      mgr.markRemoteReviewerForReconcile(REVIEWER);
      // First (failed) turn_end consumes the marker without dinging...
      expect(mgr.reconcileRemoteReviewerTurnEnd(PROJECT, BRANCH, REVIEWER, "failed")).toBeNull();
      // ...so a later `completed` (e.g. a human-takeover turn) no longer reconciles.
      expect(mgr.reconcileRemoteReviewerTurnEnd(PROJECT, BRANCH, REVIEWER, "completed")).toBeNull();
      expect(branchEvents.map((e) => e.activity)).toEqual(["working"]);
    });

    it("is idempotent against a live taskCompleted-derived `completed` (dedupe + marker consumed)", () => {
      const { mgr, branchEvents } = harness();
      mgr.emitBranchActivityIfChanged(PROJECT, BRANCH, { activity: "working", since: 1, sessionId: REVIEWER });
      mgr.markRemoteReviewerForReconcile(REVIEWER);
      // turn_end fires first (real stream order), emitting completed + consuming marker.
      mgr.reconcileRemoteReviewerTurnEnd(PROJECT, BRANCH, REVIEWER, "completed");
      // taskCompleted frame arrives next → clearRemoteReviewerReconcile (no-op) + dedup.
      mgr.clearRemoteReviewerReconcile(REVIEWER);
      mgr.emitBranchActivityIfChanged(PROJECT, BRANCH, { activity: "completed", since: 2, sessionId: REVIEWER });
      expect(branchEvents.map((e) => e.activity)).toEqual(["working", "completed"]);
    });
  });

  // Mirrors the reconnect sync-delta scan in remote-agent-sessions.ts: a review
  // that finished during a disconnect is only seen on reconnect, as a replayed
  // `turn_end` patch (taskCompleted isn't replayed). Drives the same
  // detection helper + manager method the scan loop composes.
  describe("reconnect replay scan (turn_end recovered from replay buffer)", () => {
    it("recovers a `completed` review missed during the disconnect", () => {
      const { mgr, branchEvents } = harness();
      mgr.emitBranchActivityIfChanged(PROJECT, BRANCH, { activity: "working", since: 1, sessionId: REVIEWER });
      mgr.markRemoteReviewerForReconcile(REVIEWER);
      // Replayed history on reconnect: some entries, then the completion turn_end.
      const replayBuffer = [
        JSON.stringify({ JsonPatch: ConversationPatch.addEntry(6, { type: "assistant", content: "review", timestamp: 1 } as AgentMessage) }),
        turnEndFrame("completed"),
      ];
      for (const raw of replayBuffer) {
        const parsed = JSON.parse(raw);
        const outcome = reviewerTurnEndOutcomeFromRemotePatch(parsed);
        if (outcome !== null) mgr.reconcileRemoteReviewerTurnEnd(PROJECT, BRANCH, REVIEWER, outcome);
      }
      expect(branchEvents.map((e) => e.activity)).toEqual(["working", "completed"]);
    });

    it("stays silent when the replayed review turn_end failed", () => {
      const { mgr, branchEvents } = harness();
      mgr.emitBranchActivityIfChanged(PROJECT, BRANCH, { activity: "working", since: 1, sessionId: REVIEWER });
      mgr.markRemoteReviewerForReconcile(REVIEWER);
      const parsed = JSON.parse(turnEndFrame("failed"));
      const outcome = reviewerTurnEndOutcomeFromRemotePatch(parsed);
      if (outcome !== null) mgr.reconcileRemoteReviewerTurnEnd(PROJECT, BRANCH, REVIEWER, outcome);
      expect(branchEvents.map((e) => e.activity)).toEqual(["working"]);
    });
  });
});
