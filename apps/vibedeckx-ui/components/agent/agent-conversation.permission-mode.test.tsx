// @vitest-environment jsdom
//
// Regression cover for the local `permissionMode` state.
//
// AgentConversation is rendered WITHOUT a `key` in app/page.tsx, so it never
// remounts on a workspace switch or New Conversation. `permissionMode` used to
// be synced FROM a session but never reset when the session went away, so the
// mode of whatever was on screen last (typically a reviewer session, which is
// always plan) leaked into the next session created via
// ensureSession(permissionMode) — chains of plan-mode sessions the user never
// asked for.
//
// Mock scaffolding mirrors agent-conversation.pending-model.test.tsx; see the
// notes there. PermissionModeToggle is stubbed to a node echoing the mode plus
// two buttons so the test can read/drive the local state directly.

import { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentConversationHandle } from "./agent-conversation";

const ensureSession = vi.fn(async (): Promise<{ id: string } | null> => null);
const switchMode = vi.fn(async () => {});

const hookState: {
  session: { id: string; permissionMode?: "plan" | "edit" } | null;
  status: string;
  messages: unknown[];
} = { session: null, status: "idle", messages: [] };

vi.mock("@/components/ui/permission-mode-toggle", () => ({
  PermissionModeToggle: ({
    mode,
    onModeChange,
  }: {
    mode: "plan" | "edit";
    onModeChange: (m: "plan" | "edit") => void;
  }) => (
    <div>
      <span data-testid="mode-value">{mode}</span>
      <button data-testid="pick-plan" onClick={() => onModeChange("plan")}>plan</button>
      <button data-testid="pick-edit" onClick={() => onModeChange("edit")}>edit</button>
    </div>
  ),
}));

vi.mock("./model-picker", () => ({ ModelPicker: () => null }));

vi.mock("@/hooks/use-agent-session", () => ({
  useAgentSession: () => ({
    session: hookState.session,
    messages: hookState.messages,
    status: hookState.status,
    isConnected: true,
    isInitialized: true,
    isLoading: false,
    error: null,
    remoteStatus: null,
    backgroundTasks: { tasks: [], turnParked: false, parkDeadlineAt: null, canStopTasks: false },
    sendMessage: vi.fn(),
    uploadPaste: vi.fn(),
    stopSession: vi.fn(),
    switchAgentType: vi.fn(),
    setModel: vi.fn(),
    startNewConversation: vi.fn(),
    ensureSession,
    switchMode,
    acceptPlan: vi.fn(),
    residentLimitPrompt: null,
  }),
}));

vi.mock("@/hooks/use-surface-commander-session", () => ({
  useSurfaceCommanderSession: vi.fn(),
}));
vi.mock("@/hooks/project-remotes-context", () => ({
  useProjectRemotesContext: () => ({ remotes: [] }),
}));
vi.mock("@/hooks/use-conversation-settings", () => ({
  useConversationSettings: () => ({ settings: { agentFontSize: 13 } }),
}));
vi.mock("@/hooks/use-workspace-draft", () => ({
  useWorkspaceDraft: () => ["", vi.fn()],
}));
vi.mock("@/hooks/use-input-history", () => ({
  useInputHistory: () => ({ onKeyDown: vi.fn(), reset: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/hooks/use-marker-keyboard-nav", () => ({
  useMarkerKeyboardNav: () => vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  getAgentProviders: vi.fn().mockResolvedValue([
    { type: "claude-code", displayName: "Claude Code", available: true, models: ["opus"] },
  ]),
  translateText: vi.fn(),
  branchAgentSession: vi.fn(),
  api: { getActiveWorkflowRuns: vi.fn().mockResolvedValue([]) },
}));

vi.mock("@/components/ui/dropdown-menu", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  type Kids = { children?: React.ReactNode };
  return {
    ...actual,
    DropdownMenu: ({ children }: Kids) => <>{children}</>,
    DropdownMenuTrigger: ({ children }: Kids) => <>{children}</>,
    DropdownMenuContent: ({ children }: Kids) => <>{children}</>,
    DropdownMenuRadioGroup: ({ children }: Kids) => <>{children}</>,
    DropdownMenuRadioItem: ({ children }: Kids) => <>{children}</>,
  };
});

vi.mock("@/components/ai-elements/prompt-input", async () => {
  type Kids = { children?: React.ReactNode };
  const Pass = ({ children }: Kids) => <>{children}</>;
  return {
    PromptInput: ({ children }: Kids) => <form>{children}</form>,
    PromptInputTextarea: () => <textarea />,
    PromptInputSubmit: () => <button type="submit">send</button>,
    PromptInputAttachments: () => null,
    PromptInputAttachment: () => null,
    PromptInputActionMenu: Pass,
    PromptInputActionMenuTrigger: () => null,
    PromptInputActionMenuContent: Pass,
    PromptInputActionAddAttachments: () => null,
    PromptInputActionMenuItem: Pass,
    PromptInputHeader: Pass,
    usePromptInputAttachments: () => ({ files: [] }),
  };
});

vi.mock("./session-history-dropdown", () => ({ SessionHistoryDropdown: () => null }));
vi.mock("./review-dialog", () => ({ ReviewDialog: () => null }));
vi.mock("./agent-message", () => ({ AgentMessageItem: () => null }));
vi.mock("./user-input-markers", () => ({ UserInputMarkers: () => null }));
vi.mock("./quote-popover", () => ({ QuotePopover: () => null, appendQuote: vi.fn() }));
vi.mock("./turn-end-divider", () => ({ TurnEndDivider: () => null }));

import { AgentConversation } from "./agent-conversation";

function q(container: HTMLElement, testid: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testid}"]`);
}

describe("AgentConversation permissionMode", () => {
  let container: HTMLDivElement;
  let root: Root;
  const ref = createRef<AgentConversationHandle>();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    ensureSession.mockClear();
    switchMode.mockClear();
    hookState.session = null;
    hookState.status = "idle";
    hookState.messages = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  const render = async (projectId = "pA", branch: string | null = "featA") => {
    await act(async () => {
      root.render(
        <AgentConversation
          ref={ref}
          projectId={projectId}
          branch={branch}
          project={{ id: projectId, name: projectId, path: `/tmp/${projectId}` } as never}
        />,
      );
    });
  };

  const mode = () => q(container, "mode-value")!.textContent;

  it("follows the displayed session's mode", async () => {
    hookState.session = { id: "reviewer", permissionMode: "plan" };
    await render();
    expect(mode()).toBe("plan");
  });

  it("returns to edit when the session goes away (New Conversation / empty workspace)", async () => {
    // The leak: a plan-mode reviewer session was on screen, the user hit New
    // Conversation, and the first message created the new session in plan.
    hookState.session = { id: "reviewer", permissionMode: "plan" };
    await render();
    expect(mode()).toBe("plan");

    hookState.session = null;
    await render("pB", "featA");
    expect(mode()).toBe("edit");

    await act(async () => {
      await ref.current!.submitMessage("hi");
    });
    expect(ensureSession).toHaveBeenCalledWith("edit", null);
  });

  it("re-syncs when a plan session is swapped for another plan session without a null in between", async () => {
    // Warm preview replaces the session object directly. Both sessions are
    // plan, so a sync keyed only on session.permissionMode would not re-run —
    // and if anything had reset the local state to edit in the meantime the
    // toggle would lie. Keying on session.id closes that gap.
    hookState.session = { id: "a", permissionMode: "plan" };
    await render();
    await act(async () => {
      q(container, "pick-edit")!.click();
    });
    // The click optimistically flips local state (and asks the server via switchMode).
    expect(mode()).toBe("edit");

    hookState.session = { id: "b", permissionMode: "plan" };
    await render();
    expect(mode()).toBe("plan");
  });

  it("keeps a mode picked on the placeholder and passes it to ensureSession", async () => {
    await render();
    expect(mode()).toBe("edit");
    await act(async () => {
      q(container, "pick-plan")!.click();
    });
    expect(mode()).toBe("plan");

    await act(async () => {
      await ref.current!.submitMessage("plan this");
    });
    expect(ensureSession).toHaveBeenCalledWith("plan", null);
  });
});
