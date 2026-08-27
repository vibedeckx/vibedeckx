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
