// @vitest-environment jsdom
// The service switch tells the Main Chat commander not to wait for a dev
// server to exit; it only exists for command executors.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Executor } from "@/lib/api";
import { ExecutorForm } from "./executor-form";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const existing: Executor = {
  id: "e1", project_id: "p1", workspace_id: "w1", name: "dev", command: "pnpm dev",
  executor_type: "command", prompt_provider: null, cwd: null, pty: true, lifecycle: "service",
  position: 0, disabled_targets: [], created_at: "2026-01-01T00:00:00Z",
};

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
});

const serviceSwitch = () => document.querySelector<HTMLButtonElement>('button[aria-label="Long-running service"]');
const submit = async () => {
  const form = document.querySelector("form")!;
  await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
};

describe("ExecutorForm lifecycle", () => {
  it("shows an existing service as switched on and submits it unchanged", async () => {
    const onSubmit = vi.fn(async () => {});
    await act(async () => { root.render(<ExecutorForm open onOpenChange={() => {}} executor={existing} onSubmit={onSubmit} />); });
    expect(serviceSwitch()?.getAttribute("aria-checked")).toBe("true");
    await submit();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "service" }));
  });

  it("switching it off submits oneshot", async () => {
    const onSubmit = vi.fn(async () => {});
    await act(async () => { root.render(<ExecutorForm open onOpenChange={() => {}} executor={existing} onSubmit={onSubmit} />); });
    await act(async () => { serviceSwitch()!.click(); });
    await submit();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "oneshot" }));
  });

  it("is not offered for a prompt executor, which always submits oneshot", async () => {
    const onSubmit = vi.fn(async () => {});
    const prompt: Executor = { ...existing, executor_type: "prompt", prompt_provider: "claude", lifecycle: "oneshot" };
    await act(async () => { root.render(<ExecutorForm open onOpenChange={() => {}} executor={prompt} onSubmit={onSubmit} />); });
    expect(serviceSwitch()).toBeNull();
    await submit();
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ lifecycle: "oneshot" }));
  });
});
