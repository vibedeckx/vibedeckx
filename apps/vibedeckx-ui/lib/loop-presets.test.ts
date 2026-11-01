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

  it("custom generates nothing", () => {
    expect(generateInstruction("custom", { planFile: "x" })).toBe("");
  });
});

describe("preset metadata", () => {
  it("records only the preset's own non-blank fields", () => {
    expect(presetFieldsForMeta("plan", { planFile: "PLAN.md", readDocs: " ", junk: "x" })).toEqual({ planFile: "PLAN.md" });
    expect(presetFieldsForMeta("custom", { planFile: "x" })).toBeUndefined();
  });

  it("labels the card's source line", () => {
    expect(presetSourceLabel({ kind: "plan", fields: { planFile: "PLAN.md" } })).toBe("Plan: PLAN.md");
    expect(presetSourceLabel({ kind: "plan" })).toBe("Plan: docs/implementation-plan.md");
    expect(presetSourceLabel({ kind: "plan", edited: true })).toBe("Plan: docs/implementation-plan.md（已手改）");
    expect(presetSourceLabel({ kind: "custom" })).toBe("Custom");
    expect(presetSourceLabel(null)).toBeNull();
    expect(presetSourceLabel({ kind: "tasks" as never })).toBeNull();
  });
});
