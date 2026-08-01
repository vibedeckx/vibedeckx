export const PROJECT_CHAT_PUBLIC_ERROR_LIMIT = 512;

const REDACTED = "[redacted]";
const REDACTED_URL = "[redacted URL]";
const SECRET_NAME = [
  "authorization",
  "proxy[_-]?authorization",
  "api(?:[_-]|\\s+)?key",
  "x-api-key",
  "x-vibedeckx-api-key",
  "access[_-]?token",
  "refresh[_-]?token",
  "connect[_-]?token",
  "token",
  "client[_-]?secret",
  "credential(?:s)?",
  "private[_-]?key",
  "secret",
  "password",
].join("|");
const SECRET_KEY = new RegExp(`^(?:${SECRET_NAME})$`, "i");
const ERROR_KEY = /^(?:error|message|reason|detail|details|cause)$/i;

function rawErrorMessage(error: unknown, fallback: string): string {
  try {
    if (error instanceof Error && typeof error.message === "string") return error.message || fallback;
    if (typeof error === "string") return error || fallback;
    const converted = String(error);
    return converted && converted !== "undefined" && converted !== "null" ? converted : fallback;
  } catch {
    return fallback;
  }
}

function bounded(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, Math.max(0, limit - 1))}…`;
}

/**
 * Removes credentials and internal locations from text that can reach a
 * Project Chat transcript, WebSocket frame, work item, or tool result.
 * This is deliberately independent of configured secrets: provider errors
 * can contain credentials that this process never knew about.
 */
export function redactProjectChatSensitiveText(value: string): string {
  let redacted = value;
  // Remove the complete URL. Even without its credential query, an internal
  // host/path is implementation detail rather than actionable user guidance.
  redacted = redacted.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu, REDACTED_URL);
  redacted = redacted.replace(
    /\b(?:authorization|proxy-authorization)\s*[:=]\s*(?:bearer|basic)?\s*[^\s,;]+/giu,
    `Authorization: ${REDACTED}`,
  );
  redacted = redacted.replace(/\bbearer\s+[A-Za-z0-9._~+/=-]+/giu, `Bearer ${REDACTED}`);
  redacted = redacted.replace(
    new RegExp(`(["']?(?:${SECRET_NAME})["']?\\s*[:=]\\s*)(["'])(.*?)\\2`, "giu"),
    (_match, prefix: string, quote: string) => `${prefix}${quote}${REDACTED}${quote}`,
  );
  redacted = redacted.replace(
    new RegExp(`(\\b(?:${SECRET_NAME})\\b\\s*[:=]\\s*)([^\\s,;&]+)`, "giu"),
    `$1${REDACTED}`,
  );
  redacted = redacted.replace(
    new RegExp(`(--(?:${SECRET_NAME})(?:=|\\s+))([^\\s]+)`, "giu"),
    `$1${REDACTED}`,
  );
  redacted = redacted.replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/giu, REDACTED);
  redacted = redacted.replace(/(?:^|\s)(?:\/(?:home|var|tmp|etc|Users)\/[^\s,;]+)/gu, (path) =>
    `${path.startsWith(" ") ? " " : ""}[redacted path]`);
  redacted = redacted.replace(/\r?\n\s*at\s+[^\r\n]*/gu, "");
  return redacted;
}

export function sanitizeProjectChatPublicError(
  error: unknown,
  fallback = "Project Chat request failed",
): string {
  const safe = redactProjectChatSensitiveText(rawErrorMessage(error, fallback)).trim();
  return bounded(safe || fallback, PROJECT_CHAT_PUBLIC_ERROR_LIMIT);
}

function sanitizeValue(value: unknown, key: string, seen: WeakSet<object>, depth: number): unknown {
  if (SECRET_KEY.test(key)) return REDACTED;
  if (ERROR_KEY.test(key)) return sanitizeProjectChatPublicError(value, "Operation failed");
  if (typeof value === "string") return redactProjectChatSensitiveText(value);
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return String(value);
  if (value === undefined) return null;
  if (typeof value !== "object" || depth >= 8 || seen.has(value)) return "[unavailable]";
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => sanitizeValue(item, "", seen, depth + 1));
  }
  const result: Record<string, unknown> = {};
  try {
    for (const [childKey, child] of Object.entries(value).slice(0, 100)) {
      result[childKey] = sanitizeValue(child, childKey, seen, depth + 1);
    }
  } catch {
    return "[unavailable]";
  }
  return result;
}

/** Sanitizes structured or plain-text tool results at the persistence edge. */
export function sanitizeProjectChatPublicToolResult(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    return bounded(JSON.stringify(sanitizeValue(parsed, "", new WeakSet(), 0)), 64 * 1024);
  } catch {
    return bounded(redactProjectChatSensitiveText(content), 64 * 1024);
  }
}
