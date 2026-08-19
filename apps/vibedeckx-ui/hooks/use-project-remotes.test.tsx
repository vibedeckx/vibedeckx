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
