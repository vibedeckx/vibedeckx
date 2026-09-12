// @vitest-environment jsdom
//
// A resident-session seed is an *insert-time* snapshot (see
// `upsertResidentSession`): its `status` freezes at the moment the session
// started and can be handed to the hook seconds later. Once the session's
// process is reported dead its row is dropped, and no later seed may bring it
// back — the regression that motivated this file was a title landing ~1s after
// the user hit Stop, re-inserting the row as "running" and leaving a stopped
// session pulsing blue in the sidebar for good.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Worktree } from "@/lib/api";
import type { ResidentSidebarSession } from "./use-resident-sessions";

const listBranchSessions = vi.hoisted(() => vi.fn(async () => ({ sessions: [] as unknown[] })));
const listAliveSessions = vi.hoisted(() =>
  vi.fn(async () => ({ sessions: [] as unknown[], complete: true })),
);
vi.mock("@/lib/api", () => ({ listBranchSessions, listAliveSessions }));

let capturedListener: ((evt: { type?: string; [k: string]: unknown }) => void) | null = null;
vi.mock("@/hooks/global-event-stream", () => ({
  useGlobalEventStream: (listener: (evt: unknown) => void) => {
    capturedListener = listener;
  },
  useConnectionStatus: () => ({ state: "live" }),
}));

import { useResidentSessions } from "./use-resident-sessions";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type HookApi = ReturnType<typeof useResidentSessions>;
let latest: HookApi | null = null;

function Probe({
  projectId,
  seed,
}: {
  projectId: string | null;
  seed: ResidentSidebarSession | null;
}) {
  latest = useResidentSessions(projectId, [{ branch: "dev" }] as Worktree[], seed);
  return null;
}

const PROJECT = "p-seed";
const SESSION = "remote-srv-proj-sess";

const seedOf = (status: string): ResidentSidebarSession => ({
  id: SESSION,
  projectId: PROJECT,
  branch: "dev",
  title: "New Session",
  status,
  processAlive: true,
  updated_at: "2026-09-07T02:52:32.000Z",
});

describe("useResidentSessions seed vs process death", () => {
  let root: Root;
  let container: HTMLElement;

  const render = async (seed: ResidentSidebarSession | null) => {
    await act(async () => {
      root.render(<Probe projectId={PROJECT} seed={seed} />);
      await Promise.resolve();
    });
  };
  const fireProcess = async (alive: boolean) => {
    await act(async () => {
      capturedListener?.({
        type: "session:process",
        projectId: PROJECT,
        sessionId: SESSION,
        alive,
        branch: "dev",
      });
      await Promise.resolve();
    });
  };
  const rows = () => latest!.get("dev") ?? [];

  beforeEach(() => {
    capturedListener = null;
    listBranchSessions.mockReset();
    listBranchSessions.mockResolvedValue({ sessions: [] });
    listAliveSessions.mockReset();
    listAliveSessions.mockResolvedValue({ sessions: [], complete: true });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    latest = null;
  });

  // Mount seedless first, mirroring production: the seed only appears once a
  // session starts, which is always after mount. Mounting *with* one would
  // race the mount refresh (an empty `/alive` merge) against the insert.
  const start = async () => {
    await render(null);
    await render(seedOf("running"));
  };

  it("inserts the row a start seed carries", async () => {
    await start();
    expect(rows().map((s) => s.id)).toEqual([SESSION]);
    expect(rows()[0].status).toBe("running");
  });

  it("drops the row when the process dies, and a later stale seed cannot resurrect it", async () => {
    await start();
    // User hits Stop: status goes stopped, then the process-death event
    // removes the row (a resident row means a live process).
    await act(async () => {
      capturedListener?.({
        type: "session:status",
        projectId: PROJECT,
        sessionId: SESSION,
        status: "stopped",
      });
      await Promise.resolve();
    });
    await fireProcess(false);
    expect(rows()).toEqual([]);

    // The generated title lands afterwards. Whatever republishes a seed for
    // this session, it still carries the frozen start-time status.
    await render(seedOf("running"));
    expect(rows()).toEqual([]);
  });

  // A start seed is also the hub's cue that the worker just spawned a process
  // — and that the resident cap may have hibernated another session to make
  // room. That eviction is announced on the evicted session's own stream,
  // which the hub carries only while it holds one, so it can be lost entirely
  // and leave a row for a session with no process behind it.
  it("re-reads /alive when a seed adds a row, dropping a session evicted meanwhile", async () => {
    const EVICTED = "remote-srv-proj-evicted";
    listAliveSessions.mockResolvedValue({
      sessions: [{ id: EVICTED, branch: "dev", title: "Evicted", status: "stopped" }],
      complete: true,
    });
    await render(null);
    expect(rows().map((s) => s.id)).toEqual([EVICTED]);

    listAliveSessions.mockResolvedValue({
      sessions: [{ id: SESSION, branch: "dev", title: "New Session", status: "running" }],
      complete: true,
    });
    await render(seedOf("running"));

    expect(rows().map((s) => s.id)).toEqual([SESSION]);
    expect(listAliveSessions).toHaveBeenCalledTimes(2);
  });

  // The seeded row is what renders a just-started session before any request
  // lands, so the revalidation it triggers must not delete it when the
  // authoritative answer raced it and does not list it yet.
  it("keeps the seeded row when the revalidation predates the session", async () => {
    await start();
    expect(rows().map((s) => s.id)).toEqual([SESSION]);
    expect(listAliveSessions).toHaveBeenCalledTimes(2);
  });

  // `/alive` answers are snapshots. One taken before a death and delivered
  // after it must not re-insert the row: the death is the newer fact.
  it("lets a death that lands during the seed refresh beat the answer", async () => {
    await render(null);
    let release: () => void = () => {};
    listAliveSessions.mockImplementationOnce(
      () => new Promise((resolve) => {
        release = () => resolve({
          sessions: [{ id: SESSION, branch: "dev", title: "New Session", status: "running" }],
          complete: true,
        });
      }),
    );

    await render(seedOf("running"));
    expect(rows().map((s) => s.id)).toEqual([SESSION]);

    // User hits Stop while that request is still in flight.
    await fireProcess(false);
    expect(rows()).toEqual([]);

    await act(async () => {
      release();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rows()).toEqual([]);
  });

  // ...and the veto is scoped to that window: a later wake is re-added by the
  // next refresh rather than being suppressed forever.
  it("re-adds a session that woke after an earlier death", async () => {
    await start();
    await fireProcess(false);
    expect(rows()).toEqual([]);

    listAliveSessions.mockResolvedValue({
      sessions: [{ id: SESSION, branch: "dev", title: "Awake", status: "running" }],
      complete: true,
    });
    await fireProcess(true);

    expect(rows().map((s) => s.id)).toEqual([SESSION]);
  });

  // Two sessions starting back to back: the worker evicts the first to make
  // room for the second, and each start triggers a read. If the older answer
  // (taken before the second session existed) lands last, a membership-
  // authoritative merge would resurrect the evicted one and drop the live one.
  it("ignores a read answer that a newer read has overtaken", async () => {
    const OTHER = "remote-srv-proj-other";
    await render(null);

    let releaseOld: () => void = () => {};
    listAliveSessions.mockImplementationOnce(
      () => new Promise((resolve) => {
        releaseOld = () => resolve({
          sessions: [{ id: SESSION, branch: "dev", title: "First", status: "running" }],
          complete: true,
        });
      }),
    );
    await render(seedOf("running"));

    // Second session starts and evicts the first; its read answers right away.
    listAliveSessions.mockResolvedValue({
      sessions: [{ id: OTHER, branch: "dev", title: "Second", status: "running" }],
      complete: true,
    });
    await render({ ...seedOf("running"), id: OTHER });
    expect(rows().map((s) => s.id)).toEqual([OTHER]);

    await act(async () => {
      releaseOld();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(rows().map((s) => s.id)).toEqual([OTHER]);
  });

  it("spends no request on a seed for a row it already shows", async () => {
    await start();
    listAliveSessions.mockClear();

    await render(seedOf("running"));

    expect(listAliveSessions).not.toHaveBeenCalled();
    expect(rows().map((s) => s.id)).toEqual([SESSION]);
  });

  it("accepts a seed again once the session reports a live process", async () => {
    await start();
    await fireProcess(false);
    expect(rows()).toEqual([]);

    // Wake / restart: the process is back, so the seed is trustworthy again.
    listAliveSessions.mockResolvedValue({ sessions: [], complete: true });
    await fireProcess(true);
    await render({ ...seedOf("running"), updated_at: "2026-09-07T03:00:00.000Z" });
    expect(rows().map((s) => s.id)).toEqual([SESSION]);
  });
});
