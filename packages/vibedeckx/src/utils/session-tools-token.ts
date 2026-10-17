import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { Storage } from "../storage/types.js";

export const SESSION_TOOLS_SECRET_SETTING = "session_tools_token_secret";
// Backstop only; live checks (session usable + project owned) do the real
// revocation. Same reasoning as the cross-remote TTL: the token is baked into
// the agent's MCP config at spawn and cannot rotate while the process lives.
export const SESSION_TOOLS_TOKEN_TTL_MS = 7 * 86_400_000;

export interface SessionToolsTokenPayload {
  /** The hub's id for the session (`remote-…` for a remote one). */
  sessionId: string;
  /** The one project the token reaches (its tasks; the project of its proposals). */
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
 * Deliberately a separate secret (and wire shape) from the cross-remote token:
 * that one authorizes reaching other machines, this one only the session's own
 * project on the hub. Distinct secrets mean neither can be presented as the other.
 */
const sign = (secret: string, body: string): string =>
  createHmac("sha256", secret).update(body).digest("base64url");

export function signSessionToolsToken(
  secret: string,
  payload: SessionToolsTokenPayload,
  nowMs: number,
  ttlMs: number = SESSION_TOOLS_TOKEN_TTL_MS,
): string {
  const wire: WirePayload = { s: payload.sessionId, p: payload.projectId, u: payload.userId, exp: nowMs + ttlMs };
  const body = Buffer.from(JSON.stringify(wire)).toString("base64url");
  return `${body}.${sign(secret, body)}`;
}

export function verifySessionToolsToken(secret: string, token: string, nowMs: number): SessionToolsTokenPayload | null {
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

export async function getSessionToolsSecret(storage: Pick<Storage, "settings">): Promise<string> {
  return storage.settings.getOrCreate(SESSION_TOOLS_SECRET_SETTING, () => randomBytes(32).toString("hex"));
}
