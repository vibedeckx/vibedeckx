import { describe, it, expect } from "vitest";
import { appendTaskIntent, TASK_INTENT_BLOCK, takeTaskMarker } from "./task-intent";

describe("task intent block", () => {
  it("appends after the text and comes back out intact", () => {
    const sent = appendTaskIntent("the skipped remote test");
    expect(sent).toBe(`the skipped remote test\n\n${TASK_INTENT_BLOCK}`);
    expect(takeTaskMarker(sent as string)).toEqual({ text: "the skipped remote test", found: true });
  });

  it("is the whole message when nothing was typed", () => {
    expect(appendTaskIntent("")).toBe(TASK_INTENT_BLOCK);
    expect(takeTaskMarker(TASK_INTENT_BLOCK)).toEqual({ text: "", found: true });
  });

  it("rides as its own text part next to images", () => {
    const image = { type: "image" as const, mediaType: "image/png", data: "x" };
    expect(appendTaskIntent([image])).toEqual([image, { type: "text", text: TASK_INTENT_BLOCK }]);
  });

  it("tells the agent to record, not do, the work", () => {
    expect(TASK_INTENT_BLOCK).toMatch(/Do NOT do the work now/);
  });

  it("leaves text without the block untouched", () => {
    expect(takeTaskMarker("plain  ")).toEqual({ text: "plain  ", found: false });
  });
});
