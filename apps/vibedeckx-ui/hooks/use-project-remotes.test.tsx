// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useProjectRemotes } from "./use-project-remotes";

let capturedListener: ((evt: { type?: string; [k: string]: unknown }) => void) | null = null;
vi.mock("@/hooks/global-event-stream", () => ({
  useGlobalEventStream: (listener: (evt: unknown) => void) => {
    capturedListener = listener;
  },
}));

const getProjectRemotes = vi.fn();
const getRemoteServers = vi.fn();
vi.mock("@/lib/api", () => ({
  api: {
    getProjectRemotes: (...a: unknown[]) => getProjectRemotes(...a),
    getRemoteServers: (...a: unknown[]) => getRemoteServers(...a),
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let latest: ReturnType<typeof useProjectRemotes> | null = null;
function Probe({ projectId }: { projectId: string | undefined }) {
  latest = useProjectRemotes(projectId, { withStatus: true });
  return null;
}

let root: Root | null = null;
let container: HTMLElement | null = null;
async function render(projectId: string | undefined) {
  if (!root) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  const r = root;
  await act(async () => {
    r.render(<Probe projectId={projectId} />);
  });
}
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

beforeEach(() => {
  capturedListener = null;
  latest = null;
  getProjectRemotes.mockReset();
  getRemoteServers.mockReset();
  getProjectRemotes.mockResolvedValue([
    { id: "pr1", project_id: "p1", remote_server_id: "srv1", remote_path: "/r", server_name: "srv" },
  ]);
  getRemoteServers.mockResolvedValue([{ id: "srv1", status: "offline" }]);
  vi.useFakeTimers();
});

afterEach(() => {
  if (root) {
    const r = root;
    act(() => r.unmount());
    root = null;
  }
  container?.remove();
  container = null;
  vi.useRealTimers();
});

describe("useProjectRemotes status refresh", () => {
  it("refetches only /remote-servers on a remote-server:status event for this project", async () => {
    await render("p1");
    await flush();
    expect(getProjectRemotes).toHaveBeenCalledTimes(1);
    expect(getRemoteServers).toHaveBeenCalledTimes(1);
    expect(latest?.remotes[0]?.status).toBe("offline");

    getRemoteServers.mockResolvedValue([{ id: "srv1", status: "online" }]);
    await act(async () => {
      capturedListener?.({ type: "remote-server:status", projectId: "p1", remoteServerId: "srv1", status: "online" });
    });
    await flush();

    expect(getRemoteServers).toHaveBeenCalledTimes(2);
    expect(getProjectRemotes).toHaveBeenCalledTimes(1); // links are not re-read
    expect(latest?.remotes[0]?.status).toBe("online");
  });

  it("ignores events for other projects", async () => {
    await render("p1");
    await flush();
    await act(async () => {
      capturedListener?.({ type: "remote-server:status", projectId: "p2", remoteServerId: "srv1", status: "online" });
    });
    await flush();
    expect(getRemoteServers).toHaveBeenCalledTimes(1);
  });

  it("drops a slow previous-project response that lands after the new project's", async () => {
    // A→B switch; B's /remotes resolves first, then A's. A must not overwrite
    // B's links nor flip loadedProjectId back to A (which would leave B
    // loaded=false for good and gate the diff panel shut).
    let resolveA!: (v: unknown) => void;
    let resolveB!: (v: unknown) => void;
    getProjectRemotes.mockReset();
    getProjectRemotes
      .mockImplementationOnce(() => new Promise((r) => { resolveA = r; }))
      .mockImplementationOnce(() => new Promise((r) => { resolveB = r; }));
    getRemoteServers.mockResolvedValue([]);

    await render("pA");
    await flush();
    expect(latest?.loaded).toBe(false);
    await render("pB");
    await flush();
    expect(latest?.remotes).toEqual([]); // A's pre-fetch list is not shown for B
    expect(latest?.loaded).toBe(false);

    await act(async () => { resolveB([{ id: "prB", project_id: "pB", remote_server_id: "srvB", remote_path: "/b", server_name: "B" }]); });
    await flush();
    expect(latest?.remotes.map((r) => r.id)).toEqual(["prB"]);
    expect(latest?.loaded).toBe(true);

    await act(async () => { resolveA([{ id: "prA", project_id: "pA", remote_server_id: "srvA", remote_path: "/a", server_name: "A" }]); });
    await flush();
    expect(latest?.remotes.map((r) => r.id)).toEqual(["prB"]);
    expect(latest?.loaded).toBe(true);
  });

  it("A→B→A while B is pending: A is not loaded again until its own refetch lands", async () => {
    let resolveB!: (v: unknown) => void;
    let resolveA2!: (v: unknown) => void;
    const linksA = [{ id: "prA", project_id: "pA", remote_server_id: "srvA", remote_path: "/a", server_name: "A" }];
    getProjectRemotes.mockReset();
    getProjectRemotes
      .mockResolvedValueOnce(linksA)                                        // A, first visit
      .mockImplementationOnce(() => new Promise((r) => { resolveB = r; }))  // B, left pending
      .mockImplementationOnce(() => new Promise((r) => { resolveA2 = r; })); // A, revisit
    getRemoteServers.mockResolvedValue([]);

    await render("pA");
    await flush();
    expect(latest?.loaded).toBe(true);

    await render("pB");
    await flush();
    expect(latest?.loaded).toBe(false);

    await render("pA"); // back before B resolved
    await flush();
    expect(latest?.remotes).toEqual([]);
    expect(latest?.loaded).toBe(false); // not "loaded" on the strength of the earlier visit

    await act(async () => { resolveB([]); });
    await flush();
    expect(latest?.loaded).toBe(false); // B's late response is ignored

    await act(async () => { resolveA2(linksA); });
    await flush();
    expect(latest?.remotes.map((r) => r.id)).toEqual(["prA"]);
    expect(latest?.loaded).toBe(true);
  });

  it("on a failed fetch for the new project, shows no links (not the previous project's) and still reports loaded", async () => {
    await render("pA");
    await flush();
    expect(latest?.remotes).toHaveLength(1);

    getProjectRemotes.mockRejectedValueOnce(new Error("network"));
    await render("pB");
    await flush();
    expect(latest?.remotes).toEqual([]);
    expect(latest?.loaded).toBe(true); // attempt finished — consumers may proceed with the empty list
  });

  it("does not poll /remotes on the backstop interval, only /remote-servers", async () => {
    await render("p1");
    await flush();
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    await flush();
    expect(getRemoteServers).toHaveBeenCalledTimes(2);
    expect(getProjectRemotes).toHaveBeenCalledTimes(1);
  });
});
