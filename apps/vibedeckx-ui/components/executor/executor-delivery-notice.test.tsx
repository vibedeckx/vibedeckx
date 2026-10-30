// @vitest-environment jsdom
// A remote start whose request was lost must never be silent: the user sees
// that it is being retried and why, can retry it at once, and is told when the
// hub gives up — with the warning that it may have run after all.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ExecutorDelivery } from "@/lib/api";
import { applyDeliveryEvent, deliveryKey } from "@/hooks/use-executor-deliveries";
import { ExecutorDeliveryNotice } from "./executor-delivery-notice";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/hooks/project-remotes-context", () => ({
  useOptionalProjectRemotesContext: () => ({ remotes: [{ remote_server_id: "srv", server_name: "Mac" }] }),
}));

const NOW = new Date("2026-10-30T13:30:00Z").getTime();

function makeDelivery(overrides: Partial<ExecutorDelivery> = {}): ExecutorDelivery {
  return {
    processId: "remote-e1-p1", executorId: "e1", executorName: "git pull", projectId: "p1",
    remoteServerId: "srv", branch: "main", state: "retrying", attempts: 2, reason: "timeout",
    error: "Request timed out after 30000ms", nextAttemptAt: NOW + 25_000,
    firstSentAt: NOW - 60_000, deadlineAt: NOW - 60_000 + 20 * 60_000,
    mayHaveRun: true,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

const button = () => container.querySelector("button")!;

describe("ExecutorDeliveryNotice", () => {
  it("shows the retry and its reason, and re-sends on Retry now", async () => {
    const onRetry = vi.fn(async () => null);
    act(() => root.render(<ExecutorDeliveryNotice delivery={makeDelivery()} onRetry={onRetry} showExecutorName />));

    const text = container.textContent!;
    expect(text).toContain(`"git pull" couldn't reach Mac (no response within 30s)`);
    expect(text).toContain("attempt 2, trying again about every 30s");
    expect(text).toContain("won't run twice (unless Mac's worker restarts meanwhile");

    expect(button().textContent).toBe("Retry now");
    await act(async () => { button().click(); });
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("says it is waiting for the remote when it is offline", () => {
    act(() => root.render(
      <ExecutorDeliveryNotice delivery={makeDelivery({ reason: "offline", nextAttemptAt: null })} onRetry={vi.fn()} />,
    ));
    expect(container.textContent).toContain("This start couldn't reach Mac (Mac is offline)");
    expect(container.textContent).toContain("waiting for Mac to reconnect");
  });

  it("after giving up, warns it may have run and offers Run again", () => {
    act(() => root.render(
      <ExecutorDeliveryNotice delivery={makeDelivery({ state: "gave_up", attempts: 9, nextAttemptAt: null })} onRetry={vi.fn()} />,
    ));
    expect(container.textContent).toContain("couldn't reach Mac for 20 minutes (9 attempts; no response within 30s)");
    expect(container.textContent).toContain("check on Mac before running it again");
    expect(button().textContent).toBe("Run again");
  });

  it("after a give-up where nothing was ever sent, says it did not run", () => {
    act(() => root.render(<ExecutorDeliveryNotice
      delivery={makeDelivery({ state: "gave_up", reason: "offline", mayHaveRun: false, nextAttemptAt: null })}
      onRetry={vi.fn()}
    />));
    expect(container.textContent).toContain("It never reached Mac, so it did not run.");
  });
});

describe("applyDeliveryEvent", () => {
  const key = deliveryKey("e1", "srv");
  const event = (delivery: ExecutorDelivery) => ({ type: "executor:delivery" as const, projectId: "p1", delivery });

  it("keeps retrying and given-up starts, and drops them once refused", () => {
    let state = applyDeliveryEvent(new Map(), event(makeDelivery()));
    expect(state.get(key)?.state).toBe("retrying");
    state = applyDeliveryEvent(state, event(makeDelivery({ state: "gave_up" })));
    expect(state.get(key)?.state).toBe("gave_up");
    expect(applyDeliveryEvent(state, event(makeDelivery({ state: "rejected" }))).has(key)).toBe(false);
  });

  it("clears a give-up when the executor starts on that target, and only there", () => {
    const state = applyDeliveryEvent(new Map(), event(makeDelivery({ state: "gave_up" })));
    expect(applyDeliveryEvent(state, { type: "executor:started", projectId: "p1", executorId: "e1", target: "other" })).toBe(state);
    expect(applyDeliveryEvent(state, { type: "executor:started", projectId: "p1", executorId: "e1", target: "srv" }).has(key)).toBe(false);
  });
});
