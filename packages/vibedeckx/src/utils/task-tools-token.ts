import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { Storage } from "../storage/types.js";

export const TASK_TOOLS_SECRET_SETTING = "task_tools_token_secret";
// Backstop only; live checks (session usable + project owned) do the real
// revocation. Same reasoning as the cross-remote TTL: the token is baked into
// the agent's MCP config at spawn and cannot rotate while the process lives.
export const TASK_TOOLS_TOKEN_TTL_MS = 7 * 86_400_000;

export interface TaskToolsTokenPayload {
  /** The hub's id for the session (`remote-…` for a remote one). */
  sessionId: string;
  /** The one project whose tasks the token reaches. */
  projectId: string;
  /** Owner the project is re-checked against; null in solo (no-auth) mode. */
  userId: string | null;
}

interface WirePayload {
  s: string;
  p: string;
  u: string | null;
  exp: number;
}

/**
 * A third secret, distinct from the cross-remote and session-tools ones: this
 * token is presented to the hub — over loopback by local sessions, over the
 * public URL by remote ones — and names a project, so it must never verify as
 * either of the other two.
 */
const sign = (secret: string, body: string): string =>
  createHmac("sha256", secret).update(body).digest("base64url");

export function signTaskToolsToken(
  secret: string,
  payload: TaskToolsTokenPayload,
  nowMs: number,
  ttlMs: number = TASK_TOOLS_TOKEN_TTL_MS,
): string {
  const wire: WirePayload = { s: payload.sessionId, p: payload.projectId, u: payload.userId, exp: nowMs + ttlMs };
  const body = Buffer.from(JSON.stringify(wire)).toString("base64url");
  return `${body}.${sign(secret, body)}`;
}

export function verifyTaskToolsToken(secret: string, token: string, nowMs: number): TaskToolsTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, providedSig] = parts;
  if (!body || !providedSig) return null;

  const provided = Buffer.from(providedSig);
  const expected = Buffer.from(sign(secret, body));
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  let wire: WirePayload;
  try {
    wire = JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    return null;
  }

  if (typeof wire.s !== "string" || !wire.s || typeof wire.p !== "string" || !wire.p) return null;
  if (wire.u !== null && (typeof wire.u !== "string" || !wire.u)) return null;
  if (typeof wire.exp !== "number" || nowMs >= wire.exp) return null;

  return { sessionId: wire.s, projectId: wire.p, userId: wire.u };
}

export async function getTaskToolsSecret(storage: Pick<Storage, "settings">): Promise<string> {
  return storage.settings.getOrCreate(TASK_TOOLS_SECRET_SETTING, () => randomBytes(32).toString("hex"));
}
