import type { ProjectChatMessageType } from "./storage/types.js";

export const PROJECT_CHAT_STRUCTURED_MESSAGE_BYTE_LIMIT = 64 * 1024;

export function assertProjectChatMessageWithinByteLimit(
  type: ProjectChatMessageType,
  content: string,
): void {
  if ((type === "tool_use" || type === "tool_approval_request")
    && Buffer.byteLength(content, "utf8") > PROJECT_CHAT_STRUCTURED_MESSAGE_BYTE_LIMIT) {
    throw new Error(`Project Chat ${type} content exceeds the UTF-8 byte limit`);
  }
}
