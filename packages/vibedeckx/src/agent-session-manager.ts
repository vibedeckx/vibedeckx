import { spawn, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import type { WebSocket } from "@fastify/websocket";
import type { Storage } from "./storage/types.js";
import type {
  AgentMessage,
  AgentSessionStatus,
  AgentType,
  ContentPart,
} from "./agent-types.js";
import { getProvider } from "./providers/index.js";
import type { ParsedAgentEvent } from "./agent-provider.js";
import { ConversationPatch, type Patch, type AgentWsMessage } from "./conversation-patch.js";
import type { EventBus } from "./event-bus.js";
import { EntryIndexProvider, EntryTracker } from "./entry-index-provider.js";
import { resolveWorktreePath } from "./utils/worktree-paths.js";
import { generateSessionTitle, snippetTitle, extractUserText } from "./utils/session-title.js";

// ============ Session Store Types ============

interface MessageStore {
  /** All patches sent for this session (for history replay) */
  patches: Patch[];
  /** Reconstructed entries from patches (for quick access) */
  entries: AgentMessage[];
  /** Index provider for monotonic indices */
  indexProvider: EntryIndexProvider;
  /** Tracks tool_use/tool_result blocks by ID to prevent duplicates from streaming replays */
  toolTracker: EntryTracker;
  /** Index of the current streaming assistant message, or null if not streaming */
  currentAssistantIndex: number | null;
}

interface RunningSession {
  id: string;
  projectId: string;
  branch: string | null;
  process: ChildProcess | null;
  dormant: boolean; // true when restored from DB (no process yet)
  store: MessageStore;
  subscribers: Set<WebSocket>;
  status: AgentSessionStatus;
  buffer: string; // Buffer for incomplete JSON lines
  skipDb: boolean; // Skip DB operations for remote path-based sessions
  permissionMode: "plan" | "edit"; // Claude Code permission mode
  agentType: AgentType; // Which agent provider to use
}

export class AgentSessionManager {
  private sessions: Map<string, RunningSession> = new Map();
  private storage: Storage;
  private eventBus: EventBus | null = null;
  /** Sessions for which title generation is currently in flight or already done. */
  private titleResolved: Set<string> = new Set();

  constructor(storage: Storage) {
    this.storage = storage;
  }

  setEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
  }

  /**
   * Idempotency guard for one-shot title generation per session. Returns
   * true if the caller is the first to claim the slot (and should proceed
   * with generation), false if another path has already taken it.
   */
  markTitleResolved(sessionId: string): boolean {
    if (this.titleResolved.has(sessionId)) return false;
    this.titleResolved.add(sessionId);
    return true;
  }

  /**
   * Get or create an agent session for a branch.
   *
   * Resolution order for "which session matches (projectId, branch)":
   * 1. DB-first: query `getLatestByBranch` (ORDER BY updated_at DESC LIMIT 1)
   *    so we always return the most-recently-updated session, not whichever
   *    one happened to be inserted first into the in-memory Map. This is
   *    the authoritative answer.
   * 2. skipDb fallback (remote path-based pseudo-projects): no DB to query,
   *    so fall back to a scan of `this.sessions`. Remote-only sessions
   *    rarely have multiple entries per branch, so first-match is fine.
   * 3. No match anywhere → create a brand new session.
   */
  getOrCreateSession(
    projectId: string,
    branch: string | null,
    projectPath: string,
    skipDb = false,
    permissionMode: "plan" | "edit" = "edit",
    agentType: AgentType = "claude-code"
  ): string {
    console.log(`[getOrCreate] ENTER projectId=${projectId} branch=${branch ?? "<null>"} skipDb=${skipDb} sessionsMapSize=${this.sessions.size}`);
    // 1. DB-first resolution (preferred path)
    if (!skipDb) {
      const latestDbRow = this.storage.agentSessions.getLatestByBranch(
        projectId,
        branch ?? ""
      );
      console.log(`[getOrCreate] DB latestByBranch(${projectId}, ${branch ?? ""}) → ${latestDbRow ? `id=${latestDbRow.id} status=${latestDbRow.status} updatedAt=${latestDbRow.updated_at}` : "NONE"}`);
      if (latestDbRow) {
        const inMemory = this.sessions.get(latestDbRow.id);
        console.log(`[getOrCreate] inMemory lookup for ${latestDbRow.id} → ${inMemory ? `FOUND (dormant=${inMemory.dormant}, status=${inMemory.status}, entries=${inMemory.store.entries.filter(Boolean).length}, processAlive=${inMemory.process != null && inMemory.process.exitCode === null})` : "NOT FOUND — will fall through to create NEW"}`);
        if (inMemory) {
          return this.reuseExistingSession(inMemory, projectPath, permissionMode);
        }
        // DB row exists but session isn't in memory. The restore path (called
        // on startup) should have populated it; if we're here, either restore
        // was skipped or the session has no entries yet. Fall through to
        // create — same behavior as before.
      }
    } else {
      // 2. skipDb fallback: in-memory scan for remote path-based sessions.
      // These are pseudo-projects with no DB rows, so there's nothing more
      // authoritative to consult. First-match is acceptable because remote
      // pseudo-projects don't accumulate many sessions per branch.
      for (const session of this.sessions.values()) {
        if (session.projectId === projectId && session.branch === branch) {
          console.log(`[getOrCreate] skipDb in-memory match: ${session.id} (entries=${session.store.entries.filter(Boolean).length})`);
          return this.reuseExistingSession(session, projectPath, permissionMode);
        }
      }
      console.log(`[getOrCreate] skipDb: no in-memory match, will create NEW`);
    }

    // Create new session
    const sessionId = randomUUID();
    console.log(`[AgentSession] Creating new session ${sessionId}`);

    // Calculate absolute worktree path
    const absoluteWorktreePath = resolveWorktreePath(projectPath, branch);

    console.log(`[AgentSession] projectPath=${projectPath}, branch=${branch}, absoluteWorktreePath=${absoluteWorktreePath}`);

    // Create session in database (skip for remote path-based sessions)
    if (!skipDb) {
      this.storage.agentSessions.create({
        id: sessionId,
        project_id: projectId,
        branch: branch ?? "",
        permission_mode: permissionMode,
        // agent_type passed to storage after Phase 4 migration (task 4.2/4.3)
      });
    }

    // Initialize message store with EntryIndexProvider
    const indexProvider = new EntryIndexProvider();

    const store: MessageStore = {
      patches: [],
      entries: [],
      indexProvider,
      toolTracker: new EntryTracker(indexProvider),
      currentAssistantIndex: null,
    };

    // Initialize running session
    const runningSession: RunningSession = {
      id: sessionId,
      projectId,
      branch,
      process: null,
      dormant: false,
      store,
      subscribers: new Set(),
      status: "running",
      buffer: "",
      skipDb,
      permissionMode,
      agentType,
    };

    this.sessions.set(sessionId, runningSession);

    // Notify provider of session creation (for per-session state init)
    getProvider(agentType).onSessionCreated?.(sessionId);

    // Spawn Claude Code process
    this.spawnAgent(runningSession, absoluteWorktreePath);

    return sessionId;
  }

  /**
   * Always create a brand-new session row and spawn a process.
   * Unlike getOrCreateSession, this never reuses an existing row for the branch.
   * Used by "New Conversation" flow where the user explicitly wants a fresh conversation.
   */
  createNewSession(
    projectId: string,
    branch: string | null,
    projectPath: string,
    skipDb: boolean = false,
    permissionMode: "plan" | "edit" = "edit",
    agentType: AgentType = "claude-code",
  ): string {
    // Defense-in-depth: if there's an existing non-dormant session on the same
    // project+branch, its child process may still be alive (stream-json agents
    // keep the CLI waiting on stdin between turns while reporting status
    // "stopped"). Spawning a new process without stopping it would leak the
    // old one. The frontend is supposed to stop first, but can't reliably tell
    // from status alone — so we enforce it here.
    const existing = this.getSessionByBranch(projectId, branch);
    if (existing && !existing.dormant) {
      console.log(`[AgentSession] createNewSession: stopping prior session ${existing.id} on same branch to prevent process leak`);
      this.stopSession(existing.id);
    }

    const sessionId = randomUUID();
    const branchKey = branch ?? "";

    // Calculate absolute worktree path
    const absoluteWorktreePath = resolveWorktreePath(projectPath, branch);

    if (!skipDb) {
      this.storage.agentSessions.create({
        id: sessionId,
        project_id: projectId,
        branch: branchKey,
        permission_mode: permissionMode,
        // agent_type passed to storage after Phase 4 migration (task 4.2/4.3)
      });
    }

    // Initialize message store with EntryIndexProvider
    const indexProvider = new EntryIndexProvider();

    const store: MessageStore = {
      patches: [],
      entries: [],
      indexProvider,
      toolTracker: new EntryTracker(indexProvider),
      currentAssistantIndex: null,
    };

    // Initialize running session
    const session: RunningSession = {
      id: sessionId,
      projectId,
      branch,
      process: null,
      dormant: false,
      store,
      subscribers: new Set(),
      status: "running",
      buffer: "",
      skipDb,
      permissionMode,
      agentType,
    };

    this.sessions.set(sessionId, session);

    // Notify provider of session creation (for per-session state init)
    const provider = getProvider(agentType);
    provider.onSessionCreated?.(sessionId);

    // Spawn agent process
    this.spawnAgent(session, absoluteWorktreePath);
    console.log(`[AgentSession] createNewSession: id=${sessionId}, projectId=${projectId}, branch=${branchKey}`);

    // The new session has fresh updated_at and no timestamps, so the branch
    // resets to idle (see computeBranchActivity). Emit so SSE consumers don't
    // sit on a stale "completed" until the next user message arrives.
    this.eventBus?.emit({
      type: "branch:activity",
      projectId,
      branch,
      activity: "idle",
      since: Date.now(),
    });

    return sessionId;
  }

  /**
   * Handle reuse of an existing in-memory session found by getOrCreateSession:
   * - dormant: update permission mode if differs (no respawn — wakes lazily)
   * - running OR process alive (stream-json between-turns: status="stopped"
   *   but the CLI is still waiting on stdin): switchMode if mode differs,
   *   leave entries intact
   * - process actually dead: restart the process so callers always get a
   *   running session
   * Returns the session id.
   */
  private reuseExistingSession(
    session: RunningSession,
    projectPath: string,
    permissionMode: "plan" | "edit"
  ): string {
    const entriesCount = session.store.entries.filter(Boolean).length;
    if (session.dormant) {
      if (session.permissionMode !== permissionMode) {
        session.permissionMode = permissionMode;
        if (!session.skipDb) {
          this.storage.agentSessions.updatePermissionMode(session.id, permissionMode);
        }
      }
      console.log(`[AgentSession] Returning dormant session ${session.id} (entries=${entriesCount})`);
      return session.id;
    }

    // stream-json CLIs (Claude Code) keep the process alive between turns and
    // flip status="stopped" via the result-event handler. Treat that state as
    // "still reusable" — restarting would clear entries and wipe the
    // conversation. sendUserMessage flips status back to "running" and writes
    // to stdin on the next turn.
    const processAlive = session.process != null && session.process.exitCode === null;
    if (session.status === "running" || processAlive) {
      if (session.permissionMode !== permissionMode) {
        console.log(`[AgentSession] Session ${session.id} exists with mode ${session.permissionMode}, switching to ${permissionMode}`);
        this.switchMode(session.id, projectPath, permissionMode);
      }
      console.log(`[AgentSession] Returning existing session ${session.id} (status=${session.status}, processAlive=${processAlive}, entries=${entriesCount})`);
      return session.id;
    }

    // Dead session (process exited, not dormant) — restart so callers always get a running session
    console.log(`[AgentSession] Session ${session.id} is ${session.status} (entries=${entriesCount} — WILL BE CLEARED), restarting`);
    this.restartSession(session.id, projectPath);
    return session.id;
  }

  /**
   * Kill an agent process and its entire process tree.
   * Uses negative PID to signal the process group (requires detached: true at spawn).
   */
  private killProcess(proc: ChildProcess | null, signal: NodeJS.Signals = "SIGTERM"): void {
    if (!proc?.pid) return;
    try {
      process.kill(-proc.pid, signal);
    } catch {
      // Process group kill failed (e.g. already dead) — try direct kill as fallback
      try { proc.kill(signal); } catch { /* already dead */ }
    }
  }

  /**
   * Spawn agent process using the provider for this session's agent type
   */
  private spawnAgent(session: RunningSession, cwd: string): void {
    const provider = getProvider(session.agentType);
    console.log(`[AgentSession] Spawning ${provider.getDisplayName()} in ${cwd}`);

    // Verify cwd exists
    if (!existsSync(cwd)) {
      console.error(`[AgentSession] ERROR: cwd does not exist: ${cwd}`);
      session.status = "error";
      if (!session.skipDb) this.storage.agentSessions.updateStatus(session.id, "error");
      this.pushEntry(session.id, {
        type: "error",
        message: `Error: Working directory does not exist: ${cwd}`,
        timestamp: Date.now(),
      });
      this.broadcastPatch(session.id, ConversationPatch.updateStatus("error"));
      this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId: session.id, status: "error" });
      this.broadcastRaw(session.id, { finished: true });
      return;
    }

    const config = provider.buildSpawnConfig(cwd, session.permissionMode);

    const childProcess = spawn(config.command, config.args, {
      cwd,
      env: { ...process.env, FORCE_COLOR: "1", ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: config.shell ?? false,
      detached: true, // Own process group so we can kill the entire tree
    });

    session.process = childProcess;

    console.log(`[AgentSession] Process ${session.id} started, PID: ${childProcess.pid}`);

    // Pre-initialize provider protocol (e.g. Codex needs initialize + thread/start handshake)
    if (provider.getInitializationMessages) {
      const initMsgs = provider.getInitializationMessages(session.id);
      if (initMsgs) {
        childProcess.stdin?.write(initMsgs);
      }
    }

    // Handle stdout (JSON messages from Claude)
    childProcess.stdout?.on("data", (data: Buffer) => {
      this.handleStdout(session, data.toString());
    });

    // Handle stderr (errors and debug info)
    childProcess.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      console.log(`[AgentSession] stderr: ${text}`);
      // Don't treat all stderr as errors - Claude Code uses it for progress
    });

    // Handle process exit
    childProcess.on("close", (code) => {
      console.log(`[AgentSession] Process ${session.id} exited with code ${code}`);

      // Don't update status or send finished signal if this is an old process
      // (happens when we restart - old process closes but new one is already running)
      if (session.process !== childProcess) {
        console.log(`[AgentSession] Old process closed, new process already running, skipping finished signal`);
        return;
      }

      session.status = code === 0 ? "stopped" : "error";
      if (!session.skipDb) this.storage.agentSessions.updateStatus(session.id, session.status);

      // Send status patch and finished signal
      this.broadcastPatch(session.id, ConversationPatch.updateStatus(session.status));
      this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId: session.id, status: session.status });
      this.broadcastRaw(session.id, { finished: true });
    });

    // Handle spawn errors
    childProcess.on("error", (error) => {
      console.error(`[AgentSession] Process ${session.id} error:`, error);
      session.status = "error";
      if (!session.skipDb) this.storage.agentSessions.updateStatus(session.id, "error");
      this.pushEntry(session.id, {
        type: "error",
        message: error.message,
        timestamp: Date.now(),
      }, true);
    });
  }

  /**
   * Handle stdout data from agent process
   */
  private handleStdout(session: RunningSession, data: string): void {
    // Ignore output from a process that has been stopped — the process may
    // still flush data to stdout while shutting down after SIGTERM.
    if (session.dormant) return;

    // Add to buffer
    session.buffer += data;

    // Process complete lines
    const lines = session.buffer.split("\n");
    session.buffer = lines.pop() || ""; // Keep incomplete line in buffer

    const provider = getProvider(session.agentType);

    for (const line of lines) {
      if (!line.trim()) continue;

      const events = provider.parseStdoutLine(line, session.id);
      for (const event of events) {
        this.processAgentEvent(session.id, event);
      }
    }
  }

  /**
   * Process a single parsed agent event (provider-agnostic).
   * Routes each ParsedAgentEvent to the appropriate message store / broadcast action.
   * Includes input_tokens/output_tokens in taskCompleted broadcast for token reporting.
   */
  private processAgentEvent(sessionId: string, event: ParsedAgentEvent): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const timestamp = Date.now();

    switch (event.type) {
      case "text":
        this.updateAssistantMessage(sessionId, event.content, timestamp);
        break;

      case "tool_use": {
        this.finalizeStreamingEntry(session);
        session.store.currentAssistantIndex = null;
        const tuKey = `tool_use:${event.toolUseId}`;
        const { index: tuIndex, isNew: tuIsNew } = session.store.toolTracker.getOrCreate(tuKey);
        const tuMessage: AgentMessage = {
          type: "tool_use",
          tool: event.tool,
          input: event.input,
          toolUseId: event.toolUseId,
          timestamp,
        };
        if (tuIsNew) {
          session.store.entries[tuIndex] = tuMessage;
          const patch = ConversationPatch.addEntry(tuIndex, tuMessage);
          session.store.patches.push(patch);
          this.broadcastPatch(sessionId, patch);
        } else {
          session.store.entries[tuIndex] = tuMessage;
          const patch = ConversationPatch.replaceEntry(tuIndex, tuMessage);
          session.store.patches.push(patch);
          this.broadcastPatch(sessionId, patch);
        }
        if (!session.skipDb) {
          this.persistEntry(session, tuIndex, tuMessage);
        }
        break;
      }

      case "tool_result": {
        this.finalizeStreamingEntry(session);
        session.store.currentAssistantIndex = null;
        const trKey = `tool_result:${event.toolUseId}`;
        const { index: trIndex, isNew: trIsNew } = session.store.toolTracker.getOrCreate(trKey);
        const trMessage: AgentMessage = {
          type: "tool_result",
          tool: event.tool,
          output: event.output,
          toolUseId: event.toolUseId,
          timestamp,
        };
        if (trIsNew) {
          session.store.entries[trIndex] = trMessage;
          const patch = ConversationPatch.addEntry(trIndex, trMessage);
          session.store.patches.push(patch);
          this.broadcastPatch(sessionId, patch);
        } else {
          session.store.entries[trIndex] = trMessage;
          const patch = ConversationPatch.replaceEntry(trIndex, trMessage);
          session.store.patches.push(patch);
          this.broadcastPatch(sessionId, patch);
        }
        if (!session.skipDb) {
          this.persistEntry(session, trIndex, trMessage);
        }
        break;
      }

      case "thinking":
        this.finalizeStreamingEntry(session);
        session.store.currentAssistantIndex = null;
        this.pushEntry(sessionId, {
          type: "thinking",
          content: event.content,
          timestamp,
        }, true);
        break;

      case "system":
        this.finalizeStreamingEntry(session);
        session.store.currentAssistantIndex = null;
        this.pushEntry(sessionId, {
          type: "system",
          content: event.content,
          timestamp,
        }, true);
        break;

      case "error":
        this.finalizeStreamingEntry(session);
        session.store.currentAssistantIndex = null;
        this.pushEntry(sessionId, {
          type: "error",
          message: event.message,
          timestamp,
        }, true);
        break;

      case "result":
        console.log(`[Agent:result] sessionId=${sessionId} subtype=${event.subtype} prevStatus=${session.status}`);
        this.finalizeStreamingEntry(session);
        session.store.currentAssistantIndex = null;

        if (event.subtype === "error" && event.error) {
          this.pushEntry(sessionId, {
            type: "error",
            message: event.error,
            timestamp,
          }, true);
        }

        if (event.subtype === "success") {
          console.log(`[AgentSession] taskCompleted: sessionId=${sessionId}, eventBus=${!!this.eventBus}, projectId=${session.projectId}, branch=${session.branch}`);
          const completedAt = Date.now();
          if (!session.skipDb) {
            this.storage.agentSessions.markCompleted(sessionId, completedAt);
          }
          this.broadcastRaw(sessionId, {
            taskCompleted: {
              duration_ms: event.duration_ms,
              cost_usd: event.cost_usd,
              input_tokens: event.input_tokens,
              output_tokens: event.output_tokens,
            },
          });
          this.eventBus?.emit({
            type: "session:taskCompleted",
            projectId: session.projectId,
            branch: session.branch,
            sessionId,
            duration_ms: event.duration_ms,
            cost_usd: event.cost_usd,
            input_tokens: event.input_tokens,
            output_tokens: event.output_tokens,
          });
          this.eventBus?.emit({
            type: "branch:activity",
            projectId: session.projectId,
            branch: session.branch,
            activity: "completed",
            since: completedAt,
          });

          // Turn finished — process stays alive (stream-json) waiting for next
          // input, but status now reflects "between turns" so UI affordances
          // like "New Conversation" don't prompt for a running confirmation.
          if (session.status !== "stopped") {
            session.status = "stopped";
            if (!session.skipDb) this.storage.agentSessions.updateStatus(sessionId, "stopped");
            this.broadcastPatch(sessionId, ConversationPatch.updateStatus("stopped"));
            this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId, status: "stopped" });
          }

          // Auto-update task status to "done" for the branch's assigned task
          const tasks = this.storage.tasks.getByProjectId(session.projectId);
          const branchKey = session.branch ?? "";
          const assignedTask = tasks.find(t => t.assigned_branch === branchKey);
          if (assignedTask && assignedTask.status !== "done") {
            this.storage.tasks.update(assignedTask.id, { status: "done" });
            this.eventBus?.emit({
              type: "task:updated",
              projectId: session.projectId,
              task: { ...assignedTask, status: "done" } as Record<string, unknown>,
            });
          }
        }
        break;

      case "approval_request":
        this.finalizeStreamingEntry(session);
        session.store.currentAssistantIndex = null;
        if (event.requestType === "command") {
          this.pushEntry(sessionId, {
            type: "approval_request",
            requestType: "command",
            requestId: event.requestId,
            command: event.command,
            cwd: event.cwd,
            timestamp,
          }, true);
        } else {
          this.pushEntry(sessionId, {
            type: "approval_request",
            requestType: "fileChange",
            requestId: event.requestId,
            changes: event.changes,
            timestamp,
          }, true);
        }
        break;

      case "stdin_write":
        // Provider needs to send deferred data to the agent's stdin
        session.process?.stdin?.write(event.content);
        break;
    }
  }

  /**
   * Update or add an assistant message using JSON Patch semantics
   * This is the key method that handles streaming updates correctly
   */
  private updateAssistantMessage(sessionId: string, content: string, timestamp: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const { store } = session;

    // Check if we have an ongoing assistant message (streaming update)
    if (store.currentAssistantIndex !== null) {
      const existingIndex = store.currentAssistantIndex;
      const message: AgentMessage = {
        type: "assistant",
        content,
        timestamp,
      };
      // Update the entry in our store
      store.entries[existingIndex] = message;
      // Create and broadcast REPLACE patch
      const patch = ConversationPatch.replaceEntry(existingIndex, message);
      store.patches.push(patch);
      this.broadcastPatch(sessionId, patch);
      return;
    }

    // Start new assistant message (ADD)
    const message: AgentMessage = {
      type: "assistant",
      content,
      timestamp,
    };
    const index = this.pushEntry(sessionId, message, true);
    // Remember this index for streaming updates
    store.currentAssistantIndex = index;
  }

  /**
   * Push a new entry with ADD patch
   */
  private pushEntry(
    sessionId: string,
    message: AgentMessage,
    broadcast: boolean = true,
    userId: string = "local",
  ): number {
    const session = this.sessions.get(sessionId);
    if (!session) return -1;

    const { store } = session;

    // Get next index from provider
    const index = store.indexProvider.next();

    // Store the entry
    store.entries[index] = message;

    // Create ADD patch
    const patch = ConversationPatch.addEntry(index, message);
    store.patches.push(patch);

    // Persist to DB (skip streaming assistant text — those get finalized later)
    if (!session.skipDb && message.type !== "assistant") {
      this.persistEntry(session, index, message, userId);
    }

    if (broadcast) {
      this.broadcastPatch(sessionId, patch);
    }

    return index;
  }

  /**
   * Persist a single entry to the database
   */
  private persistEntry(
    session: RunningSession,
    index: number,
    message: AgentMessage,
    userId: string = "local",
  ): void {
    if (session.skipDb) return;
    try {
      this.storage.agentSessions.upsertEntry(session.id, index, JSON.stringify(message));
      this.storage.agentSessions.touchUpdatedAt(session.id);
      if (message.type === "user") {
        const now = Date.now();
        this.storage.agentSessions.markUserMessage(session.id, now);
        this.eventBus?.emit({
          type: "branch:activity",
          projectId: session.projectId,
          branch: session.branch,
          activity: "working",
          since: now,
        });
        const dbRow = this.storage.agentSessions.getById(session.id);
        if (dbRow && (dbRow.title === null || dbRow.title === undefined)) {
          const text = extractUserText(message.content);
          if (text.trim().length > 0 && this.markTitleResolved(session.id)) {
            void this.ensureSessionTitle(session, text, userId);
          }
        }
      }
    } catch (error) {
      console.error(`[AgentSession] Failed to persist entry ${index}:`, error);
    }
  }

  /**
   * Finalize and persist the current streaming assistant message
   */
  private finalizeStreamingEntry(session: RunningSession): void {
    const index = session.store.currentAssistantIndex;
    if (index === null || session.skipDb) return;

    const entry = session.store.entries[index];
    if (entry) {
      this.persistEntry(session, index, entry);
    }
  }

  /**
   * Send a user message to the agent
   */
  sendUserMessage(
    sessionId: string,
    content: string | ContentPart[],
    projectPath?: string,
    userId: string = "local",
  ): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // If session is dormant, wake it up
    if (session.dormant) {
      if (!projectPath) {
        console.error(`[AgentSession] Cannot wake dormant session ${sessionId} without projectPath`);
        return false;
      }
      this.wakeDormantSession(session, projectPath, content, userId);
      return true;
    }

    if (!session.process?.stdin) {
      return false;
    }

    // Start-of-turn: if the previous turn ended (status="stopped" but process
    // still alive in stream-json mode), flip back to "running" and broadcast
    // so subscribers see the transition.
    if (session.status !== "running") {
      session.status = "running";
      if (!session.skipDb) this.storage.agentSessions.updateStatus(sessionId, "running");
      this.broadcastPatch(sessionId, ConversationPatch.updateStatus("running"));
      this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId, status: "running" });
    }

    // Clear current assistant key - user message breaks streaming
    this.finalizeStreamingEntry(session);
    session.store.currentAssistantIndex = null;

    // Add user message with ADD patch
    this.pushEntry(sessionId, {
      type: "user",
      content,
      timestamp: Date.now(),
    }, true, userId);

    // Send to agent stdin via provider
    try {
      const provider = getProvider(session.agentType);
      const formatted = provider.formatUserInput(content, session.id);
      session.process.stdin.write(formatted);
      return true;
    } catch (error) {
      console.error(`[AgentSession] Failed to send message:`, error);
      return false;
    }
  }

  /**
   * Send an approval response to the agent process (for agents with approval flow).
   * Returns false if session not found, not running, or provider doesn't support approvals.
   */
  sendApprovalResponse(sessionId: string, requestId: string, decision: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    if (session.status !== "running" || !session.process?.stdin) {
      return false;
    }

    try {
      const provider = getProvider(session.agentType);
      const formatted = provider.formatApprovalResponse?.(requestId, decision, session.id);
      if (!formatted) return false;
      session.process.stdin.write(formatted);
      return true;
    } catch (error) {
      console.error(`[AgentSession] Failed to send approval response:`, error);
      return false;
    }
  }

  /**
   * Subscribe to session updates (WebSocket connection)
   */
  subscribe(sessionId: string, ws: WebSocket): (() => void) | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    session.subscribers.add(ws);

    // Send all historical patches to replay state
    for (const patch of session.store.patches) {
      const msg: AgentWsMessage = { JsonPatch: patch };
      ws.send(JSON.stringify(msg));
    }

    // Send Ready signal to indicate history is complete
    ws.send(JSON.stringify({ Ready: true }));

    // Send current status
    const statusPatch = ConversationPatch.updateStatus(session.status);
    ws.send(JSON.stringify({ JsonPatch: statusPatch }));

    // Return unsubscribe function
    return () => {
      session.subscribers.delete(ws);
    };
  }

  /**
   * Get all messages for a session (reconstructed from patches)
   */
  getMessages(sessionId: string): AgentMessage[] {
    const session = this.sessions.get(sessionId);
    return session?.store.entries.filter(Boolean) ?? [];
  }

  /**
   * Get session info
   */
  getSession(sessionId: string): RunningSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /**
   * Get session by branch
   */
  getSessionByBranch(projectId: string, branch: string | null): RunningSession | null {
    for (const session of this.sessions.values()) {
      if (session.projectId === projectId && session.branch === branch) {
        return session;
      }
    }
    return null;
  }

  /**
   * Get all sessions for a project regardless of branch
   */
  getSessionsByProject(projectId: string): RunningSession[] {
    const results: RunningSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.projectId === projectId) {
        results.push(session);
      }
    }
    return results;
  }

  /**
   * Check if a session is running
   */
  isRunning(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session?.status === "running";
  }

  /**
   * Stop a session — kills the process but preserves conversation history
   * (like pressing ESC in Claude Code). The session becomes dormant so the
   * next user message will spawn a fresh process with full context replay.
   * The WebSocket stays alive so the UI remains connected.
   */
  stopSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    try {
      const proc = session.process;

      // Try provider-specific interrupt first (e.g. $/cancelRequest for Codex)
      const provider = getProvider(session.agentType);
      const interruptMsg = provider.formatInterrupt?.(sessionId);
      if (interruptMsg && proc?.stdin) {
        proc.stdin.write(interruptMsg);
      }

      // Clear session.process before killing so the process close handler
      // (which checks session.process !== childProcess) skips its cleanup —
      // we handle status + broadcast here instead.
      session.process = null;
      this.killProcess(proc);

      // Finalize any in-flight streaming assistant text
      this.finalizeStreamingEntry(session);
      session.store.currentAssistantIndex = null;

      // Add a system message so the UI shows the stop event in the conversation
      this.pushEntry(sessionId, {
        type: "system",
        content: "Session stopped by user.",
        timestamp: Date.now(),
      });

      // Mark as dormant so the next message triggers wakeDormantSession
      // (which spawns a new process and replays the full conversation context).
      session.dormant = true;
      session.status = "stopped";
      if (!session.skipDb) this.storage.agentSessions.updateStatus(sessionId, "stopped");
      this.broadcastPatch(sessionId, ConversationPatch.updateStatus("stopped"));
      this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId: session.id, status: "stopped" });
      // Only surface "stopped" (amber) when the user's last message hadn't yet
      // reached completion — that's the genuine "interrupted, unfinished work"
      // case. If the prior turn already completed naturally (e.g. New
      // Conversation stops a dormant session between turns), emitting "stopped"
      // would briefly flash amber over a workspace that should stay green
      // until the new session's idle overlay takes over.
      const dbRow = !session.skipDb ? this.storage.agentSessions.getById(sessionId) : undefined;
      const lastUser = dbRow?.last_user_message_at ?? 0;
      const lastCompleted = dbRow?.last_completed_at ?? 0;
      if (lastUser > lastCompleted) {
        const stoppedAt = Date.now();
        this.eventBus?.emit({
          type: "branch:activity",
          projectId: session.projectId,
          branch: session.branch,
          activity: "stopped",
          since: stoppedAt,
        });
        // Mirror over the per-session WS so the local-side bridge for remote
        // sessions can re-emit on the local EventBus (parallel to how
        // taskCompleted bridges into branch:activity:completed). Local-direct
        // subscribers ignore unknown message types, so this is a no-op there.
        this.broadcastRaw(sessionId, {
          branchActivity: { activity: "stopped", since: stoppedAt },
        });
      }
      // Don't send { finished: true } — keep the WebSocket connection alive
      // so the UI stays "Connected" and the user can continue the conversation.
      return true;
    } catch (error) {
      console.error(`[AgentSession] Failed to stop session:`, error);
      return false;
    }
  }

  /**
   * Delete a session (stop and remove)
   *
   * Steps (in spec order):
   * 1. stopSession — kills the process and transitions to dormant (no-op if already stopped)
   * 2. deleteEntries — clear entry rows from DB (skipped for remote sessions)
   * 3. delete — delete the session row from DB (skipped for remote sessions)
   * 4. broadcastRaw({finished: true}) — signal subscribers to disconnect cleanly
   *    (must happen before sessions.delete because broadcastRaw looks up the
   *    session by id to reach its subscriber set).
   * 5. sessions.delete — remove from in-memory map
   */
  deleteSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    getProvider(session.agentType).onSessionDestroyed?.(sessionId);

    // 1. Stop the process (safe if already stopped/dormant)
    this.stopSession(sessionId);

    // 2-3. Clear DB rows (skip for remote path-based sessions)
    if (!session.skipDb) {
      this.storage.agentSessions.deleteEntries(sessionId);
      this.storage.agentSessions.delete(sessionId);
    }

    // 4. Signal terminal state so subscribers stop reconnecting — must run
    //    before sessions.delete() since broadcastRaw reads this.sessions.
    this.broadcastRaw(sessionId, { finished: true });

    // 5. Remove from in-memory map
    this.sessions.delete(sessionId);
    return true;
  }

  /**
   * Restart a session (stop process, clear history, respawn)
   * Returns the same session ID with a fresh conversation
   */
  restartSession(sessionId: string, projectPath: string, agentType?: AgentType): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    console.log(`[AgentSession] Restarting session ${sessionId}`);

    // 1. Kill the existing process
    this.killProcess(session.process);

    // 2. Clear persisted entries
    if (!session.skipDb) {
      this.storage.agentSessions.deleteEntries(sessionId);
    }

    // 3. Clear message store
    session.store.patches = [];
    session.store.entries = [];
    session.store.indexProvider.reset();
    session.store.toolTracker.clear();
    session.store.currentAssistantIndex = null;
    session.buffer = "";
    session.dormant = false;

    // 4. Broadcast clear signal to all subscribers
    const clearPatch = ConversationPatch.clearAll();
    this.broadcastPatch(sessionId, clearPatch);

    // 5. Update status to running
    session.status = "running";
    if (!session.skipDb) this.storage.agentSessions.updateStatus(sessionId, "running");
    this.broadcastPatch(sessionId, ConversationPatch.updateStatus("running"));
    this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId: session.id, status: "running" });

    // 6. Reset provider state and update agent type if specified
    getProvider(session.agentType).onSessionDestroyed?.(sessionId);
    if (agentType) {
      session.agentType = agentType;
    }
    getProvider(session.agentType).onSessionCreated?.(sessionId);

    // 7. Calculate absolute worktree path and respawn
    const absoluteWorktreePath = resolveWorktreePath(projectPath, session.branch);

    this.spawnAgent(session, absoluteWorktreePath);

    return true;
  }

  /**
   * Switch permission mode for a session (preserves conversation history)
   */
  switchMode(
    sessionId: string,
    projectPath: string,
    newMode: "plan" | "edit",
    initialMessage?: string
  ): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    console.log(`[AgentSession] Switching session ${sessionId} from ${session.permissionMode} to ${newMode}`);

    // 1. Kill existing process
    this.killProcess(session.process);

    // 2. Keep message store intact (preserve history in UI)
    // Only reset streaming state and buffer
    this.finalizeStreamingEntry(session);
    session.store.currentAssistantIndex = null;
    session.buffer = "";
    session.dormant = false;

    // 3. Set new permission mode + persist
    session.permissionMode = newMode;
    if (!session.skipDb) {
      this.storage.agentSessions.updatePermissionMode(session.id, newMode);
    }

    // 4. Update status to running, broadcast
    session.status = "running";
    if (!session.skipDb) this.storage.agentSessions.updateStatus(sessionId, "running");
    this.broadcastPatch(sessionId, ConversationPatch.updateStatus("running"));
    this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId: session.id, status: "running" });

    // 5. Respawn Claude Code with new mode flags
    const absoluteWorktreePath = resolveWorktreePath(projectPath, session.branch);

    this.spawnAgent(session, absoluteWorktreePath);

    // 6. Send initial message or conversation summary
    if (initialMessage) {
      // Wait a bit for process to be ready, then send
      setTimeout(() => {
        this.sendUserMessage(sessionId, initialMessage);
      }, 500);
    } else {
      // Build full conversation context from existing entries
      const context = this.buildFullConversationContext(session.store.entries);
      if (context) {
        setTimeout(() => {
          // Send context without adding to visible messages
          const provider = getProvider(session.agentType);
          const formatted = provider.formatUserInput(context, session.id);
          try {
            session.process?.stdin?.write(formatted);
          } catch (error) {
            console.error(`[AgentSession] Failed to send conversation context:`, error);
          }
        }, 500);
      }
    }

    return true;
  }

  /**
   * Accept a plan and restart the session in edit mode
   */
  acceptPlanAndRestart(
    sessionId: string,
    projectPath: string,
    planContent: string
  ): boolean {
    return this.switchMode(sessionId, projectPath, "edit", planContent);
  }

  /**
   * Build full conversation context from message entries for context transfer.
   * Uses XML-tagged format to prevent Claude from confusing historical context
   * with actual tool executions in the current session.
   */
  private buildFullConversationContext(entries: AgentMessage[]): string | null {
    const lines: string[] = [];

    for (const entry of entries) {
      if (!entry) continue;

      switch (entry.type) {
        case "user": {
          const text = typeof entry.content === "string"
            ? entry.content
            : entry.content.filter(p => p.type === "text").map(p => (p as { text: string }).text).join("\n");
          lines.push(`<user_message>${text}</user_message>`);
          break;
        }
        case "assistant":
          lines.push(`<assistant_message>${entry.content}</assistant_message>`);
          break;
        case "tool_use": {
          const inputStr = typeof entry.input === "string"
            ? entry.input
            : JSON.stringify(entry.input);
          const truncatedInput = inputStr.length > 2000 ? inputStr.substring(0, 2000) + "..." : inputStr;
          lines.push(`<historical_tool_call tool="${entry.tool}">${truncatedInput}</historical_tool_call>`);
          break;
        }
        case "tool_result": {
          const truncatedOutput = entry.output.length > 2000 ? entry.output.substring(0, 2000) + "..." : entry.output;
          lines.push(`<historical_tool_result>${truncatedOutput}</historical_tool_result>`);
          break;
        }
        case "error":
          lines.push(`<error>${entry.message}</error>`);
          break;
        case "system":
          // Skip system messages (session lifecycle noise)
          break;
        // Skip thinking blocks (internal)
      }
    }

    if (lines.length === 0) return null;

    return [
      `<conversation_summary>`,
      `This is a READ-ONLY summary of a previous conversation session. The session was interrupted and you are now in a NEW process.`,
      ``,
      `IMPORTANT:`,
      `- You did NOT execute any of the tool calls shown below in THIS session. They happened in a previous, now-terminated process.`,
      `- Any file edits, reads, or other tool actions shown here may or may not have been applied. Do NOT assume they succeeded.`,
      `- If you need to read or edit files, you MUST make new tool calls. Do not reference previous tool calls as if they are still in effect.`,
      `- Respond naturally to the user's latest message below. Use your tools normally — do not format tool calls as text.`,
      ``,
      ...lines,
      `</conversation_summary>`,
    ].join("\n");
  }

  /**
   * Wake a dormant session: spawn process, send full context + user message
   */
  private wakeDormantSession(
    session: RunningSession,
    projectPath: string,
    userMessage: string | ContentPart[],
    userId: string = "local",
  ): void {
    console.log(`[AgentSession] Waking dormant session ${session.id}`);

    session.dormant = false;
    session.status = "running";
    if (!session.skipDb) this.storage.agentSessions.updateStatus(session.id, "running");
    this.broadcastPatch(session.id, ConversationPatch.updateStatus("running"));
    this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId: session.id, status: "running" });

    // Spawn Claude Code process
    const absoluteWorktreePath = resolveWorktreePath(projectPath, session.branch);
    this.spawnAgent(session, absoluteWorktreePath);

    // Push user message to store (+ persist to DB)
    this.pushEntry(session.id, {
      type: "user",
      content: userMessage,
      timestamp: Date.now(),
    }, true, userId);

    // After process ready: send full context + new message to stdin
    setTimeout(() => {
      const context = this.buildFullConversationContext(session.store.entries);
      if (context) {
        const provider = getProvider(session.agentType);
        const formatted = provider.formatUserInput(context, session.id);
        try {
          session.process?.stdin?.write(formatted);
        } catch (error) {
          console.error(`[AgentSession] Failed to send context to woken session:`, error);
        }
      }
    }, 500);
  }

  /**
   * Restore sessions from database on startup.
   * Creates dormant RunningSession objects with process=null for sessions that have entries.
   */
  restoreSessionsFromDb(): void {
    const allSessions = this.storage.agentSessions.getAll();
    let restoredCount = 0;

    for (const dbSession of allSessions) {
      // Skip sessions already in memory
      if (this.sessions.has(dbSession.id)) continue;

      const entries = this.storage.agentSessions.getEntries(dbSession.id);
      // Skip sessions with no entries (stale metadata)
      if (entries.length === 0) continue;

      // Rebuild MessageStore
      const indexProvider = new EntryIndexProvider();
      const toolTracker = new EntryTracker(indexProvider);
      const store: MessageStore = {
        patches: [],
        entries: [],
        indexProvider,
        toolTracker,
        currentAssistantIndex: null,
      };

      let maxIndex = -1;
      for (const row of entries) {
        try {
          const message = JSON.parse(row.data) as AgentMessage;
          const idx = row.entry_index;
          store.entries[idx] = message;

          // Generate ADD patch for history replay
          const patch = ConversationPatch.addEntry(idx, message);
          store.patches.push(patch);

          // Rebuild tool tracker for tool_use and tool_result entries
          if (message.type === "tool_use" && message.toolUseId) {
            toolTracker.set(`tool_use:${message.toolUseId}`, idx);
          } else if (message.type === "tool_result" && message.toolUseId) {
            toolTracker.set(`tool_result:${message.toolUseId}`, idx);
          }

          if (idx > maxIndex) maxIndex = idx;
        } catch (error) {
          console.error(`[AgentSession] Failed to parse entry for session ${dbSession.id}:`, error);
        }
      }

      // Set index provider to continue after the max restored index
      indexProvider.setIndex(maxIndex + 1);

      const permissionMode = (dbSession.permission_mode === "plan" ? "plan" : "edit") as "plan" | "edit";

      const runningSession: RunningSession = {
        id: dbSession.id,
        projectId: dbSession.project_id,
        branch: dbSession.branch || null,
        process: null,
        dormant: true,
        store,
        subscribers: new Set(),
        status: "stopped",
        buffer: "",
        skipDb: false,
        permissionMode,
        agentType: ((dbSession as unknown as Record<string, unknown>).agent_type as AgentType) || "claude-code",
      };

      this.sessions.set(dbSession.id, runningSession);

      // Update DB status to stopped (was likely "running" when server crashed).
      // Use the timestamp-preserving variant — this is a bulk bookkeeping reset,
      // not a real status event, and `updateStatus` would rewrite `updated_at`
      // for every restored row, corrupting the ordering used by
      // `getLatestByBranch`.
      this.storage.agentSessions.updateStatusPreservingTimestamp(dbSession.id, "stopped");

      restoredCount++;
    }

    if (restoredCount > 0) {
      console.log(`[AgentSession] Restored ${restoredCount} dormant session(s) from database`);
    }
  }

  /**
   * Kill all active session processes and clear state for graceful shutdown
   */
  shutdown(): void {
    for (const [id, session] of this.sessions) {
      try {
        getProvider(session.agentType).onSessionDestroyed?.(id);
      } catch { /* ignore - provider cleanup is best-effort */ }
      this.killProcess(session.process);
    }
    this.sessions.clear();
  }

  /**
   * Broadcast a JSON patch to all subscribers
   */
  /**
   * Generate a title for a freshly-started session from its first user message.
   * Tries the configured chat model first; on failure or when no model is
   * configured, falls back to a truncated snippet. Writes the title once and
   * notifies subscribers so the session list can refresh.
   */
  private async ensureSessionTitle(
    session: RunningSession,
    userText: string,
    userId: string,
  ): Promise<void> {
    const fallback = snippetTitle(userText);
    let title: string | null = null;
    try {
      title = await generateSessionTitle(this.storage, userText, userId);
    } catch (error) {
      console.warn(`[AgentSession] Title generation threw for ${session.id}:`, error);
    }
    const finalTitle = title && title.length > 0 ? title : fallback;
    if (!finalTitle) return;

    try {
      const dbRow = this.storage.agentSessions.getById(session.id);
      // Respect any title the user (or another writer) has set in the meantime.
      if (!dbRow || (dbRow.title !== null && dbRow.title !== undefined)) return;
      this.storage.agentSessions.updateTitle(session.id, finalTitle);
      this.broadcastRaw(session.id, { titleUpdated: { title: finalTitle } });
    } catch (error) {
      console.error(`[AgentSession] Failed to persist generated title for ${session.id}:`, error);
    }
  }

  private broadcastPatch(sessionId: string, patch: Patch): void {
    // DEBUG: surface every /status transition — helps localize "dialog still fires"
    const statusOp = patch.find(p => p.path === "/status");
    if (statusOp) {
      const session = this.sessions.get(sessionId);
      console.log(
        `[Agent:broadcastPatch] ${sessionId} /status →`,
        (statusOp.value as { content?: string } | undefined)?.content,
        `subs=${session?.subscribers.size ?? 0}`,
      );
    }
    const msg: AgentWsMessage = { JsonPatch: patch };
    this.broadcastRaw(sessionId, msg);
  }

  /**
   * Broadcast a raw message to all subscribers
   */
  private broadcastRaw(sessionId: string, message: AgentWsMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const json = JSON.stringify(message);
    for (const ws of session.subscribers) {
      try {
        ws.send(json);
      } catch (error) {
        // WebSocket might be closed
        session.subscribers.delete(ws);
      }
    }
  }
}

