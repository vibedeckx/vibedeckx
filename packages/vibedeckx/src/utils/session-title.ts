import { generateText } from "ai";
import type { Storage } from "../storage/types.js";
import type { ContentPart } from "../agent-types.js";
import { getChatProviderConfig, resolveChatModel } from "./chat-model.js";

const TITLE_MAX_CHARS = 60;
const AI_TIMEOUT_MS = 15_000;

/**
 * Whether the user has configured an API key for the active chat provider
 * (or supplied one via env var). When false, AI title generation is skipped
 * and the caller should fall back to a snippet.
 */
export function isChatModelConfigured(storage: Storage): boolean {
  const config = getChatProviderConfig(storage);
  if (config.provider === "openrouter") {
    return Boolean(config.openrouterApiKey || process.env.OPENROUTER_API_KEY);
  }
  return Boolean(config.deepseekApiKey || process.env.DEEPSEEK_API_KEY);
}

/**
 * Pull the plain-text portion out of a user message's `content` field, which
 * may be either a raw string or an array of TextPart/ImagePart blocks.
 */
export function extractUserText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join(" ");
}

/**
 * Truncate a free-form string to a session-title-sized snippet. Used both as
 * the AI fallback and to normalize the AI's own output.
 */
export function snippetTitle(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "";
  if (trimmed.length <= TITLE_MAX_CHARS) return trimmed;
  return trimmed.slice(0, TITLE_MAX_CHARS) + "…";
}

function sanitizeTitle(raw: string): string {
  let t = raw.trim();
  // Strip surrounding quotes if the model wrapped the title.
  t = t.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "").trim();
  // Collapse whitespace/newlines.
  t = t.replace(/\s+/g, " ");
  // Strip trailing sentence punctuation.
  t = t.replace(/[。.!?！？,，:：;；]+$/u, "").trim();
  if (t.length > TITLE_MAX_CHARS) {
    t = t.slice(0, TITLE_MAX_CHARS).trim();
  }
  return t;
}

/**
 * Ask the configured chat model to summarize the user's first message into a
 * short conversation title. Returns null on any failure (timeout, network,
 * empty output) so the caller can fall back to a snippet.
 */
export async function generateSessionTitle(
  storage: Storage,
  userMessage: string,
  userId: string,
): Promise<string | null> {
  if (!isChatModelConfigured(storage)) return null;
  const trimmed = userMessage.trim();
  if (trimmed.length === 0) return null;

  // Cap the prompt so a giant first message doesn't blow up the token budget.
  const MAX_INPUT_CHARS = 2000;
  const input = trimmed.length > MAX_INPUT_CHARS
    ? trimmed.slice(0, MAX_INPUT_CHARS) + "…"
    : trimmed;

  try {
    const result = await Promise.race([
      generateText({
        model: resolveChatModel(storage),
        system:
          "You write very short, descriptive titles for chat conversations. " +
          "Reply with the title only — no quotes, no trailing punctuation, no markdown, no prefixes like 'Title:'. " +
          "Use the same language as the user's message. Keep it under 8 words and 50 characters.",
        prompt: `Generate a title for a conversation that begins with this user message:\n\n${input}`,
        experimental_telemetry: {
          isEnabled: true,
          functionId: "session-title",
          metadata: {
            userId,
            tags: ["vibedeckx", "session-title"],
          },
        },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("title generation timed out")), AI_TIMEOUT_MS),
      ),
    ]);

    const text = (result as { text?: string }).text ?? "";
    const sanitized = sanitizeTitle(text);
    return sanitized.length > 0 ? sanitized : null;
  } catch (error) {
    console.warn("[SessionTitle] AI generation failed:", (error as Error).message);
    return null;
  }
}
