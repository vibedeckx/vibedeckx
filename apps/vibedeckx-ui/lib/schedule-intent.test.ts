import { describe, it, expect } from "vitest";
import { appendScheduleIntent, SCHEDULE_INTENT_BLOCK, takeScheduleMarker } from "./schedule-intent";

describe("schedule intent block", () => {
  it("appends after the text and comes back out intact", () => {
    const sent = appendScheduleIntent("every weekday at 9");
    expect(sent).toBe(`every weekday at 9\n\n${SCHEDULE_INTENT_BLOCK}`);
    expect(takeScheduleMarker(sent as string)).toEqual({ text: "every weekday at 9", found: true });
  });

  it("is the whole message when nothing was typed", () => {
    expect(appendScheduleIntent("")).toBe(SCHEDULE_INTENT_BLOCK);
    expect(takeScheduleMarker(SCHEDULE_INTENT_BLOCK)).toEqual({ text: "", found: true });
  });

  it("rides as its own text part next to images", () => {
    const image = { type: "image" as const, mediaType: "image/png", data: "x" };
    expect(appendScheduleIntent([image])).toEqual([image, { type: "text", text: SCHEDULE_INTENT_BLOCK }]);
  });

  it("is still found with the hub's grant block after it", () => {
    const delivered = `${appendScheduleIntent("go")}\n\n<vremotes names="a">x</vremotes>`;
    expect(takeScheduleMarker(delivered).found).toBe(true);
  });

  it("leaves text without the block untouched", () => {
    expect(takeScheduleMarker("plain  ")).toEqual({ text: "plain  ", found: false });
  });
});
