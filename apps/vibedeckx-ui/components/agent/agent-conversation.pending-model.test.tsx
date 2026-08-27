// @vitest-environment jsdom
//
// Regression cover for the pre-session model choice (`pendingModel`).
//
// AgentConversation is rendered WITHOUT a `key` in app/page.tsx, so it does not
// remount when the user switches project/branch — every piece of
// workspace-scoped state has to be reset by hand. `pendingModel` was missed,
// so a model picked in workspace A and never sent leaked into the session
// spawned in workspace B.
//
// This repo has no @testing-library/react; component tests drive
// react-dom/client + act and query with document.querySelector (see
// model-picker.test.tsx and search/quick-switcher.test.tsx).
//
// The component pulls in the whole conversation surface (WebSocket hook,
// prompt input, message renderer, dialogs), none of which this behaviour
// touches, so those modules are mocked out. ModelPicker itself is replaced by a
// two-element stub — a button that reports a pick and a node that echoes the
// value back — because the real picker's Radix popover + cmdk combobox is
// tested in model-picker.test.tsx and is not what's under test here. What IS
// real is AgentConversation's own state and its reset effect.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ensureSession = vi.fn(async () => null);
const setModel = vi.fn(async (): Promise<string | null> => null);

/**
 * What the hook reports, so a test can put the component in front of a session
 * that already exists (a branch, a running turn) instead of the empty
 * pre-session state the pendingModel cases need.
 */
const hookState: {
  session: { id: string; model?: string | null } | null;
  status: string;
  messages: unknown[];
} = { session: null, status: "idle", messages: [] };

vi.mock("./model-picker", () => ({
  ModelPicker: ({
    value,
    onChange,
    locked,
  }: {
    value: string | null;
    onChange: (m: string | null) => void;
    locked: boolean;
  }) => (
    <div>
      <span data-testid="model-value">{value ?? "Default"}</span>
      <span data-testid="model-locked">{String(locked)}</span>
      <button data-testid="pick-opus" onClick={() => onChange("opus")}>
        pick
      </button>
      <button data-testid="pick-sonnet" onClick={() => onChange("sonnet")}>
        pick other
      </button>
    </div>
  ),
}));

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
    setModel,
    startNewConversation: vi.fn(),
    ensureSession,
    switchMode: vi.fn(),
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

// Two agents so the header renders the agent DROPDOWN rather than a static
// label — the pre-session branch of that dropdown is the second reset site.
vi.mock("@/lib/api", () => ({
  getAgentProviders: vi.fn().mockResolvedValue([
    { type: "claude-code", displayName: "Claude Code", available: true, models: ["opus", "sonnet"] },
    { type: "codex", displayName: "Codex", available: true, models: ["gpt-5.6-sol"] },
  ]),
  translateText: vi.fn(),
  branchAgentSession: vi.fn(),
  // Only reached once a session exists: the reviewer-run hook polls for the
  // session's workflow runs on mount. Nothing here reads the result.
  api: { getActiveWorkflowRuns: vi.fn().mockResolvedValue({ runs: [] }) },
}));

// Radix's DropdownMenu opens on pointerdown and portals its content; jsdom has
// no PointerEvent, so the menu can never be opened here. Swapped for plain
// buttons that invoke the same onValueChange the real radio items do — the
// handler is what's under test, not shadcn's menu.
vi.mock("@/components/ui/dropdown-menu", async (importOriginal) => {
  const React = await import("react");
  const actual = await importOriginal<Record<string, unknown>>();
  const Ctx = React.createContext<(v: string) => void>(() => {});
  type Kids = { children?: React.ReactNode };
  return {
    // The prompt-input attachment menu uses other exports from this module.
    ...actual,
    DropdownMenu: ({ children }: Kids) => <>{children}</>,
    DropdownMenuTrigger: ({ children }: Kids) => <>{children}</>,
    DropdownMenuContent: ({ children }: Kids) => <>{children}</>,
    DropdownMenuRadioGroup: ({
      children,
      onValueChange,
    }: Kids & { onValueChange: (v: string) => void }) => (
      <Ctx.Provider value={onValueChange}>{children}</Ctx.Provider>
    ),
    DropdownMenuRadioItem: ({ children, value }: Kids & { value: string }) => {
      const onValueChange = React.useContext(Ctx);
      return (
        <button data-testid={`agent-${value}`} onClick={() => onValueChange(value)}>
          {children}
        </button>
      );
    },
  };
});

// The composer builds its attachment menu out of the REAL DropdownMenu, which
// the stub above cannot host. It plays no part in the model choice, so it is
// stubbed down to the bare shape AgentConversation composes with.
vi.mock("@/components/ai-elements/prompt-input", async () => {
  const React = await import("react");
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

vi.mock("./session-history-dropdown", () => ({
  SessionHistoryDropdown: ({
    onSwitch,
    onDelete,
  }: {
    onSwitch: (id: string) => void;
    onDelete?: (id: string, remaining: Array<{ id: string }>) => void;
  }) => (
    <div>
      <button data-testid="session-history-switch" onClick={() => onSwitch("selected-session")}>
        switch session
      </button>
      <button
        data-testid="session-history-delete"
        onClick={() => onDelete?.("current-session", [{ id: "fallback-session" }])}
      >
        delete session
      </button>
    </div>
  ),
}));
vi.mock("./review-dialog", () => ({ ReviewDialog: () => null }));
vi.mock("./agent-message", () => ({ AgentMessageItem: () => null }));
vi.mock("./user-input-markers", () => ({ UserInputMarkers: () => null }));
vi.mock("./quote-popover", () => ({ QuotePopover: () => null, appendQuote: vi.fn() }));
vi.mock("./turn-end-divider", () => ({ TurnEndDivider: () => null }));

import { AgentConversation } from "./agent-conversation";

function q(container: HTMLElement, testid: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testid}"]`);
}

describe("AgentConversation pendingModel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    ensureSession.mockClear();
    setModel.mockClear();
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

  const render = async (projectId: string, branch: string | null) => {
    await act(async () => {
      root.render(
        <AgentConversation
          projectId={projectId}
          branch={branch}
          project={{ id: projectId, name: projectId, path: `/tmp/${projectId}` } as never}
        />,
      );
    });
  };

  it("gives every agent option the same accent icon the collapsed chip uses", async () => {
    await render("pA", "featA");

    // The accent colour is the fastest cue for which agent is active. Showing it
    // only after the menu closes makes the user pick by name and confirm by
    // colour; the two have to agree at the point of choice.
    const icon = (testid: string) => q(container, testid)!.querySelector("svg")?.getAttribute("class");
    expect(icon("agent-claude-code")).toContain("text-violet-500");
    expect(icon("agent-codex")).toContain("text-green-500");
  });

  it("records explicit Session History switches but not deletion fallback navigation", async () => {
    hookState.session = { id: "current-session" };
    const setSessionUrlParam = vi.fn();
    const onSessionSelected = vi.fn();

    await act(async () => {
      root.render(
        <AgentConversation
          projectId="pA"
          branch="featA"
          project={{ id: "pA", name: "pA", path: "/tmp/pA" } as never}
          setSessionUrlParam={setSessionUrlParam}
          onSessionSelected={onSessionSelected}
        />,
      );
    });

    await act(async () => {
      q(container, "session-history-switch")!.click();
    });
    expect(onSessionSelected).toHaveBeenCalledOnce();
    expect(onSessionSelected).toHaveBeenCalledWith("selected-session");
    expect(setSessionUrlParam).toHaveBeenCalledWith("selected-session");

    onSessionSelected.mockClear();
    setSessionUrlParam.mockClear();
    await act(async () => {
      q(container, "session-history-delete")!.click();
    });
    expect(onSessionSelected).not.toHaveBeenCalled();
    expect(setSessionUrlParam).toHaveBeenCalledWith("fallback-session");
  });

  it("holds the picked model while the workspace is unchanged", async () => {
    await render("pA", "featA");
    await act(async () => {
      q(container, "pick-opus")!.click();
    });

    expect(q(container, "model-value")!.textContent).toBe("opus");
  });

  it("drops the pending model when the project changes", async () => {
    // The leak: pick opus in workspace A without sending, switch to B, send —
    // B's session spawned on opus. No remount happens, so the reset effect is
    // the only thing standing between the two workspaces.
    await render("pA", "featA");
    await act(async () => {
      q(container, "pick-opus")!.click();
    });
    expect(q(container, "model-value")!.textContent).toBe("opus");

    await render("pB", "featA");

    expect(q(container, "model-value")!.textContent).toBe("Default");
  });

  it("drops the pending model when only the branch changes", async () => {
    await render("pA", "featA");
    await act(async () => {
      q(container, "pick-opus")!.click();
    });

    await render("pA", "featB");

    expect(q(container, "model-value")!.textContent).toBe("Default");
  });

  it("drops the pending model when the agent type changes before any session exists", async () => {
    // A model name belongs to one agent — "opus" is meaningless to Codex — so
    // carrying it across the pre-session agent switch would spawn a session
    // that fails every turn behind a locked chip.
    await render("pA", "featA");
    await act(async () => {
      q(container, "pick-opus")!.click();
    });
    expect(q(container, "model-value")!.textContent).toBe("opus");

    await act(async () => {
      q(container, "agent-codex")!.click();
    });

    expect(q(container, "model-value")!.textContent).toBe("Default");
  });

  // Once a session exists the model belongs to it, not to `pendingModel` — but
  // the session may still have no process (a branch arrives dormant, with its
  // history already copied in). The chip has to stay live there, or the model
  // a branch inherited is the only one it can ever run.
  describe("once a session exists", () => {
    it("stays live on a branch that has history but has not run", async () => {
      hookState.session = { id: "s1", model: "opus" };
      hookState.status = "stopped";
      hookState.messages = [{ type: "user" }];

      await render("pA", "featA");

      expect(q(container, "model-locked")!.textContent).toBe("false");
      expect(q(container, "model-value")!.textContent).toBe("opus");
    });

    it("locks while a turn is in flight on a session that has history", async () => {
      // The running process was spawned with a model and cannot be told about
      // another — the same moment the agent dropdown above it goes disabled.
      hookState.session = { id: "s1", model: "opus" };
      hookState.status = "running";
      hookState.messages = [{ type: "user" }];

      await render("pA", "featA");

      expect(q(container, "model-locked")!.textContent).toBe("true");
    });

    it("stays live on a session that is running but still empty", async () => {
      // A session created by New Conversation holds an idle process and no
      // history. The server retires that process on the change, so locking the
      // chip here would only strand a session nothing has been said to.
      hookState.session = { id: "s1", model: null };
      hookState.status = "running";
      hookState.messages = [];

      await render("pA", "featA");

      expect(q(container, "model-locked")!.textContent).toBe("false");
    });

    it("sends the pick to the server instead of holding it locally", async () => {
      hookState.session = { id: "s1", model: "opus" };
      hookState.status = "stopped";
      hookState.messages = [{ type: "user" }];
      await render("pA", "featA");

      await act(async () => {
        q(container, "pick-sonnet")!.click();
      });

      expect(setModel).toHaveBeenCalledWith("sonnet");
      // The chip renders the session's stored model, so it does not move on
      // the click alone: an optimistic swap would show a model the next turn
      // wouldn't run on if the write were refused.
      expect(q(container, "model-value")!.textContent).toBe("opus");
    });
  });

  it("keeps the pending model when the agent dropdown re-picks the same agent", async () => {
    // Re-selecting the agent already in use is a no-op and must not silently
    // cost the user their choice.
    await render("pA", "featA");
    await act(async () => {
      q(container, "pick-opus")!.click();
    });

    await act(async () => {
      q(container, "agent-claude-code")!.click();
    });

    expect(q(container, "model-value")!.textContent).toBe("opus");
  });
});
