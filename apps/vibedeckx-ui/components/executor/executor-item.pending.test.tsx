// @vitest-environment jsdom
// A slow (remote) start gives no feedback unless the button locks: repeated
// clicks then land on Stop the instant it replaces Start and kill the process
// that just came up.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ExecutorWithProcess } from "@/hooks/use-executors";
import { ExecutorItem } from "./executor-item";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/hooks/executor-logs-context", () => ({
  useExecutorProcessLogs: () => ({
    logs: [], status: "idle", exitCode: null, isPty: false, replayingHistory: false,
    sendInput: vi.fn(), sendResize: vi.fn(),
  }),
}));

vi.mock("./executor-output", () => ({ ExecutorOutput: () => null }));

function makeExecutor(overrides: Partial<ExecutorWithProcess> = {}): ExecutorWithProcess {
  return {
    id: "e1",
    name: "dev server",
    command: "pnpm start",
    executor_type: "command",
    prompt_provider: null,
    cwd: null,
    pty: true,
    disabled_targets: [],
    currentProcessId: null,
    isRunning: false,
    lastProcessId: null,
    lastStartedAt: null,
    isDisabled: false,
    ...overrides,
  } as ExecutorWithProcess;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const actionButton = () => container.querySelector<HTMLButtonElement>("[data-locate-action]")!;

describe("ExecutorItem start/stop lock", () => {
  it("ignores clicks while a start is in flight and right after the button flips to Stop", async () => {
    let resolveStart!: (id: string) => void;
    const onStart = vi.fn(() => new Promise<string | null>((r) => { resolveStart = r; }));
    const onStop = vi.fn(async () => {});
    const render = (executor: ExecutorWithProcess) => root.render(
      <ExecutorItem
        executor={executor}
        isOpen={false}
        onOpenChange={() => {}}
        onStart={onStart}
        onStop={onStop}
        onUpdate={async () => {}}
        onDelete={async () => {}}
        onProcessFinished={() => {}}
      />,
    );

    act(() => render(makeExecutor()));
    act(() => actionButton().click());
    expect(actionButton().disabled).toBe(true);
    act(() => actionButton().click());
    expect(onStart).toHaveBeenCalledTimes(1);

    // Start resolves and the row flips to running: Stop stays locked briefly.
    await act(async () => { resolveStart("p1"); });
    act(() => render(makeExecutor({ isRunning: true, currentProcessId: "p1" })));
    expect(actionButton().textContent).toContain("Stop");
    expect(actionButton().disabled).toBe(true);
    act(() => actionButton().click());
    expect(onStop).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(1000); });
    expect(actionButton().disabled).toBe(false);
    await act(async () => { actionButton().click(); });
    expect(onStop).toHaveBeenCalledWith("p1");
  });
});
