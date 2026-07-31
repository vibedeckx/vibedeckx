// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  getScheduleRuns: vi.fn(async () => []),
  getScheduleRun: vi.fn(),
}));

vi.mock("@/lib/api", async (original) => ({ ...(await original()), api }));
vi.mock("streamdown", () => ({ Streamdown: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { SchedulesView } from "./schedules-view";
import type { Schedule, ScheduleRun } from "@/lib/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const schedule: Schedule = {
  id: "schedule-1",
  project_id: "project-1",
  name: "Nightly tests",
  cron_expr: "0 0 * * *",
  timezone: "UTC",
  target: "local",
  enabled: true,
  run_type: "command",
  prompt_provider: null,
  content: "pnpm test",
  cwd_mode: "branch",
  branch: null,
  directory: null,
  timeout_seconds: 300,
  created_at: "2026-07-31 00:00:00",
  updated_at: "2026-07-31 00:00:00",
};

const run: ScheduleRun = {
  id: "run-1",
  schedule_id: schedule.id,
  project_id: "project-1",
  status: "failed",
  exit_code: 1,
  output: "RAW FAILURE",
  report: "Failure report",
  process_id: null,
  started_at: "2026-07-31 00:00:00",
  finished_at: "2026-07-31 00:01:00",
};

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.clearAllMocks();
  api.getScheduleRun.mockResolvedValue(run);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.querySelectorAll("[data-radix-focus-guard]").forEach((node) => node.remove());
});

describe("SchedulesView external run navigation", () => {
  it("opens the exact requested run in the existing report dialog and acknowledges it", async () => {
    const onOpenRunHandled = vi.fn();
    await act(async () => {
      root.render(
        <SchedulesView
          projectId="project-1"
          schedules={[schedule]}
          loading={false}
          selectedId={schedule.id}
          onSelect={vi.fn()}
          worktrees={[]}
          onCreate={vi.fn()}
          onUpdate={vi.fn()}
          onDelete={vi.fn()}
          onRunNow={vi.fn()}
          createOpen={false}
          onCreateOpenChange={vi.fn()}
          openRunId="run-1"
          onOpenRunHandled={onOpenRunHandled}
        />,
      );
    });

    expect(api.getScheduleRun).toHaveBeenCalledWith("run-1");
    expect(document.body.textContent).toContain("Failure report");
    expect(onOpenRunHandled).toHaveBeenCalledWith("run-1");
  });
});
