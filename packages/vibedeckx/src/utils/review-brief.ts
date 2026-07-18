import { generateText } from "ai";
import type { Storage } from "../storage/types.js";
import type { AgentMessage } from "../agent-types.js";
import { extractUserText, isChatModelConfigured } from "./session-title.js";
import { resolveFastChatModel } from "./chat-model.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyLanguageModel = any;

const AI_TIMEOUT_MS = 15_000;
const PER_MESSAGE_MAX_CHARS = 1500;
const TOTAL_INPUT_MAX_CHARS = 24_000;
/** When the serialized conversation overflows, keep this much of the start… */
const HEAD_CHARS = 8_000;
/** …and this much of the end (the middle is elided). */
const TAIL_CHARS = 15_000;
const BRIEF_MAX_CHARS = 4_000;

const SYSTEM_PROMPT = [
  "You distill a coding-agent conversation into an intent brief for an independent code reviewer.",
  "The reviewer will NOT see the conversation — only your brief plus the actual code, so capture what the code alone cannot show:",
  "1. The original request and its goal.",
  "2. Constraints and explicit user decisions, including approaches the user rejected.",
  "3. The intended scope of the changes.",
  "4. Trade-offs or limitations that were acknowledged and accepted.",
  "Do NOT include the agent's reasoning, self-assessment, or claims that the work is correct or complete — the reviewer must judge that independently.",
  "Write concise markdown bullets under those numbered headings, under 400 words total, in the same language as the conversation. Reply with the brief only.",
].join("\n");

function capText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

/**
 * Flatten a conversation into labeled plain text for distillation. Only user
 * and assistant text carry intent — tool traffic and thinking are noise at
 * this altitude. Harness-injected event notifications (user-typed but not
 * user-written) are skipped. Overflow keeps the head (original request) and
 * tail (latest state) and elides the middle.
 */
export function serializeConversationForBrief(messages: AgentMessage[]): string {
  const lines: string[] = [];
  for (const msg of messages) {
    if (!msg) continue;
    if (msg.type === "user" && !msg.event) {
      const text = extractUserText(msg.content).trim();
      if (text) lines.push(`User: ${capText(text, PER_MESSAGE_MAX_CHARS)}`);
    } else if (msg.type === "assistant" && typeof msg.content === "string") {
      const text = msg.content.trim();
      if (text) lines.push(`Agent: ${capText(text, PER_MESSAGE_MAX_CHARS)}`);
    }
  }
  const full = lines.join("\n\n");
  if (full.length <= TOTAL_INPUT_MAX_CHARS) return full;
  return `${full.slice(0, HEAD_CHARS)}\n\n[… middle of the conversation omitted …]\n\n${full.slice(-TAIL_CHARS)}`;
}

/**
 * Run the brief-distillation prompt against any AI SDK language model.
 * Returns null on timeout, network error, or empty output — callers fall
 * back to the deterministic excerpt (tier 2).
 */
export async function generateIntentBriefWithModel(
  model: AnyLanguageModel,
  conversation: string,
  options: { userId?: string } = {},
): Promise<string | null> {
  if (conversation.trim().length === 0) return null;

  const telemetry = options.userId
    ? {
        isEnabled: true,
        functionId: "review-intent-brief",
        metadata: {
          userId: options.userId,
          tags: ["vibedeckx", "review-intent-brief"],
        },
      }
    : undefined;

  try {
    // Native SDK timeout: aborts the underlying request on expiry (a
    // Promise.race would only detach from it, leaving the model generating
    // billable tokens in the background) and leaves no dangling timer.
    const result = await generateText({
      model,
      system: SYSTEM_PROMPT,
      prompt: `Distill this conversation into an intent brief:\n\n${conversation}`,
      timeout: AI_TIMEOUT_MS,
      experimental_telemetry: telemetry,
    });

    const text = ((result as { text?: string }).text ?? "").trim();
    return text.length > 0 ? capText(text, BRIEF_MAX_CHARS) : null;
  } catch (error) {
    console.warn("[ReviewBrief] AI generation failed:", (error as Error).message);
    return null;
  }
}

/**
 * Distill a source session's conversation into an intent brief using the
 * configured fast chat model. Null on any failure or when no model is
 * configured — never throws, so review start degrades to tier 2 silently.
 */
export async function generateIntentBrief(
  storage: Storage,
  userId: string,
  messages: AgentMessage[],
): Promise<string | null> {
  try {
    if (!(await isChatModelConfigured(storage, userId))) return null;
    const conversation = serializeConversationForBrief(messages);
    if (!conversation) return null;
    return await generateIntentBriefWithModel(await resolveFastChatModel(storage, userId), conversation, { userId });
  } catch (error) {
    console.warn("[ReviewBrief] generation failed:", (error as Error).message);
    return null;
  }
}
