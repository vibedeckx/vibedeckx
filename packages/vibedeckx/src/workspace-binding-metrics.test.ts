import { beforeEach, describe, expect, it } from "vitest";
import {
  getWorkspaceBindingReadMetrics,
  recordWorkspaceBindingRead,
  resetWorkspaceBindingReadMetrics,
} from "./workspace-binding-metrics.js";

describe("workspace binding read metrics", () => {
  beforeEach(resetWorkspaceBindingReadMetrics);

  it("keeps independent cumulative counters for every consumer and outcome", () => {
    recordWorkspaceBindingRead("search", "checkout-hit", 2);
    recordWorkspaceBindingRead("search", "legacy-fallback");
    recordWorkspaceBindingRead("notification", "dangling");

    const metrics = getWorkspaceBindingReadMetrics();
    expect(metrics).toContainEqual({ consumer: "search", outcome: "checkout-hit", count: 2 });
    expect(metrics).toContainEqual({ consumer: "search", outcome: "legacy-fallback", count: 1 });
    expect(metrics).toContainEqual({ consumer: "notification", outcome: "dangling", count: 1 });
    expect(metrics).toContainEqual({ consumer: "workflow-reviewer", outcome: "mismatch", count: 0 });
  });
});
