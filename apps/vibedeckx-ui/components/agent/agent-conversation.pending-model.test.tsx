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
import { translateText, type WorkflowRun } from "@/lib/api";
import { toast } from "sonner";
import type { EnsuredAgentSession, PreparedConversation } from "@/hooks/use-agent-session";

const startConversation = vi.fn(async (): Promise<EnsuredAgentSession | null> => null);
const prepareConversation = vi.fn(async (): Promise<PreparedConversation | null> => null);
const activateConversation = vi.fn(async (): Promise<EnsuredAgentSession | null> => null);
const cancelPreparedConversation = vi.fn(async () => {});
const uploadPaste = vi.fn();
const uploadAttachment = vi.fn();
const setModel = vi.fn(async (): Promise<string | null> => null);
const reviewerRunState = vi.hoisted(() => ({ value: null as WorkflowRun | null }));
type PickedFile = { id?: string; type: "file"; filename: string; mediaType: string; url: string };
const promptState = vi.hoisted(() => ({
  submit: null as null | ((message: { text: string; files: PickedFile[] }) => Promise<void>),
  /** What the composer sees inside `PromptInput` — drives the pick-time upload. */
  files: [] as PickedFile[],
  clearAttachments: vi.fn(),
  onPasteText: null as null | ((event: unknown, text: string) => void),
  maxFileSize: null as number | null,
  onError: null as null | ((err: { code: string; message: string; files?: File[] }) => void),
}));
const draftState = vi.hoisted(() => ({ value: "", set: vi.fn() }));

/**
 * What the hook reports, so a test can put the component in front of a session
 * that already exists (a branch, a running turn) instead of the empty
 * pre-session state the pendingModel cases need.
 */
const hookState: {
  session: { id: string; model?: string | null } | null;
  status: string;
  messages: unknown[];
  workflowRunUpdate: WorkflowRun | null;
} = { session: null, status: "idle", messages: [], workflowRunUpdate: null };

vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

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
  createAgentWorkspaceIdentity: (
    projectId: string | null,
    branch: string | null,
    agentMode?: string | null,
    explicitSessionId?: string | null,
  ) => projectId ? {
    projectId,
    branch,
    agentMode: agentMode || "local",
    explicitSessionId: explicitSessionId ?? null,
  } : null,
  sameAgentWorkspace: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b),
  useAgentSession: () => ({
    session: hookState.session,
    messages: hookState.messages,
    status: hookState.status,
    isConnected: true,
    isInitialized: true,
    isLoading: false,
    error: null,
    remoteStatus: null,
    workflowRunUpdate: hookState.workflowRunUpdate,
    backgroundTasks: { tasks: [], turnParked: false, parkDeadlineAt: null, canStopTasks: false },
    streamEpoch: 0,
    sendMessage: vi.fn(),
    startConversation,
    prepareConversation,
    activateConversation,
    cancelPreparedConversation,
    uploadPaste,
    uploadAttachment,
    stopSession: vi.fn(),
    switchAgentType: vi.fn(),
    setModel,
    startNewConversation: vi.fn(),
    switchMode: vi.fn(),
    acceptPlan: vi.fn(),
    residentLimitPrompt: null,
  }),
}));

vi.mock("@/hooks/use-surface-commander-session", () => ({
  useSurfaceCommanderSession: vi.fn(),
}));

vi.mock("@/hooks/use-reviewer-run", () => ({
  useReviewerRun: () => reviewerRunState.value,
}));

vi.mock("@/hooks/project-remotes-context", () => ({
  useProjectRemotesContext: () => ({ remotes: [] }),
}));

vi.mock("@/hooks/use-conversation-settings", () => ({
  useConversationSettings: () => ({ settings: { agentFontSize: 13 } }),
}));

vi.mock("@/hooks/use-workspace-draft", () => ({
  useWorkspaceDraft: () => [draftState.value, draftState.set],
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
    PromptInput: ({ children, onSubmit, maxFileSize, onError }: Kids & {
      onSubmit: typeof promptState.submit;
      maxFileSize?: number;
      onError?: typeof promptState.onError;
    }) => {
      promptState.submit = onSubmit;
      promptState.maxFileSize = maxFileSize ?? null;
      promptState.onError = onError ?? null;
      return <form>{children}</form>;
    },
    PromptInputTextarea: ({ onPasteText }: { onPasteText: typeof promptState.onPasteText }) => {
      promptState.onPasteText = onPasteText;
      return <textarea />;
    },
    PromptInputSubmit: ({ status, disabled }: { status: string; disabled?: boolean }) => (
      <button type="submit" data-testid="prompt-submit" data-status={status} disabled={disabled}>send</button>
    ),
    PromptInputAttachments: () => null,
    PromptInputAttachment: () => null,
    PromptInputActionMenu: Pass,
    PromptInputActionMenuTrigger: () => null,
    PromptInputActionMenuContent: Pass,
    PromptInputActionAddAttachments: () => null,
    PromptInputActionMenuItem: ({ children, onSelect }: Kids & { onSelect?: () => void }) => (
      <button type="button" data-testid="prompt-action" onClick={() => onSelect?.()}>{children}</button>
    ),
    PromptInputHeader: Pass,
    usePromptInputAttachments: () => ({ files: promptState.files, clear: promptState.clearAttachments }),
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
vi.mock("./agent-message", () => ({
  AgentMessageItem: ({
    message,
    messageIndex,
  }: {
    message: { type: string; content?: string; message?: string };
    messageIndex: number;
  }) => (
    <div data-testid={`message-${messageIndex}`}>
      {message.content ?? message.message ?? message.type}
    </div>
  ),
}));
vi.mock("./user-input-markers", () => ({ UserInputMarkers: () => null }));
vi.mock("./quote-popover", () => ({ QuotePopover: () => null, appendQuote: vi.fn() }));
vi.mock("./turn-end-divider", () => ({ TurnEndDivider: () => null }));

import { AgentConversation } from "./agent-conversation";

function makeRun(status: WorkflowRun["status"]): WorkflowRun {
  return {
    id: "run-1",
    project_id: "pA",
    branch: "featA",
    source_session_id: "source",
    source_turn_end_index: 1,
    reviewer_session_id: "reviewer",
    review_focus: null,
    review_target: null,
    feedback_snapshot: null,
    status,
    error: status === "failed" ? "distillation failed" : null,
    created_at: "2026-08-30T00:00:00.000Z",
    updated_at: "2026-08-30T00:00:00.000Z",
  };
}

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
    startConversation.mockReset();
    startConversation.mockResolvedValue(null);
    prepareConversation.mockReset();
    prepareConversation.mockResolvedValue(null);
    activateConversation.mockReset();
    activateConversation.mockResolvedValue(null);
    cancelPreparedConversation.mockReset();
    cancelPreparedConversation.mockResolvedValue(undefined);
    uploadPaste.mockReset();
    uploadAttachment.mockReset();
    vi.mocked(translateText).mockReset();
    setModel.mockClear();
    promptState.submit = null;
    promptState.files = [];
    promptState.clearAttachments.mockReset();
    promptState.clearAttachments.mockImplementation(() => { promptState.files = []; });
    promptState.onPasteText = null;
    draftState.value = "";
    draftState.set.mockReset();
    hookState.session = null;
    hookState.status = "idle";
    hookState.messages = [];
    hookState.workflowRunUpdate = null;
    reviewerRunState.value = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  const render = async (projectId: string, branch: string | null, sessionId?: string | null) => {
    await act(async () => {
      root.render(
        <AgentConversation
          projectId={projectId}
          branch={branch}
          sessionId={sessionId}
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

  describe("failed first-send preprocessing", () => {
    // Uploads need an identity before the first instruction exists, so a
    // paste first send goes prepare → upload → activate; plain text goes
    // through one start. Either way nothing is visible until activation.
    const prepared: PreparedConversation = {
      operationId: "op-1",
      sessionId: "s-new",
      origin: {
        projectId: "pA",
        branch: "featA",
        agentMode: "local",
        explicitSessionId: null,
      },
      legacy: false,
    };

    const started = {
      session: { id: "s-new", projectId: "pA", branch: "featA", status: "running" as const },
      origin: prepared.origin,
      adopted: false,
    };

    const renderFirstSend = async () => {
      prepareConversation.mockResolvedValue(prepared);
      // Default to an accepted send: preprocessing *and* send failures now
      // reject the submit so `PromptInput` keeps the attachments for a retry.
      activateConversation.mockResolvedValue(started);
      startConversation.mockResolvedValue(started);
      await render("pA", "featA");
      expect(promptState.submit).not.toBeNull();
    };

    it.each(["returned-error", "thrown-error"] as const)(
      "does not start a session when translation fails (%s)",
      async (failure) => {
        await renderFirstSend();
        await act(async () => { q(container, "prompt-action")!.click(); });
        if (failure === "returned-error") {
          vi.mocked(translateText).mockResolvedValue({ translatedText: "", error: "failed" });
        } else {
          vi.mocked(translateText).mockRejectedValue(new Error("failed"));
        }

        await act(async () => {
          await expect(promptState.submit!({ text: "hello", files: [] }))
            .rejects.toThrow(/Disable translation/);
        });

        // Translation needs no identity, so nothing was prepared and nothing
        // needs discarding: the placeholder simply stays.
        expect(prepareConversation).not.toHaveBeenCalled();
        // One failure, one toast: the returned-error path must not fall
        // through the surrounding catch and report a second time.
        expect(toast.error).toHaveBeenCalledTimes(1);
        expect(startConversation).not.toHaveBeenCalled();
        expect(activateConversation).not.toHaveBeenCalled();
      },
    );

    it("cancels the prepared identity when oversize paste upload fails", async () => {
      await renderFirstSend();
      uploadPaste.mockRejectedValue(new Error("upload failed"));

      await act(async () => {
        await expect(promptState.submit!({ text: "x".repeat(2001), files: [] }))
          .rejects.toThrow(/upload failed/);
      });

      expect(uploadPaste).toHaveBeenCalledWith("x".repeat(2001), "s-new");
      expect(cancelPreparedConversation).toHaveBeenCalledWith(prepared);
      expect(activateConversation).not.toHaveBeenCalled();
      expect(startConversation).not.toHaveBeenCalled();
    });

    it("cancels the prepared identity when tokenized paste upload fails", async () => {
      await renderFirstSend();
      const pasted = "x".repeat(2001);
      await act(async () => {
        promptState.onPasteText!(
          {
            preventDefault: vi.fn(),
            currentTarget: { value: "", selectionStart: 0, selectionEnd: 0 },
          },
          pasted,
        );
      });
      uploadPaste.mockRejectedValue(new Error("upload failed"));

      await act(async () => {
        await expect(promptState.submit!({ text: "[📎 paste #1 (2.0KB)]", files: [] }))
          .rejects.toThrow(/upload failed/);
      });

      expect(uploadPaste).toHaveBeenCalledWith(pasted, "s-new");
      expect(cancelPreparedConversation).toHaveBeenCalledWith(prepared);
      expect(activateConversation).not.toHaveBeenCalled();
    });

    it("restores the same branch draft and resets submit state after a session switch", async () => {
      await renderFirstSend();
      await act(async () => { q(container, "prompt-action")!.click(); });
      let rejectTranslation!: (error: Error) => void;
      vi.mocked(translateText).mockImplementationOnce(() => new Promise((_, reject) => {
        rejectTranslation = reject;
      }));

      let pending!: Promise<void>;
      await act(async () => {
        pending = promptState.submit!({ text: "keep this draft", files: [] });
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(q(container, "prompt-submit")!.dataset.status).toBe("submitted");

      // Same draft workspace, different explicit session. Session-specific UI
      // must not be adopted, but component lifecycle and draft state still
      // belong to the composer currently on this branch.
      await render("pA", "featA", "selected-session");
      await act(async () => {
        rejectTranslation(new Error("failed"));
        await expect(pending).rejects.toThrow(/Disable translation/);
      });

      expect(draftState.set).toHaveBeenLastCalledWith("keep this draft");
      expect(q(container, "prompt-submit")!.dataset.status).toBe("ready");
    });

    it("clears materialized paste state after switching sessions on the same branch", async () => {
      await renderFirstSend();
      // The first send succeeds (for a workspace no longer displayed): the
      // pastes it materialized must not come back into the composer.
      activateConversation.mockResolvedValue({
        session: { id: "s-new", projectId: "pA", branch: "featA", status: "running" },
        origin: prepared.origin,
        adopted: false,
      });
      const pasted = "x".repeat(2001);
      await act(async () => {
        promptState.onPasteText!(
          {
            preventDefault: vi.fn(),
            currentTarget: { value: "", selectionStart: 0, selectionEnd: 0 },
          },
          pasted,
        );
      });
      let resolveUpload!: (value: { path: string; size: number }) => void;
      uploadPaste.mockImplementationOnce(() => new Promise((resolve) => {
        resolveUpload = resolve;
      }));

      let pending!: Promise<void>;
      await act(async () => {
        pending = promptState.submit!({ text: "[📎 paste #1 (2.0KB)]", files: [] });
        await Promise.resolve();
      });
      await render("pA", "featA", "selected-session");
      await act(async () => {
        resolveUpload({ path: "/tmp/paste", size: pasted.length });
        await pending;
      });

      uploadPaste.mockClear();
      await act(async () => {
        await promptState.submit!({ text: "[📎 paste #1 (2.0KB)]", files: [] });
      });
      expect(uploadPaste).not.toHaveBeenCalled();
    });

    it("restores the draft when the first send does not start a session", async () => {
      await renderFirstSend();
      startConversation.mockResolvedValueOnce(null);

      await act(async () => {
        await promptState.submit!({ text: "retry me", files: [] });
      });

      // Text-only: one start under a stable key; the submission stays pending
      // so resending retries the same operation. Nothing to discard.
      expect(startConversation).toHaveBeenCalledWith("retry me", "edit", null);
      expect(cancelPreparedConversation).not.toHaveBeenCalled();
      expect(draftState.set).toHaveBeenLastCalledWith("retry me");
    });

    it("activates the prepared identity with the materialized paste", async () => {
      await renderFirstSend();
      uploadPaste.mockResolvedValueOnce({ path: "/tmp/paste", size: 2001 });

      await act(async () => {
        await promptState.submit!({ text: "x".repeat(2001), files: [] });
      });

      expect(prepareConversation).toHaveBeenCalledWith("edit", null);
      expect(activateConversation).toHaveBeenCalledWith(prepared, '<vpaste path="/tmp/paste" size="2001" />');
      expect(startConversation).not.toHaveBeenCalled();
      expect(cancelPreparedConversation).not.toHaveBeenCalled();
    });

    // Non-image files have no content-part type in either agent protocol, so
    // they go to a temp file on the agent's machine (needing an identity up
    // front, like a paste) and the instruction carries a <vfile/> marker.
    // Images stay inline as content parts.
    const pdf = {
      id: "a1",
      type: "file" as const,
      filename: "spec.pdf",
      mediaType: "application/pdf",
      url: "data:application/pdf;base64,JVBERi0=",
    };
    // Full 8-byte PNG signature: inline routing is decided on the bytes.
    const png = {
      id: "a2",
      type: "file" as const,
      filename: "shot.png",
      mediaType: "image/png",
      url: "data:image/png;base64,iVBORw0KGgo=",
    };

    // Picking is what starts the upload; sending only awaits it. On a
    // placeholder that means an identity is prepared at pick time too, since a
    // temp file has to land next to some session.
    it("uploads a picked file before the message is sent, then reuses it", async () => {
      await renderFirstSend();
      uploadAttachment.mockResolvedValueOnce({ path: "/tmp/att/spec.pdf", name: "spec.pdf", size: 5, mediaType: "application/pdf" });

      promptState.files = [pdf];
      await render("pA", "featA");

      expect(uploadAttachment).toHaveBeenCalledTimes(1);
      expect(prepareConversation).toHaveBeenCalledWith("edit", null);
      expect(activateConversation).not.toHaveBeenCalled();

      await act(async () => {
        await promptState.submit!({ text: "read this", files: [pdf] });
      });

      // The send did not upload again — it awaited the finished work.
      expect(uploadAttachment).toHaveBeenCalledTimes(1);
      expect(activateConversation).toHaveBeenCalledWith(
        prepared,
        'read this\n<vfile path="/tmp/att/spec.pdf" name="spec.pdf" size="5" />',
      );
    });

    it("drops uploaded attachments and the prepared identity when the workspace changes", async () => {
      await renderFirstSend();
      uploadAttachment.mockResolvedValueOnce({ path: "/tmp/att/spec.pdf", name: "spec.pdf", size: 5, mediaType: "application/pdf" });
      promptState.files = [pdf];
      await render("pA", "featA");
      expect(prepareConversation).toHaveBeenCalledTimes(1);

      // Both halves are workspace-bound: the temp file sits on the machine
      // that ran this workspace, and the identity would start the session in
      // the wrong place. The attachment list is dropped, not carried over.
      await act(async () => { await render("pB", "featB"); });
      expect(promptState.clearAttachments).toHaveBeenCalled();
      expect(cancelPreparedConversation).toHaveBeenCalledWith(prepared);

      await act(async () => {
        await promptState.submit!({ text: "plain", files: [] });
      });
      expect(activateConversation).not.toHaveBeenCalled();
      expect(startConversation).toHaveBeenCalledWith("plain", "edit", null);
    });

    it("does not cancel another workspace's identity when an old submission fails", async () => {
      // A submission owns the identity it is going to activate. A second
      // workspace preparing its own in the meantime must be untouched when
      // the first one finally fails.
      const preparedB: PreparedConversation = {
        ...prepared,
        operationId: "op-2",
        sessionId: "s-new-b",
        origin: { projectId: "pB", branch: "featB", agentMode: "local", explicitSessionId: null },
      };
      await renderFirstSend();
      uploadAttachment.mockResolvedValue({ path: "/tmp/att/spec.pdf", name: "spec.pdf", size: 5, mediaType: "application/pdf" });
      promptState.files = [pdf];
      await render("pA", "featA");
      expect(prepareConversation).toHaveBeenCalledTimes(1);

      // Hold the submission open inside translation, the way a slow network
      // would.
      await act(async () => { q(container, "prompt-action")!.click(); });
      let rejectTranslation!: (error: Error) => void;
      vi.mocked(translateText).mockImplementationOnce(() => new Promise((_, reject) => {
        rejectTranslation = reject;
      }));
      let pending!: Promise<void>;
      await act(async () => {
        pending = promptState.submit!({ text: "in flight", files: [pdf] });
        await Promise.resolve();
        await Promise.resolve();
      });

      // Switch workspace and prepare a second identity there.
      prepareConversation.mockResolvedValue(preparedB);
      await act(async () => { await render("pB", "featB"); });
      promptState.files = [pdf];
      await render("pB", "featB");
      expect(prepareConversation).toHaveBeenCalledTimes(2);

      await act(async () => {
        rejectTranslation(new Error("failed"));
        await expect(pending).rejects.toThrow(/Disable translation/);
      });

      expect(cancelPreparedConversation).toHaveBeenCalledWith(prepared);
      expect(cancelPreparedConversation).not.toHaveBeenCalledWith(preparedB);
    });

    it("re-prepares for a paste when the pick-time identity has obsolete settings", async () => {
      // `prepareConversation` resumes a prepare-step submission under the
      // settings it was started with, so a leftover identity has to be
      // tombstoned before a paste target is created — otherwise the session
      // would run with the model the user has since changed away from.
      const preparedForOpus: PreparedConversation = { ...prepared, operationId: "op-2", sessionId: "s-new-2" };
      await renderFirstSend();
      uploadAttachment.mockResolvedValueOnce({ path: "/tmp/att/spec.pdf", name: "spec.pdf", size: 5, mediaType: "application/pdf" });
      promptState.files = [pdf];
      await render("pA", "featA");
      expect(prepareConversation).toHaveBeenCalledTimes(1);

      await act(async () => { q(container, "pick-opus")!.click(); });
      prepareConversation.mockResolvedValue(preparedForOpus);
      uploadPaste.mockResolvedValueOnce({ path: "/tmp/paste", size: 2001 });

      await act(async () => {
        await promptState.submit!({ text: "x".repeat(2001), files: [pdf] });
      });

      expect(cancelPreparedConversation).toHaveBeenCalledWith(prepared);
      expect(prepareConversation).toHaveBeenLastCalledWith("edit", "opus");
      expect(activateConversation).toHaveBeenCalledWith(
        preparedForOpus,
        '<vpaste path="/tmp/paste" size="2001" />\n<vfile path="/tmp/att/spec.pdf" name="spec.pdf" size="5" />',
      );
    });

    it("starts fresh when the prepared identity has aged out of its TTL", async () => {
      // The identity is now prepared while the user picks a file, so a long
      // compose can outlive the server's pending window; activating then
      // would be rejected.
      await renderFirstSend();
      uploadAttachment.mockResolvedValueOnce({ path: "/tmp/att/spec.pdf", name: "spec.pdf", size: 5, mediaType: "application/pdf" });
      promptState.files = [pdf];
      await render("pA", "featA");

      const nowSpy = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 11 * 60_000);
      try {
        await act(async () => {
          await promptState.submit!({ text: "read this", files: [pdf] });
        });
      } finally {
        nowSpy.mockRestore();
      }

      expect(cancelPreparedConversation).toHaveBeenCalledWith(prepared);
      expect(activateConversation).not.toHaveBeenCalled();
      // The uploaded path is still good — only the identity went stale.
      expect(uploadAttachment).toHaveBeenCalledTimes(1);
      expect(startConversation).toHaveBeenCalledWith(
        'read this\n<vfile path="/tmp/att/spec.pdf" name="spec.pdf" size="5" />',
        "edit", null,
      );
    });

    it("does not activate a Claude identity after the user switches to Codex", async () => {
      // The agent is frozen when the identity is prepared, so a pick-time
      // prepare must not outlive a later switch.
      await renderFirstSend();
      uploadAttachment.mockResolvedValueOnce({ path: "/tmp/att/spec.pdf", name: "spec.pdf", size: 5, mediaType: "application/pdf" });
      promptState.files = [pdf];
      await render("pA", "featA");
      expect(prepareConversation).toHaveBeenCalledTimes(1);

      await act(async () => { q(container, "agent-codex")!.click(); });

      await act(async () => {
        await promptState.submit!({ text: "read this", files: [pdf] });
      });

      expect(cancelPreparedConversation).toHaveBeenCalledWith(prepared);
      expect(activateConversation).not.toHaveBeenCalled();
      // The file was uploaded once and its path is still valid — same machine.
      expect(uploadAttachment).toHaveBeenCalledTimes(1);
      expect(startConversation).toHaveBeenCalledWith(
        'read this\n<vfile path="/tmp/att/spec.pdf" name="spec.pdf" size="5" />',
        "edit", null,
      );
    });

    it("blocks sending while an attachment is still uploading", async () => {
      // Sending mid-upload would clear the draft and then sit waiting on the
      // upload — from the user's side the message just disappears.
      draftState.value = "read this";
      await renderFirstSend();
      let finishUpload!: (value: { path: string; name: string; size: number; mediaType: string }) => void;
      uploadAttachment.mockImplementationOnce(() => new Promise((resolve) => { finishUpload = resolve; }));
      promptState.files = [pdf];
      await render("pA", "featA");

      const submitButton = () => q(container, "prompt-submit") as HTMLButtonElement;
      expect(submitButton().disabled).toBe(true);
      expect(submitButton().dataset.status).toBe("submitted");

      await act(async () => {
        finishUpload({ path: "/tmp/att/spec.pdf", name: "spec.pdf", size: 5, mediaType: "application/pdf" });
      });

      expect(submitButton().disabled).toBe(false);
      expect(submitButton().dataset.status).toBe("ready");
    });

    it("uploads a non-image attachment and activates with a <vfile/> marker", async () => {
      await renderFirstSend();
      uploadAttachment.mockResolvedValueOnce({ path: "/tmp/att/spec.pdf", name: "spec.pdf", size: 5, mediaType: "application/pdf" });

      await act(async () => {
        await promptState.submit!({ text: "read this", files: [pdf] });
      });

      expect(uploadAttachment).toHaveBeenCalledWith(
        { name: "spec.pdf", mediaType: "application/pdf", contentBase64: "JVBERi0=" },
        "s-new",
        expect.any(Function),
      );
      expect(activateConversation).toHaveBeenCalledWith(
        prepared,
        'read this\n<vfile path="/tmp/att/spec.pdf" name="spec.pdf" size="5" />',
      );
      expect(startConversation).not.toHaveBeenCalled();
    });

    it("keeps images inline while uploading the other files", async () => {
      await renderFirstSend();
      uploadAttachment.mockResolvedValueOnce({ path: "/tmp/att/spec.pdf", name: "spec.pdf", size: 5, mediaType: "application/pdf" });

      await act(async () => {
        await promptState.submit!({ text: "both", files: [png, pdf] });
      });

      expect(uploadAttachment).toHaveBeenCalledTimes(1);
      expect(activateConversation).toHaveBeenCalledWith(prepared, [
        { type: "text", text: 'both\n<vfile path="/tmp/att/spec.pdf" name="spec.pdf" size="5" />' },
        { type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" },
      ]);
    });

    it("inlines a mislabeled image with the media type its bytes actually are", async () => {
      // `File.type` comes from the extension; a JPEG renamed to .png would be
      // rejected by the API under image/png. The bytes win.
      await renderFirstSend();
      const jpegAsPng = { type: "file" as const, filename: "shot.png", mediaType: "image/png", url: "data:image/png;base64,/9j/4AAQ" };

      await act(async () => {
        await promptState.submit!({ text: "look", files: [jpegAsPng] });
      });

      expect(uploadAttachment).not.toHaveBeenCalled();
      // No upload needed → no prepare; single-shot start with the image part.
      expect(startConversation).toHaveBeenCalledWith(
        [{ type: "text", text: "look" }, { type: "image", mediaType: "image/jpeg", data: "/9j/4AAQ" }],
        "edit", null,
      );
    });

    it("sends an image over the inline size limit as a file", async () => {
      // A real PNG header followed by enough payload to exceed 5 MB raw. The
      // API would refuse it inline; as a file the agent can still Read it.
      await renderFirstSend();
      const rawBytes = 5 * 1024 * 1024 + 3;
      const head = "iVBORw0KGgo="; // 8-byte PNG signature (with padding)
      const body = "A".repeat(Math.ceil((rawBytes - 8) / 3) * 4);
      const big = { type: "file" as const, filename: "huge.png", mediaType: "image/png", url: `data:image/png;base64,${head.slice(0, -1)}${body}` };
      uploadAttachment.mockResolvedValueOnce({ path: "/tmp/att/huge.png", name: "huge.png", size: rawBytes, mediaType: "image/png" });

      await act(async () => {
        await promptState.submit!({ text: "big", files: [big] });
      });

      expect(uploadAttachment).toHaveBeenCalledTimes(1);
      expect(uploadAttachment.mock.calls[0][0].name).toBe("huge.png");
      expect(activateConversation).toHaveBeenCalledWith(prepared, `big\n<vfile path="/tmp/att/huge.png" name="huge.png" size="${rawBytes}" />`);
    });

    it("caps attachments at the server limit at pick time and names the refused files", async () => {
      await renderFirstSend();
      expect(promptState.maxFileSize).toBe(20 * 1024 * 1024);

      await act(async () => {
        promptState.onError!({ code: "max_file_size", message: "…", files: [new File(["x"], "huge.zip")] });
      });

      expect(toast.error).toHaveBeenCalledWith(
        "Files must be 20MB or smaller",
        expect.objectContaining({ description: "Not attached: huge.zip" }),
      );
    });

    it("sends a file claiming to be an image but with unknown bytes as a file", async () => {
      await renderFirstSend();
      const fake = { type: "file" as const, filename: "fake.png", mediaType: "image/png", url: "data:image/png;base64,aGVsbG8gd29ybGQ=" };
      uploadAttachment.mockResolvedValueOnce({ path: "/tmp/att/fake.png", name: "fake.png", size: 11, mediaType: "image/png" });

      await act(async () => {
        await promptState.submit!({ text: "hm", files: [fake] });
      });

      expect(uploadAttachment).toHaveBeenCalledWith(
        { name: "fake.png", mediaType: "image/png", contentBase64: "aGVsbG8gd29ybGQ=" },
        "s-new",
        expect.any(Function),
      );
      expect(activateConversation).toHaveBeenCalledWith(prepared, 'hm\n<vfile path="/tmp/att/fake.png" name="fake.png" size="11" />');
    });

    it("sends an image type the model cannot see (SVG) as a file, not inline", async () => {
      await renderFirstSend();
      const svg = { type: "file" as const, filename: "logo.svg", mediaType: "image/svg+xml", url: "data:image/svg+xml;base64,PHN2Zz4=" };
      uploadAttachment.mockResolvedValueOnce({ path: "/tmp/att/logo.svg", name: "logo.svg", size: 5, mediaType: "image/svg+xml" });

      await act(async () => {
        await promptState.submit!({ text: "use this", files: [svg] });
      });

      expect(uploadAttachment).toHaveBeenCalledWith(
        { name: "logo.svg", mediaType: "image/svg+xml", contentBase64: "PHN2Zz4=" },
        "s-new",
        expect.any(Function),
      );
      // No image part: the instruction is plain text carrying the marker.
      expect(activateConversation).toHaveBeenCalledWith(
        prepared,
        'use this\n<vfile path="/tmp/att/logo.svg" name="logo.svg" size="5" />',
      );
    });

    it("cancels the prepared identity when an attachment upload fails", async () => {
      await renderFirstSend();
      uploadAttachment.mockRejectedValue(new Error("The remote worker is too old to receive file attachments. Update it and reconnect."));

      // Rejecting (rather than resolving) is what keeps the attachment in the
      // composer: PromptInput only clears its files when onSubmit resolves.
      await act(async () => {
        await expect(promptState.submit!({ text: "read this", files: [pdf] })).rejects.toThrow(/too old/);
      });

      expect(cancelPreparedConversation).toHaveBeenCalledWith(prepared);
      expect(activateConversation).not.toHaveBeenCalled();
      expect(startConversation).not.toHaveBeenCalled();
      expect(draftState.set).toHaveBeenLastCalledWith("read this");
    });

    it("fails instead of silently dropping an attachment that never became a data URL", async () => {
      await renderFirstSend();

      await act(async () => {
        await expect(
          promptState.submit!({ text: "read this", files: [{ ...pdf, url: "blob:http://x/1" }] }),
        ).rejects.toThrow(/Could not read spec.pdf/);
      });

      expect(uploadAttachment).not.toHaveBeenCalled();
      // Reading the bytes comes before anything else, so no identity was ever
      // prepared and there is nothing to discard.
      expect(prepareConversation).not.toHaveBeenCalled();
      expect(activateConversation).not.toHaveBeenCalled();
    });
  });

  describe("reviewer startup placeholders", () => {
    const showReviewer = async (messages: unknown[], runStatus: "preparing" | "failed") => {
      hookState.session = { id: "reviewer" };
      hookState.status = "running";
      hookState.messages = messages;
      if (runStatus === "preparing") {
        reviewerRunState.value = makeRun("preparing");
      } else {
        hookState.workflowRunUpdate = makeRun("failed");
      }
      await render("pA", "featA");
    };

    it("shows Preparing review while the reviewer has no messages", async () => {
      await showReviewer([], "preparing");

      expect(container.textContent).toContain("Preparing review…");
    });

    it("keeps Preparing review visible alongside Codex startup diagnostics", async () => {
      await showReviewer([
        { type: "system", content: 'MCP server "github" failed to start.', timestamp: 1 },
        { type: "error", message: "Sandbox initialization degraded.", timestamp: 2 },
      ], "preparing");

      expect(container.textContent).toContain("Preparing review…");
      expect(q(container, "message-0")?.textContent).toContain("MCP server");
      expect(q(container, "message-1")?.textContent).toContain("Sandbox initialization degraded");
    });

    it("shows the conversation once the workflow review prompt arrives", async () => {
      await showReviewer([
        { type: "user", content: "Review this change", origin: "workflow", timestamp: 1 },
      ], "preparing");

      expect(container.textContent).not.toContain("Preparing review…");
      expect(q(container, "message-0")?.textContent).toBe("Review this change");
    });

    it("does not hide a user-typed message behind Preparing review", async () => {
      await showReviewer([
        { type: "system", content: "MCP connection failed", timestamp: 1 },
        { type: "user", content: "What are you reviewing?", timestamp: 2 },
      ], "preparing");

      expect(container.textContent).not.toContain("Preparing review…");
      expect(q(container, "message-1")?.textContent).toBe("What are you reviewing?");
    });

    it("shows review setup failure alongside startup diagnostics", async () => {
      await showReviewer([
        { type: "system", content: 'MCP server "github" failed to start.', timestamp: 1 },
      ], "failed");

      expect(container.textContent).toContain("Review setup failed");
      expect(container.textContent).toContain("distillation failed");
      expect(q(container, "message-0")?.textContent).toContain("MCP server");
    });

    it("does not permanently hide user content after review setup fails", async () => {
      await showReviewer([
        { type: "user", content: "Manual reviewer question", timestamp: 1 },
        { type: "assistant", content: "Manual reviewer answer", timestamp: 2 },
      ], "failed");

      expect(container.textContent).not.toContain("Review setup failed");
      expect(q(container, "message-0")?.textContent).toBe("Manual reviewer question");
      expect(q(container, "message-1")?.textContent).toBe("Manual reviewer answer");
    });
  });
});
