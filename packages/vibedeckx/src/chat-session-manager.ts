/**
 * ChatSessionManager — lightweight AI chat session manager using Vercel AI SDK.
 *
 * No child processes, no tool tracking, no permission modes.
 * Streams responses from DeepSeek via `streamText` and broadcasts
 * JSON Patches over WebSocket (same architecture as AgentSessionManager).
 */

import { randomUUID } from "crypto";
import { streamText, tool, stepCountIs } from "ai";
import { z } from "zod";
import { resolveChatModel } from "./utils/chat-model.js";
import type WebSocket from "ws";
import type { AgentMessage, AgentSessionStatus } from "./agent-types.js";
import { ConversationPatch } from "./conversation-patch.js";
import type { Patch, AgentWsMessage } from "./conversation-patch.js";
import type { Storage } from "./storage/types.js";
import type { EventBus, GlobalEvent } from "./event-bus.js";
import type { ProcessManager, LogMessage } from "./process-manager.js";
import type { AgentSessionManager } from "./agent-session-manager.js";
import { resolveWorktreePath } from "./utils/worktree-paths.js";
import { proxyToRemote } from "./utils/remote-proxy.js";
import type { RemoteExecutorInfo, RemoteSessionInfo } from "./server-types.js";
import type { RemotePatchCache } from "./remote-patch-cache.js";

// ============ Types ============

interface ChatStore {
  patches: Patch[];
  entries: AgentMessage[];
  nextIndex: number;
}

interface ChatSession {
  id: string;
  projectId: string;
  branch: string | null;
  store: ChatStore;
  subscribers: Set<WebSocket>;
  status: AgentSessionStatus;
  abortController: AbortController | null;
  eventListeningEnabled: boolean;
}

// ============ Helpers ============

function stripAnsi(text: string): string {
  return text.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g, "");
}

function extractLogText(logs: LogMessage[], tailLines: number): string {
  const textLogs = logs
    .filter((l): l is Exclude<LogMessage, { type: "finished" }> => l.type !== "finished")
    .map((l) => l.data);
  const joined = textLogs.join("");
  const lines = joined.split("\n");
  return stripAnsi(lines.slice(-tailLines).join("\n"));
}

// ============ Manager ============

export class ChatSessionManager {
  /** sessionId → ChatSession */
  private sessions = new Map<string, ChatSession>();

  /** projectId:branch → sessionId (one session per project+branch) */
  private sessionIndex = new Map<string, string>();

  private storage: Storage;
  private eventBus: EventBus | null = null;
  private processManager: ProcessManager;
  private agentSessionManager: AgentSessionManager;
  private remoteSessionMap: Map<string, RemoteSessionInfo>;
  private remoteExecutorMap: Map<string, RemoteExecutorInfo>;
  private remotePatchCache: RemotePatchCache;

  constructor(
    storage: Storage,
    processManager: ProcessManager,
    agentSessionManager: AgentSessionManager,
    remoteSessionMap: Map<string, RemoteSessionInfo>,
    remoteExecutorMap: Map<string, RemoteExecutorInfo>,
    remotePatchCache: RemotePatchCache,
  ) {
    this.storage = storage;
    this.processManager = processManager;
    this.agentSessionManager = agentSessionManager;
    this.remoteSessionMap = remoteSessionMap;
    this.remoteExecutorMap = remoteExecutorMap;
    this.remotePatchCache = remotePatchCache;
  }

  setEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
    this.setupEventListeners();
  }

  setEventListening(sessionId: string, enabled: boolean): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.eventListeningEnabled = enabled;
    return true;
  }

  getEventListening(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session?.eventListeningEnabled ?? false;
  }

  private setupEventListeners(): void {
    if (!this.eventBus) return;
    this.eventBus.subscribe((event: GlobalEvent) => {
      if (event.type === "executor:stopped") {
        this.handleExecutorFinished(event);
      }
    });
  }

  private handleExecutorFinished(event: Extract<GlobalEvent, { type: "executor:stopped" }>): void {
    try {
      // Look up executor metadata
      const executor = this.storage.executors.getById(event.executorId);
      if (!executor) return;

      // Look up group to get branch
      const group = this.storage.executorGroups.getById(executor.group_id);
      if (!group) return;

      const branch = group.branch || null;

      // Find a chat session for this project+branch that has event listening enabled
      const key = `${event.projectId}:${branch ?? ""}`;
      const sessionId = this.sessionIndex.get(key);
      if (!sessionId) return;

      const session = this.sessions.get(sessionId);
      if (!session || !session.eventListeningEnabled) return;

      // Get tail output from process manager
      const logs = this.processManager.getLogs(event.processId);
      const outputLogs = logs.filter(
        (l) => l.type === "pty" || l.type === "stdout" || l.type === "stderr"
      );
      const tail = outputLogs.slice(-100);
      let raw = tail.map((l) => (l as { data: string }).data).join("");
      raw = raw.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, "");
      const tailOutput = raw.length > 10000 ? raw.slice(-10000) : raw;

      const exitStatus = event.exitCode === 0 ? "success" : "failed";
      const message = [
        `[Executor Event: Process Finished]`,
        `Executor: "${executor.name}"`,
        `Command: ${executor.command}`,
        `Exit Code: ${event.exitCode} (${exitStatus})`,
        ``,
        `Last output:`,
        `---`,
        tailOutput || "(no output captured)",
        `---`,
        ``,
        `Summarize in 1-2 sentences.`,
      ].join("\n");

      // Send as a user message into the main chat — triggers DeepSeek AI response
      this.sendMessage(sessionId, message).catch((err) => {
        console.error(`[ChatSession] handleExecutorFinished sendMessage error:`, err);
      });
    } catch (error) {
      console.error(`[ChatSession] handleExecutorFinished error:`, error);
    }
  }

  private findRemoteSessionForProject(projectId: string, branch?: string | null): { localSessionId: string; info: RemoteSessionInfo } | null {
    // Session IDs use format: remote-{serverId}-{projectId}-{remoteSessionId}
    // Match any session that contains the projectId segment
    const projectSegment = `-${projectId}-`;
    let fallback: { localSessionId: string; info: RemoteSessionInfo } | null = null;

    for (const [key, info] of this.remoteSessionMap) {
      if (key.startsWith("remote-") && key.includes(projectSegment)) {
        // Exact branch match
        if (info.branch === (branch ?? null)) {
          return { localSessionId: key, info };
        }
        // Keep first match as fallback in case no branch match
        if (!fallback) {
          fallback = { localSessionId: key, info };
        }
      }
    }

    if (fallback) {
      console.log(`[ChatSession] findRemoteSessionForProject: no exact branch match for branch=${branch ?? "null"}, using fallback session=${fallback.localSessionId} (branch=${fallback.info.branch ?? "null"})`);
    }
    return fallback;
  }

  /**
   * Extract AgentMessage[] from the local remotePatchCache for a given session.
   * Parses cached WS messages and collects ENTRY patch values into an ordered array.
   */
  private extractMessagesFromCache(sessionId: string): AgentMessage[] {
    const cacheEntry = this.remotePatchCache.get(sessionId);
    console.log(`[ChatSession] extractMessagesFromCache: sessionId=${sessionId}, cacheExists=${!!cacheEntry}, cachedMsgCount=${cacheEntry?.messages.length ?? 0}, patchCount=${cacheEntry?.patchCount ?? 0}, finished=${cacheEntry?.finished ?? "N/A"}, remoteWsState=${cacheEntry?.remoteWs?.readyState ?? "null"}, subscribers=${cacheEntry?.subscribers.size ?? 0}`);
    if (!cacheEntry || cacheEntry.messages.length === 0) return [];

    const result: AgentMessage[] = [];
    // Track patch types for diagnostics
    let entryCount = 0;
    let statusCount = 0;
    let readyCount = 0;
    let finishedCount = 0;
    let otherCount = 0;
    let nonJsonPatchCount = 0;
    let parseErrorCount = 0;

    for (const raw of cacheEntry.messages) {
      try {
        const parsed = JSON.parse(raw);
        if (!parsed.JsonPatch || !Array.isArray(parsed.JsonPatch)) {
          nonJsonPatchCount++;
          continue;
        }

        for (const op of parsed.JsonPatch) {
          if ((op.op === "add" || op.op === "replace") && op.value?.type === "ENTRY" && op.value.content) {
            const match = op.path?.match(/^\/entries\/(\d+)$/);
            if (match) {
              const index = parseInt(match[1], 10);
              result[index] = op.value.content as AgentMessage;
              entryCount++;
            }
          } else if (op.path === "/status") {
            statusCount++;
          } else if (op.value?.type === "READY") {
            readyCount++;
          } else if (op.value?.type === "FINISHED") {
            finishedCount++;
          } else {
            otherCount++;
          }
        }
      } catch {
        parseErrorCount++;
      }
    }

    const filtered = result.filter(Boolean);
    console.log(`[ChatSession] extractMessagesFromCache: extracted ${filtered.length} messages from ${cacheEntry.messages.length} cached raw messages. Patch breakdown: entry=${entryCount}, status=${statusCount}, ready=${readyCount}, finished=${finishedCount}, other=${otherCount}, nonJsonPatch=${nonJsonPatchCount}, parseErrors=${parseErrorCount}`);
    return filtered;
  }

  private summarizeMessages(messages: AgentMessage[]) {
    return messages.map((msg) => {
      switch (msg.type) {
        case "user":
          return { type: "user", content: msg.content };
        case "assistant":
          return { type: "assistant", content: msg.content };
        case "tool_use": {
          const inputStr = typeof msg.input === "string"
            ? msg.input
            : JSON.stringify(msg.input);
          return {
            type: "tool_use",
            tool: msg.tool,
            input: inputStr.length > 500 ? inputStr.substring(0, 500) + "..." : inputStr,
          };
        }
        case "tool_result":
          return {
            type: "tool_result",
            tool: msg.tool,
            output: msg.output.length > 500 ? msg.output.substring(0, 500) + "..." : msg.output,
          };
        case "error":
          return { type: "error", message: msg.message };
        case "system":
          return { type: "system", content: msg.content };
        case "thinking":
          return { type: "thinking", content: msg.content };
        default:
          return { type: (msg as AgentMessage).type };
      }
    });
  }

  // ---- Session lifecycle ----

  getOrCreateSession(projectId: string, branch: string | null): string {
    const key = `${projectId}:${branch ?? ""}`;
    const existing = this.sessionIndex.get(key);
    if (existing && this.sessions.has(existing)) {
      return existing;
    }

    const id = randomUUID();
    const session: ChatSession = {
      id,
      projectId,
      branch,
      store: { patches: [], entries: [], nextIndex: 0 },
      subscribers: new Set(),
      status: "stopped",
      abortController: null,
      eventListeningEnabled: false,
    };

    this.sessions.set(id, session);
    this.sessionIndex.set(key, id);
    console.log(`[ChatSession] Created session ${id} for project=${projectId} branch=${branch}`);
    return id;
  }

  getSession(sessionId: string): ChatSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  getMessages(sessionId: string): AgentMessage[] {
    return this.sessions.get(sessionId)?.store.entries ?? [];
  }

  // ---- WebSocket subscription ----

  subscribe(sessionId: string, ws: WebSocket): (() => void) | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // Replay all historical patches
    for (const patch of session.store.patches) {
      const msg: AgentWsMessage = { JsonPatch: patch };
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        // Client gone
      }
    }

    // Send current status
    const statusPatch = ConversationPatch.updateStatus(session.status);
    try {
      ws.send(JSON.stringify({ JsonPatch: statusPatch }));
    } catch {
      // Client gone
    }

    // Signal replay complete
    try {
      ws.send(JSON.stringify({ Ready: true }));
    } catch {
      // Client gone
    }

    session.subscribers.add(ws);

    return () => {
      session.subscribers.delete(ws);
    };
  }

  // ---- Tools & system prompt ----

  private getSystemPrompt(projectId: string, branch: string | null): string {
    return [
      "You are a helpful assistant for a software development workspace.",
      "You can check the status of running executors (dev servers, build processes, etc.) using the getExecutorStatus tool.",
      "You can start executors using the runExecutor tool and stop them using the stopExecutor tool.",
      "When the user asks about running processes, errors, build status, or dev server status, use the getExecutorStatus tool.",
      "When the user asks to start, run, or launch a process, use runExecutor. When they ask to stop or kill a process, use stopExecutor.",
      "You can view the coding agent's conversation history using the getAgentConversation tool.",
      "When the user asks about what the agent is doing, has done, or references agent activities, use this tool.",
      "When you receive an [Executor Event] message, respond in 1-2 sentences only. State what finished, whether it succeeded or failed, and the key detail (e.g. error message) if it failed. Do not repeat the output logs.",
      "You can list active terminal sessions using the listTerminals tool.",
      "You can run commands in a terminal using the runInTerminal tool. The command runs visibly in the user's terminal.",
      "When the user asks to run a command, check something in the terminal, or interact with a shell, use these tools.",
      "If no terminals are open, suggest the user open one in the Terminal tab first.",
      `Current workspace: project=${projectId}, branch=${branch ?? "default"}.`,
    ].join("\n");
  }

  private createTools(projectId: string, branch: string | null) {
    const storage = this.storage;
    const processManager = this.processManager;
    const agentSessionManager = this.agentSessionManager;
    const remoteExecutorMap = this.remoteExecutorMap;

    return {
      getAgentConversation: tool({
        description:
          "Get the conversation history of the coding agent in the current workspace. " +
          "Use this when the user asks about what the coding agent is doing, what it has done, " +
          "or needs context about the agent's work. Returns recent messages from the agent session.",
        inputSchema: z.object({
          tailMessages: z
            .number()
            .min(1)
            .max(50)
            .default(20)
            .describe("Number of recent messages to return"),
        }),
        execute: async ({ tailMessages }) => {
          // Collect local session
          let localResult: { sessionId: string; status: string; totalMessages: number; messages: unknown[] } | null = null;
          let agentSession = agentSessionManager.getSessionByBranch(projectId, branch);
          if (!agentSession) {
            const projectSessions = agentSessionManager.getSessionsByProject(projectId);
            agentSession = projectSessions.find(s => s.status === "running")
              ?? projectSessions[0]
              ?? null;
          }
          if (agentSession) {
            const allMessages = agentSessionManager.getMessages(agentSession.id);
            const recent = allMessages.slice(-tailMessages);
            localResult = {
              sessionId: agentSession.id,
              status: agentSession.status,
              totalMessages: allMessages.length,
              messages: this.summarizeMessages(recent),
            };
          }

          // Collect remote session
          let remoteResult: { sessionId: string; status: string; totalMessages: number; messages: unknown[]; note?: string } | null = null;
          const remote = this.findRemoteSessionForProject(projectId, branch);
          console.log(`[ChatSession] getAgentConversation: projectId=${projectId}, branch=${branch ?? "null"}, remote=${remote ? remote.localSessionId : "null"}, remoteBranch=${remote?.info.branch ?? "null"}`);
          if (remote) {
            try {
              const result = await proxyToRemote(
                remote.info.remoteUrl,
                remote.info.remoteApiKey,
                "GET",
                `/api/agent-sessions/${remote.info.remoteSessionId}`,
              );
              console.log(`[ChatSession] getAgentConversation: remote proxy result ok=${result.ok}, status=${result.status}`);
              if (result.ok) {
                const data = result.data as { session: { status: string }; messages: AgentMessage[] };
                let allMessages = data.messages ?? [];
                console.log(`[ChatSession] getAgentConversation: remote returned ${allMessages.length} messages, session.status=${data.session?.status}`);

                // Fallback: if remote returned no messages, extract from local cache
                if (allMessages.length === 0) {
                  allMessages = this.extractMessagesFromCache(remote.localSessionId);
                }

                // If session is running but still no messages, poll cache briefly
                // to allow time for ENTRY patches to arrive via WebSocket
                if (allMessages.length === 0 && data.session?.status === "running") {
                  const cacheState = this.remotePatchCache.get(remote.localSessionId);
                  console.log(`[ChatSession] getAgentConversation: 0 messages for running session, starting retry. Cache state: wsState=${cacheState?.remoteWs?.readyState ?? "null"}, cachedMsgs=${cacheState?.messages.length ?? 0}, patchCount=${cacheState?.patchCount ?? 0}, finished=${cacheState?.finished ?? "N/A"}, reconnecting=${cacheState?.reconnecting ?? "N/A"}`);
                  for (let attempt = 0; attempt < 3; attempt++) {
                    await new Promise(resolve => setTimeout(resolve, 1000));
                    allMessages = this.extractMessagesFromCache(remote.localSessionId);
                    console.log(`[ChatSession] getAgentConversation: retry attempt ${attempt + 1}/3, extracted ${allMessages.length} messages`);
                    if (allMessages.length > 0) break;
                  }
                  if (allMessages.length === 0) {
                    const finalCache = this.remotePatchCache.get(remote.localSessionId);
                    console.log(`[ChatSession] getAgentConversation: all retries exhausted, still 0 messages. Final cache: wsState=${finalCache?.remoteWs?.readyState ?? "null"}, cachedMsgs=${finalCache?.messages.length ?? 0}, patchCount=${finalCache?.patchCount ?? 0}`);
                  }
                }

                const recent = allMessages.slice(-tailMessages);
                remoteResult = {
                  sessionId: remote.localSessionId,
                  status: data.session?.status ?? "unknown",
                  totalMessages: allMessages.length,
                  messages: this.summarizeMessages(recent),
                  ...(allMessages.length === 0 && data.session?.status === "running"
                    ? { note: "Session just started, agent is still initializing. Try again in a few seconds." }
                    : {}),
                };
              } else {
                console.error(`[ChatSession] getAgentConversation: remote proxy failed status=${result.status}`);
                // Try local cache even if remote returned non-ok status
                const cachedMessages = this.extractMessagesFromCache(remote.localSessionId);
                if (cachedMessages.length > 0) {
                  remoteResult = {
                    sessionId: remote.localSessionId,
                    status: "running",
                    totalMessages: cachedMessages.length,
                    messages: this.summarizeMessages(cachedMessages.slice(-tailMessages)),
                  };
                }
              }
            } catch (err) {
              console.error(`[ChatSession] getAgentConversation: remote proxy error:`, err);
              // Try local cache even if remote is unreachable
              const cachedMessages = this.extractMessagesFromCache(remote.localSessionId);
              if (cachedMessages.length > 0) {
                remoteResult = {
                  sessionId: remote.localSessionId,
                  status: "running",
                  totalMessages: cachedMessages.length,
                  messages: this.summarizeMessages(cachedMessages.slice(-tailMessages)),
                };
              }
            }
          }

          if (!localResult && !remoteResult) {
            return { local: null, remote: null, message: "No coding agent session found for this workspace." };
          }

          return { local: localResult, remote: remoteResult };
        },
      }),

      getExecutorStatus: tool({
        description:
          "Get the status of all executors (dev servers, build processes, etc.) in the current workspace. " +
          "Use this when the user asks about running processes, errors, build output, or dev server status.",
        inputSchema: z.object({
          tailLines: z
            .number()
            .min(1)
            .max(100)
            .default(20)
            .describe("Number of recent output lines to include per executor"),
        }),
        execute: async ({ tailLines }) => {
          const group = branch
            ? storage.executorGroups.getByBranch(projectId, branch)
            : undefined;

          if (!group) {
            return { executors: [], message: "No executor group found for this workspace." };
          }

          const executors = storage.executors.getByGroupId(group.id);

          const results = executors.map((executor) => {
            const processes = processManager.getProcessesByExecutorId(executor.id);
            const latestProcess = processes[processes.length - 1];

            return {
              name: executor.name,
              command: executor.command,
              isRunning: latestProcess?.isRunning ?? false,
              recentOutput: latestProcess
                ? extractLogText(latestProcess.logs, tailLines)
                : "(no process history)",
            };
          });

          return { executors: results };
        },
      }),

      runExecutor: tool({
        description:
          "Start an executor (dev server, build process, etc.) by name. " +
          "Use this when the user asks to start, run, or launch a process.",
        inputSchema: z.object({
          executorName: z
            .string()
            .describe("Name of the executor to start (case-insensitive match)"),
        }),
        execute: async ({ executorName }) => {
          const group = branch
            ? storage.executorGroups.getByBranch(projectId, branch)
            : undefined;

          if (!group) {
            return { success: false, message: "No executor group found for this workspace." };
          }

          const executors = storage.executors.getByGroupId(group.id);
          const executor = executors.find(
            (e) => e.name.toLowerCase() === executorName.toLowerCase()
          );

          if (!executor) {
            const available = executors.map((e) => e.name).join(", ");
            return {
              success: false,
              message: `Executor "${executorName}" not found. Available: ${available || "none"}`,
            };
          }

          // Check if already running
          const processes = processManager.getProcessesByExecutorId(executor.id);
          const running = processes.find((p) => p.isRunning);
          if (running) {
            return {
              success: false,
              processId: running.processId,
              executorName: executor.name,
              message: `Executor "${executor.name}" is already running (processId=${running.processId}).`,
            };
          }

          // Resolve project path
          const project = storage.projects.getById(projectId);
          if (!project?.path) {
            return { success: false, message: "No project path configured." };
          }

          const basePath = resolveWorktreePath(project.path, branch);

          try {
            const processId = processManager.start(executor, basePath);
            return {
              success: true,
              processId,
              executorName: executor.name,
              command: executor.command,
              message: `Started "${executor.name}" (${executor.command}).`,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            return { success: false, message: `Failed to start executor: ${msg}` };
          }
        },
      }),

      stopExecutor: tool({
        description:
          "Stop a running executor (dev server, build process, etc.) by name. " +
          "Use this when the user asks to stop, kill, or terminate a process.",
        inputSchema: z.object({
          executorName: z
            .string()
            .describe("Name of the executor to stop (case-insensitive match)"),
        }),
        execute: async ({ executorName }) => {
          const group = branch
            ? storage.executorGroups.getByBranch(projectId, branch)
            : undefined;

          if (!group) {
            return { success: false, message: "No executor group found for this workspace." };
          }

          const executors = storage.executors.getByGroupId(group.id);
          const executor = executors.find(
            (e) => e.name.toLowerCase() === executorName.toLowerCase()
          );

          if (!executor) {
            const available = executors.map((e) => e.name).join(", ");
            return {
              success: false,
              message: `Executor "${executorName}" not found. Available: ${available || "none"}`,
            };
          }

          const processes = processManager.getProcessesByExecutorId(executor.id);
          const running = processes.find((p) => p.isRunning);

          if (!running) {
            return {
              success: false,
              executorName: executor.name,
              message: `Executor "${executor.name}" is not running.`,
            };
          }

          const stopped = processManager.stop(running.processId);
          return {
            success: stopped,
            executorName: executor.name,
            processId: running.processId,
            message: stopped
              ? `Stopped "${executor.name}" (processId=${running.processId}).`
              : `Failed to stop "${executor.name}".`,
          };
        },
      }),

      listTerminals: tool({
        description:
          "List all active terminal sessions in the current workspace. " +
          "Use this to discover available terminals before running commands with runInTerminal.",
        inputSchema: z.object({}),
        execute: async () => {
          // Local terminals
          const localTerminals = processManager.getTerminals(projectId).map((t) => ({
            id: t.id,
            name: t.name,
            cwd: t.cwd,
            branch: t.branch,
            location: "local" as const,
          }));

          // Remote terminals from remoteExecutorMap
          const remoteTerminals: Array<{
            id: string;
            name: string;
            cwd?: string;
            branch?: string | null;
            location: "remote";
          }> = [];
          for (const [key, info] of remoteExecutorMap.entries()) {
            if (!key.startsWith("remote-terminal-")) continue;
            if (info.projectId && info.projectId !== projectId) continue;
            remoteTerminals.push({
              id: key,
              name: key,
              branch: info.branch,
              location: "remote",
            });
          }

          const terminals = [...localTerminals, ...remoteTerminals];
          if (terminals.length === 0) {
            return {
              terminals: [],
              message: "No active terminals. The user should open a terminal in the Terminal tab first.",
            };
          }
          return { terminals };
        },
      }),

      runInTerminal: tool({
        description:
          "Run a shell command in an active terminal session. The command executes visibly in the user's terminal. " +
          "Use listTerminals first to get available terminal IDs. " +
          "Use this when the user asks to run a command, check something, or interact with their shell.",
        inputSchema: z.object({
          terminalId: z.string().describe("ID of the terminal to run the command in (from listTerminals)"),
          command: z.string().describe("The shell command to execute"),
          timeout: z
            .number()
            .min(1)
            .max(120)
            .default(30)
            .describe("Max seconds to wait for command to finish"),
        }),
        execute: async ({ terminalId, command, timeout }) => {
          try {
            // Remote terminal — proxy to remote server
            if (terminalId.startsWith("remote-terminal-")) {
              const remoteInfo = remoteExecutorMap.get(terminalId);
              if (!remoteInfo) {
                return { success: false, output: "", message: `Remote terminal ${terminalId} not found.` };
              }
              const result = await proxyToRemote(
                remoteInfo.remoteUrl,
                remoteInfo.remoteApiKey,
                "POST",
                `/api/path/terminals/${remoteInfo.remoteProcessId}/execute`,
                { command, timeout },
                { timeoutMs: (timeout + 5) * 1000 },
              );
              if (!result.ok) {
                return { success: false, output: "", message: `Remote execution failed: ${JSON.stringify(result.data)}` };
              }
              const data = result.data as { exitCode: number; output: string; timedOut: boolean };
              return {
                success: !data.timedOut,
                exitCode: data.exitCode,
                output: data.output,
                timedOut: data.timedOut,
              };
            }

            // Local terminal
            const result = await processManager.executeInTerminal(terminalId, command, timeout);
            return {
              success: !result.timedOut,
              exitCode: result.exitCode,
              output: result.output,
              timedOut: result.timedOut,
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : "Unknown error";
            return {
              success: false,
              output: "",
              message: msg,
            };
          }
        },
      }),
    };
  }

  // ---- Send message & stream AI response ----

  async sendMessage(sessionId: string, content: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    // 1. Push user message
    const userMsg: AgentMessage = { type: "user", content, timestamp: Date.now() };
    this.pushEntry(session, userMsg);

    // 2. Update status to running
    session.status = "running";
    this.broadcastPatch(session, ConversationPatch.updateStatus("running"));

    // 3. Build messages array for AI SDK
    const messages = session.store.entries
      .filter((e): e is Extract<AgentMessage, { type: "user" | "assistant" }> =>
        e.type === "user" || e.type === "assistant"
      )
      .map((e) => ({
        role: e.type as "user" | "assistant",
        content: typeof e.content === "string" ? e.content : e.content.filter(p => p.type === "text").map(p => (p as { text: string }).text).join("\n"),
      }));

    // 4. Stream response
    const abortController = new AbortController();
    session.abortController = abortController;

    let assistantIndex: number | null = null;
    let accumulatedText = "";

    try {
      const result = streamText({
        model: resolveChatModel(this.storage),
        system: this.getSystemPrompt(session.projectId, session.branch),
        messages,
        tools: this.createTools(session.projectId, session.branch),
        stopWhen: stepCountIs(3),
        abortSignal: abortController.signal,
      });

      for await (const part of result.fullStream) {
        if (abortController.signal.aborted) break;

        switch (part.type) {
          case "text-delta": {
            accumulatedText += part.text;

            if (assistantIndex === null) {
              // First chunk — create the assistant entry
              const assistantMsg: AgentMessage = {
                type: "assistant",
                content: accumulatedText,
                partial: true,
                timestamp: Date.now(),
              };
              assistantIndex = session.store.nextIndex;
              session.store.nextIndex++;

              const patch = ConversationPatch.addEntry(assistantIndex, assistantMsg);
              session.store.patches.push(patch);
              session.store.entries[assistantIndex] = assistantMsg;
              this.broadcastPatch(session, patch);
            } else {
              // Subsequent chunks — replace entry
              const assistantMsg: AgentMessage = {
                type: "assistant",
                content: accumulatedText,
                partial: true,
                timestamp: Date.now(),
              };
              const patch = ConversationPatch.replaceEntry(assistantIndex, assistantMsg);
              session.store.patches.push(patch);
              session.store.entries[assistantIndex] = assistantMsg;
              this.broadcastPatch(session, patch);
            }
            break;
          }

          case "tool-call": {
            // Finalize any partial assistant message before the tool call
            if (assistantIndex !== null && accumulatedText) {
              const finalMsg: AgentMessage = {
                type: "assistant",
                content: accumulatedText,
                partial: false,
                timestamp: Date.now(),
              };
              const patch = ConversationPatch.replaceEntry(assistantIndex, finalMsg);
              session.store.patches.push(patch);
              session.store.entries[assistantIndex] = finalMsg;
              this.broadcastPatch(session, patch);
            }

            const toolUseMsg: AgentMessage = {
              type: "tool_use",
              tool: part.toolName,
              input: part.input,
              toolUseId: part.toolCallId,
              timestamp: Date.now(),
            };
            this.pushEntry(session, toolUseMsg);

            // Reset so next text starts a new assistant message
            assistantIndex = null;
            accumulatedText = "";
            break;
          }

          case "tool-result": {
            const output = part.output;
            const toolResultMsg: AgentMessage = {
              type: "tool_result",
              tool: part.toolName,
              output: typeof output === "string" ? output : JSON.stringify(output),
              toolUseId: part.toolCallId,
              timestamp: Date.now(),
            };
            this.pushEntry(session, toolResultMsg);
            break;
          }
        }
      }

      // 5. Finalize — mark as non-partial
      if (assistantIndex !== null) {
        const finalMsg: AgentMessage = {
          type: "assistant",
          content: accumulatedText,
          partial: false,
          timestamp: Date.now(),
        };
        const patch = ConversationPatch.replaceEntry(assistantIndex, finalMsg);
        session.store.patches.push(patch);
        session.store.entries[assistantIndex] = finalMsg;
        this.broadcastPatch(session, patch);
      }
    } catch (err: unknown) {
      // Don't push error for intentional abort
      if (abortController.signal.aborted) {
        // Finalize partial message if we have one
        if (assistantIndex !== null && accumulatedText) {
          const finalMsg: AgentMessage = {
            type: "assistant",
            content: accumulatedText,
            partial: false,
            timestamp: Date.now(),
          };
          const patch = ConversationPatch.replaceEntry(assistantIndex, finalMsg);
          session.store.patches.push(patch);
          session.store.entries[assistantIndex] = finalMsg;
          this.broadcastPatch(session, patch);
        }
      } else {
        const errorMessage = err instanceof Error ? err.message : "Unknown error";
        console.error(`[ChatSession] Stream error for ${sessionId}:`, errorMessage);
        const errorMsg: AgentMessage = {
          type: "error",
          message: errorMessage,
          timestamp: Date.now(),
        };
        this.pushEntry(session, errorMsg);
      }
    } finally {
      session.abortController = null;
      session.status = "stopped";
      this.broadcastPatch(session, ConversationPatch.updateStatus("stopped"));
    }

    return true;
  }

  // ---- Stop generation ----

  stopGeneration(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.abortController) return false;

    session.abortController.abort();
    return true;
  }

  // ---- Internal helpers ----

  private pushEntry(session: ChatSession, entry: AgentMessage): void {
    const index = session.store.nextIndex;
    session.store.nextIndex++;

    const patch = ConversationPatch.addEntry(index, entry);
    session.store.patches.push(patch);
    session.store.entries[index] = entry;
    this.broadcastPatch(session, patch);
  }

  private broadcastPatch(session: ChatSession, patch: Patch): void {
    const raw = JSON.stringify({ JsonPatch: patch });
    for (const ws of session.subscribers) {
      try {
        ws.send(raw);
      } catch {
        // Client gone, will be cleaned up on close
      }
    }
  }
}
