// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { createRepeatLoop } = vi.hoisted(() => ({ createRepeatLoop: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: { createRepeatLoop },
  REPEAT_LOOP_DEFAULT_ITERATIONS: 20,
  REPEAT_LOOP_MAX_ITERATIONS: 200,
  REPEAT_LOOP_DEFAULT_MINUTES: 240,
  REPEAT_LOOP_MAX_MINUTES: 1440,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { NewLoopDialog } from "./new-loop-dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("NewLoopDialog", () => {
  let container: HTMLDivElement;
  let root: Root;
  const setValue = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const startButton = () => [...document.body.querySelectorAll("button")].find((b) => b.textContent === "Start loop")!;

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    createRepeatLoop.mockResolvedValue({ id: "l1" });
    await act(async () => { root.render(<NewLoopDialog projectId="p1" branch="dev" />); });
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="New loop"]')!.click(); });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("cannot start without an instruction", () => {
    expect(startButton().disabled).toBe(true);
  });

  it("sends the instruction with limits clamped to what the server accepts", async () => {
    await act(async () => {
      setValue(byId<HTMLTextAreaElement>("loop-prompt"), "  handle the next order  ");
      setValue(byId<HTMLInputElement>("loop-iterations"), "9999");
      setValue(byId<HTMLInputElement>("loop-minutes"), "");
      setValue(byId<HTMLInputElement>("loop-check"), "npm test");
    });
    await act(async () => { startButton().click(); });
    expect(createRepeatLoop).toHaveBeenCalledWith({
      projectId: "p1", branch: "dev", prompt: "handle the next order", agentType: "claude-code",
      maxIterations: 200, maxMinutes: 240, checkCommand: "npm test",
    });
  });

  it("keeps the dialog open and shows the server's reason when the start is refused", async () => {
    createRepeatLoop.mockRejectedValueOnce(new Error("This machine's worker doesn't support loops yet"));
    await act(async () => { setValue(byId<HTMLTextAreaElement>("loop-prompt"), "x"); });
    await act(async () => { startButton().click(); });
    expect(document.body.textContent).toContain("doesn't support loops yet");
    expect(byId("loop-prompt")).not.toBeNull();
  });
});
