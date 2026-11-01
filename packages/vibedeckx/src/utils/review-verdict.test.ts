import { describe, expect, it } from "vitest";
import {
  HANDOFF_INSTRUCTIONS, HANDOFF_MAX_CHARS, HANDOFF_MAX_LINES, parseClosingLine, parseTaskStatus, parseVerdict, splitHandoff,
  TASK_STATUS_INSTRUCTIONS,
} from "./review-verdict.js";

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

describe("splitHandoff", () => {
  it("everything from the first standalone Handoff: line on is the note; the rest is the body", () => {
    const reply = "Did S2.\n\nStatus: continue\nItem: S2\nRemaining: 1\n\nHandoff:\n- tests need NODE_ENV=test\n- S3 next";
    expect(splitHandoff(reply)).toEqual({
      body: "Did S2.\n\nStatus: continue\nItem: S2\nRemaining: 1\n",
      handoff: "- tests need NODE_ENV=test\n- S3 next",
    });
    // Text on the marker line itself belongs to the note; markdown marks are allowed.
    expect(splitHandoff("Status: done\n**Handoff:** all clear").handoff).toBe("all clear");
    expect(splitHandoff("Status: done\n## Handoff:\nx").handoff).toBe("x");
  });

  it("a Status: line inside the note cannot override the real status", () => {
    const reply = "Status: continue\nItem: S1\nHandoff:\nlast time S0 ended with\nStatus: blocked";
    const { body, handoff } = splitHandoff(reply);
    expect(parseTaskStatus(body)).toBe("continue");
    expect(parseClosingLine(body, "Item")).toBe("S1");
    expect(handoff).toContain("Status: blocked");
  });

  it("a repeated Handoff: inside the note splits at the FIRST one", () => {
    const reply = "Status: continue\nHandoff:\nlessons\nStatus: blocked\nHandoff:\nstep 2 notes";
    const { body, handoff } = splitHandoff(reply);
    expect(body).toBe("Status: continue");
    expect(parseTaskStatus(body)).toBe("continue");
    expect(handoff).toBe("lessons\nStatus: blocked\nHandoff:\nstep 2 notes");
  });

  it("only a line that OPENS with the label counts; no marker → whole text is body", () => {
    const prose = "See the Handoff: section of the docs.\nStatus: continue";
    expect(splitHandoff(prose)).toEqual({ body: prose, handoff: null });
    expect(splitHandoff(null)).toEqual({ body: null, handoff: null });
    expect(splitHandoff("Status: done\nHandoff:\n   \n")).toEqual({ body: "Status: done", handoff: null });
  });

  it("caps the note at 60 lines and 4000 characters", () => {
    const many = Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n");
    const byLines = splitHandoff(`Status: continue\nHandoff:\n${many}`).handoff!;
    expect(byLines.split("\n")).toHaveLength(HANDOFF_MAX_LINES);
    expect(byLines.endsWith(`line ${HANDOFF_MAX_LINES - 1}`)).toBe(true);
    const long = splitHandoff(`Status: continue\nHandoff:\n${"x".repeat(9000)}`).handoff!;
    expect(long).toHaveLength(HANDOFF_MAX_CHARS);
  });

  it("the closing instructions put the note last and keep the status labels out of it", () => {
    expect(HANDOFF_INSTRUCTIONS).toContain("\nHandoff:\n");
    expect(HANDOFF_INSTRUCTIONS).toMatch(/very last part/);
    expect(HANDOFF_INSTRUCTIONS).toMatch(/"Status:", "Item:" or "Remaining:"/);
  });
});

describe("TASK_STATUS_INSTRUCTIONS ↔ the New loop dialog's preview", () => {
  it("the UI shows exactly what the engine appends (apps/vibedeckx-ui/lib/loop-presets.ts)", async () => {
    // A path in a variable: the UI file is outside this package's tsc rootDir.
    const uiModule = new URL("../../../../apps/vibedeckx-ui/lib/loop-presets.ts", import.meta.url).href;
    const { TASK_STATUS_PROTOCOL_PREVIEW } = (await import(uiModule)) as { TASK_STATUS_PROTOCOL_PREVIEW: string };
    expect(TASK_STATUS_PROTOCOL_PREVIEW).toBe(TASK_STATUS_INSTRUCTIONS);
  });
});
