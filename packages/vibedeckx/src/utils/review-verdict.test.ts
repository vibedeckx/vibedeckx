import { describe, expect, it } from "vitest";
import { parseClosingLine, parseTaskStatus, parseVerdict } from "./review-verdict.js";

describe("parseVerdict", () => {
  it("reads the shapes real reviewers produced (2026-09-18 live runs)", () => {
    expect(parseVerdict("实现简单，没有发现正确性问题。\n\n1. **Verdict：** ship\n2. **Blocking findings：** 无。")).toBe("ship");
    expect(parseVerdict("已核对提交与 diff。\n\n1. **Verdict — needs-changes**\n\n2. **Blocking findings**\n   - [P1] …")).toBe("needs-changes");
  });

  it.each([
    ["Verdict: ship", "ship"],
    ["Verdict — cannot-verify", "cannot-verify"],
    ["1. Verdict – needs-changes.", "needs-changes"],
    ["- **Verdict**: `ship`", "ship"],
    ["### Verdict：Needs-Changes", "needs-changes"],
    ["1) VERDICT - SHIP", "ship"],
  ])("normalises %j", (line, expected) => {
    expect(parseVerdict(`some review text\n${line}\nBlocking findings: none`)).toBe(expected);
  });

  it("refuses a negated or qualified value instead of matching the word inside it", () => {
    expect(parseVerdict("Verdict: do not ship")).toBeNull();
    expect(parseVerdict("Verdict: ship (with notes)")).toBeNull();
    expect(parseVerdict("Verdict: not ready to ship yet")).toBeNull();
    expect(parseVerdict("Verdict: needs-changes, but close")).toBeNull();
  });

  it("refuses the option list echoed back", () => {
    expect(parseVerdict("1. Verdict — exactly one of: ship / needs-changes / cannot-verify")).toBeNull();
    expect(parseVerdict("Verdict: ship / needs-changes")).toBeNull();
  });

  it("takes the LAST verdict line, so discussing verdicts earlier cannot decide the outcome", () => {
    expect(parseVerdict("My earlier verdict: ship\nAfter the discussion:\n1. Verdict: needs-changes")).toBe("needs-changes");
    // …and an unreadable last one is not rescued by a readable earlier one.
    expect(parseVerdict("1. Verdict: ship\nOn reflection my verdict is that this should not go out.")).toBeNull();
  });

  it("reads the value from the next non-empty line when the label stands alone", () => {
    expect(parseVerdict("**Verdict**\n\nship\n\nBlocking findings: none")).toBe("ship");
    expect(parseVerdict("## Verdict\n\nI would not ship this.")).toBeNull();
    expect(parseVerdict("Verdict:")).toBeNull();
  });

  it("returns null when there is no verdict at all", () => {
    expect(parseVerdict("Looks fine to me, ship it!")).toBeNull();
    expect(parseVerdict("")).toBeNull();
    expect(parseVerdict(null)).toBeNull();
  });
});


describe("parseTaskStatus", () => {
  it("reads the three values off a closing Status line, tolerating list marks and emphasis", () => {
    expect(parseTaskStatus("Processed order 17.\n\nStatus: continue\nItem: order 17\nRemaining: 4")).toBe("continue");
    expect(parseTaskStatus("- **Status:** done")).toBe("done");
    expect(parseTaskStatus("Status： blocked.")).toBe("blocked");
    expect(parseTaskStatus("status: <continue>")).toBe("continue");
  });

  it("is an exact match: anything else is null, never a guess", () => {
    expect(parseTaskStatus("Status: not done yet")).toBeNull();
    expect(parseTaskStatus("Status: done (mostly)")).toBeNull();
    expect(parseTaskStatus("Status: continue / done / blocked")).toBeNull();
    expect(parseTaskStatus("All done!")).toBeNull();
    expect(parseTaskStatus("")).toBeNull();
    expect(parseTaskStatus(null)).toBeNull();
  });

  it("ignores the word in prose; only a line that opens with the label counts, and the last one wins", () => {
    expect(parseTaskStatus("The API returned status: done for item 3.\nStatus: continue")).toBe("continue");
    expect(parseTaskStatus("The API returned HTTP status 200 and everything is done.")).toBeNull();
    expect(parseTaskStatus("Status: continue\nActually I hit an error.\nStatus: blocked")).toBe("blocked");
  });
});

describe("parseClosingLine", () => {
  it("returns the raw value of the last labelled line", () => {
    expect(parseClosingLine("Status: continue\nItem: `order 17` — refund\nRemaining: 4", "Item")).toBe("order 17 — refund");
    expect(parseClosingLine("Status: done", "Item")).toBeNull();
  });
});
