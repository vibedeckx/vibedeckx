// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Schedule, ScheduleRun } from "@/lib/api";

vi.mock("@/lib/api", () => ({
  api: {
    getScheduleRuns: vi.fn(),
    getScheduleRun: vi.fn(),
  },
}));

vi.mock("./schedule-form-dialog", () => ({
  ScheduleFormDialog: () => null,
}));

vi.mock("streamdown", () => ({
  Streamdown: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="report">{children}</div>
  ),
}));

vi.mock("@/components/ui/resizable", () => {
  type Kids = { children?: React.ReactNode };
  return {
    ResizablePanelGroup: ({ children, direction }: Kids & { direction?: string }) => (
      <div data-panel-group-direction={direction}>{children}</div>
    ),
    ResizablePanel: ({ children }: Kids) => <section data-testid="resizable-panel">{children}</section>,
    ResizableHandle: () => <div data-testid="resizable-handle" />,
  };
});

import { api } from "@/lib/api";
import { SchedulesView } from "./schedules-view";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const getScheduleRuns = api.getScheduleRuns as unknown as ReturnType<typeof vi.fn>;
const getScheduleRun = api.getScheduleRun as unknown as ReturnType<typeof vi.fn>;

const schedule: Schedule = {
  id: "schedule-1",
  project_id: "project-1",
  name: "Nightly check",
  cron_expr: "0 2 * * *",
  timezone: "UTC",
  target: "local",
  enabled: true,
  run_type: "command",
  prompt_provider: null,
  content: "pnpm test",
  cwd_mode: "branch",
  branch: "main",
  directory: null,
  timeout_seconds: 600,
  created_at: "2026-07-30 00:00:00",
  updated_at: "2026-07-30 00:00:00",
};

const makeRun = (id: string, startedAt: string, output?: string): ScheduleRun => ({
  id,
  schedule_id: schedule.id,
  status: "completed",
  exit_code: 0,
  output,
  report: null,
  process_id: `process-${id}`,
  started_at: startedAt,
  finished_at: "2026-07-31 02:01:00",
});

const newest = makeRun("run-new", "2026-07-31 02:00:00");
const older = makeRun("run-old", "2026-07-30 02:00:00");

let container: HTMLDivElement;
let root: Root;

const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
});

const click = async (element: Element | null) => {
  if (!element) throw new Error("element not found");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function renderView() {
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
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getScheduleRuns.mockResolvedValue([newest, older]);
  getScheduleRun.mockImplementation(async (id: string) =>
    id === newest.id
      ? makeRun(newest.id, newest.started_at, "new output")
      : makeRun(older.id, older.started_at, "old output"),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("schedule run split view", () => {
  it("selects the newest run and renders its output in a horizontal split view", async () => {
    await act(async () => renderView());
    await flush();

    expect(container.querySelector("[data-panel-group-direction='horizontal']")).not.toBeNull();
    expect(getScheduleRun).toHaveBeenCalledWith("run-new");
    expect(container.textContent).toContain("new output");
    expect(document.querySelector("[role='dialog']")).toBeNull();
  });

  it("loads an older run into the right panel when its row is selected", async () => {
    await act(async () => renderView());
    await flush();

    const oldRow = Array.from(container.querySelectorAll("tbody tr")).find((row) =>
      row.textContent?.includes("7/30/2026"),
    );
    await click(oldRow ?? null);
    await flush();

    expect(getScheduleRun).toHaveBeenLastCalledWith("run-old");
    expect(container.textContent).toContain("old output");
    expect(container.textContent).not.toContain("new output");
  });

  it("does not let an older detail request replace the newly selected run", async () => {
    const first = deferred<ScheduleRun>();
    getScheduleRun.mockImplementation((id: string) =>
      id === newest.id
        ? first.promise
        : Promise.resolve(makeRun(older.id, older.started_at, "old output")),
    );

    await act(async () => renderView());
    await flush();
    const oldRow = Array.from(container.querySelectorAll("tbody tr")).find((row) =>
      row.textContent?.includes("7/30/2026"),
    );
    await click(oldRow ?? null);
    await flush();
    expect(container.textContent).toContain("old output");

    await act(async () => {
      first.resolve(makeRun(newest.id, newest.started_at, "late new output"));
      await first.promise;
    });

    expect(container.textContent).toContain("old output");
    expect(container.textContent).not.toContain("late new output");
  });

  it("offers a retry when loading the selected run fails", async () => {
    getScheduleRun
      .mockRejectedValueOnce(new Error("detail unavailable"))
      .mockResolvedValueOnce(makeRun(newest.id, newest.started_at, "retried output"));

    await act(async () => renderView());
    await flush();

    expect(container.textContent).toContain("detail unavailable");
    const retry = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Retry",
    );
    expect(retry).not.toBeNull();
    await click(retry ?? null);
    await flush();

    expect(getScheduleRun).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("retried output");
  });

  it("marks skipped runs unavailable and never requests their details", async () => {
    const skipped: ScheduleRun = {
      ...makeRun("run-skipped", "2026-07-29 02:00:00"),
      status: "skipped",
      exit_code: null,
      finished_at: "2026-07-29 02:00:00",
    };
    getScheduleRuns.mockResolvedValue([newest, skipped]);

    await act(async () => renderView());
    await flush();
    const skippedRow = Array.from(container.querySelectorAll("tbody tr")).find((row) =>
      row.textContent?.includes("skipped"),
    );

    expect(skippedRow?.getAttribute("aria-disabled")).toBe("true");
    await click(skippedRow ?? null);
    await flush();
    expect(getScheduleRun).not.toHaveBeenCalledWith("run-skipped");
  });

  it("shows run metadata and keeps raw output collapsed beneath a report", async () => {
    getScheduleRun.mockResolvedValue({
      ...makeRun(newest.id, newest.started_at, "\u001b[31mraw diagnostic\u001b[0m"),
      report: "# Summary\nEverything completed.",
    });

    await act(async () => renderView());
    await flush();

    const panels = container.querySelectorAll("[data-testid='resizable-panel']");
    const detailPanel = panels[1];
    expect(detailPanel.textContent).toContain("Summary");
    expect(detailPanel.textContent).toContain("completed");
    expect(detailPanel.textContent).toContain("1m 0s");
    expect(detailPanel.textContent).toContain("Exit code: 0");
    const rawDetails = detailPanel.querySelector("details");
    expect(rawDetails).not.toBeNull();
    expect(rawDetails?.hasAttribute("open")).toBe(false);
    expect(rawDetails?.textContent).toContain("raw diagnostic");
    expect(rawDetails?.textContent).not.toContain("\u001b[31m");
  });

  it("shows cleaned raw output directly when the run has no report", async () => {
    getScheduleRun.mockResolvedValue(
      makeRun(newest.id, newest.started_at, "\u001b[32mplain output\u001b[0m"),
    );

    await act(async () => renderView());
    await flush();

    const panels = container.querySelectorAll("[data-testid='resizable-panel']");
    const detailPanel = panels[1];
    expect(detailPanel.querySelector("details")).toBeNull();
    expect(detailPanel.querySelector("pre")?.textContent).toBe("plain output");
  });
});
