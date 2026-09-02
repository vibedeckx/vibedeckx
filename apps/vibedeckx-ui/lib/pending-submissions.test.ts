// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearPendingSubmission,
  readPendingSubmission,
  sameSubmissionContent,
  writePendingSubmission,
  type PendingSubmission,
} from "./pending-submissions";

const sub = (over: Partial<PendingSubmission> = {}): PendingSubmission => ({
  workspaceKey: "p1:main:local", projectId: "p1", branch: "main", agentMode: "local",
  operationId: "op-1", sessionId: null, content: "hello", createdAt: 1, ...over,
});

describe("pending submissions store", () => {
  beforeEach(() => { window.sessionStorage.clear(); });

  it("round-trips through sessionStorage and survives a reload of the module state", () => {
    expect(writePendingSubmission(sub())).toBeNull();
    expect(readPendingSubmission("p1:main:local")).toMatchObject({ operationId: "op-1", content: "hello" });
    expect(readPendingSubmission("p1:other:local")).toBeNull();
    // The raw storage is the only state: a fresh read sees exactly what was written.
    expect(JSON.parse(window.sessionStorage.getItem("vibedeckx:pending-submissions")!)).toHaveLength(1);
  });

  it("reports the submission it replaces for the same workspace", () => {
    writePendingSubmission(sub());
    expect(writePendingSubmission(sub({ operationId: "op-1", sessionId: "s1" }))).toBeNull(); // same operation: update
    expect(readPendingSubmission("p1:main:local")?.sessionId).toBe("s1");
    const replaced = writePendingSubmission(sub({ operationId: "op-2", content: "other" }));
    expect(replaced).toMatchObject({ operationId: "op-1", sessionId: "s1" });
  });

  it("clears only the matching operation", () => {
    writePendingSubmission(sub());
    expect(clearPendingSubmission("p1:main:local", "op-9")).toBe(false);
    expect(readPendingSubmission("p1:main:local")).not.toBeNull();
    expect(clearPendingSubmission("p1:main:local", "op-1")).toBe(true);
    expect(readPendingSubmission("p1:main:local")).toBeNull();
    expect(window.sessionStorage.getItem("vibedeckx:pending-submissions")).toBeNull();
  });

  it("tolerates corrupt storage", () => {
    window.sessionStorage.setItem("vibedeckx:pending-submissions", "{not json");
    expect(readPendingSubmission("p1:main:local")).toBeNull();
    expect(writePendingSubmission(sub())).toBeNull();
    expect(readPendingSubmission("p1:main:local")?.operationId).toBe("op-1");
  });

  it("compares submission content by trimmed text or structural equality", () => {
    expect(sameSubmissionContent("a ", "a")).toBe(true);
    expect(sameSubmissionContent("a", "b")).toBe(false);
    expect(sameSubmissionContent(null, "a")).toBe(false);
    expect(sameSubmissionContent([{ type: "text", text: "a" }], [{ type: "text", text: "a" }])).toBe(true);
    expect(sameSubmissionContent([{ type: "text", text: "a" }], "a")).toBe(false);
  });
});
