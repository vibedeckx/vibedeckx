// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProjectChatOperationMessage } from "@/lib/api";
import { ProjectOperationCard } from "./project-operation-card";
import { WorkspaceSelectionCard } from "./workspace-selection-card";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function render(node: React.ReactNode) {
  act(() => root.render(node));
}

function button(name: string): HTMLButtonElement {
  const match = [...container.querySelectorAll("button")].find((candidate) => (
    candidate.textContent?.trim() === name || candidate.getAttribute("aria-label") === name
  ));
  if (!match) throw new Error(`Button not found: ${name}`);
  return match as HTMLButtonElement;
}

const sessionOperation = (
  status: ProjectChatOperationMessage["status"],
  overrides: Partial<Extract<ProjectChatOperationMessage, { kind: "agent_session_create" }>> = {},
): Extract<ProjectChatOperationMessage, { kind: "agent_session_create" }> => ({
  version: 1,
  operationId: "operation-session",
  kind: "agent_session_create",
  status,
  sessionId: "session-1",
  target: "local",
  branch: "feature/chat",
  ...overrides,
});

const scheduleOperation = (
  status: ProjectChatOperationMessage["status"],
  overrides: Partial<Extract<ProjectChatOperationMessage, { kind: "schedule_run" }>> = {},
): Extract<ProjectChatOperationMessage, { kind: "schedule_run" }> => ({
  version: 1,
  operationId: "operation-schedule",
  kind: "schedule_run",
  status,
  scheduleId: "schedule-1",
  runId: "run-1",
  ...overrides,
});

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("ProjectOperationCard", () => {
  it.each([
    ["pending", "Queued"],
    ["resolving", "Running"],
    ["running", "Running"],
    ["completed", "Completed"],
    ["failed", "Failed"],
  ] as const)("renders agent session %s as %s from its structured status", (status, label) => {
    render(<ProjectOperationCard operation={sessionOperation(status)} />);

    expect(container.textContent).toContain("Agent session");
    expect(container.textContent).toContain(label);
    expect(container.textContent).toContain("feature/chat");
    expect(container.querySelector('[role="status"]')?.textContent).toBe(label);
    expect(container.querySelector('[role="status"]')?.getAttribute("aria-live")).toBe("polite");
  });

  it("renders timeout, remote-offline, and deleted-target states without parsing prose", () => {
    const cases = [
      [scheduleOperation("failed", { failure: { code: "timeout" } }), "Timed out"],
      [sessionOperation("failed", { failure: { code: "remote_offline" } }), "Remote offline"],
      [sessionOperation("failed", { failure: { code: "deleted_target" } }), "Deleted target"],
    ] as const;

    for (const [operation, expected] of cases) {
      render(<ProjectOperationCard operation={operation} />);
      expect(container.textContent).toContain(expected);
    }
  });

  it("renders task and instruction operations supported by the public union", () => {
    const task: ProjectChatOperationMessage = {
      version: 1, operationId: "task-operation", kind: "task_create", status: "completed",
      taskId: "task-1", title: "Ship operation cards",
    };
    render(<ProjectOperationCard operation={task} />);
    expect(container.textContent).toContain("Task created");
    expect(container.textContent).toContain("Ship operation cards");

    const instruction: ProjectChatOperationMessage = {
      version: 1, operationId: "instruction-operation", kind: "agent_instruction", status: "running",
      sessionId: "session-1", instruction: "Run the focused tests", delivery: "pending",
    };
    render(<ProjectOperationCard operation={instruction} />);
    expect(container.textContent).toContain("Agent instruction");
    expect(container.textContent).toContain("Running");
  });

  it("exposes only safe session and schedule actions", () => {
    const onOpenSession = vi.fn();
    const onViewOutput = vi.fn();
    const onRunAgain = vi.fn();
    render(
      <div>
        <ProjectOperationCard operation={sessionOperation("completed")} onOpenSession={onOpenSession} />
        <ProjectOperationCard
          operation={scheduleOperation("failed")}
          onViewOutput={onViewOutput}
          onRunAgain={onRunAgain}
        />
      </div>,
    );

    act(() => {
      button("Open Session").click();
      button("View Output").click();
      button("Run Again").click();
    });
    expect(onOpenSession).toHaveBeenCalledWith(sessionOperation("completed"));
    expect(onViewOutput).toHaveBeenCalledWith(scheduleOperation("failed"));
    expect(onRunAgain).toHaveBeenCalledWith(scheduleOperation("failed"));
    expect(container.textContent).not.toMatch(/delete|stop|worktree|git/i);
  });

  it("disables unavailable or in-flight actions and exposes an accessible action error", () => {
    render(
      <ProjectOperationCard
        operation={scheduleOperation("failed", { failure: { code: "deleted_target" } })}
        onViewOutput={vi.fn()}
        onRunAgain={vi.fn()}
        pendingAction="run_again"
        actionError="Schedule could not be started"
      />,
    );

    expect(button("View Output").disabled).toBe(true);
    expect(button("Running again…").disabled).toBe(true);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Schedule could not be started");
  });
});

describe("WorkspaceSelectionCard", () => {
  const operation: Extract<ProjectChatOperationMessage, { kind: "workspace_selection" }> = {
    version: 1,
    operationId: "selection-operation",
    kind: "workspace_selection",
    status: "pending",
    requestId: "request-1",
    candidates: [
      { id: '["local","main"]', target: "local", branch: null },
      { id: '["remote-1","feature/chat"]', target: "remote-1", branch: "feature/chat" },
    ],
  };

  it("submits only the exact selected candidate identity with its request identity", () => {
    const onSelect = vi.fn();
    render(<WorkspaceSelectionCard operation={operation} onSelect={onSelect} />);

    act(() => button("Select workspace: remote-1 / feature/chat").click());
    expect(onSelect).toHaveBeenCalledWith({
      requestId: "request-1",
      workspaceId: '["remote-1","feature/chat"]',
    });
    expect(container.textContent).not.toMatch(/delete|stop|worktree|git/i);
  });

  it("disables all candidates while confirmation is in flight and reports failure", () => {
    render(
      <WorkspaceSelectionCard
        operation={operation}
        onSelect={vi.fn()}
        pendingWorkspaceId={'["remote-1","feature/chat"]'}
        actionError="Workspace is no longer available"
      />,
    );

    expect([...container.querySelectorAll("button")].every((candidate) => candidate.disabled)).toBe(true);
    expect(container.textContent).toContain("Selecting…");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Workspace is no longer available");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Waiting for workspace selection");
    expect(container.querySelector('[role="status"]')?.textContent).not.toContain("Workspace is no longer available");
  });

  it("announces a resolving transition without announcing action controls", () => {
    render(
      <WorkspaceSelectionCard
        operation={{ ...operation, status: "resolving" }}
        onSelect={vi.fn()}
      />,
    );

    const status = container.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(status?.getAttribute("aria-atomic")).toBe("true");
    expect(status?.textContent).toBe("Workspace selected; creating agent session");
    expect(status?.textContent).not.toContain("Select workspace:");
  });
});
