// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getProjectRemotes: vi.fn(async () => []),
  getProjectWorktrees: vi.fn(async () => []),
}));

vi.mock("@/lib/api", async (original) => ({ ...(await original()), api }));

import type { Schedule } from "@/lib/api";
import { ScheduleFormDialog } from "./schedule-form-dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const schedule: Schedule = {
  id: "schedule-1",
  project_id: "project-1",
  name: "Long prompt",
  cron_expr: "0 9 * * *",
  timezone: "UTC",
  target: "local",
  enabled: true,
  run_type: "prompt",
  prompt_provider: "claude",
  content: `${"unbroken".repeat(1_000)}\n${"another line\n".repeat(1_000)}`,
  cwd_mode: "branch",
  branch: null,
  directory: null,
  timeout_seconds: 1_800,
  created_at: "2026-08-27 00:00:00",
  updated_at: "2026-08-27 00:00:00",
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.querySelectorAll("[data-radix-focus-guard]").forEach((node) => node.remove());
  vi.clearAllMocks();
});

describe("ScheduleFormDialog sizing", () => {
  it("keeps a long prompt inside a viewport-bounded, scrollable dialog", async () => {
    await act(async () => {
      root.render(
        <ScheduleFormDialog
          open
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
          initial={schedule}
          worktrees={[]}
          projectId="project-1"
        />,
      );
    });

    const dialog = document.body.querySelector<HTMLElement>("[data-slot='dialog-content']");
    const body = document.body.querySelector<HTMLElement>("[data-slot='schedule-form-body']");
    const textarea = document.body.querySelector<HTMLTextAreaElement>("textarea");

    expect(dialog?.className).toContain("max-h-[calc(100dvh-2rem)]");
    expect(dialog?.className).toContain("overflow-hidden");
    expect(body?.className).toContain("overflow-y-auto");
    expect(body?.className).toContain("overflow-x-hidden");
    expect(textarea?.className).toContain("field-sizing-fixed");
    expect(textarea?.className).toContain("max-w-full");
    expect(textarea?.className).toContain("overflow-auto");
  });
});

describe("ScheduleFormDialog timing", () => {
  const render = async (initial: Schedule, onSubmit = vi.fn(async () => {})) => {
    await act(async () => {
      root.render(
        <ScheduleFormDialog open onOpenChange={vi.fn()} onSubmit={onSubmit} initial={initial} worktrees={[]} projectId="project-1" />,
      );
    });
    return onSubmit;
  };
  const preview = () => document.body.querySelector<HTMLElement>("[data-slot='schedule-preview']");

  it("opens a recognizable cron in the builder with a readable preview", async () => {
    await render({ ...schedule, cron_expr: "0 9 * * 1-5", timezone: "Asia/Shanghai" });
    expect(document.body.querySelector("[aria-label='Frequency']")?.textContent).toBe("Weekdays");
    expect(document.body.querySelector<HTMLInputElement>("input[aria-label='Time']")?.value).toBe("09:00");
    expect(preview()?.textContent).toContain("At 09:00, Monday through Friday");
    expect(preview()?.textContent).toContain("(Asia/Shanghai)");
    expect(preview()?.textContent).toContain("Next:");
  });

  it("falls back to the raw cron editor for shapes the builder can't express", async () => {
    await render({ ...schedule, cron_expr: "0 9 1-7 * 1" });
    expect(document.body.querySelector("[aria-label='Frequency']")?.textContent).toBe("Custom (cron)");
    expect(document.body.querySelector<HTMLInputElement>("input[aria-label='Cron expression']")?.value).toBe("0 9 1-7 * 1");
  });

  it("keeps the custom editor mounted when an edit passes through a builder shape", async () => {
    await render({ ...schedule, cron_expr: "0 9-17 * * *" });
    const input = () => document.body.querySelector<HTMLInputElement>("input[aria-label='Cron expression']");
    const type = async (value: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
        input()!.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await type("0 9 * * *");
    expect(document.body.querySelector("[aria-label='Frequency']")?.textContent).toBe("Custom (cron)");
    expect(input()?.value).toBe("0 9 * * *");
    await type("0 9-18 * * *");
    expect(input()?.value).toBe("0 9-18 * * *");
  });

  it("blocks saving an invalid cron", async () => {
    await render({ ...schedule, cron_expr: "0 9 * *" });
    expect(preview()?.querySelector(".text-destructive")).not.toBeNull();
    const save = document.body.querySelector<HTMLButtonElement>("button[aria-label='Save']");
    expect(save?.disabled).toBe(true);
    expect(document.body.querySelector("[role='alert']")?.textContent).toContain("Fix the cron expression before saving.");
  });
});
