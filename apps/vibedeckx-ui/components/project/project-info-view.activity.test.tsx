// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  listProjectChatThreads: vi.fn(async () => []),
  createProjectChatThread: vi.fn(),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/api")>();
  return { ...original, api: { ...original.api, ...apiMocks } };
});

vi.mock("@/hooks/use-project-remotes", () => ({ useProjectRemotes: () => ({ remotes: [] }) }));
vi.mock("@/hooks/use-project-activity", () => ({
  useProjectActivity: () => ({
    activity: {
      recentThreads: [],
      recentAgentSessions: [],
      recentScheduleRuns: [],
      priorityTasks: [],
      attention: [],
      summary: { running: 0, failed: 0, nextScheduleAt: null },
    },
    loading: false,
    error: null,
    refetch: vi.fn(async () => {}),
  }),
}));
vi.mock("./project-settings-form", () => ({ ProjectSettingsForm: () => null }));
vi.mock("@/components/task/task-detail-dialog", () => ({ TaskDetailDialog: () => null }));

import { ProjectInfoView } from "./project-info-view";
import type { Project, ProjectChatThread } from "@/lib/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const project: Project = {
  id: "project-1",
  name: "Project One",
  path: "/repo/project-one",
  is_remote: false,
  agent_mode: "local",
  executor_mode: "local",
  created_at: "2026-07-31T00:00:00.000Z",
};

const createdThread: ProjectChatThread = {
  id: "thread-1",
  project_id: project.id,
  user_id: "user-1",
  title: "Release review",
  created_at: "2026-07-31T00:00:00.000Z",
  updated_at: "2026-07-31T00:00:00.000Z",
  archived_at: null,
};

let root: Root;
let container: HTMLDivElement;

function setInput(input: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function startButton(): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")]
    .find((button) => button.textContent?.includes("Start conversation"));
  if (!match) throw new Error("Start conversation button not found");
  return match as HTMLButtonElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.sessionStorage.clear();
  apiMocks.createProjectChatThread
    .mockRejectedValueOnce(new Error("response lost"))
    .mockResolvedValueOnce(createdThread);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.sessionStorage.clear();
});

describe("ProjectInfoView Project Chat composer", () => {
  it("uses only the activity aggregate for reads and reuses its create id after a recoverable failure", async () => {
    const onOpenProjectChatThread = vi.fn();
    await act(async () => {
      root.render(
        <ProjectInfoView
          project={project}
          onOpenProjectChatThread={onOpenProjectChatThread}
          onOpenAgentSession={vi.fn()}
          onOpenScheduleRun={vi.fn()}
          onRunScheduleAgain={vi.fn()}
          onViewAllTasks={vi.fn()}
          onProjectUpdated={vi.fn()}
        />,
      );
    });

    expect(apiMocks.listProjectChatThreads).not.toHaveBeenCalled();
    const composer = container.querySelector("textarea") as HTMLTextAreaElement;
    act(() => setInput(composer, "  Release review  "));
    await act(async () => startButton().click());
    expect(composer.value).toBe("  Release review  ");

    await act(async () => startButton().click());
    expect(apiMocks.createProjectChatThread).toHaveBeenCalledTimes(2);
    const firstKey = apiMocks.createProjectChatThread.mock.calls[0][2];
    const retryKey = apiMocks.createProjectChatThread.mock.calls[1][2];
    expect(firstKey).toEqual(expect.any(String));
    expect(retryKey).toBe(firstKey);
    expect(onOpenProjectChatThread).toHaveBeenCalledWith("thread-1");
    expect(composer.value).toBe("");
  });
});
