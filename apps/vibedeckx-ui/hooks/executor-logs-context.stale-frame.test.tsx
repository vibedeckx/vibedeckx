// @vitest-environment jsdom
//
// Unsubscribing does not close the mux socket, and the hub's teardown of the
// upstream stream is asynchronous. For a remote process that teardown used to
// fabricate `finished` (a closed proxy channel looks exactly like a process
// that exited), so unmounting the executor item — a right-panel tab switch, a
// workspace switch — could land `status:"closed", exitCode:0` in the retained
// state of a process that was still running. The next mount read that and dropped the
// executor out of `runningProcesses` — a black Start button under live output,
// with `/api/executor-processes/running` still reporting it as running.
//
// The hub now detaches a subscription before tearing it down; this pins the
// client-side half, which also covers frames already in flight.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, getFreshToken: vi.fn().mockResolvedValue(null) };
});

import {
  ExecutorLogsProvider,
  useExecutorLogsStore,
  useExecutorProcessLogs,
  type ExecutorLogsStore,
} from "./executor-logs-context";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROCESS_ID = "remote-server1-p1";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  frames() { return this.sent.map((raw) => JSON.parse(raw) as { type: string; processId?: string }); }
  deliver(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ processId: PROCESS_ID, ...message }) });
  }
}
vi.stubGlobal("WebSocket", FakeWebSocket);

let store: ExecutorLogsStore | null = null;

function StoreProbe() {
  const value = useExecutorLogsStore();
  useEffect(() => { store = value; }, [value]);
  return null;
}

/**
 * Mounting subscribes, unmounting unsubscribes — ExecutorItem calls the logs
 * hook unconditionally, so this models the item itself going away, not the
 * output panel merely collapsing.
 */
function Subscriber() {
  useExecutorProcessLogs(PROCESS_ID);
  return null;
}

let root: Root | null = null;

async function render(subscribed: boolean) {
  const r = root!;
  await act(async () => {
    r.render(
      <ExecutorLogsProvider projectId="proj1">
        <StoreProbe />
        {subscribed ? <Subscriber /> : null}
      </ExecutorLogsProvider>,
    );
  });
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  store = null;
  root = createRoot(document.body.appendChild(document.createElement("div")));
});

afterEach(async () => {
  const r = root;
  await act(async () => { r?.unmount(); });
  root = null;
  document.body.innerHTML = "";
});

describe("mux frames after unsubscribe", () => {
  it("ignores a fabricated finished for a process the client dropped", async () => {
    await render(true);
    const ws = FakeWebSocket.instances[0];
    await act(async () => { ws.open(); });
    await act(async () => { ws.deliver({ type: "init", isPty: true }); });
    expect(store!.getProcessState(PROCESS_ID).status).toBe("connected");

    // View switch: the item unmounts, the mux socket stays open.
    await render(false);
    expect(ws.frames().some((f) => f.type === "unsubscribe" && f.processId === PROCESS_ID)).toBe(true);

    await act(async () => { ws.deliver({ type: "finished", exitCode: 0 }); });

    const state = store!.getProcessState(PROCESS_ID);
    expect(state.status).toBe("connected");
    expect(state.exitCode).toBeNull();
  });

  it("still applies finished while the client is subscribed", async () => {
    await render(true);
    const ws = FakeWebSocket.instances[0];
    await act(async () => { ws.open(); });
    await act(async () => { ws.deliver({ type: "init", isPty: true }); });

    await act(async () => { ws.deliver({ type: "finished", exitCode: 3 }); });

    const state = store!.getProcessState(PROCESS_ID);
    expect(state.status).toBe("closed");
    expect(state.exitCode).toBe(3);
  });
});
