// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelPicker, modelLabel, shouldOfferCustom, shouldWidenPanel } from "./model-picker";

describe("model picker logic", () => {
  it("labels a null model as Default", () => {
    expect(modelLabel(null)).toBe("Default");
    expect(modelLabel("opus")).toBe("opus");
  });

  describe("panel widening", () => {
    // The decision is pure geometry, in px: how wide the typed text renders
    // versus how wide the field is while the panel sits at chip width. Both are
    // read from the DOM at runtime, which is why they are parameters here — a
    // character count could not stand in for either.
    it("widens exactly when the text outgrows the field", () => {
      expect(shouldWidenPanel({ textWidth: 60, narrowFieldWidth: 78, wide: false })).toBe(false);
      expect(shouldWidenPanel({ textWidth: 78, narrowFieldWidth: 78, wide: false })).toBe(false);
      expect(shouldWidenPanel({ textWidth: 79, narrowFieldWidth: 78, wide: false })).toBe(true);
    });

    it("tracks the field width, so a wider chip tolerates a longer name", () => {
      // Same text, two agents: one whose longest suggestion reserves a narrow
      // chip, one whose reserved chip is wide enough to hold the text outright.
      expect(shouldWidenPanel({ textWidth: 90, narrowFieldWidth: 60, wide: false })).toBe(true);
      expect(shouldWidenPanel({ textWidth: 90, narrowFieldWidth: 120, wide: false })).toBe(false);
    });

    it("goes by rendered width, not character count", () => {
      // "WWWWWWWWWW" and "iiiiiiiiii" are both ten characters and render about
      // 3x apart, so the same field either overflows or does not.
      const field = 78;
      expect(shouldWidenPanel({ textWidth: 140, narrowFieldWidth: field, wide: false })).toBe(true);
      expect(shouldWidenPanel({ textWidth: 40, narrowFieldWidth: field, wide: false })).toBe(false);
    });

    it("holds steady once wide, since neither input depends on the current width", () => {
      // The oscillation this avoids: scrollWidth > clientWidth widens the panel,
      // which removes the overflow, which collapses it, which restores the
      // overflow. Re-deciding from the same two measurements is stable.
      const m = { textWidth: 140, narrowFieldWidth: 78 };
      expect(shouldWidenPanel({ ...m, wide: true })).toBe(true);
      expect(shouldWidenPanel({ ...m, wide: false })).toBe(true);
      const fits = { textWidth: 40, narrowFieldWidth: 78 };
      expect(shouldWidenPanel({ ...fits, wide: true })).toBe(false);
      expect(shouldWidenPanel({ ...fits, wide: false })).toBe(false);
    });

    it("keeps the current state until the field has been measured", () => {
      // jsdom, first layout pass, or a panel that has never been narrow: no
      // measurement to act on, so do not guess.
      expect(shouldWidenPanel({ textWidth: 500, narrowFieldWidth: 0, wide: false })).toBe(false);
      expect(shouldWidenPanel({ textWidth: 0, narrowFieldWidth: 0, wide: true })).toBe(true);
    });
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
    // The tooltip must name the condition that actually holds the chip shut.
    // Locking is now temporary — the turn ending is enough — so it must not
    // send the user off to start a new conversation, and must not suggest
    // stopping the agent, which would spend in-flight work for nothing.
    const tooltip = container.querySelector("[title]")?.getAttribute("title");
    expect(tooltip).toContain("fixed while the agent is running");
    expect(tooltip).toContain("once the turn ends");
    expect(tooltip).not.toContain("new conversation");
    expect(tooltip).not.toContain("stop");
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

/**
 * jsdom does not lay text out, so the two widths the picker reads are stubbed:
 * the field reports a fixed width, and the mirror span reports its text at a
 * given px-per-character. That leaves the wiring under test — ref reaches the
 * cmdk input, the mirror carries the query, the measurement picks the width
 * class — with only the font metrics faked.
 */
describe("ModelPicker panel width wiring", () => {
  let container: HTMLDivElement;
  let root: Root;

  const stubGeometry = (fieldWidth: number, pxPerChar: number) => {
    Object.defineProperty(HTMLInputElement.prototype, "clientWidth", {
      configurable: true,
      get: () => fieldWidth,
    });
    Object.defineProperty(HTMLSpanElement.prototype, "offsetWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return (this.textContent?.length ?? 0) * pxPerChar;
      },
    });
  };

  const type = async (text: string) => {
    const input = document.querySelector<HTMLInputElement>("[data-slot='command-input']")!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setValue.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  const panelClass = () =>
    document.querySelector("[data-slot='popover-content']")!.className;

  const openPicker = async (models: string[]) => {
    await act(async () => {
      root.render(
        <ModelPicker
          agentType="codex"
          models={models}
          value={null}
          onChange={vi.fn()}
          locked={false}
        />,
      );
    });
    await act(async () => {
      container.querySelector("button")!.click();
    });
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    // cmdk observes its list; Radix scrolls the active item into view.
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as never;
    Element.prototype.scrollIntoView = () => {};
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    // @ts-expect-error restoring jsdom's own zero-width getters
    delete HTMLInputElement.prototype.clientWidth;
    // @ts-expect-error restoring jsdom's own zero-width getters
    delete HTMLSpanElement.prototype.offsetWidth;
  });

  it("explains that Default means the CLI's current model, not its built-in one", async () => {
    stubGeometry(78, 8);
    await openPicker(["gpt-5.6-codex"]);

    const row = Array.from(document.querySelectorAll("[data-slot='command-item']")).find((el) =>
      el.textContent?.startsWith("Default"),
    )!;
    // The icon is the hover affordance; the sentence has to reach a reader who
    // is not hovering, so it also lives in the row as sr-only copy.
    expect(row.querySelector("[data-slot='tooltip-trigger']")).not.toBeNull();
    expect(row.querySelector("svg")).not.toBeNull();
    const hint = row.querySelector(".sr-only")!.textContent!;
    expect(hint).toContain("currently set to");
    expect(hint).toContain("built-in default");
  });

  it("does not choose Default when the info icon is clicked", async () => {
    stubGeometry(78, 8);
    await openPicker(["gpt-5.6-codex"]);

    const trigger = document.querySelector<HTMLElement>("[data-slot='tooltip-trigger']")!;
    await act(async () => {
      trigger.click();
    });

    // Reading the note is not picking the row: the panel stays open.
    expect(document.querySelector("[data-slot='popover-content']")).not.toBeNull();
  });

  it("opens at the chip's width", async () => {
    stubGeometry(78, 8);
    await openPicker(["gpt-5.6-codex"]);

    expect(panelClass()).toContain("w-[var(--radix-popover-trigger-width)]");
  });

  it("widens once the typed name no longer fits the field", async () => {
    stubGeometry(78, 8);
    await openPicker(["gpt-5.6-codex"]);

    await type("abcdefghi"); // 72px — fits
    expect(panelClass()).toContain("w-[var(--radix-popover-trigger-width)]");

    await type("abcdefghij"); // 80px — does not
    expect(panelClass()).toContain("w-56");
  });

  it("tolerates a longer name when the chip reserved a wider field", async () => {
    // Same text as the case above, but this agent's suggestions hold the chip
    // open wide enough to show it — so no widening. A character-count threshold
    // could not tell these two apart.
    stubGeometry(200, 8);
    await openPicker(["gpt-5.6-codex"]);

    await type("abcdefghij");
    expect(panelClass()).toContain("w-[var(--radix-popover-trigger-width)]");
  });

  it("goes by rendered width, so ten narrow characters still fit", async () => {
    stubGeometry(78, 3);
    await openPicker(["gpt-5.6-codex"]);

    await type("iiiiiiiiii"); // 30px
    expect(panelClass()).toContain("w-[var(--radix-popover-trigger-width)]");
  });

  it("collapses back when the name is edited down to something that fits", async () => {
    stubGeometry(78, 8);
    await openPicker(["gpt-5.6-codex"]);

    await type("abcdefghijklmnop");
    expect(panelClass()).toContain("w-56");

    await type("abc");
    expect(panelClass()).toContain("w-[var(--radix-popover-trigger-width)]");
  });
});
