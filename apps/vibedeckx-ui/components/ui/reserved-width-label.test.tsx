// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ReservedWidthLabel } from "./reserved-width-label";

describe("ReservedWidthLabel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
  });

  // jsdom does not lay out, so the width itself cannot be asserted here. What is
  // testable is the structure that produces it: one sizer per candidate, all in
  // the same grid cell.
  it("renders a hidden sizer for every candidate plus the visible label", async () => {
    await act(async () => {
      root.render(
        <ReservedWidthLabel candidates={["Claude Code", "Codex"]}>Codex</ReservedWidthLabel>,
      );
    });

    const sizers = Array.from(container.querySelectorAll("[aria-hidden]"));
    expect(sizers.map((s) => s.textContent)).toEqual(["Claude Code", "Codex"]);
    for (const s of sizers) {
      expect(s.className).toContain("invisible");
      expect(s.className).toContain("col-start-1");
      expect(s.className).toContain("row-start-1");
    }

    const visible = container.querySelector("span > span:not([aria-hidden])");
    expect(visible?.textContent).toBe("Codex");
    expect(visible?.className).toContain("truncate");
  });

  it("collapses duplicate candidates so React keys stay unique", async () => {
    await act(async () => {
      root.render(
        <ReservedWidthLabel candidates={["opus", "opus", "sonnet"]}>opus</ReservedWidthLabel>,
      );
    });

    expect(container.querySelectorAll("[aria-hidden]")).toHaveLength(2);
  });

  it("keeps the sizers out of the accessible text", async () => {
    await act(async () => {
      root.render(
        <button>
          <ReservedWidthLabel candidates={["Claude Code", "Codex"]}>Codex</ReservedWidthLabel>
        </button>,
      );
    });

    // Every sizer is aria-hidden, so a screen reader announces the label once
    // rather than once per candidate.
    const announced = Array.from(container.querySelectorAll("span"))
      .filter((s) => !s.hasAttribute("aria-hidden") && s.children.length === 0)
      .map((s) => s.textContent);
    expect(announced).toEqual(["Codex"]);
  });
});
