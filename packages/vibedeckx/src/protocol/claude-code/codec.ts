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
