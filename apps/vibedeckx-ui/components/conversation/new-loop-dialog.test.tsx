// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { createRepeatLoop, workflowRunGate } = vi.hoisted(() => ({ createRepeatLoop: vi.fn(), workflowRunGate: vi.fn() }));
vi.mock("@/lib/api", () => ({
  api: { createRepeatLoop, workflowRunGate },
  REPEAT_LOOP_DEFAULT_ITERATIONS: 20,
  REPEAT_LOOP_MAX_ITERATIONS: 200,
  REPEAT_LOOP_DEFAULT_MINUTES: 240,
  REPEAT_LOOP_MAX_MINUTES: 1440,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { NewLoopDialog } from "./new-loop-dialog";
import { loopDraftKey, TASK_STATUS_PROTOCOL_PREVIEW } from "@/lib/loop-presets";

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
  const startButton = () => document.body.querySelector<HTMLButtonElement>('button[aria-label="Start loop"]')!;
  const buttonNamed = (text: string) =>
    [...document.body.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
  const click = async (el: HTMLElement | undefined) => {
    expect(el).toBeDefined();
    await act(async () => { el!.click(); });
  };
  const type = async (id: string, value: string) => { await act(async () => { setValue(byId(id), value); }); };
  const openDialog = async () => {
    await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="New loop"]')!.click(); });
  };
  const closeDialog = async () => click(buttonNamed("Cancel") ?? buttonNamed("Close"));
  const instructionTab = () => [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === "Instruction");
  const formTab = () => [...document.body.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((b) => b.textContent === "Form");

  beforeEach(async () => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    createRepeatLoop.mockResolvedValue({ id: "l1" });
    workflowRunGate.mockResolvedValue({ id: "l1" });
    await act(async () => { root.render(<NewLoopDialog projectId="p1" branch="dev" />); });
    await openDialog();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  it("opens on the Plan preset: editing a field regenerates the instruction", async () => {
    await type("loop-field-planFile", "PLAN.md");
    await click(instructionTab());
    const text = byId<HTMLTextAreaElement>("loop-prompt").value;
    expect(text).toContain("`PLAN.md`");
    expect(text).not.toContain("implementation-plan.md");
    // The engine's closing protocol is shown, not part of the editable text.
    expect(document.querySelector('[data-testid="loop-protocol"]')!.textContent).toBe(TASK_STATUS_PROTOCOL_PREVIEW.trim());
    expect(text).not.toContain("End your final message with these lines");
  });

  it("a hand edit makes the text the truth: the form is disabled, and regenerating asks first", async () => {
    await click(instructionTab());
    await type("loop-prompt", "my own plan instruction");
    expect(document.body.textContent).toContain("Edited by hand");
    await click(formTab());
    expect(byId<HTMLInputElement>("loop-field-planFile").closest("fieldset")!.disabled).toBe(true);

    await click(buttonNamed("Regenerate from form"));
    expect(document.body.textContent).toContain("your edits are lost");
    await click(buttonNamed("Keep it"));
    await click(instructionTab());
    expect(byId<HTMLTextAreaElement>("loop-prompt").value).toBe("my own plan instruction");

    await click(buttonNamed("Regenerate from form"));
    await click(buttonNamed("Discard my text"));
    expect(byId<HTMLTextAreaElement>("loop-prompt").value).toContain("docs/implementation-plan.md");
    expect(document.body.textContent).not.toContain("Edited by hand");
  });

  it("switching to a preset that would overwrite hand-written text asks first", async () => {
    await click(buttonNamed("Custom"));
    // Custom keeps the box's text as a starting point; clear it and write our own.
    await type("loop-prompt", "handle the next order");
    await click(buttonNamed("Plan file"));
    expect(document.body.textContent).toContain("Switching to Plan file replaces the instruction");
    await click(buttonNamed("Keep it"));
    expect(byId<HTMLTextAreaElement>("loop-prompt").value).toBe("handle the next order");
    await click(buttonNamed("Plan file"));
    await click(buttonNamed("Discard my text"));
    expect(byId("loop-field-planFile")).not.toBeNull();
  });

  it("Custom: cannot start without an instruction", async () => {
    await click(buttonNamed("Custom"));
    await type("loop-prompt", "   ");
    expect(startButton().disabled).toBe(true);
  });

  it("sends the instruction, limits clamped to what the server accepts, and the preset it came from", async () => {
    await type("loop-field-planFile", "PLAN.md");
    await type("loop-iterations", "9999");
    await type("loop-minutes", "");
    await type("loop-check", "npm test");
    await click(startButton());
    expect(createRepeatLoop).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "p1", branch: "dev", agentType: "claude-code",
      maxIterations: 200, maxMinutes: 240, checkCommand: "npm test",
      prompt: expect.stringContaining("`PLAN.md`"),
      preset: { kind: "plan", fields: expect.objectContaining({ planFile: "PLAN.md" }) },
    }));
    expect(workflowRunGate).not.toHaveBeenCalled();
  });

  it("Custom sends its text as is and says so", async () => {
    await click(buttonNamed("Custom"));
    await type("loop-prompt", "  handle the next order  ");
    await click(startButton());
    expect(createRepeatLoop).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "handle the next order", preset: { kind: "custom" },
    }));
  });

  it("a hand-edited plan is marked edited", async () => {
    await click(instructionTab());
    await type("loop-prompt", "edited plan");
    await click(startButton());
    expect(createRepeatLoop).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "edited plan", preset: expect.objectContaining({ kind: "plan", edited: true }),
    }));
  });

  it("keeps the dialog open and shows the server's reason when the start is refused", async () => {
    createRepeatLoop.mockRejectedValueOnce(new Error("This machine's worker doesn't support loops yet"));
    await click(startButton());
    expect(document.body.textContent).toContain("doesn't support loops yet");
    expect(startButton()).toBeDefined();
  });

  describe("run one item first", () => {
    it("pauses the loop right after starting it", async () => {
      await act(async () => { byId<HTMLInputElement>("loop-run-once").click(); });
      await click(startButton());
      expect(createRepeatLoop).toHaveBeenCalledTimes(1);
      expect(workflowRunGate).toHaveBeenCalledWith("l1", "pause");
      expect(byId("loop-run-once")).toBeNull(); // dialog closed
    });

    it("a failed pause says the loop is still running, and offers to retry — the loop is not rolled back", async () => {
      workflowRunGate.mockRejectedValueOnce(new Error("tunnel down"));
      await act(async () => { byId<HTMLInputElement>("loop-run-once").click(); });
      await click(startButton());
      expect(document.body.textContent).toContain("still running item after item");
      expect(document.body.textContent).toContain("tunnel down");
      expect(startButton().disabled).toBe(true);

      await click(buttonNamed("Retry pause"));
      expect(workflowRunGate).toHaveBeenCalledTimes(2);
      expect(createRepeatLoop).toHaveBeenCalledTimes(1);
      expect(byId("loop-run-once")).toBeNull();
    });

    it("is off again on the next open — after a retried pause or a cancel", async () => {
      workflowRunGate.mockRejectedValueOnce(new Error("tunnel down"));
      await act(async () => { byId<HTMLInputElement>("loop-run-once").click(); });
      await click(startButton());
      await click(buttonNamed("Retry pause"));
      await openDialog();
      expect(byId<HTMLInputElement>("loop-run-once").checked).toBe(false);

      await act(async () => { byId<HTMLInputElement>("loop-run-once").click(); });
      await closeDialog();
      await openDialog();
      expect(byId<HTMLInputElement>("loop-run-once").checked).toBe(false);
    });
  });

  describe("last-used settings", () => {
    it("are restored on the next open, including a hand edit", async () => {
      await type("loop-check", "pnpm test");
      await click(instructionTab());
      await type("loop-prompt", "my edited plan");
      await closeDialog();
      expect(JSON.parse(window.localStorage.getItem(loopDraftKey("p1"))!)).toMatchObject({
        kind: "plan", edited: true, prompt: "my edited plan", checkCommand: "pnpm test",
      });

      await openDialog();
      expect(byId<HTMLTextAreaElement>("loop-prompt").value).toBe("my edited plan");
      expect(byId<HTMLInputElement>("loop-check").value).toBe("pnpm test");
      expect(document.body.textContent).toContain("Edited by hand");
      await click(formTab());
      expect(byId<HTMLInputElement>("loop-field-planFile").closest("fieldset")!.disabled).toBe(true);
    });

    it("an unedited plan comes back as its fields", async () => {
      await type("loop-field-planFile", "PLAN.md");
      await closeDialog();
      await openDialog();
      expect(byId<HTMLInputElement>("loop-field-planFile").value).toBe("PLAN.md");
      expect(document.body.textContent).not.toContain("Edited by hand");
    });
  });
});
