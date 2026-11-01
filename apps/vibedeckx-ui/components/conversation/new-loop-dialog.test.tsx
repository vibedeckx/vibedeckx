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
import { loopDraftKey } from "@/lib/loop-presets";

/** What api.ts throws for a refused request (`WorkflowRequestError`) — the dialog reads only `code`. */
const refused = (message: string, code?: string) => Object.assign(new Error(message), { status: 409, code });

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lacks what the Radix "Items from" select calls when it opens.
Element.prototype.scrollIntoView ??= () => {};
Element.prototype.hasPointerCapture ??= () => false;

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
  /** Pick an option of the "Items from" select (Radix: keyboard opens it, Enter on an option picks it). */
  const pickSource = async (label: string) => {
    const trigger = document.body.querySelector<HTMLButtonElement>('button[aria-label="Items from"]')!;
    await act(async () => { trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find((o) => o.textContent === label);
    expect(option).toBeDefined();
    await act(async () => {
      option!.focus();
      option!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
  };
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
    // The engine appends its closing protocol itself; it is not part of the editable text.
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
    await pickSource("Write my own");
    await type("loop-field-source", "orders.md, one per line");
    await click(instructionTab());
    await type("loop-prompt", "handle the next order");
    await pickSource("Plan file");
    expect(document.body.textContent).toContain("Switching to Plan file replaces the instruction");
    await click(buttonNamed("Keep it"));
    expect(byId<HTMLTextAreaElement>("loop-prompt").value).toBe("handle the next order");
    await pickSource("Plan file");
    await click(buttonNamed("Discard my text"));
    expect(byId("loop-field-planFile")).not.toBeNull();
  });

  it("Write my own: generates nothing, and cannot start, until it says where items come from", async () => {
    await pickSource("Write my own");
    expect(byId<HTMLTextAreaElement>("loop-field-source").closest("div")!.textContent).toContain("Required");
    expect(startButton().disabled).toBe(true);
    await type("loop-field-source", "   ");
    expect(startButton().disabled).toBe(true);
    await type("loop-field-source", "orders.md, one per line");
    expect(startButton().disabled).toBe(false);
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

  it("Write my own generates the instruction around its source and records it", async () => {
    await pickSource("Write my own");
    await type("loop-field-source", "orders.md, one per line");
    await click(startButton());
    expect(createRepeatLoop).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("> orders.md, one per line"),
      preset: { kind: "custom", fields: { source: "orders.md, one per line" } },
    }));
  });

  it("a Write my own draft from before it had a form comes back as a hand edit", async () => {
    await closeDialog();
    window.localStorage.setItem(loopDraftKey("p1"), JSON.stringify({
      kind: "custom", fields: { planFile: "docs/implementation-plan.md" }, prompt: "handle the next order", edited: false,
    }));
    await openDialog();
    expect(byId<HTMLTextAreaElement>("loop-prompt").value).toBe("handle the next order");
    expect(document.body.textContent).toContain("Edited by hand");
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

  describe("handoff note", () => {
    const handoffBox = () => byId<HTMLInputElement>("loop-handoff");

    it("is on for the Plan preset and sent as true", async () => {
      expect(handoffBox().checked).toBe(true);
      await click(startButton());
      expect(createRepeatLoop).toHaveBeenCalledWith(expect.objectContaining({ handoff: true }));
    });

    it("is off for Write my own, and an explicit false is still sent", async () => {
      await pickSource("Write my own");
      expect(handoffBox().checked).toBe(false);
      await type("loop-field-source", "orders.md, one per line");
      await click(startButton());
      expect(createRepeatLoop).toHaveBeenCalledWith(expect.objectContaining({ handoff: false }));
    });

    it("an old worker's refusal says to update it, and offers to retry without the note", async () => {
      createRepeatLoop.mockRejectedValueOnce(refused(
        "This machine's worker doesn't support handoff notes yet — update the worker, or turn handoff off and try again.",
        "worker_unsupported",
      ));
      await click(startButton());
      expect(document.body.textContent).toContain("update the worker");
      expect(byId("loop-handoff")).not.toBeNull(); // still open

      await click(buttonNamed("Turn off handoff note and retry"));
      expect(createRepeatLoop).toHaveBeenCalledTimes(2);
      expect(createRepeatLoop).toHaveBeenLastCalledWith(expect.objectContaining({ handoff: false }));
      expect(byId("loop-handoff")).toBeNull(); // started, dialog closed
    });

    it("no retry offer when the switch was already off — turning it off cannot help", async () => {
      await act(async () => { handoffBox().click(); });
      createRepeatLoop.mockRejectedValueOnce(refused("This machine's worker doesn't support loops yet", "worker_unsupported"));
      await click(startButton());
      expect(document.body.textContent).toContain("doesn't support loops yet");
      expect(buttonNamed("Turn off handoff note and retry")).toBeUndefined();
    });

    it("no retry offer for an unrelated failure", async () => {
      createRepeatLoop.mockRejectedValueOnce(refused("Project not found"));
      await click(startButton());
      expect(buttonNamed("Turn off handoff note and retry")).toBeUndefined();
    });

    it("the last choice is restored with the draft", async () => {
      await act(async () => { handoffBox().click(); });
      await closeDialog();
      await openDialog();
      expect(handoffBox().checked).toBe(false);
    });

    it("a draft from before handoff notes falls back to the preset's default", async () => {
      await closeDialog();
      const draft = JSON.parse(window.localStorage.getItem(loopDraftKey("p1"))!);
      delete draft.handoff;
      window.localStorage.setItem(loopDraftKey("p1"), JSON.stringify(draft));
      await openDialog();
      expect(handoffBox().checked).toBe(true);
    });
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
