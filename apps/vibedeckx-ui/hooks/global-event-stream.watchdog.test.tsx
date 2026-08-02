// @vitest-environment jsdom
//
// A zombie SSE socket — open, accepted, and silent — never fires `onerror`, so
// nothing in the EventSource contract recovers it. Every SSE-driven surface
// (sidebar status dots, the notification bell, live titles) freezes until the
// stream is reopened, which used to require the user noticing the stale pill or
// reloading the page.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("@/hooks/use-app-config", () => ({
  useAppConfig: () => ({ config: { authEnabled: false }, loading: false }),
}));
vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, getFreshToken: vi.fn() };
});

import { getFreshToken } from "@/lib/api";
import {
  GlobalEventStreamProvider,
  useConnectionStatus,
  type ConnectionState,
} from "./global-event-stream";

const tokenMock = vi.mocked(getFreshToken);

/** Token mints that can be held open, to park `connect()` mid-flight. */
const pendingTokens: Array<(token: string | null) => void> = [];
function deferTokens() {
  tokenMock.mockImplementation(
    () => new Promise<string | null>((resolve) => pendingTokens.push(resolve)),
  );
}

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  close() {
    this.closed = true;
  }
}
vi.stubGlobal("EventSource", FakeEventSource);

let state: ConnectionState = "connecting";

function Probe() {
  const status = useConnectionStatus();
  useEffect(() => {
    state = status.state;
  });
  return null;
}

let root: Root | null = null;

/** Render the provider and bring the first stream up to `live`. */
async function renderLive() {
  root = createRoot(document.body.appendChild(document.createElement("div")));
  const r = root;
  await act(async () => {
    r.render(
      <GlobalEventStreamProvider>
        <Probe />
      </GlobalEventStreamProvider>,
    );
  });
  await act(async () => {
    FakeEventSource.instances[0].onopen?.();
    FakeEventSource.instances[0].onmessage?.({ data: JSON.stringify({ type: "ping" }) });
  });
}

const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  FakeEventSource.instances = [];
  pendingTokens.length = 0;
  tokenMock.mockReset();
  tokenMock.mockResolvedValue(null); // solo mode: no auth, no token
  state = "connecting";
});

afterEach(async () => {
  const r = root;
  if (r) await act(async () => { r.unmount(); });
  root = null;
  vi.useRealTimers();
});

describe("SSE watchdog", () => {
  it("reopens a stream that has gone silent", async () => {
    await renderLive();
    expect(state).toBe("live");
    expect(FakeEventSource.instances).toHaveLength(1);

    // Silence past the heartbeat deadline (backend pings every 15s).
    await tick(45000);

    expect(state).toBe("stale");
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });

  it("stays stale when the replacement only handshakes", async () => {
    await renderLive();
    await tick(45000);

    // A zombie server accepts the connection and then says nothing again. The
    // handshake alone must not clear the warning — otherwise the indicator
    // claims live updates for another full silent window.
    await act(async () => {
      FakeEventSource.instances[1].onopen?.();
    });

    expect(state).toBe("stale");
  });

  it("returns to live once the replacement stream delivers", async () => {
    await renderLive();
    await tick(45000);

    await act(async () => {
      FakeEventSource.instances[1].onopen?.();
    });
    expect(state).toBe("stale");

    await act(async () => {
      FakeEventSource.instances[1].onmessage?.({ data: JSON.stringify({ type: "ping" }) });
    });

    expect(state).toBe("live");
  });

  it("backs off instead of reopening on every watchdog tick", async () => {
    await renderLive();
    await tick(45000);
    expect(FakeEventSource.instances).toHaveLength(2);

    // The replacement never even opens: without a backoff gate the 5s watchdog
    // would tear it down and rebuild it on every tick.
    await tick(9000);
    expect(FakeEventSource.instances).toHaveLength(2);

    await tick(2000);
    expect(FakeEventSource.instances).toHaveLength(3);

    // ...and the gate widens: 10s → 20s → 40s, so a server that stays silent is
    // retried less and less rather than forever at a fixed cadence. (The
    // watchdog only samples every 5s, so these windows are checked with room on
    // either side of the 20s boundary rather than at it.)
    await tick(15000);
    expect(FakeEventSource.instances).toHaveLength(3);

    await tick(10000);
    expect(FakeEventSource.instances).toHaveLength(4);
  });

  it("collapses reopens that pile up behind a slow token mint", async () => {
    await renderLive();
    // Every later connect parks on its token, so watchdog reopens accumulate
    // without ever producing a stream.
    deferTokens();

    await tick(45000); // first reopen — parked on its token
    await tick(11000); // gate expired — second reopen, also parked
    expect(pendingTokens).toHaveLength(2);
    expect(FakeEventSource.instances).toHaveLength(1);

    await act(async () => {
      for (const resolve of pendingTokens) resolve(null);
    });

    // Only the newest attempt may build a stream. Without a generation guard
    // both resolve and assign over the shared `es`, leaving the first
    // EventSource open, unreferenced, and still dispatching to every listener.
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(FakeEventSource.instances[1].closed).toBe(false);
  });

  it("leaves a healthy stream alone", async () => {
    await renderLive();

    // A ping every 15s, as the backend sends.
    for (let i = 0; i < 6; i++) {
      await tick(15000);
      await act(async () => {
        FakeEventSource.instances[0].onmessage?.({ data: JSON.stringify({ type: "ping" }) });
      });
    }

    expect(state).toBe("live");
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
