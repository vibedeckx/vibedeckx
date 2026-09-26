// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig, Project, ProjectRemote } from "@/lib/api";

const useProjectRemotes = vi.hoisted(() => vi.fn());
const useAppConfig = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({ api: {} }));
vi.mock("@/hooks/use-project-remotes", () => ({ useProjectRemotes }));
vi.mock("@/hooks/use-app-config", () => ({ useAppConfig }));
vi.mock("./remote-directory-browser", () => ({ RemoteDirectoryBrowser: () => null }));

import { ProjectSettingsForm } from "./project-settings-form";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const remoteOnly: Project = {
  id: "p1",
  name: "Project 1",
  path: null,
  is_remote: false,
  agent_mode: "local",
  executor_mode: "local",
  created_at: "2026-07-13T00:00:00Z",
};

const remotes: ProjectRemote[] = [{
  id: "remote-link-1",
  project_id: "p1",
  remote_server_id: "server-1",
  remote_path: "/repo-a",
  sort_order: 0,
  server_name: "Remote A",
}];

let root: Root | null = null;
let container: HTMLElement | null = null;

function render(project: Project, config: AppConfig | null) {
  useAppConfig.mockReturnValue({ config, loading: false });
  act(() => {
    root!.render(<ProjectSettingsForm project={project} onSave={vi.fn()} />);
  });
}

beforeEach(() => {
  useProjectRemotes.mockReturnValue({ remotes, loading: false, refresh: vi.fn() });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("ProjectSettingsForm local folder", () => {
  it("hides the local folder field when local projects are disabled", () => {
    render(remoteOnly, { authEnabled: true, localProjectsEnabled: false });
    expect(container!.textContent).not.toContain("Local Folder");
    expect(container!.textContent).not.toContain("local checkout");
  });

  it("keeps the field for a legacy project that already has a local folder", () => {
    render({ ...remoteOnly, path: "/srv/legacy" }, { authEnabled: true, localProjectsEnabled: false });
    expect(container!.textContent).toContain("Local Folder");
  });

  it("shows the field when the server does not report the flag", () => {
    render(remoteOnly, null);
    expect(container!.textContent).toContain("Local Folder");
  });
});
