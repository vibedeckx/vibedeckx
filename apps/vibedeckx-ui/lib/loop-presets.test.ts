import { describe, expect, it } from "vitest";
import {
  generateInstruction, PLAN_PRESET, presetFieldsForMeta, presetSourceLabel,
} from "./loop-presets";

describe("generateInstruction — Plan file", () => {
  it("fills every placeholder from the defaults; no template marker survives", () => {
    const text = generateInstruction("plan", { ...PLAN_PRESET.defaults });
    expect(text).not.toMatch(/\{\{|\}\}|TODO|<promise>/);
    expect(text).toContain("`docs/implementation-plan.md`");
    expect(text).toContain("note the value and the reason in the commit body");
    // No marker vocabulary: the loop's ledger is the source of progress (design §5.3) …
    expect(text).not.toContain("Pass condition");
    expect(text).toContain("NOT in the completed list");
    // … a step found already done is reported, not redone …
    expect(text).toContain("do not redo it");
    // … and ticking the file follows the file's own convention, when it has one.
    expect(text).toContain("the file's own convention");
    expect(text).toContain("`Remaining:` to the number of steps still not done");
    // Bridge to the loop's closing protocol instead of Ralph's <promise> markers.
    expect(text).toContain("`Status: done`");
    expect(text).toContain("`Status: blocked`");
    expect(text).toContain("`Status: continue`");
    // progress.md is gone (the engine will carry the handoff).
    expect(text).not.toContain("progress.md");
  });

  it("omits the sections of empty optional fields", () => {
    const text = generateInstruction("plan", { ...PLAN_PRESET.defaults });
    expect(text).not.toContain("Also read these every session");
    expect(text).not.toContain("Constraints that must never be violated");
    expect(text).not.toContain("Run these every session");
    expect(text).not.toContain("not a blocker:\n");
  });

  it("writes multi-line fields as lists, one entry per non-blank line", () => {
    const text = generateInstruction("plan", {
      ...PLAN_PRESET.defaults,
      planFile: "PLAN.md",
      readDocs: "AGENTS.md\n\n  docs/design.md  ",
    });
    expect(text).toContain("`PLAN.md`");
    expect(text).not.toContain("implementation-plan.md");
    expect(text).toContain("  - AGENTS.md\n  - docs/design.md");
  });

  it("blank single-line fields fall back to the defaults", () => {
    const text = generateInstruction("plan", { planFile: "  " });
    expect(text).toContain("`docs/implementation-plan.md`");
  });

  it("ignores the marker fields of drafts saved before they were dropped", () => {
    const text = generateInstruction("plan", { ...PLAN_PRESET.defaults, pendingMarker: "**Pass condition.** False", doneMarker: "**Pass condition.** True" });
    expect(text).not.toContain("Pass condition");
    expect(presetFieldsForMeta("plan", { planFile: "PLAN.md", pendingMarker: "x" })).toEqual({ planFile: "PLAN.md" });
  });

});

describe("generateInstruction — Write my own", () => {
  it("generates nothing until it says where items come from", () => {
    expect(generateInstruction("custom", { planFile: "x" })).toBe("");
    expect(generateInstruction("custom", { source: " \n " })).toBe("");
  });

  it("wraps the user's source in the shared skeleton", () => {
    const text = generateInstruction("custom", { source: "Each error `pnpm lint` reports.\n\nOne per session." });
    expect(text).toContain("  > Each error `pnpm lint` reports.\n  > One per session.");
    expect(text).toContain("NOT in the completed list");
    expect(text).toContain("do not redo it");
    expect(text).toContain("`Status: done`");
    expect(text).toContain("`Status: blocked`");
    expect(text).toContain("`Status: continue`");
    // Not every item changes the repo; nothing about a plan.
    expect(text).toContain("If nothing in the repository changed, there is nothing to commit");
    expect(text).not.toContain("the plan");
    // Marking a finished item is the description's job; the template only follows it.
    expect(text).toContain("Otherwise leave the source alone");
    expect(text).not.toContain("Also read these every session");
  });

  it("adds the docs to read, and ignores a marking field from older drafts", () => {
    const text = generateInstruction("custom", { source: "todo/", markDone: "Move it to done/.", readDocs: "AGENTS.md" });
    expect(text).toContain("  - AGENTS.md");
    expect(text).not.toContain("Move it to done/.");
    expect(presetFieldsForMeta("custom", { source: "todo/", markDone: "x" })).toEqual({ source: "todo/" });
  });
});

describe("preset metadata", () => {
  it("records only the preset's own non-blank fields", () => {
    expect(presetFieldsForMeta("plan", { planFile: "PLAN.md", readDocs: " ", junk: "x" })).toEqual({ planFile: "PLAN.md" });
    expect(presetFieldsForMeta("custom", { planFile: "x" })).toBeUndefined();
    expect(presetFieldsForMeta("custom", { planFile: "x", source: "todo/" })).toEqual({ source: "todo/" });
  });

  it("labels the card's source line", () => {
    expect(presetSourceLabel({ kind: "plan", fields: { planFile: "PLAN.md" } })).toBe("Plan: PLAN.md");
    expect(presetSourceLabel({ kind: "plan" })).toBe("Plan: docs/implementation-plan.md");
    expect(presetSourceLabel({ kind: "plan", edited: true })).toBe("Plan: docs/implementation-plan.md（已手改）");
    expect(presetSourceLabel({ kind: "custom" })).toBe("Own instruction");
    expect(presetSourceLabel({ kind: "custom", fields: { source: "\norders.md\nmore" } })).toBe("Own: orders.md");
    expect(presetSourceLabel({ kind: "custom", fields: { source: "x".repeat(70) } })).toBe(`Own: ${"x".repeat(60)}…`);
    expect(presetSourceLabel(null)).toBeNull();
    expect(presetSourceLabel({ kind: "tasks" as never })).toBeNull();
  });
});
