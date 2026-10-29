/**
 * What the Main Chat commander is shown of its conversation (design §11).
 *
 * - The open turn is sent in full: every stream's assistant messages, tool
 *   calls and tool results, so a later stream of the same turn sees what the
 *   earlier ones found out.
 * - Ended turns are sent as their text (user and assistant words only).
 * - Once more than KEEP_RECENT_TURNS have ended, the older ones are folded
 *   into one rolling summary, so a long conversation keeps going without a
 *   Clear.
 */
import type { ModelMessage } from "ai";
import type { AgentMessage } from "./agent-types.js";

/** Ended turns kept as text before they are folded into the summary. */
export const KEEP_RECENT_TURNS = 3;

/** One tool result in the open turn is cut down to this. */
export const MAX_TOOL_RESULT_CHARS = 8_000;

/** The open turn's messages are kept under this, dropping the oldest tool outputs first. */
export const MAX_TURN_CHARS = 120_000;

/** Ended-turn text handed to the summarizer is cut to this, keeping the most recent. */
const MAX_SUMMARY_INPUT_CHARS = 60_000;

const DROPPED_OUTPUT = "(output dropped to keep the conversation within its context budget; call the tool again if you need it)";

/** The user/assistant words of entries [from, to). */
export function textHistory(entries: readonly AgentMessage[], from: number, to: number): ModelMessage[] {
  const messages: ModelMessage[] = [];
  for (let i = Math.max(0, from); i < Math.min(to, entries.length); i++) {
    const entry = entries[i];
    if (!entry || (entry.type !== "user" && entry.type !== "assistant")) continue;
    const content = typeof entry.content === "string"
      ? entry.content
      : entry.content.filter((part) => part.type === "text").map((part) => (part as { text: string }).text).join("\n");
    messages.push({ role: entry.type, content });
  }
  return messages;
}

/** The same range as plain text, for the summarizer. */
export function transcriptText(entries: readonly AgentMessage[], from: number, to: number): string {
  const text = textHistory(entries, from, to)
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content as string}`)
    .join("\n\n");
  return text.length > MAX_SUMMARY_INPUT_CHARS ? `…${text.slice(-MAX_SUMMARY_INPUT_CHARS)}` : text;
}

/** The summary as the opening message of what the model is shown. */
export function summaryMessage(summary: string): ModelMessage {
  return {
    role: "user",
    content: `[Earlier conversation, summarized]\n${summary}\n[End of summary — the conversation continues below.]`,
  };
}

export const SUMMARY_SYSTEM_PROMPT = [
  "You maintain the running summary of a conversation between a user and a coding-workspace assistant (the commander), so the assistant can keep working without the full transcript.",
  "Fold the new part of the conversation into the previous summary. Keep what later turns may refer back to: the user's goals and preferences, decisions made and why, what was built, run or changed (executor names, branches, files), outcomes and failures, and anything still open.",
  "Drop chit-chat and step-by-step narration. Write compact plain prose or short bullets, at most about 400 words. Output only the summary.",
].join("\n");

export function summaryPrompt(previous: string | null, transcript: string): string {
  return [
    previous ? `Previous summary:\n${previous}` : "There is no previous summary yet.",
    "",
    `New part of the conversation to fold in:\n${transcript}`,
  ].join("\n");
}

type ToolResultPart = { type: "tool-result"; output: { type: string; value?: unknown } };

function outputText(output: ToolResultPart["output"]): string | null {
  switch (output.type) {
    case "text":
    case "error-text":
      return typeof output.value === "string" ? output.value : null;
    case "json":
    case "error-json":
      return JSON.stringify(output.value);
    default:
      return null;
  }
}

/** Response messages as kept in the open turn: each tool result cut to MAX_TOOL_RESULT_CHARS. */
export function capToolResults(messages: ModelMessage[], max = MAX_TOOL_RESULT_CHARS): ModelMessage[] {
  return messages.map((message) => {
    if (message.role !== "tool") return message;
    let changed = false;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result") return part;
      const text = outputText((part as ToolResultPart).output);
      if (text === null || text.length <= max) return part;
      changed = true;
      return { ...part, output: { type: "text" as const, value: `${text.slice(0, max)}…(truncated)` } };
    });
    return changed ? { ...message, content } : message;
  });
}

/**
 * Keep the open turn under MAX_TURN_CHARS by replacing its oldest tool outputs
 * with a note. Mutates `messages`; the newest results are the last to go.
 */
export function fitTurnBudget(messages: ModelMessage[], max = MAX_TURN_CHARS): void {
  let size = JSON.stringify(messages).length;
  for (let i = 0; i < messages.length && size > max; i++) {
    const message = messages[i];
    if (message.role !== "tool") continue;
    const content = message.content.map((part) => {
      if (part.type !== "tool-result") return part;
      const text = outputText((part as ToolResultPart).output);
      if (text === null || text === DROPPED_OUTPUT) return part;
      return { ...part, output: { type: "text" as const, value: DROPPED_OUTPUT } };
    });
    messages[i] = { ...message, content };
    size = JSON.stringify(messages).length;
  }
}
