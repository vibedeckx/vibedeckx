// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project, ProjectRemote } from "@/lib/api";

const setProjectRemotePrimary = vi.hoisted(() => vi.fn());
const useProjectRemotes = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  api: { setProjectRemotePrimary },
}));
vi.mock("@/hooks/use-project-remotes", () => ({ useProjectRemotes }));
vi.mock("./remote-directory-browser", () => ({ RemoteDirectoryBrowser: () => null }));

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
  {
    id: "remote-link-1",
    project_id: "p1",
    remote_server_id: "server-1",
    remote_path: "/repo-a",
    sort_order: 0,
    server_name: "Remote A",
    server_url: "http://a",
  },
  {
    id: "remote-link-2",
    project_id: "p1",
    remote_server_id: "server-2",
    remote_path: "/repo-b",
    sort_order: 1,
    server_name: "Remote B",
    server_url: "http://b",
  },
];

let root: Root | null = null;
let container: HTMLElement | null = null;
let refreshRemotes: ReturnType<typeof vi.fn>;

function findButton(text: string): HTMLButtonElement {
  const button = Array.from(container!.querySelectorAll("button"))
    .find((element) => element.textContent?.includes(text));
  if (!button) throw new Error(`Button not found: ${text}`);
  return button;
}

beforeEach(() => {
  setProjectRemotePrimary.mockReset();
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

describe("ProjectSettingsForm primary remote", () => {
  it("shows the primary remote and lets another remote become primary", async () => {
    expect(container!.textContent).toContain("Primary");
    expect(container!.textContent).toContain("Set as Primary");
    setProjectRemotePrimary.mockResolvedValue(undefined);

    await act(async () => {
      findButton("Set as Primary").click();
    });

    expect(setProjectRemotePrimary).toHaveBeenCalledWith("p1", "remote-link-2");
    expect(refreshRemotes).toHaveBeenCalledTimes(1);
  });

  it("shows an error and does not refresh when promotion fails", async () => {
    setProjectRemotePrimary.mockRejectedValue(new Error("promotion failed"));

    await act(async () => {
      findButton("Set as Primary").click();
    });

    expect(refreshRemotes).not.toHaveBeenCalled();
    expect(container!.textContent).toContain("promotion failed");
  });
});
