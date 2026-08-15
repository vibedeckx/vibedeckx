"use client";

import { useState, useEffect, useMemo, useRef, useCallback, forwardRef, useImperativeHandle, createContext, useContext, type ClipboardEvent } from "react";
import { useAgentSession } from "@/hooks/use-agent-session";
import { useSurfaceCommanderSession } from "@/hooks/use-surface-commander-session";
import type { AgentMessage, ContentPart, UploadedPaste, AgentSession } from "@/hooks/use-agent-session";
import { AgentMessageItem } from "./agent-message";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  PromptInput,
  PromptInputTextarea,
  PromptInputSubmit,
  PromptInputAttachments,
  PromptInputAttachment,
  PromptInputActionMenu,
  PromptInputActionMenuTrigger,
  PromptInputActionMenuContent,
  PromptInputActionAddAttachments,
  PromptInputActionMenuItem,
  PromptInputHeader,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import type { PromptInputMessage } from "@/components/ai-elements/prompt-input";
import { Loader } from "@/components/ai-elements/loader";
import { Bot, Square, AlertCircle, Wifi, WifiOff, SquarePen, Monitor, Languages, X, Loader2, ChevronDown } from "lucide-react";
import { ExecutionModeToggle, type ExecutionModeTarget } from "@/components/ui/execution-mode-toggle";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu";
import { TurnEndDivider } from "./turn-end-divider";
import { ModelPicker } from "./model-picker";
import { cn } from "@/lib/utils";
import { PermissionModeToggle } from "@/components/ui/permission-mode-toggle";
import { ReservedWidthLabel } from "@/components/ui/reserved-width-label";
import { AgentTypeIcon } from "./agent-type-icon";
import { useInputHistory } from "@/hooks/use-input-history";
import { useReviewerRun } from "@/hooks/use-reviewer-run";
import { useWorkspaceDraft } from "@/hooks/use-workspace-draft";
import { remoteConnectionIcon } from "@/hooks/use-project-remotes";
import { useProjectRemotesContext } from "@/hooks/project-remotes-context";
import { useAgentTabActive } from "@/hooks/agent-tab-active-context";
import { useConversationSettings } from "@/hooks/use-conversation-settings";
import type { Project, ExecutionMode, AgentType, AgentProviderInfo } from "@/lib/api";
import { getAgentProviders, translateText, branchAgentSession, api } from "@/lib/api";
import { toast } from "sonner";
import { UserInputMarkers } from "./user-input-markers";
import { useMarkerKeyboardNav } from "@/hooks/use-marker-keyboard-nav";
import { SessionHistoryDropdown } from "./session-history-dropdown";
import { ConversationAnchorHold } from "./conversation-anchor-hold";
import { QuotePopover, appendQuote } from "./quote-popover";
import { ReviewDialog } from "./review-dialog";

/** Only renders the attachment header when there are files attached */
function AttachmentHeader() {
  const attachments = usePromptInputAttachments();
  if (attachments.files.length === 0) return null;
  return (
    // pt-3/pb-0 + p-0: the block-end addon variant pads its bottom and the
    // attachments div pads all sides — stacked with the textarea's pt-3 they
    // left ~31px under the thumbnails; separation now comes from the textarea
    // padding alone
    <PromptInputHeader className="pt-3 pb-0">
      <PromptInputAttachments className="p-0">
        {(attachment) => <PromptInputAttachment data={attachment} />}
      </PromptInputAttachments>
    </PromptInputHeader>
  );
}

interface AgentConversationContextValue {
  sendMessage: (content: string | ContentPart[], sessionId?: string) => Promise<void>;
  messages: AgentMessage[];
  acceptPlan: (planContent: string) => Promise<void>;
  permissionMode: "plan" | "edit";
  agentType: AgentType;
  sessionId: string | null;
  /**
   * The session's authoritative bindings, for tool cards that create server
   * state from a conversation (schedule proposals). Deliberately sourced here
   * rather than from tool arguments — a model-supplied project/branch/target
   * could be stale or invented.
   */
  projectId: string | null;
  branch: string | null;
  /** Execution target: "local" or a remote_server_id. */
  target: string;
  /** Human-readable name of that target, for display only. */
  targetLabel: string;
  /** Navigate to the Schedules view (a specific schedule, or the list). */
  openSchedule?: (scheduleId: string | null) => void;
}

const AgentConversationContext = createContext<AgentConversationContextValue | null>(null);

export function useAgentConversation() {
  const ctx = useContext(AgentConversationContext);
  if (!ctx) throw new Error("useAgentConversation must be used within AgentConversationContext");
  return ctx;
}

interface AgentConversationProps {
  projectId: string | null;
  branch: string | null;
  sessionId?: string | null;
  /**
   * True while a cross-project session jump is still resolving (branch nulled,
   * target session not yet selected). Suspends session auto-load so the window
   * shows a loading state instead of flashing the default branch's session.
   */
  navPending?: boolean;
  setSessionUrlParam?: (id: string | null) => void;
  project?: Project | null;
  onAgentModeChange?: (mode: ExecutionMode) => void;
  onTaskCompleted?: () => void;
  onSessionStarted?: (session: AgentSession) => void;
  /**
   * The session this window is actually DISPLAYING, whenever it changes.
   *
   * Distinct from `sessionId`, which is only the explicit `?session=` selection:
   * with no URL param this component still resolves and renders the branch's
   * most recent session. Consumers that need "what the user is looking at"
   * (notification auto-read) must use this, not the URL.
   */
  onActiveSessionChange?: (sessionId: string | null) => void;
  onSessionTitleUpdated?: (sessionId: string, title: string) => void;
  /** Called only when the user explicitly selects a Session History row. */
  onSessionSelected?: (sessionId: string) => void;
  onStatusChange?: () => void;
  onNewConversation?: () => void;
  /** Open the Schedules view — a specific schedule, or the list when null. */
  onOpenSchedule?: (scheduleId: string | null) => void;
}

export interface AgentConversationHandle {
  submitMessage: (content: string) => Promise<void>;
  startNewConversation: () => Promise<void>;
}

// TODO(paste): expose as configurable setting
const PASTE_TO_FILE_THRESHOLD = 2000;
// Match any size label inside the parens (e.g. "1.2KB", "42KB", "900B") so the
// regex stays in sync with formatPasteSize without coupling the two.
const PASTE_TOKEN_RE = /\[📎 paste #(\d+) \([^)]+\)\]/g;

interface PasteEntry {
  id: number;
  content: string;
  size: number; // bytes, UTF-8
}

function formatPasteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = bytes / 1024;
  if (kb < 10) return `${kb.toFixed(1)}KB`;
  return `${Math.round(kb)}KB`;
}

function pasteTokenFor(id: number, bytes: number): string {
  return `[📎 paste #${id} (${formatPasteSize(bytes)})]`;
}

export const AgentConversation = forwardRef<AgentConversationHandle, AgentConversationProps>(
  function AgentConversation({ projectId, branch, sessionId, navPending, setSessionUrlParam, project, onAgentModeChange, onTaskCompleted, onSessionStarted, onSessionTitleUpdated, onSessionSelected, onStatusChange, onNewConversation, onActiveSessionChange, onOpenSchedule }, ref) {
  const [input, setInput] = useWorkspaceDraft(projectId, branch);
  const [pastes, setPastes] = useState<PasteEntry[]>([]);
  const [nextPasteId, setNextPasteId] = useState(1);
  const [permissionMode, setPermissionMode] = useState<"plan" | "edit">("edit");
  const [translateEnabled, setTranslateEnabled] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [agentType, setAgentType] = useState<AgentType>("claude-code");
  const [providers, setProviders] = useState<AgentProviderInfo[]>([]);
  // Pre-session model choice. Mirrors how agentType is pre-selected before a
  // session exists (see the agent dropdown's `if (!session)` branch). Reset to
  // null on New Conversation so a choice never leaks into the next session —
  // the last pick is deliberately not remembered.
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [titleRefreshKey, setTitleRefreshKey] = useState(0);
  // Tracks the session whose AI title is currently being generated. When set,
  // the SessionHistoryDropdown renders a "Generating title…" loader instead of
  // the snippet title that the remote backend wrote synchronously. Cleared as
  // soon as the AI result arrives over the WebSocket (`onTitleUpdated`).
  const [pendingTitleSessionId, setPendingTitleSessionId] = useState<string | null>(null);
  // The AI-generated title arrives over WS, but the dropdown's session list
  // refresh is async — for ~100–300ms after WS arrival the cached row still
  // holds the snippet, causing a brief snippet flash before the AI title
  // shows. Using the WS-delivered title as an optimistic override bridges
  // that gap. Cleared once refresh syncs (or on session switch / timeout).
  const [aiTitleOverride, setAiTitleOverride] = useState<{ sessionId: string; title: string } | null>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const onMarkerKeyDown = useMarkerKeyboardNav(messagesRef);
  const textareaWrapperRef = useRef<HTMLDivElement>(null);
  const inputHistory = useInputHistory(setInput, projectId, branch);
  const { remotes } = useProjectRemotesContext();

  // Build execution mode targets from local path + project remotes
  const agentTargets: ExecutionModeTarget[] = [];
  if (project?.path) agentTargets.push({ id: "local", label: "Local", icon: Monitor });
  for (const r of remotes) {
    agentTargets.push({ id: r.remote_server_id, label: r.server_name, icon: remoteConnectionIcon(r) });
  }

  // Where this window's sessions run: the same value that keys useAgentSession
  // below, so it describes the displayed session rather than some other mode.
  const sessionTarget = project?.agent_mode ?? "local";
  const sessionTargetLabel =
    agentTargets.find((t) => t.id === sessionTarget)?.label
    ?? (sessionTarget === "local" ? "Local" : sessionTarget);

  const {
    session,
    messages,
    status,
    isConnected,
    isInitialized,
    isLoading,
    isCachePreview,
    error,
    remoteStatus,
    workflowRunUpdate,
    streamEpoch,
    messageEntryIndices: loadedMessageEntryIndices,
    hasEarlierHistory,
    isLoadingEarlier,
    loadEarlierHistory,
    sendMessage,
    uploadPaste,
    stopSession,
    switchAgentType,
    setModel,
    startNewConversation,
    ensureSession,
    switchMode,
    acceptPlan,
    residentLimitPrompt,
  } = useAgentSession(projectId, branch, project?.agent_mode, agentType, {
    sessionId,
    suspended: navPending,
    onTaskCompleted,
    onSessionStarted,
    onTitleUpdated: (title: string, titleSessionId: string | null) => {
      const sid = titleSessionId ?? session?.id;
      if (sid && title) {
        setAiTitleOverride({ sessionId: sid, title });
        onSessionTitleUpdated?.(sid, title);
      }
      setTitleRefreshKey((k) => k + 1);
      setPendingTitleSessionId(null);
    },
  });
  // Older test doubles/plugins may not expose window metadata yet.
  const messageEntryIndices = loadedMessageEntryIndices ?? messages.map((_, index) => index);

  // Surface a commander-spawned session into this open window (auto-swap).
  useSurfaceCommanderSession(
    projectId,
    branch,
    session?.id ?? null,
    (id) => setSessionUrlParam?.(id),
  );

  // Report what this window is actually showing. `session` is the RESOLVED
  // session — which is non-null for a branch's auto-restored conversation even
  // when no `?session=` was ever set — so consumers get real visibility rather
  // than "did the URL name a session".
  const activeSessionId = session?.id ?? null;
  useEffect(() => {
    onActiveSessionChange?.(activeSessionId);
  }, [activeSessionId, onActiveSessionChange]);

  // On unmount (tab/workspace switch) nothing is on screen any more. Reported
  // through a ref so this fires ONLY on unmount, not on every id change.
  const onActiveSessionChangeRef = useRef(onActiveSessionChange);
  onActiveSessionChangeRef.current = onActiveSessionChange;
  useEffect(() => () => onActiveSessionChangeRef.current?.(null), []);

  // Fetch available agent providers on mount
  useEffect(() => {
    getAgentProviders().then(setProviders).catch(() => {});
  }, []);

  // Sync local permissionMode from session (e.g. after workspace switch restores cached session)
  useEffect(() => {
    if (session?.permissionMode) {
      setPermissionMode(session.permissionMode);
    }
  }, [session?.permissionMode]);

  // Sync local agentType from session (e.g. after workspace switch restores cached session)
  useEffect(() => {
    if (session?.agentType) {
      setAgentType(session.agentType);
    }
  }, [session?.agentType]);

  // Reset per-workspace draft state when the workspace changes.
  //
  // AgentConversation renders without a `key` (app/page.tsx), so it does NOT
  // remount on a project/branch switch — anything scoped to one workspace has
  // to be cleared here by hand. pendingModel is such state: picking "opus" in
  // workspace A without sending, then switching to B and sending, would
  // otherwise spawn B's session on A's model.
  useEffect(() => {
    setPastes([]);
    setNextPasteId(1);
    setPendingModel(null);
  }, [projectId, branch]);

  // Arm the "title pending" state the moment the user's first message becomes
  // visible in the active session. The AI title generator runs on the local
  // backend and broadcasts `titleUpdated` 1–2s later; until then we show a
  // loader instead of the snippet/timestamp the dropdown would otherwise pull
  // from listBranchSessions.
  const prevMessagesCountRef = useRef<{ sessionId: string | null; count: number }>({
    sessionId: null,
    count: 0,
  });
  useEffect(() => {
    const sid = session?.id ?? null;
    const prev = prevMessagesCountRef.current;
    if (sid && prev.sessionId === sid && prev.count === 0 && messages.length > 0) {
      setPendingTitleSessionId(sid);
    }
    prevMessagesCountRef.current = { sessionId: sid, count: messages.length };
  }, [session?.id, messages.length]);

  // Drop the loader when switching away from a session whose AI title hasn't
  // resolved yet — the WS for that session is gone, so we'd never get the
  // titleUpdated event on this client. The session list refresh on switch
  // already shows whatever title the backend persisted.
  useEffect(() => {
    if (pendingTitleSessionId && session?.id !== pendingTitleSessionId) {
      setPendingTitleSessionId(null);
    }
  }, [session?.id, pendingTitleSessionId]);

  // Clear the title override on session switch — the override only matters
  // for the session that just received it, and the new session's list
  // refresh will populate its own (already-final) title.
  useEffect(() => {
    if (aiTitleOverride && session?.id !== aiTitleOverride.sessionId) {
      setAiTitleOverride(null);
    }
  }, [session?.id, aiTitleOverride]);

  // Safety net: drop the override after a short window. By then the session
  // list refresh has long completed; keeping it longer would mask manual
  // renames performed right after AI generation.
  useEffect(() => {
    if (!aiTitleOverride) return;
    const captured = aiTitleOverride;
    const timer = setTimeout(() => {
      setAiTitleOverride((prev) => (prev === captured ? null : prev));
    }, 5000);
    return () => clearTimeout(timer);
  }, [aiTitleOverride]);

  // Safety net for pendingTitleSessionId: cleared by `onTitleUpdated` in the
  // happy path, but if /message ever fails (or the agent crashes before the
  // title generator runs) we'd otherwise leave the trigger as a skeleton
  // forever. 30s is well past the typical 1–2s generation latency.
  useEffect(() => {
    if (!pendingTitleSessionId) return;
    const captured = pendingTitleSessionId;
    const timer = setTimeout(() => {
      setPendingTitleSessionId((prev) => (prev === captured ? null : prev));
    }, 30000);
    return () => clearTimeout(timer);
  }, [pendingTitleSessionId]);

  // "Connecting..." vs "Disconnected": isConnected starts false during the
  // initial WS handshake (after ensureSession/startSession sets the session
  // synchronously but before ws.onopen fires). Without this gate the status
  // badge briefly flashes "Disconnected" on every fresh connect — most
  // visibly when sending the first message after New Conversation.
  const [hasConnectedOnce, setHasConnectedOnce] = useState(false);
  useEffect(() => {
    setHasConnectedOnce(false);
  }, [session?.id]);
  useEffect(() => {
    if (isConnected) setHasConnectedOnce(true);
  }, [isConnected]);

  const handlePermissionModeChange = async (newMode: "plan" | "edit") => {
    setPermissionMode(newMode);
    if (session) {
      await switchMode(newMode);
    }
    // If no session yet, the mode will be used when startSession is called
  };

  // Model change on a session that already exists. The chip renders
  // `session.model`, so nothing moves until the server has stored the new
  // name — an optimistic swap here would show a model the next turn wouldn't
  // actually run on if the write were refused.
  const handleSessionModelChange = async (model: string | null) => {
    const errMsg = await setModel(model);
    if (errMsg) {
      toast.error("Failed to change model", { description: errMsg });
    }
  };

  const handleAcceptPlan = async (planContent: string) => {
    await acceptPlan(planContent);
    setPermissionMode("edit");
    onStatusChange?.();  // Agent will now implement the plan → signal "working"
  };

  const [isBranching, setIsBranching] = useState(false);
  const handleBranch = async (branchAgentType?: AgentType, upToEntryIndex?: number) => {
    if (!session || isBranching) return;
    setIsBranching(true);
    try {
      const result = await branchAgentSession(session.id, branchAgentType, upToEntryIndex);
      // Refresh the session dropdown so the "Branch - ..." entry shows up,
      // then switch this window to the new session.
      setTitleRefreshKey((k) => k + 1);
      setSessionUrlParam?.(result.session.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Failed to branch conversation";
      toast.error("Branch failed", { description: msg });
    } finally {
      setIsBranching(false);
    }
  };
  const currentAgentName =
    providers.find((p) => p.type === agentType)?.displayName
    ?? (agentType === "codex" ? "Codex" : "Claude Code");
  const availableBranchProviders = providers.filter((p) => p.available);
  const alternateBranchProviders = availableBranchProviders.filter((p) => p.type !== agentType);

  // Last persisted turn_end — rendered with "normal" emphasis as the
  // discoverable tail affordance; earlier stop points render "subtle".
  const lastTurnEndIndex = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.type === "turn_end") return i;
    }
    return -1;
  }, [messages]);

  // A trailing turn_end marks "no turn in flight". Drives the resize animation
  // choice and the anchor hold: streaming into a stable view keeps the smooth
  // follow; all other pinned-state growth snaps (see ConversationAnchorHold).
  const turnInFlight =
    status === "running" && messages.length > 0 && messages[messages.length - 1].type !== "turn_end";

  // 本 session 是否为某活跃 review run 的 reviewer(讨论态才显示终稿按钮)。
  // frame-wins:WS 帧驱动为主,REST 只在种子期间没有任何帧到达时落地——见
  // useReviewerRun 里的详细说明。远程会话两侧 id 均已按 remote- 前缀映射,
  // 直接比对。streamEpoch 让每次 socket 连上都重新对账一次,补掉断线期间
  // 丢掉的帧(该帧不入 store、重连不回放)。
  const reviewerRun = useReviewerRun(projectId, branch, activeSessionId, workflowRunUpdate, streamEpoch);
  const [isFinalizing, setIsFinalizing] = useState(false);

  const handleFinalize = useCallback(async () => {
    if (!reviewerRun) return;
    setIsFinalizing(true);
    try {
      // reviewerRun now comes from useReviewerRun (frame-driven); the gate
      // response itself is a discardable side-effect trigger — the backend
      // always emits a workflowRunUpdated frame right after this transition
      // (workflow-engine.ts requestFinalVerdict → emitRunUpdated), so the
      // hook picks up the new status from that frame.
      await api.workflowRunGate(reviewerRun.id, "finalize");
    } catch (e) {
      // 失败(如 reviewer 正在回复中)保持 discussing,按钮可重试;错误通过 toast 展示。
      toast.error(e instanceof Error ? e.message : "生成终稿失败");
    } finally {
      setIsFinalizing(false);
    }
  }, [reviewerRun]);

  // preventScroll because this panel has a history of scroll-jump regressions;
  // the composer sits outside the transcript's scroll container, so focusing it
  // should never move the transcript.
  const focusComposer = useCallback(() => {
    textareaWrapperRef.current?.querySelector("textarea")?.focus({ preventScroll: true });
  }, []);

  // Land the cursor in the composer whenever the Agent tab comes on screen, so
  // ⌃⇧A lets you type immediately — the same deal the Terminal tab gives its
  // shell. Only fires on an explicit switch to the tab (shortcut, tab click,
  // activateAgentTabNonce, or first paint with Agent as the persisted tab);
  // session changes while already on the tab deliberately don't refocus, since
  // those also happen during sidebar/cross-project jumps where grabbing focus
  // would feel like a steal.
  const agentTabActive = useAgentTabActive();
  useEffect(() => {
    if (!agentTabActive) return;
    focusComposer();
  }, [agentTabActive, focusComposer]);

  const handleQuote = useCallback((text: string) => {
    setInput(appendQuote(input, text));
    requestAnimationFrame(() => {
      const ta = textareaWrapperRef.current?.querySelector("textarea");
      if (!ta) return;
      ta.focus();
      const len = ta.value.length;
      try {
        ta.setSelectionRange(len, len);
      } catch {
        // ignore — textarea may have been unmounted
      }
    });
  }, [setInput, input]);

  // Shared by the header button and the global ⌘⇧O shortcut (page.tsx).
  // Multiple sessions can run concurrently per workspace, so opening a
  // new conversation no longer stops the current one — `startNewConversation`
  // just detaches this view and shows an empty placeholder. The running
  // session keeps going in the background (reachable via session history).
  const handleNewConversation = useCallback(async () => {
    // Mirrors the button's disabled state — the keyboard path has no
    // disabled attribute to stop it.
    if (isLoading || !session) return;
    await startNewConversation();
    setPendingModel(null);
    onNewConversation?.();
    // Drop ?session=<id> from the URL — the new conversation has no
    // sessionId yet (one is created on first user message). Without
    // this, refreshing the page would reload the prior session.
    setSessionUrlParam?.(null);
    // Land the cursor in the input so typing can start immediately —
    // covers both the header button and the ⌘⇧O shortcut. The textarea
    // stays mounted through the reset, so a plain focus is enough.
    focusComposer();
  }, [isLoading, session, startNewConversation, onNewConversation, setSessionUrlParam, focusComposer]);

  useImperativeHandle(ref, () => ({
    startNewConversation: handleNewConversation,
    submitMessage: async (content: string) => {
      onStatusChange?.();  // Optimistic "working" overlay — overrides any prior
      // "idle" overlay set by New Conversation so the dot turns blue immediately.
      if (!session) {
        // No persisted session yet (placeholder). Create one via /new on first send.
        const newSession = await ensureSession(permissionMode, pendingModel);
        if (newSession) {
          // Arm the title-pending loader before sendMessage so the dropdown
          // never flashes the snippet/timestamp the server writes synchronously.
          setPendingTitleSessionId(newSession.id);
          sendMessage(content, newSession.id);
        }
      } else {
        sendMessage(content);
      }
    }
  }), [handleNewConversation, session, ensureSession, sendMessage, permissionMode, pendingModel, onStatusChange]);

  const handlePasteText = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>, text: string) => {
      if (text.length <= PASTE_TO_FILE_THRESHOLD) return;

      event.preventDefault();

      const textarea = event.currentTarget;
      const start = textarea.selectionStart ?? input.length;
      const end = textarea.selectionEnd ?? input.length;
      const size = new TextEncoder().encode(text).length;

      const id = nextPasteId;
      const token = pasteTokenFor(id, size);
      const newValue = input.slice(0, start) + token + input.slice(end);

      setInput(newValue);
      setPastes((prev) => [...prev, { id, content: text, size }]);
      setNextPasteId(id + 1);

      // Restore caret after the inserted token.
      const caret = start + token.length;
      requestAnimationFrame(() => {
        try {
          textarea.setSelectionRange(caret, caret);
        } catch {
          // ignore — textarea may have been unmounted
        }
      });
    },
    [input, nextPasteId, setInput]
  );

  async function materializePastes(
    rawText: string,
    pastes: PasteEntry[],
    upload: (content: string, sessionId?: string) => Promise<UploadedPaste>,
    sessionId?: string
  ): Promise<string> {
    const presentIds = new Set<number>();
    for (const match of rawText.matchAll(PASTE_TOKEN_RE)) {
      presentIds.add(Number(match[1]));
    }
    const surviving = pastes.filter((p) => presentIds.has(p.id));
    if (surviving.length === 0) return rawText;

    let result = rawText;
    for (const paste of surviving) {
      const uploaded = await upload(paste.content, sessionId);
      const token = pasteTokenFor(paste.id, paste.size);
      const marker = `<vpaste path="${uploaded.path}" size="${uploaded.size}" />`;
      // Replace every occurrence of this token (should be exactly one, but be safe).
      result = result.split(token).join(marker);
    }
    return result;
  }

  const handleSubmit = async (message: PromptInputMessage) => {
    const rawText = message.text;
    const hasFiles = message.files.length > 0;
    const hasPastes = pastes.length > 0;
    const trimmedRaw = rawText.trim();
    if (!trimmedRaw && !hasFiles) return;

    setIsSubmitting(true);
    try {
    setInput("");
    inputHistory.push(trimmedRaw);

    // Always overlay "working" — even when the session is already running, the
    // optimistic update overrides the "idle" overlay set by New Conversation
    // so the workspace dot turns blue the moment the user hits send.
    onStatusChange?.();

    // Resolve which session id to use. If no session yet, create one via /new
    // and use the resulting id for paste materialization + sendMessage.
    let targetSessionId: string | undefined = session?.id;
    let startedSession: AgentSession | null = null;
    if (!session) {
      startedSession = await ensureSession(permissionMode, pendingModel);
      if (!startedSession) {
        // Restore input on failure so the user doesn't lose their pastes.
        setInput(rawText);
        return;
      }
      targetSessionId = startedSession.id;
      // Arm the title-pending loader the moment the session exists so the
      // dropdown trigger goes straight from "New Session" to skeleton without
      // flashing "History" or the snippet/created_at the server persists
      // synchronously. Cleared by `onTitleUpdated` (or the 30s safety net).
      setPendingTitleSessionId(startedSession.id);
    }

    // Upload pastes (if any) and replace tokens with <vpaste/> markers.
    let processedText = trimmedRaw;
    if (hasPastes) {
      try {
        processedText = (await materializePastes(rawText, pastes, uploadPaste, targetSessionId)).trim();
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to upload paste";
        toast.error("Paste upload failed", { description: msg });
        setInput(rawText);
        return;
      }
    }

    // If the resulting message text is still over the threshold (typed long
    // content, accumulated small pastes, etc.), wrap the whole thing into a
    // single paste file so the conversation/UI doesn't carry the bulk inline.
    if (processedText.length > PASTE_TO_FILE_THRESHOLD) {
      try {
        const uploaded = await uploadPaste(processedText, targetSessionId);
        processedText = `<vpaste path="${uploaded.path}" size="${uploaded.size}" />`;
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to upload paste";
        toast.error("Paste upload failed", { description: msg });
        setInput(rawText);
        return;
      }
    }

    // Clear pastes state now that they've been materialized into the outgoing message.
    const capturedPastes = pastes;
    const capturedNextPasteId = nextPasteId;
    setPastes([]);
    setNextPasteId(1);

    // Build content: plain string when no files, ContentPart[] when files are attached
    let content: string | ContentPart[];
    if (!hasFiles) {
      content = processedText;
    } else {
      const parts: ContentPart[] = [];
      if (processedText) {
        parts.push({ type: "text", text: processedText });
      }
      for (const file of message.files) {
        if (file.mediaType && file.url) {
          // Extract base64 data from data URL (format: "data:mediaType;base64,DATA")
          const base64Match = file.url.match(/^data:[^;]+;base64,(.+)$/);
          if (base64Match) {
            parts.push({ type: "image", mediaType: file.mediaType, data: base64Match[1] });
          }
        }
      }
      content = parts;
    }

    if (translateEnabled) {
      const textToTranslate = typeof content === "string"
        ? content
        : content.filter(p => p.type === "text").map(p => (p as { type: "text"; text: string }).text).join("\n");

      if (textToTranslate.trim()) {
        setIsTranslating(true);
        try {
          const result = await translateText(textToTranslate);
          if (result.error) {
            setInput(rawText);
            setPastes(capturedPastes);
            setNextPasteId(capturedNextPasteId);
            toast.error("Translation failed", { description: "Disable translation to send the original text." });
            return;
          }
          if (typeof content === "string") {
            content = result.translatedText;
          } else {
            content = content.map(p =>
              p.type === "text" ? { ...p, text: result.translatedText } : p
            );
          }
        } catch {
          setInput(rawText);
          setPastes(capturedPastes);
          setNextPasteId(capturedNextPasteId);
          toast.error("Translation failed", { description: "Disable translation to send the original text." });
          return;
        } finally {
          setIsTranslating(false);
        }
      }
    }

    if (startedSession) {
      console.log(`[AgentConversation] handleSubmit: using freshly started session ${startedSession.id}`);
      await sendMessage(content, startedSession.id);
    } else {
      console.log(`[AgentConversation] handleSubmit: existing session ${session!.id}, status=${status}`);
      await sendMessage(content);
    }
    } finally {
      setIsSubmitting(false);
    }
  };

  const { settings: convSettings } = useConversationSettings();

  // No project selected
  if (!projectId) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <div className="mx-auto w-10 h-10 rounded-xl bg-muted flex items-center justify-center mb-3">
            <Bot className="h-5 w-5 text-muted-foreground/50" />
          </div>
          <p className="text-sm">Select a project to start coding</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="h-full flex flex-col min-h-0"
      style={{ "--conv-font-size": `${convSettings.agentFontSize}px` } as React.CSSProperties}
    >
      {/* Header */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 h-10 border-b border-border/60 bg-muted/20">
        <div className="flex items-center gap-2">
          {providers.length > 1 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  disabled={isLoading || (status === "running" && messages.length > 0)}
                  className={cn(
                    "inline-flex items-center gap-1 rounded-md border bg-muted/50 px-2 py-0.5 text-xs font-medium transition-colors hover:bg-muted",
                    (isLoading || (status === "running" && messages.length > 0)) && "opacity-50 cursor-not-allowed"
                  )}
                >
                  {/* The icon anchors the left edge and the reserved label slot
                      pins the chevron, so switching between a long name
                      ("Claude Code") and a short one ("Codex") no longer shifts
                      this chip or everything after it in the header row. */}
                  <AgentTypeIcon type={agentType} />
                  <ReservedWidthLabel candidates={providers.map((p) => p.displayName)}>
                    {currentAgentName}
                  </ReservedWidthLabel>
                  <ChevronDown className="h-3 w-3 text-muted-foreground" />
                </button>
              </DropdownMenuTrigger>
              {/* Anchored to the trigger's own width so the menu reads as the chip
                  expanding, not as a separate panel. min-w, not w: the items are
                  ~12px narrower than the trigger (no chevron, hidden radio dot),
                  so this lands on exactly the trigger width today while still
                  letting a future wider item grow instead of truncating. It also
                  overrides shadcn's default 8rem floor, which today is wider than
                  the chip. */}
              <DropdownMenuContent
                align="start"
                className="min-w-[var(--radix-dropdown-menu-trigger-width)]"
              >
                <DropdownMenuRadioGroup
                  value={agentType}
                  onValueChange={async (v) => {
                    const newType = v as AgentType;
                    if (!session) {
                      // No session yet — just pick the agent for the upcoming one.
                      // A model name belongs to one agent ("opus" means nothing
                      // to Codex), so a pending pick from the previous agent has
                      // to go with it, or the first message would spawn a
                      // session that fails every turn with a locked chip.
                      // Mirrors the backend's switchAgentType / branch-override
                      // clears.
                      if (newType !== agentType) setPendingModel(null);
                      setAgentType(newType);
                      return;
                    }
                    // Non-destructive switch: history is preserved; the next
                    // message wakes the session under the new agent with full
                    // context replay. The server rejects with 409 mid-run.
                    const errMsg = await switchAgentType(newType);
                    if (errMsg) {
                      toast.error("Failed to switch agent", { description: errMsg });
                    } else {
                      setAgentType(newType);
                    }
                  }}
                >
                  {providers.map((p) => (
                    <DropdownMenuRadioItem
                      key={p.type}
                      value={p.type}
                      disabled={!p.available}
                      className="text-xs pl-2 [&>span:first-child]:hidden data-[state=checked]:bg-accent data-[state=checked]:text-accent-foreground"
                    >
                      {/* Same accent as the collapsed chip — the colour is only a
                          useful cue if it is visible where the choice is made,
                          not just after the menu closes. */}
                      <AgentTypeIcon type={p.type} />
                      {p.displayName}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <>
              <AgentTypeIcon type={agentType} className="h-4 w-4" />
              <span className="text-sm font-medium">{currentAgentName}</span>
            </>
          )}
          <ModelPicker
            models={providers.find((p) => p.type === agentType)?.models ?? []}
            widthCandidates={providers.flatMap((p) => p.models ?? [])}
            value={session ? (session.model ?? null) : pendingModel}
            // Before a session exists the pick is held locally and spent on
            // creation; afterwards the session owns the model and the server
            // applies the change to its next process (a branch has none yet —
            // that is the case this exists for).
            onChange={session ? handleSessionModelChange : setPendingModel}
            // Same rule as the agent dropdown above, which is the other
            // respawn-shaped change in this row: only a turn in flight on a
            // session that already has history is too late to change.
            locked={session != null && status === "running" && messages.length > 0}
          />
          <PermissionModeToggle
            mode={permissionMode}
            onModeChange={handlePermissionModeChange}
          />
          {agentTargets.length >= 1 && onAgentModeChange && (
            <ExecutionModeToggle
              targets={agentTargets}
              activeTarget={project?.agent_mode ?? "local"}
              onTargetChange={onAgentModeChange}
            />
          )}
          {session && (() => {
            // For remote sessions, combine frontend WS status with remote WS status
            const isRemote = session.id.startsWith("remote-");
            let statusColor = "text-muted-foreground";
            let statusIcon = <WifiOff className="h-3 w-3" />;
            let statusText = "Disconnected";

            if (isCachePreview) {
              // A warm transcript is already visible while its sealed head is
              // revalidated. Keep this transient state in the header instead
              // of appending a loader to the conversation itself.
              statusColor = "text-muted-foreground";
              statusIcon = <Loader2 className="h-3 w-3 animate-spin" />;
              statusText = "Checking for newer output...";
            } else if (!isConnected) {
              // Distinguish initial handshake from a lost connection: until the
              // WS has opened at least once for this session, treat it as
              // "Connecting..." instead of "Disconnected" so we don't flash a
              // red status during the ~10–100ms WS open delay after every
              // session creation/switch.
              if (!hasConnectedOnce) {
                statusColor = "text-amber-500";
                statusIcon = <Wifi className="h-3 w-3 animate-pulse" />;
                statusText = "Connecting...";
              }
            } else if (!isRemote || remoteStatus === "connected" || remoteStatus === null) {
              // Local session connected, or remote session fully connected
              statusColor = "text-green-500";
              statusIcon = <Wifi className="h-3 w-3" />;
              statusText = "Connected";
            } else if (remoteStatus === "reconnecting") {
              // Remote link is reconnecting
              statusColor = "text-amber-500";
              statusIcon = <Wifi className="h-3 w-3 animate-pulse" />;
              statusText = "Reconnecting...";
            } else if (remoteStatus === "disconnected") {
              // Remote link gave up
              statusColor = "text-red-500";
              statusIcon = <WifiOff className="h-3 w-3" />;
              statusText = "Remote disconnected";
            }

            return (
              // Icon-only to leave header room for the model chip. statusText
              // moves to the tooltip rather than being dropped: Connecting and
              // Reconnecting share an icon, as do the two disconnected states,
              // so the text is the only thing that tells them apart.
              <span className={`flex items-center ${statusColor}`} title={statusText}>
                {statusIcon}
              </span>
            );
          })()}
        </div>
        <div className="flex items-center gap-1">
          {projectId && (
            <ReviewDialog
              projectId={projectId}
              branch={branch}
              sessionId={session?.id ?? null}
              currentAgentType={agentType}
              providers={providers}
            />
          )}
          {projectId && (
            <SessionHistoryDropdown
              projectId={projectId}
              branch={branch}
              currentSessionId={session?.id ?? null}
              refreshKey={titleRefreshKey}
              pendingTitleSessionId={pendingTitleSessionId}
              aiTitleOverride={aiTitleOverride}
              onSwitch={(id) => {
                onSessionSelected?.(id);
                setSessionUrlParam?.(id);
              }}
              onDelete={(id, remaining) => {
                if (id === session?.id) {
                  // Current was deleted — redirect to most-recent remaining, or clear URL
                  const next = remaining[0];  // remaining is already sorted updated_at DESC
                  setSessionUrlParam?.(next ? next.id : null);
                }
              }}
            />
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={handleNewConversation}
            disabled={isLoading || !session}
            className="h-7 w-7"
            title="New Conversation (⌘⇧O / Ctrl+Shift+O)"
          >
            <SquarePen className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => stopSession()}
            disabled={status !== "running"}
            className="h-7 text-xs"
          >
            <Square className="h-3 w-3 mr-1" />
            Stop
          </Button>
        </div>
      </div>

      {/* Messages area */}
      <div className="flex-1 min-h-0 relative">
        {/* Smooth resize-follow is only wanted while a turn is streaming into
            a stable view. All other pinned-state growth is a load artifact and
            is corrected pre-paint by ConversationAnchorHold; this prop switch
            is the fallback layer for anything the hold's observer misses (the
            library reads the resize option per event). */}
        <Conversation
          className="h-full"
          initial="instant"
          resize={turnInFlight ? "smooth" : "instant"}
        >
          <ConversationContent className="gap-1 p-4" scrollClassName="edge-scrollbar">
            {!session && messages.length === 0 ? (
              <div className="text-center py-16">
                {isLoading || (projectId && !isInitialized) ? (
                  <>
                    <Loader className="h-6 w-6 mx-auto mb-4" />
                    <h3 className="text-sm font-semibold mb-1 text-foreground">Connecting to agent...</h3>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Setting up the session for this worktree
                    </p>
                  </>
                ) : (
                  <>
                    <div className="mx-auto w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-4">
                      <Bot className="h-6 w-6 text-primary/60" />
                    </div>
                    <h3 className="text-sm font-semibold mb-1 text-foreground">Start a conversation</h3>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Ask the agent to help you with coding tasks in this worktree
                    </p>
                  </>
                )}
              </div>
            ) : (
              <AgentConversationContext.Provider value={{ sendMessage, messages, acceptPlan: handleAcceptPlan, permissionMode: session?.permissionMode ?? permissionMode, agentType: session?.agentType ?? agentType, sessionId: session?.id ?? null, projectId, branch, target: sessionTarget, targetLabel: sessionTargetLabel, openSchedule: onOpenSchedule }}>
                <div
                  className="space-y-1 outline-none"
                  ref={messagesRef}
                  tabIndex={-1}
                  onKeyDown={onMarkerKeyDown}
                >
                  {hasEarlierHistory && (
                    <div className="flex justify-center pb-3">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={isLoadingEarlier}
                        onClick={() => void loadEarlierHistory()}
                      >
                        {isLoadingEarlier ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ChevronDown className="h-3.5 w-3.5 rotate-180" />}
                        Load earlier turns
                      </Button>
                    </div>
                  )}
                  {messages.map((msg, index) =>
                    msg?.type === "turn_end" ? (
                      <TurnEndDivider
                        key={messageEntryIndices[index] ?? index}
                        durationMs={msg.durationMs}
                        outcome={msg.outcome}
                        emphasis={index === lastTurnEndIndex ? "normal" : "subtle"}
                        agentType={agentType}
                        currentAgentName={currentAgentName}
                        alternateProviders={alternateBranchProviders}
                        onBranch={(t) => handleBranch(t, messageEntryIndices[index] ?? index)}
                        disabled={isBranching}
                        showFinalize={index === lastTurnEndIndex && reviewerRun?.status === "discussing"}
                        finalizeBusy={isFinalizing}
                        onFinalize={handleFinalize}
                      />
                    ) : (
                      <div
                        key={messageEntryIndices[index] ?? index}
                        data-message-idx={index}
                        {...(msg.type === "user" ? { "data-user-msg-idx": index } : {})}
                        className="scroll-mt-2"
                      >
                        <AgentMessageItem
                          message={msg}
                          messageIndex={index}
                          streaming={
                            msg.type === "assistant" && turnInFlight && index === messages.length - 1
                          }
                        />
                      </div>
                    )
                  )}
                  {isLoading && !isCachePreview && (
                    <div className="flex items-center gap-2 py-4 text-muted-foreground">
                      <Loader className="h-4 w-4" />
                      <span className="text-sm">Connecting to agent...</span>
                    </div>
                  )}
                </div>
              </AgentConversationContext.Provider>
            )}

            {error && (
              <div className="flex items-center gap-2 p-3 bg-red-500/10 rounded-lg text-red-500 text-sm mt-4">
                <AlertCircle className="h-4 w-4" />
                {error}
              </div>
            )}
          </ConversationContent>
          <ConversationScrollButton />
          <ConversationAnchorHold
            messageCount={messages.length}
            turnInFlight={turnInFlight}
            sessionId={session?.id ?? null}
          />
        </Conversation>
        <UserInputMarkers messages={messages} contentRef={messagesRef} />
        <QuotePopover containerRef={messagesRef} onQuote={handleQuote} />
      </div>

      {/* Input area */}
      <div className="flex-shrink-0 p-3">
        <PromptInput
          onSubmit={handleSubmit}
          accept="image/*"
          className="w-full"
        >
          {/* Attachment thumbnails — only rendered when images are attached */}
          <AttachmentHeader />
          <div className="relative flex w-full flex-col">
            {/* Translate badge row — only when enabled */}
            {translateEnabled && (
              <div className="flex items-center pl-12 pr-2 pt-1.5 pb-0.5">
                <button
                  type="button"
                  onClick={() => setTranslateEnabled(false)}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-blue-500/10 text-blue-600 dark:text-blue-400 px-2.5 py-0.5 text-xs font-medium hover:bg-blue-500/20 transition-colors"
                >
                  {isTranslating ? <Loader2 className="size-3 animate-spin" /> : <Languages className="size-3" />}
                  Translate
                  <X className="size-3" />
                </button>
              </div>
            )}
            {/* Input row: [+ button] [textarea] [submit button] */}
            <div className="flex w-full items-center">
              <PromptInputActionMenu>
                <PromptInputActionMenuTrigger className="ml-1" />

                <PromptInputActionMenuContent>
                  <PromptInputActionAddAttachments label="Add images" />
                  <PromptInputActionMenuItem
                    onSelect={() => {
                      setTranslateEnabled(!translateEnabled);
                    }}
                  >
                    <Languages className="mr-2 size-4" />
                    {translateEnabled ? "Disable translation" : "Translate"}
                  </PromptInputActionMenuItem>
                </PromptInputActionMenuContent>
              </PromptInputActionMenu>
              <div ref={textareaWrapperRef} className="contents">
                <PromptInputTextarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onPasteText={handlePasteText}
                  onKeyDown={inputHistory.handleKeyDown}
                  placeholder={
                    session
                      ? "Ask the agent to help with your code..."
                      : "Type your first message to start..."
                  }
                  className="pr-12"
                  style={{ fontSize: "var(--conv-font-size, 14px)" }}
                />
              </div>
              {/* Wrapper height = one textarea line (1lh must match the
                  textarea's font classes; 1.5rem = its py-3): centered on a
                  single line, hugs the last line when multiline */}
              <div
                className="pointer-events-none absolute bottom-0 right-2 flex items-center text-base md:text-sm"
                style={{
                  fontSize: "var(--conv-font-size, 14px)",
                  height: "calc(1lh + 1.5rem)",
                }}
              >
                <PromptInputSubmit
                  className="pointer-events-auto"
                  disabled={(!input.trim() && !isLoading) || isTranslating || isSubmitting}
                  status={isSubmitting || isTranslating ? "submitted" : isLoading ? "streaming" : "ready"}
                />
              </div>
            </div>
          </div>
        </PromptInput>
      </div>

      {/* Resident-limit eviction confirm — answers the suspended ensureSession
          in use-agent-session. Any dismissal (Cancel, Escape, overlay click)
          must resolve(false), otherwise the send stays stuck loading. */}
      <AlertDialog
        open={residentLimitPrompt !== null}
        onOpenChange={(open) => {
          if (!open) residentLimitPrompt?.resolve(false);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Agent process limit reached</AlertDialogTitle>
            <AlertDialogDescription>
              All {residentLimitPrompt?.maxResidentAgentProcesses} resident
              agent processes for this workspace branch are running. Starting a
              new conversation will stop the least recently active running
              session in this branch.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => residentLimitPrompt?.resolve(true)}>
              Stop &amp; start new
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
});
