// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelPicker, modelLabel, shouldOfferCustom } from "./model-picker";

describe("model picker logic", () => {
  it("labels a null model as Default", () => {
    expect(modelLabel(null)).toBe("Default");
    expect(modelLabel("opus")).toBe("opus");
  });

  it("offers a custom entry only for a non-empty query outside the suggestions", () => {
    expect(shouldOfferCustom("my-model", ["opus"])).toBe(true);
    expect(shouldOfferCustom("opus", ["opus"])).toBe(false);
    expect(shouldOfferCustom("", ["opus"])).toBe(false);
    expect(shouldOfferCustom("   ", ["opus"])).toBe(false);
  });
});

describe("ModelPicker rendering", () => {
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

  it("renders a clickable trigger before the session exists", async () => {
    await act(async () => {
      root.render(
        <ModelPicker agentType="claude-code" models={["opus"]} value={null} onChange={vi.fn()} locked={false} />,
      );
    });

    const trigger = container.querySelector("button");
    expect(trigger).not.toBeNull();
    expect(trigger!.textContent).toContain("Default");
  });

  it("is not a control once locked, but keeps the chip it was", async () => {
    await act(async () => {
      root.render(
        <ModelPicker agentType="claude-code" models={["opus"]} value="opus" onChange={vi.fn()} locked />,
      );
    });

    // Not a `<button disabled>`: disabled controls do not dispatch mouse events
    // in most browsers, which would swallow the tooltip carrying the only
    // explanation of why this cannot change.
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("opus");
    // Locking changes colour and clickability, not geometry — the box has to
    // stay the same size and shape as the live picker, or the header row shifts
    // the moment a session starts.
    const chip = container.querySelector("[title]")!;
    expect(chip.className).toContain("border");
    expect(chip.className).toContain("px-2");
    expect(chip.className).toContain("text-muted-foreground");
    expect(chip.className).toContain("cursor-default");
    expect(chip.className).not.toContain("hover:");
    // The tooltip must name an action that actually works. Branching copies
    // the parent's model and accepts no override, so it cannot change it;
    // starting a new conversation is the only path to a live picker.
    const tooltip = container.querySelector("[title]")?.getAttribute("title");
    expect(tooltip).toContain("start a new conversation to change");
    expect(tooltip).not.toContain("branch");
  });

  it("names the full model in the trigger tooltip, since a long name clips", async () => {
    await act(async () => {
      root.render(
        <ModelPicker
          agentType="codex"
          models={["gpt-5.6-codex"]}
          value="some-very-long-custom-model-name"
          onChange={vi.fn()}
          locked={false}
        />,
      );
    });

    expect(container.querySelector("button")?.getAttribute("title")).toBe(
      "some-very-long-custom-model-name",
    );
  });

  it("keeps the full model name reachable when the locked label clips", async () => {
    await act(async () => {
      root.render(
        <ModelPicker
          agentType="codex"
          models={["gpt-5.6-codex"]}
          value="some-very-long-custom-model-name"
          onChange={vi.fn()}
          locked
        />,
      );
    });

    const chip = container.querySelector("[title]")!;
    expect(chip.getAttribute("title")).toContain("some-very-long-custom-model-name");
    // The clip happens inside the reserved slot, so a hand-typed name cannot
    // stretch the chip past the width the suggestions reserved.
    const visible = Array.from(chip.querySelectorAll("span")).find(
      (s) => !s.hasAttribute("aria-hidden") && s.children.length === 0,
    );
    expect(visible?.className).toContain("truncate");
  });

  it("holds the trigger open for every agent's suggestions, not just the active one", async () => {
    await act(async () => {
      root.render(
        <ModelPicker
          agentType="claude-code"
          models={["opus"]}
          // Reserving only "opus" would leave the chip resizing on every agent
          // switch, which is the shift the header row actually shows.
          widthCandidates={["opus", "gpt-5.6-codex"]}
          value={null}
          onChange={vi.fn()}
          locked={false}
        />,
      );
    });

    const sizers = Array.from(container.querySelectorAll("button [aria-hidden]")).map(
      (s) => s.textContent,
    );
    expect(sizers).toContain("gpt-5.6-codex");
  });

  it("shows Default rather than nothing when locked with no model", async () => {
    await act(async () => {
      root.render(
        <ModelPicker agentType="claude-code" models={["opus"]} value={null} onChange={vi.fn()} locked />,
      );
    });

    expect(container.textContent).toContain("Default");
  });
});
