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

  it("renders static text — not a disabled control — once locked", async () => {
    await act(async () => {
      root.render(
        <ModelPicker agentType="claude-code" models={["opus"]} value="opus" onChange={vi.fn()} locked />,
      );
    });

    // A disabled <button> would keep its border and chevron and read as
    // "temporarily unavailable", inviting clicks on something that can never
    // change. The locked form must not be a control at all.
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toContain("opus");
    expect(container.querySelector("[title]")?.getAttribute("title")).toContain("branch to change");
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
