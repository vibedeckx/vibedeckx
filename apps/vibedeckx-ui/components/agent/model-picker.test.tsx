// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelPicker, modelLabel, needsRoomyPanel, shouldOfferCustom, shouldWidenPanel } from "./model-picker";

/** jsdom lays nothing out: make the chip's visible label report the given widths. */
function setLabelGeometry(chip: Element, scrollWidth: number, clientWidth: number) {
  const text = chip.querySelector(".truncate")!;
  Object.defineProperty(text, "scrollWidth", { configurable: true, value: scrollWidth });
  Object.defineProperty(text, "clientWidth", { configurable: true, value: clientWidth });
}

/** Hover a control the way a mouse does and return the tooltip it shows (Hint opens after 300ms). */
async function hoverHint(el: Element): Promise<string | null> {
  await act(async () => {
    // pointerover drives React's onPointerEnter; pointermove opens Radix's tooltip.
    el.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  return document.querySelector("[data-slot='tooltip-content']")?.textContent ?? null;
}

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

  it("widens the panel only for suggestion lists with long names", () => {
    expect(needsRoomyPanel(["opus", "sonnet", "haiku", "fable"])).toBe(false);
    expect(needsRoomyPanel(["gpt-6.2-sol", "gpt-5.6-terra"])).toBe(false);
    expect(needsRoomyPanel(["spacexai/grok-4.7", "anthropic/claude-opus-5.5"])).toBe(true);
    expect(needsRoomyPanel([])).toBe(false);
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
  });

  it("renders a clickable trigger before the session exists", async () => {
    await act(async () => {
      root.render(
        <ModelPicker models={["opus"]} value={null} onChange={vi.fn()} locked={false} />,
      );
    });

    const trigger = container.querySelector("button");
    expect(trigger).not.toBeNull();
    expect(trigger!.textContent).toContain("Default");
  });

  it("reports each open so the caller can revalidate its list, but not a close", async () => {
    const onOpen = vi.fn();
    await act(async () => {
      root.render(<ModelPicker models={["opus"]} value={null} onChange={vi.fn()} locked={false} onOpen={onOpen} />);
    });
    const trigger = container.querySelector("button")!;
    await act(async () => { trigger.click(); });
    expect(onOpen).toHaveBeenCalledTimes(1);
    await act(async () => { trigger.click(); });
    expect(onOpen).toHaveBeenCalledTimes(1);
    await act(async () => { trigger.click(); });
    expect(onOpen).toHaveBeenCalledTimes(2);
  });

  it("offers a refresh row only when the caller can refresh, and spins while it runs", async () => {
    const onRefresh = vi.fn();
    const render = async (refreshing: boolean) => act(async () => {
      root.render(<ModelPicker models={["opus"]} value={null} onChange={vi.fn()} locked={false} onRefresh={onRefresh} refreshing={refreshing} />);
    });
    await render(false);
    await act(async () => { container.querySelector("button")!.click(); });
    const button = () => Array.from(document.querySelectorAll<HTMLButtonElement>("[data-slot='popover-content'] button"))
      .find((b) => b.textContent?.includes("Refresh"))!;
    expect(button().textContent).toBe("Refresh list");
    await act(async () => { button().click(); });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    // A click is not a pick: the panel stays open.
    expect(document.querySelector("[data-slot='popover-content']")).not.toBeNull();
    await render(true);
    expect(button().disabled).toBe(true);
    expect(button().textContent).toBe("Refreshing…");
    expect(button().querySelector("svg")!.getAttribute("class")).toContain("animate-spin");
  });

  it("shows a clipped name in full on the arrow-key highlighted row, where focus never leaves the search field", async () => {
    // jsdom has no layout: a .truncate span is clipped when its text is over 20 chars.
    Object.defineProperty(HTMLSpanElement.prototype, "scrollWidth", {
      configurable: true,
      get(this: HTMLElement) { return (this.textContent?.length ?? 0) * 10; },
    });
    Object.defineProperty(HTMLSpanElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) { return this.classList.contains("truncate") ? 200 : (this.textContent?.length ?? 0) * 10; },
    });
    try {
      const long = "deepseek/deepseek-v4.1-flash-1017-ultrafast";
      await act(async () => {
        root.render(<ModelPicker models={[long, "openai/gpt-5.4-mini"]} value={null} onChange={vi.fn()} locked={false} />);
      });
      await act(async () => { container.querySelector("button")!.click(); });
      const input = document.querySelector<HTMLInputElement>("[data-slot='command-input']")!;
      const press = (key: string) => act(async () => {
        input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      });
      const tooltip = () => document.querySelector("[data-slot='tooltip-content']")?.textContent ?? null;

      expect(document.activeElement).toBe(input);
      await press("ArrowDown"); // Default → the long name
      expect(tooltip()).toContain(long);
      expect(document.activeElement).toBe(input);

      await press("ArrowDown"); // → a name that fits: no tooltip
      expect(tooltip()).toBeNull();
    } finally {
      // @ts-expect-error restoring jsdom's own getters
      delete HTMLSpanElement.prototype.scrollWidth;
      // @ts-expect-error restoring jsdom's own getters
      delete HTMLSpanElement.prototype.clientWidth;
    }
  });

  it("has no refresh row without onRefresh", async () => {
    await act(async () => {
      root.render(<ModelPicker models={["opus"]} value={null} onChange={vi.fn()} locked={false} />);
    });
    await act(async () => { container.querySelector("button")!.click(); });
    expect(document.querySelector("[data-slot='popover-content']")!.textContent).not.toContain("Refresh");
  });

  it("does not set a placeholder on the model search input", async () => {
    await act(async () => {
      root.render(
        <ModelPicker
          models={["opus"]}
          value={null}
          onChange={vi.fn()}
          locked={false}
        />,
      );
    });
    await act(async () => {
      container.querySelector("button")!.click();
    });

    const input = document.querySelector<HTMLInputElement>("[data-slot='command-input']");
    expect(input).not.toBeNull();
    expect(input!.hasAttribute("placeholder")).toBe(false);
  });

  it("is not a control once locked, but keeps the chip it was", async () => {
    await act(async () => {
      root.render(
        <ModelPicker models={["opus"]} value="opus" onChange={vi.fn()} locked />,
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
    const chip = container.querySelector("[data-model-chip='locked']")!;
    expect(chip.className).toContain("border");
    expect(chip.className).toContain("px-2");
    expect(chip.className).toContain("text-muted-foreground");
    expect(chip.className).toContain("cursor-default");
    expect(chip.className).not.toContain("hover:");
    // The tooltip must name the condition that actually holds the chip shut.
    // Locking is now temporary — the turn ending is enough — so it must not
    // send the user off to start a new conversation, and must not suggest
    // stopping the agent, which would spend in-flight work for nothing.
    const tooltip = await hoverHint(chip);
    expect(tooltip).toContain("fixed while the agent is running");
    expect(tooltip).toContain("once the turn ends");
    expect(tooltip).not.toContain("new conversation");
    expect(tooltip).not.toContain("stop");
  });

  it("names the full model in the trigger tooltip, since a long name clips", async () => {
    await act(async () => {
      root.render(
        <ModelPicker
          models={["gpt-5.6-codex"]}
          value="some-very-long-custom-model-name"
          onChange={vi.fn()}
          locked={false}
        />,
      );
    });

    const chip = container.querySelector("button")!;
    setLabelGeometry(chip, 240, 120);
    expect(await hoverHint(chip)).toContain("some-very-long-custom-model-name");
  });

  it("shows no tooltip when the name fits — it would only repeat the chip", async () => {
    await act(async () => {
      root.render(<ModelPicker models={["opus"]} value={null} onChange={vi.fn()} locked={false} />);
    });

    const chip = container.querySelector("button")!;
    setLabelGeometry(chip, 50, 50);
    expect(await hoverHint(chip)).toBeNull();
  });

  it("keeps the full model name reachable when the locked label clips", async () => {
    await act(async () => {
      root.render(
        <ModelPicker
          models={["gpt-5.6-codex"]}
          value="some-very-long-custom-model-name"
          onChange={vi.fn()}
          locked
        />,
      );
    });

    const chip = container.querySelector("[data-model-chip='locked']")!;
    expect(await hoverHint(chip)).toContain("some-very-long-custom-model-name");
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
        <ModelPicker models={["opus"]} value={null} onChange={vi.fn()} locked />,
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

    // The info icon's, inside the panel — the chip itself is a tooltip trigger too.
    const trigger = document.querySelector<HTMLElement>("[data-slot='popover-content'] [data-slot='tooltip-trigger']")!;
    await act(async () => {
      trigger.click();
    });

    // Reading the note is not picking the row: the panel stays open.
    expect(document.querySelector("[data-slot='popover-content']")).not.toBeNull();
  });

  it("opens wider, with one-line rows, when the suggestions are long names (a machine catalog)", async () => {
    stubGeometry(78, 8);
    await openPicker(["anthropic/claude-opus-5.5-fast", "openai/gpt-5.4-mini"]);

    expect(panelClass()).toContain("w-60");
    expect(panelClass()).not.toContain("w-[var(--radix-popover-trigger-width)]");
    const row = Array.from(document.querySelectorAll("[data-slot='command-item']"))
      .find((el) => el.textContent === "anthropic/claude-opus-5.5-fast")!;
    expect(row.querySelector("span.truncate")!.textContent).toBe("anthropic/claude-opus-5.5-fast");
  });

  it("keeps the list short enough not to hang far over the conversation", async () => {
    stubGeometry(78, 8);
    await openPicker(["gpt-5.6-codex"]);

    expect(document.querySelector("[data-slot='command-list']")!.className).toContain("max-h-52");
  });

  it("re-measures the narrow field when a refresh swaps long names for short ones while a query is typed", async () => {
    stubGeometry(78, 8);
    // The field is as wide as its panel: 200px in the roomy panel, 78px at chip width.
    Object.defineProperty(HTMLInputElement.prototype, "clientWidth", {
      configurable: true,
      get(this: HTMLElement) {
        return this.closest("[data-slot='popover-content']")?.className.includes("w-60") ? 200 : 78;
      },
    });
    const render = (models: string[]) => act(async () => {
      root.render(<ModelPicker models={models} value={null} onChange={vi.fn()} locked={false} />);
    });
    await render(["anthropic/claude-opus-5.5-fast"]);
    await act(async () => { container.querySelector("button")!.click(); });
    await type("abcdefghijk"); // 88px — fits the roomy field, not the narrow one
    expect(panelClass()).toContain("w-60");

    await render(["opus", "sonnet"]); // the refreshed list is all short names

    expect(panelClass()).toContain("w-56");
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
