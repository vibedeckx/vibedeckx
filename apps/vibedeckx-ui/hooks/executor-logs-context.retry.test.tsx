// @vitest-environment jsdom
//
// After a hub restart the browser's mux socket reconnects in ~1-15s while the
// worker can take up to its 60s no-ping timeout to notice and re-dial. The
// browser therefore re-subscribes to a hub whose tunnel is still down and gets
// back `Remote server not reachable`. That used to be a terminal state: the
// mux socket itself is healthy, so nothing ever prompted another attempt and
// the output stayed blank until the item remounted or the socket happened to
// drop. These tests pin the self-healing retry.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, getFreshToken: vi.fn().mockResolvedValue(null) };
});

import { ExecutorLogsProvider, useExecutorProcessLogs } from "./executor-logs-context";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROCESS_ID = "remote-server1-p1";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  // CONNECTING until opened, like the real thing: frames sent in that window
  // are dropped by the store's readyState guard, and it is exactly the window
  // a pending retry can land in.
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; this.readyState = 3; this.onclose?.(); }

  /** Complete the handshake. */
  open() { this.readyState = 1; this.onopen?.(); }

  /** Frames the client sent, decoded. */
  frames() { return this.sent.map((raw) => JSON.parse(raw) as { type: string; processId?: string }); }
  subscribeCount() {
    return this.frames().filter((f) => f.type === "subscribe" && f.processId === PROCESS_ID).length;
  }
  deliver(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ processId: PROCESS_ID, ...message }) });
  }
}
vi.stubGlobal("WebSocket", FakeWebSocket);

let observed: { status: string; logs: number } = { status: "closed", logs: 0 };

function Probe() {
  const { status, logs } = useExecutorProcessLogs(PROCESS_ID);
  useEffect(() => { observed = { status, logs: logs.length }; });
  return null;
}

let root: Root | null = null;

async function render() {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  const r = root;
  await act(async () => {
    r.render(
      <ExecutorLogsProvider projectId="proj1">
        <Probe />
      </ExecutorLogsProvider>,
    );
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  await act(async () => { FakeWebSocket.instances[0].open(); });
  return FakeWebSocket.instances[0];
}

const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

/** Deliver a frame and let the probe's effect commit before asserting. */
const deliver = (ws: FakeWebSocket, message: Record<string, unknown>) =>
  act(async () => { ws.deliver(message); });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  FakeWebSocket.instances = [];
  observed = { status: "closed", logs: 0 };
});

afterEach(async () => {
  const r = root;
  root = null;
  if (r) await act(async () => { r.unmount(); });
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("executor log mux — retryable errors", () => {
  it("re-subscribes on a backoff while the tunnel is down, then streams once it is back", async () => {
    const ws = await render();
    expect(ws.subscribeCount()).toBe(1);

    await deliver(ws, { type: "error", message: "Remote server not reachable (reverse-connect offline)", retryable: true });
    // Not a dead terminal: a retry is pending, so the UI stays in connecting.
    expect(observed.status).toBe("connecting");

    await tick(1300); // first backoff step (1s + up to 25% jitter)
    expect(ws.subscribeCount()).toBe(2);

    // Worker is back — the hub attaches and replays.
    await act(async () => {
      ws.deliver({ type: "init", isPty: false });
      ws.deliver({ type: "pty", data: "hello" });
      ws.deliver({ type: "history_end" });
    });
    expect(observed.status).toBe("connected");
    expect(observed.logs).toBe(1);

    // A successful attach ends the cycle — no further subscribes.
    await tick(30_000);
    expect(ws.subscribeCount()).toBe(2);
  });

  it("gives up after the attempt budget instead of retrying forever", async () => {
    const ws = await render();

    for (let i = 0; i < 12; i++) {
      await deliver(ws, { type: "error", message: "offline", retryable: true });
      await tick(20_000);
    }

    // 1 initial + 8 retries, then the state settles as a real error.
    expect(ws.subscribeCount()).toBe(9);
    expect(observed.status).toBe("error");
  });

  it("does not retry an authoritative error — the process is genuinely gone", async () => {
    const ws = await render();

    await deliver(ws, { type: "error", message: "Remote process not found" });
    expect(observed.status).toBe("error");

    await tick(30_000);
    expect(ws.subscribeCount()).toBe(1);
  });

  it("lets a socket reconnect take over the retry, restoring the full budget", async () => {
    const ws = await render();
    await deliver(ws, { type: "error", message: "offline", retryable: true });

    // Socket drops before the pending retry fires; its reopen re-subscribes
    // everything, so the pending timer must not also fire a duplicate.
    await act(async () => { ws.close(); });
    await tick(1300);
    const reconnected = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    await act(async () => { reconnected.open(); });
    expect(reconnected.subscribeCount()).toBe(1);

    // Budget was reset by the reopen: a fresh error still gets 8 more tries.
    await deliver(reconnected, { type: "error", message: "offline", retryable: true });
    await tick(1300);
    expect(reconnected.subscribeCount()).toBe(2);
  });

  it("drops a pending retry when the consumer unsubscribes", async () => {
    const ws = await render();
    await deliver(ws, { type: "error", message: "offline", retryable: true });

    const r = root;
    root = null;
    await act(async () => { r!.unmount(); });

    await tick(30_000);
    expect(ws.subscribeCount()).toBe(1);
  });
});
