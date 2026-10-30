// @vitest-environment jsdom
// The shown delivery state must track the hub's: a stale "Retry now" after the
// start was delivered would launch a fresh process — the run twice the notice
// promises cannot happen.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ExecutorDelivery } from "@/lib/api";

const api = vi.hoisted(() => ({ getExecutorDeliveries: vi.fn() }));
vi.mock("@/lib/api", () => ({ api }));

const stream = vi.hoisted(() => ({ listener: null as null | ((data: Record<string, unknown>) => void) }));
vi.mock("@/hooks/global-event-stream", () => ({
  STREAM_RECONNECTED_EVENT: "stream:reconnected",
  useGlobalEventStream: (listener: (data: Record<string, unknown>) => void) => { stream.listener = listener; },
}));

import { useExecutorDeliveries } from "./use-executor-deliveries";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const retrying: ExecutorDelivery = {
  processId: "remote-e1-p1", executorId: "e1", executorName: "git pull", projectId: "p1",
  remoteServerId: "srv", branch: "main", state: "retrying", attempts: 2, reason: "timeout",
  error: "Request timed out after 30000ms", nextAttemptAt: 1, firstSentAt: 0, deadlineAt: 1_200_000,
  mayHaveRun: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function Probe() {
  const deliveries = useExecutorDeliveries("p1");
  return <div data-testid="states">{[...deliveries.values()].map((d) => d.state).join(",")}</div>;
}

let container: HTMLDivElement;
let root: Root;
const shown = () => container.querySelector("[data-testid=states]")!.textContent;
const emit = (data: Record<string, unknown>) => act(() => stream.listener!(data));

beforeEach(() => {
  api.getExecutorDeliveries.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("useExecutorDeliveries", () => {
  it("a delivery refused while the list is loading stays ended", async () => {
    const list = deferred<ExecutorDelivery[]>();
    api.getExecutorDeliveries.mockReturnValue(list.promise);
    act(() => root.render(<Probe />));

    emit({ type: "executor:delivery", projectId: "p1", delivery: { ...retrying, state: "rejected" } });
    await act(async () => list.resolve([retrying]));

    expect(shown()).toBe("");
  });

  it("a start seen while the list is loading clears the snapshot's entry too", async () => {
    const list = deferred<ExecutorDelivery[]>();
    api.getExecutorDeliveries.mockReturnValue(list.promise);
    act(() => root.render(<Probe />));

    emit({ type: "executor:started", projectId: "p1", executorId: "e1", target: "srv", processId: "remote-e1-p1" });
    await act(async () => list.resolve([retrying]));

    expect(shown()).toBe("");
  });

  it("after a reconnect, drops a retry that was delivered while the stream was down", async () => {
    api.getExecutorDeliveries.mockResolvedValueOnce([retrying]);
    await act(async () => root.render(<Probe />));
    expect(shown()).toBe("retrying");

    api.getExecutorDeliveries.mockResolvedValueOnce([]);
    await act(async () => stream.listener!({ type: "stream:reconnected" }));

    expect(shown()).toBe("");
  });

  it("after a reconnect, shows a give-up that happened while the stream was down", async () => {
    api.getExecutorDeliveries.mockResolvedValueOnce([retrying]);
    await act(async () => root.render(<Probe />));

    api.getExecutorDeliveries.mockResolvedValueOnce([{ ...retrying, state: "gave_up" }]);
    await act(async () => stream.listener!({ type: "stream:reconnected" }));

    expect(shown()).toBe("gave_up");
  });
});
