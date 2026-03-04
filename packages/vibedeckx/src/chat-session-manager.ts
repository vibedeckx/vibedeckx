/**
 * ChatSessionManager — lightweight AI chat session manager using Vercel AI SDK.
 *
 * No child processes, no tool tracking, no permission modes.
 * Streams responses from DeepSeek via `streamText` and broadcasts
 * JSON Patches over WebSocket (same architecture as AgentSessionManager).
 */

import { randomUUID } from "crypto";
import { streamText, tool, stepCountIs } from "ai";
import { createDeepSeek } from "@ai-sdk/deepseek";
import { z } from "zod";
import type WebSocket from "ws";
import type { AgentMessage, AgentSessionStatus } from "./agent-types.js";
import { ConversationPatch } from "./conversation-patch.js";
import type { Patch, AgentWsMessage } from "./conversation-patch.js";
import type { Storage } from "./storage/types.js";
import type { ProcessManager, LogMessage } from "./process-manager.js";

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
  private processManager: ProcessManager;

  private deepseek = createDeepSeek({
    apiKey: process.env.DEEPSEEK_API_KEY ?? "",
  });

  constructor(storage: Storage, processManager: ProcessManager) {
    this.storage = storage;
    this.processManager = processManager;
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
      "When the user asks about running processes, errors, build status, or dev server status, use the tool to check.",
      `Current workspace: project=${projectId}, branch=${branch ?? "default"}.`,
    ].join("\n");
  }

  private createTools(projectId: string, branch: string | null) {
    const storage = this.storage;
    const processManager = this.processManager;

    return {
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
        content: e.content,
      }));

    // 4. Stream response
    const abortController = new AbortController();
    session.abortController = abortController;

    let assistantIndex: number | null = null;
    let accumulatedText = "";

    try {
      const result = streamText({
        model: this.deepseek("deepseek-chat"),
        system: this.getSystemPrompt(session.projectId, session.branch),
        messages,
        tools: this.createTools(session.projectId, session.branch),
        stopWhen: stepCountIs(3),
        abortSignal: abortController.signal,
      });

      for await (const chunk of result.textStream) {
        if (abortController.signal.aborted) break;

        accumulatedText += chunk;

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
