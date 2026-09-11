// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, ProjectRemote, RemoteInUseBody, RemoteUnreachableBody } from "@/lib/api";

const removeProjectRemote = vi.hoisted(() => vi.fn());
const useProjectRemotes = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { removeProjectRemote } };
});
vi.mock("@/hooks/use-project-remotes", () => ({ useProjectRemotes }));
vi.mock("./remote-directory-browser", () => ({ RemoteDirectoryBrowser: () => null }));

import { ProjectRemoteUnlinkError } from "@/lib/api";
import { ProjectSettingsForm } from "./project-settings-form";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project: Project = {
  id: "p1",
  name: "Project 1",
  path: null,
  is_remote: true,
  agent_mode: "local",
  executor_mode: "local",
  created_at: "2026-07-13T00:00:00Z",
};

const remotes: ProjectRemote[] = [
  { id: "link-1", project_id: "p1", remote_server_id: "srv-1", remote_path: "/srv/repo", sort_order: 0, server_name: "worker3" },
];

const inUse: RemoteInUseBody = {
  errorCode: "remote-in-use",
  error: "worker3 still has 2 workspaces, 1 session and 1 schedule in this project.",
  serverId: "srv-1",
  name: "worker3",
  usage: { workspaces: ["dev3", "feat-x"], sessions: 1, pendingSessions: 1, schedules: ["nightly-build"], runningExecutors: 0 },
};

const offline: RemoteUnreachableBody = {
  errorCode: "remote-unreachable",
  error: "worker3 is offline; its workspaces cannot be confirmed.",
  serverId: "srv-1",
  name: "worker3",
  reason: "offline",
  lastConnectedAt: "2026-09-01T12:00:00Z",
  lastSyncedAt: "2026-08-30T08:00:00Z",
  tokenRevoked: false,
  lastKnownUsage: { workspaces: ["dev3"], sessions: 0, pendingSessions: 0, schedules: [], runningExecutors: 0 },
};

let root: Root | null = null;
let container: HTMLElement | null = null;
let refreshRemotes: ReturnType<typeof vi.fn>;

const buttonNamed = (text: string) =>
  Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.includes(text) || b.getAttribute("aria-label")?.includes(text));

const clickUnlink = () => act(async () => { buttonNamed("Unlink worker3")!.click(); });

beforeEach(() => {
  removeProjectRemote.mockReset();
  refreshRemotes = vi.fn().mockResolvedValue(undefined);
  useProjectRemotes.mockReturnValue({ remotes, loading: false, refresh: refreshRemotes });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(<ProjectSettingsForm project={project} onSave={vi.fn()} />);
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("ProjectSettingsForm unlink guard", () => {
  it("unlinks in one round trip when the hub allows it", async () => {
    removeProjectRemote.mockResolvedValue(undefined);

    await clickUnlink();

    expect(removeProjectRemote).toHaveBeenCalledWith("p1", "link-1", undefined);
    expect(refreshRemotes).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("Cannot");
  });

  it("explains confirmed usage and offers no override", async () => {
    removeProjectRemote.mockRejectedValue(new ProjectRemoteUnlinkError(inUse));

    await clickUnlink();

    const text = document.body.textContent ?? "";
    expect(text).toContain("Cannot unlink worker3");
    expect(text).toContain("2 workspaces: dev3, feat-x");
    expect(text).toContain("2 sessions (1 still being created)");
    expect(text).toContain("1 schedule: nightly-build");
    expect(text).toContain("remove the worktrees on that machine and try again");
    expect(buttonNamed("Unlink anyway")).toBeUndefined();
    expect(refreshRemotes).not.toHaveBeenCalled();

    await act(async () => { buttonNamed("Got it")!.click(); });
    expect(document.body.textContent).not.toContain("Cannot unlink worker3");
  });

  it("shows last known usage for an offline machine and unlinks with force on confirmation", async () => {
    removeProjectRemote.mockRejectedValueOnce(new ProjectRemoteUnlinkError(offline));
    removeProjectRemote.mockResolvedValueOnce(undefined);

    await clickUnlink();

    const text = document.body.textContent ?? "";
    expect(text).toContain("Cannot confirm what is on worker3");
    expect(text).toContain("worker3 is offline. Last online");
    expect(text).toContain("As of the last sync on");
    expect(text).toContain("1 workspace: dev3");
    expect(text).toContain("Unlinking deletes nothing on that machine");

    await act(async () => { buttonNamed("Unlink anyway")!.click(); });

    expect(removeProjectRemote).toHaveBeenLastCalledWith("p1", "link-1", { force: true });
    expect(refreshRemotes).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain("Cannot confirm");
  });

  it("does not call the machine offline when it is online but did not answer", async () => {
    removeProjectRemote.mockRejectedValue(new ProjectRemoteUnlinkError({
      ...offline, reason: "sync-failed", lastSyncedAt: null, lastKnownUsage: null,
    }));

    await clickUnlink();

    const text = document.body.textContent ?? "";
    expect(text).toContain("worker3 is online, but its workspace list could not be read");
    expect(text).not.toContain("is offline");
    expect(text).toContain("never been read successfully");
    expect(buttonNamed("Unlink anyway")).toBeDefined();
  });

  it("says a machine with a revoked token will not come back", async () => {
    removeProjectRemote.mockRejectedValue(new ProjectRemoteUnlinkError({ ...offline, tokenRevoked: true }));

    await clickUnlink();

    expect(document.body.textContent).toContain("worker3 has no valid connect token and will not come back online");
  });
});
