/**
 * Stateless parse/serialize for the Claude Code stream-json protocol.
 */
import type { ContentPart } from "../../agent-types.js";
import type { ClaudeOutputMessage } from "./schema.js";

/** Parse one stdout line. Returns null when the line is not JSON. */
export function parseClaudeLine(line: string): ClaudeOutputMessage | null {
  try {
    return JSON.parse(line) as ClaudeOutputMessage;
  } catch {
    return null;
  }
}

/** Serialize user input into the stdin stream-json user envelope. */
export function serializeUserInput(content: string | ContentPart[]): string {
  if (typeof content === "string") {
    return JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
  }
  const blocks = content.map((part) => {
    if (part.type === "text") {
      return { type: "text", text: part.text };
    }
    return { type: "image", source: { type: "base64", media_type: part.mediaType, data: part.data } };
  });
  return JSON.stringify({ type: "user", message: { role: "user", content: blocks } }) + "\n";
}

/**
 * A tool_result block whose content carries at least one image (the CLI's
 * Read/ImageView on a png/jpg returns `[{type:"image",source:{type:"base64",…}}]`).
 * Text-only tool results are not surfaced: the CLI echoes every Bash/Read output
 * back as a `user` line and storing all of it would bloat the transcript for no
 * UI benefit. Images are the exception — the screenshot the agent just looked at
 * is exactly what the user wants to see inline.
 */
export interface ImageToolResult {
  toolUseId: string;
  /** The full content array, JSON-encoded — the frontend re-parses the image blocks. */
  output: string;
}

export function extractImageToolResults(msg: ClaudeOutputMessage): ImageToolResult[] {
  if (msg.type !== "user") return [];
  const content = (msg as { message?: { content?: unknown } }).message?.content;
  if (!Array.isArray(content)) return [];
  const out: ImageToolResult[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (!block || block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
    const inner = block.content;
    if (!Array.isArray(inner)) continue;
    const hasImage = inner.some(
      (b) => b && typeof b === "object" && (b as { type?: unknown }).type === "image",
    );
    if (!hasImage) continue;
    out.push({ toolUseId: block.tool_use_id, output: JSON.stringify(inner) });
  }
  return out;
}
