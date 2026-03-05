import { spawn, execFileSync, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import type { WebSocket } from "@fastify/websocket";
import type { Storage } from "./storage/types.js";
import type {
  AgentMessage,
  AgentSessionStatus,
  AgentType,
  ClaudeOutputMessage,
  ClaudeUserInput,
  ClaudeContentBlock,
} from "./agent-types.js";
import { getProvider } from "./providers/index.js";
import { ConversationPatch, type Patch, type AgentWsMessage } from "./conversation-patch.js";
import type { EventBus } from "./event-bus.js";
import { EntryIndexProvider, EntryTracker } from "./entry-index-provider.js";
import { resolveWorktreePath } from "./utils/worktree-paths.js";

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
  private claudeBinaryPath: string | null | undefined = undefined; // undefined = not yet checked
  private eventBus: EventBus | null = null;

  constructor(storage: Storage) {
    this.storage = storage;
  }

  setEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
  }

  private detectClaudeBinary(): string | null {
    if (this.claudeBinaryPath !== undefined) {
      return this.claudeBinaryPath;
    }
    try {
      const cmd = process.platform === "win32" ? "where" : "which";
      const result = execFileSync(cmd, ["claude"], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
      this.claudeBinaryPath = result || null;
      console.log(`[AgentSession] Native claude binary found: ${result}`);
    } catch {
      this.claudeBinaryPath = null;
      console.log(`[AgentSession] Native claude binary not found, will use npx`);
    }
    return this.claudeBinaryPath;
  }

  /**
   * Get or create an agent session for a branch
   */
  getOrCreateSession(
    projectId: string,
    branch: string | null,
    projectPath: string,
    skipDb = false,
    permissionMode: "plan" | "edit" = "edit"
  ): string {
    // Check if session already exists in memory (including dormant)
    for (const [id, session] of this.sessions) {
      if (
        session.projectId === projectId &&
        session.branch === branch
      ) {
        if (session.dormant) {
          // Dormant session found — update permission mode if needed, return ID
          // Don't spawn process yet (lazy — wait for user message)
          if (session.permissionMode !== permissionMode) {
            session.permissionMode = permissionMode;
            if (!session.skipDb) {
              this.storage.agentSessions.updatePermissionMode(id, permissionMode);
            }
          }
          console.log(`[AgentSession] Returning dormant session ${id}`);
          return id;
        }

        if (session.status === "running") {
          // If permission mode differs, switch mode on existing session
          if (session.permissionMode !== permissionMode) {
            console.log(`[AgentSession] Session ${id} exists with mode ${session.permissionMode}, switching to ${permissionMode}`);
            this.switchMode(id, projectPath, permissionMode);
          }
          console.log(`[AgentSession] Returning existing session ${id}`);
          return id;
        }
      }
    }

    // Check database for existing session (skip for remote path-based sessions)
    if (!skipDb) {
      const existingSession = this.storage.agentSessions.getByBranch(
        projectId,
        branch ?? ""
      );
      if (existingSession && this.sessions.has(existingSession.id)) {
        const inMemory = this.sessions.get(existingSession.id)!;
        if (inMemory.status !== "running") {
          // Dead session — restart it so callers always get a running session
          console.log(`[AgentSession] Session ${existingSession.id} is ${inMemory.status}, restarting`);
          this.restartSession(existingSession.id, projectPath);
        } else if (inMemory.permissionMode !== permissionMode) {
          console.log(`[AgentSession] Session ${existingSession.id} mode ${inMemory.permissionMode} → ${permissionMode}`);
          this.switchMode(existingSession.id, projectPath, permissionMode);
        }
        return existingSession.id;
      }
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
      agentType: "claude-code",
    };

    this.sessions.set(sessionId, runningSession);

    // Spawn Claude Code process
    this.spawnClaudeCode(runningSession, absoluteWorktreePath);

    return sessionId;
  }

  /**
   * Spawn Claude Code CLI process
   */
  private spawnClaudeCode(session: RunningSession, cwd: string): void {
    console.log(`[AgentSession] Spawning Claude Code in ${cwd}`);

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

    const nativeBinary = this.detectClaudeBinary();

    const permissionFlag = session.permissionMode === "plan"
      ? "--permission-mode=plan"
      : "--dangerously-skip-permissions";

    const claudeArgs = [
      "-p",
      "--output-format=stream-json",
      "--input-format=stream-json",
      permissionFlag,
      "--verbose",
    ];

    let command: string;
    let args: string[];

    if (nativeBinary) {
      command = nativeBinary;
      args = claudeArgs;
    } else {
      command = "npx";
      args = ["-y", "@anthropic-ai/claude-code", ...claudeArgs];
    }

    const childProcess = spawn(command, args, {
      cwd,
      env: { ...process.env, FORCE_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
      shell: true,
    });

    session.process = childProcess;

    console.log(`[AgentSession] Process ${session.id} started, PID: ${childProcess.pid}`);

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
   * Handle stdout data from Claude Code
   */
  private handleStdout(session: RunningSession, data: string): void {
    // Add to buffer
    session.buffer += data;

    // Process complete lines
    const lines = session.buffer.split("\n");
    session.buffer = lines.pop() || ""; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const json = JSON.parse(line) as ClaudeOutputMessage;
        this.processClaudeMessage(session.id, json);
      } catch (e) {
        // Not JSON, might be debug output
        console.log(`[AgentSession] Non-JSON stdout: ${line.substring(0, 100)}`);
      }
    }
  }

  /**
   * Process a parsed Claude Code message
   */
  private processClaudeMessage(sessionId: string, msg: ClaudeOutputMessage): void {
    const timestamp = Date.now();
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (msg.type === "assistant") {
      const assistantMsg = msg as { type: "assistant"; message?: { content?: ClaudeContentBlock[] } };
      const content = assistantMsg.message?.content;
      if (!content) return;

      for (const block of content) {
        this.processContentBlock(sessionId, block, timestamp);
      }
      return;
    }

    if (msg.type === "user") {
      // Echo of user message - we already added it when sending
      return;
    }

    if (msg.type === "system") {
      const systemMsg = msg as { type: "system"; message?: string };
      if (systemMsg.message) {
        // Clear current assistant key - system message breaks streaming
        this.finalizeStreamingEntry(session);
        session.store.currentAssistantIndex = null;
        this.pushEntry(sessionId, {
          type: "system",
          content: systemMsg.message,
          timestamp,
        }, true);
      }
      return;
    }

    if (msg.type === "result") {
      const resultMsg = msg as { type: "result"; subtype?: string; error?: string; duration_ms?: number; cost_usd?: number };
      this.finalizeStreamingEntry(session);
      session.store.currentAssistantIndex = null;

      if (resultMsg.subtype === "error" && resultMsg.error) {
        this.pushEntry(sessionId, {
          type: "error",
          message: resultMsg.error,
          timestamp,
        }, true);
      }

      if (resultMsg.subtype === "success") {
        this.broadcastRaw(sessionId, {
          taskCompleted: {
            duration_ms: resultMsg.duration_ms,
            cost_usd: resultMsg.cost_usd,
          },
        });

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
      return;
    }

    // Log unknown message types for debugging
    console.log(`[AgentSession] Unknown message type: ${msg.type}`);
  }

  /**
   * Process a content block from assistant message
   */
  private processContentBlock(
    sessionId: string,
    block: ClaudeContentBlock,
    timestamp: number
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    switch (block.type) {
      case "text":
        // For text blocks, use streaming update pattern
        this.updateAssistantMessage(sessionId, block.text, timestamp);
        break;

      case "tool_use": {
        // Tool use breaks the assistant streaming — finalize before clearing
        this.finalizeStreamingEntry(session);
        session.store.currentAssistantIndex = null;
        // Deduplicate by block ID — streaming can replay the same assistant message
        const tuKey = `tool_use:${block.id}`;
        const { index: tuIndex, isNew: tuIsNew } = session.store.toolTracker.getOrCreate(tuKey);
        const tuMessage: AgentMessage = {
          type: "tool_use",
          tool: block.name,
          input: block.input,
          toolUseId: block.id,
          timestamp,
        };
        if (tuIsNew) {
          // First time seeing this tool_use — add entry
          session.store.entries[tuIndex] = tuMessage;
          const patch = ConversationPatch.addEntry(tuIndex, tuMessage);
          session.store.patches.push(patch);
          this.broadcastPatch(sessionId, patch);
        } else {
          // Already seen — replace (input may have been updated during streaming)
          session.store.entries[tuIndex] = tuMessage;
          const patch = ConversationPatch.replaceEntry(tuIndex, tuMessage);
          session.store.patches.push(patch);
          this.broadcastPatch(sessionId, patch);
        }
        // Persist tool_use immediately
        if (!session.skipDb) {
          this.persistEntry(session, tuIndex, tuMessage);
        }
        break;
      }

      case "tool_result": {
        // Tool result breaks the assistant streaming — finalize before clearing
        this.finalizeStreamingEntry(session);
        session.store.currentAssistantIndex = null;
        // Deduplicate by tool_use_id
        const trKey = `tool_result:${block.tool_use_id}`;
        const { index: trIndex, isNew: trIsNew } = session.store.toolTracker.getOrCreate(trKey);
        const trMessage: AgentMessage = {
          type: "tool_result",
          tool: "",
          output: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
          toolUseId: block.tool_use_id,
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
        // Persist tool_result immediately
        if (!session.skipDb) {
          this.persistEntry(session, trIndex, trMessage);
        }
        break;
      }

      case "thinking":
        // Thinking breaks the assistant streaming — finalize before clearing
        this.finalizeStreamingEntry(session);
        session.store.currentAssistantIndex = null;
        this.pushEntry(sessionId, {
          type: "thinking",
          content: block.thinking,
          timestamp,
        }, true);
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
    broadcast: boolean = true
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
      this.persistEntry(session, index, message);
    }

    if (broadcast) {
      this.broadcastPatch(sessionId, patch);
    }

    return index;
  }

  /**
   * Persist a single entry to the database
   */
  private persistEntry(session: RunningSession, index: number, message: AgentMessage): void {
    try {
      this.storage.agentSessions.upsertEntry(session.id, index, JSON.stringify(message));
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
  sendUserMessage(sessionId: string, content: string, projectPath?: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // If session is dormant, wake it up
    if (session.dormant) {
      if (!projectPath) {
        console.error(`[AgentSession] Cannot wake dormant session ${sessionId} without projectPath`);
        return false;
      }
      this.wakeDormantSession(session, projectPath, content);
      return true;
    }

    if (session.status !== "running") {
      return false;
    }

    // Clear current assistant key - user message breaks streaming
    this.finalizeStreamingEntry(session);
    session.store.currentAssistantIndex = null;

    // Add user message with ADD patch
    this.pushEntry(sessionId, {
      type: "user",
      content,
      timestamp: Date.now(),
    }, true);

    // Send to Claude Code stdin
    const input: ClaudeUserInput = {
      type: "user",
      message: {
        role: "user",
        content,
      },
    };

    try {
      session.process?.stdin?.write(JSON.stringify(input) + "\n");
      return true;
    } catch (error) {
      console.error(`[AgentSession] Failed to send message:`, error);
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
   * Stop a session
   */
  stopSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    try {
      session.process?.kill("SIGTERM");
      session.dormant = false;
      session.status = "stopped";
      if (!session.skipDb) this.storage.agentSessions.updateStatus(sessionId, "stopped");
      this.broadcastPatch(sessionId, ConversationPatch.updateStatus("stopped"));
      this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId: session.id, status: "stopped" });
      this.broadcastRaw(sessionId, { finished: true });
      return true;
    } catch (error) {
      console.error(`[AgentSession] Failed to stop session:`, error);
      return false;
    }
  }

  /**
   * Delete a session (stop and remove)
   */
  deleteSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    this.stopSession(sessionId);
    this.sessions.delete(sessionId);
    if (!session?.skipDb) this.storage.agentSessions.delete(sessionId);
    return true;
  }

  /**
   * Restart a session (stop process, clear history, respawn)
   * Returns the same session ID with a fresh conversation
   */
  restartSession(sessionId: string, projectPath: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    console.log(`[AgentSession] Restarting session ${sessionId}`);

    // 1. Kill the existing process
    try {
      session.process?.kill("SIGTERM");
    } catch (error) {
      console.error(`[AgentSession] Failed to kill process:`, error);
    }

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

    // 6. Calculate absolute worktree path and respawn
    const absoluteWorktreePath = resolveWorktreePath(projectPath, session.branch);

    this.spawnClaudeCode(session, absoluteWorktreePath);

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
    try {
      session.process?.kill("SIGTERM");
    } catch (error) {
      console.error(`[AgentSession] Failed to kill process:`, error);
    }

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

    this.spawnClaudeCode(session, absoluteWorktreePath);

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
          const input: ClaudeUserInput = {
            type: "user",
            message: {
              role: "user",
              content: context,
            },
          };
          try {
            session.process?.stdin?.write(JSON.stringify(input) + "\n");
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
   * Includes tool information for generic agent compatibility.
   */
  private buildFullConversationContext(entries: AgentMessage[]): string | null {
    const lines: string[] = [];

    for (const entry of entries) {
      if (!entry) continue;

      switch (entry.type) {
        case "user":
          lines.push(`User: ${entry.content}`);
          break;
        case "assistant":
          lines.push(`Assistant: ${entry.content}`);
          break;
        case "tool_use": {
          const inputStr = typeof entry.input === "string"
            ? entry.input
            : JSON.stringify(entry.input);
          const truncatedInput = inputStr.length > 2000 ? inputStr.substring(0, 2000) + "..." : inputStr;
          lines.push(`[Tool: ${entry.tool}] Input: ${truncatedInput}`);
          break;
        }
        case "tool_result": {
          const truncatedOutput = entry.output.length > 2000 ? entry.output.substring(0, 2000) + "..." : entry.output;
          lines.push(`[Tool Result]: ${truncatedOutput}`);
          break;
        }
        case "error":
          lines.push(`[Error]: ${entry.message}`);
          break;
        case "system":
          lines.push(`[System]: ${entry.content}`);
          break;
        // Skip thinking blocks (internal)
      }
    }

    if (lines.length === 0) return null;

    return `[Previous conversation history - please continue from where this left off]\n\n${lines.join("\n")}\n\n[End of previous conversation history]\n\nContinue this conversation. The user will send a new message.`;
  }

  /**
   * Wake a dormant session: spawn process, send full context + user message
   */
  private wakeDormantSession(session: RunningSession, projectPath: string, userMessage: string): void {
    console.log(`[AgentSession] Waking dormant session ${session.id}`);

    session.dormant = false;
    session.status = "running";
    if (!session.skipDb) this.storage.agentSessions.updateStatus(session.id, "running");
    this.broadcastPatch(session.id, ConversationPatch.updateStatus("running"));
    this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId: session.id, status: "running" });

    // Spawn Claude Code process
    const absoluteWorktreePath = resolveWorktreePath(projectPath, session.branch);
    this.spawnClaudeCode(session, absoluteWorktreePath);

    // Push user message to store (+ persist to DB)
    this.pushEntry(session.id, {
      type: "user",
      content: userMessage,
      timestamp: Date.now(),
    }, true);

    // After process ready: send full context + new message to stdin
    setTimeout(() => {
      const context = this.buildFullConversationContext(session.store.entries);
      if (context) {
        const input: ClaudeUserInput = {
          type: "user",
          message: {
            role: "user",
            content: context,
          },
        };
        try {
          session.process?.stdin?.write(JSON.stringify(input) + "\n");
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
        agentType: "claude-code",
      };

      this.sessions.set(dbSession.id, runningSession);

      // Update DB status to stopped (was likely "running" when server crashed)
      this.storage.agentSessions.updateStatus(dbSession.id, "stopped");

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
        session.process?.kill("SIGTERM");
      } catch { /* ignore - process may already be dead */ }
    }
    this.sessions.clear();
  }

  /**
   * Broadcast a JSON patch to all subscribers
   */
  private broadcastPatch(sessionId: string, patch: Patch): void {
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
