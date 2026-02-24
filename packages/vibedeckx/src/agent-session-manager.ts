import { spawn, execFileSync, type ChildProcess } from "child_process";
import { randomUUID } from "crypto";
import { existsSync } from "fs";
import type { WebSocket } from "@fastify/websocket";
import type { Storage } from "./storage/types.js";
import type {
  AgentMessage,
  AgentSessionStatus,
  ClaudeOutputMessage,
  ClaudeUserInput,
  ClaudeContentBlock,
} from "./agent-types.js";
import { ConversationPatch, type Patch, type AgentWsMessage } from "./conversation-patch.js";
import type { EventBus } from "./event-bus.js";
import { EntryIndexProvider } from "./entry-index-provider.js";
import { resolveWorktreePath } from "./utils/worktree-paths.js";

// ============ Session Store Types ============

interface MessageStore {
  /** All patches sent for this session (for history replay) */
  patches: Patch[];
  /** Reconstructed entries from patches (for quick access) */
  entries: AgentMessage[];
  /** Index provider for monotonic indices */
  indexProvider: EntryIndexProvider;
  /** Index of the current streaming assistant message, or null if not streaming */
  currentAssistantIndex: number | null;
}

interface RunningSession {
  id: string;
  projectId: string;
  branch: string | null;
  process: ChildProcess;
  store: MessageStore;
  subscribers: Set<WebSocket>;
  status: AgentSessionStatus;
  buffer: string; // Buffer for incomplete JSON lines
  skipDb: boolean; // Skip DB operations for remote path-based sessions
  permissionMode: "plan" | "edit"; // Claude Code permission mode
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
    // Check if session already exists in memory
    for (const [id, session] of this.sessions) {
      if (
        session.projectId === projectId &&
        session.branch === branch &&
        session.status === "running"
      ) {
        // If permission mode differs, switch mode on existing session
        if (session.permissionMode !== permissionMode) {
          console.log(`[AgentSession] Session ${id} exists with mode ${session.permissionMode}, switching to ${permissionMode}`);
          this.switchMode(id, projectPath, permissionMode);
        }
        console.log(`[AgentSession] Returning existing session ${id}`);
        return id;
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
      });
    }

    // Initialize message store with EntryIndexProvider
    const indexProvider = new EntryIndexProvider();

    const store: MessageStore = {
      patches: [],
      entries: [],
      indexProvider,
      currentAssistantIndex: null,
    };

    // Initialize running session
    const runningSession: RunningSession = {
      id: sessionId,
      projectId,
      branch,
      process: null as unknown as ChildProcess,
      store,
      subscribers: new Set(),
      status: "running",
      buffer: "",
      skipDb,
      permissionMode,
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

      case "tool_use":
        // Tool use breaks the assistant streaming
        session.store.currentAssistantIndex = null;
        this.pushEntry(sessionId, {
          type: "tool_use",
          tool: block.name,
          input: block.input,
          toolUseId: block.id,
          timestamp,
        }, true);
        break;

      case "tool_result":
        // Tool result is always new
        session.store.currentAssistantIndex = null;
        this.pushEntry(sessionId, {
          type: "tool_result",
          tool: "",
          output: typeof block.content === "string" ? block.content : JSON.stringify(block.content),
          toolUseId: block.tool_use_id,
          timestamp,
        }, true);
        break;

      case "thinking":
        // Thinking is always new
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

    if (broadcast) {
      this.broadcastPatch(sessionId, patch);
    }

    return index;
  }

  /**
   * Send a user message to the agent
   */
  sendUserMessage(sessionId: string, content: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "running") {
      return false;
    }

    // Clear current assistant key - user message breaks streaming
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
      session.process.stdin?.write(JSON.stringify(input) + "\n");
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
      session.process.kill("SIGTERM");
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
      session.process.kill("SIGTERM");
    } catch (error) {
      console.error(`[AgentSession] Failed to kill process:`, error);
    }

    // 2. Clear message store
    session.store.patches = [];
    session.store.entries = [];
    session.store.indexProvider.reset();
    session.store.currentAssistantIndex = null;
    session.buffer = "";

    // 3. Broadcast clear signal to all subscribers
    // Send a special patch to clear all entries on the client
    const clearPatch = ConversationPatch.clearAll();
    this.broadcastPatch(sessionId, clearPatch);

    // 4. Update status to running
    session.status = "running";
    if (!session.skipDb) this.storage.agentSessions.updateStatus(sessionId, "running");
    this.broadcastPatch(sessionId, ConversationPatch.updateStatus("running"));
    this.eventBus?.emit({ type: "session:status", projectId: session.projectId, branch: session.branch, sessionId: session.id, status: "running" });

    // 5. Calculate absolute worktree path and respawn
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
      session.process.kill("SIGTERM");
    } catch (error) {
      console.error(`[AgentSession] Failed to kill process:`, error);
    }

    // 2. Keep message store intact (preserve history in UI)
    // Only reset streaming state and buffer
    session.store.currentAssistantIndex = null;
    session.buffer = "";

    // 3. Set new permission mode
    session.permissionMode = newMode;

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
      // Build conversation summary from existing entries
      const summary = this.buildConversationSummary(session.store.entries);
      if (summary) {
        setTimeout(() => {
          // Send summary as context without adding to visible messages
          const input: ClaudeUserInput = {
            type: "user",
            message: {
              role: "user",
              content: summary,
            },
          };
          try {
            session.process.stdin?.write(JSON.stringify(input) + "\n");
          } catch (error) {
            console.error(`[AgentSession] Failed to send context summary:`, error);
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
   * Build a conversation summary from message entries for context transfer
   */
  private buildConversationSummary(entries: AgentMessage[]): string | null {
    const lines: string[] = [];
    let pairCount = 0;
    const maxPairs = 20;

    // Iterate through entries, extract user and assistant text messages
    for (const entry of entries) {
      if (!entry) continue;
      if (pairCount >= maxPairs) break;

      if (entry.type === "user") {
        lines.push(`User: ${entry.content}`);
        pairCount++;
      } else if (entry.type === "assistant") {
        lines.push(`Assistant: ${entry.content}`);
      }
      // Skip tool_use, tool_result, thinking, system, error (too verbose)
    }

    if (lines.length === 0) return null;

    return `[Previous conversation context]\n${lines.join("\n")}\n[End of previous context]\n\nPlease continue from where the previous conversation left off.`;
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
