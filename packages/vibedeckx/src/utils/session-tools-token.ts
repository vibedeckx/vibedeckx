import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { Storage } from "../storage/types.js";

export const SESSION_TOOLS_SECRET_SETTING = "session_tools_token_secret";
/** Backstop only: the token dies with the process that minted it (loopback endpoint). */
export const SESSION_TOOLS_TOKEN_TTL_MS = 86_400_000; // 24h

export interface SessionToolsTokenPayload {
  sessionId: string;
}

interface WirePayload {
  s: string;
  exp: number;
}

/**
 * Deliberately a separate secret (and wire shape) from the cross-remote token:
 * that one carries a tenant principal and is presented to the hub over the
 * public URL, this one only names a local session on a loopback endpoint.
 * Distinct secrets mean neither audience can ever be confused for the other.
 */
const sign = (secret: string, body: string): string =>
  createHmac("sha256", secret).update(body).digest("base64url");

export function signSessionToolsToken(
  secret: string,
  payload: SessionToolsTokenPayload,
  nowMs: number,
  ttlMs: number = SESSION_TOOLS_TOKEN_TTL_MS,
): string {
  const wire: WirePayload = { s: payload.sessionId, exp: nowMs + ttlMs };
  const body = Buffer.from(JSON.stringify(wire)).toString("base64url");
  return `${body}.${sign(secret, body)}`;
}

export function verifySessionToolsToken(
  secret: string,
  token: string,
  nowMs: number,
): SessionToolsTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, providedSig] = parts;
  if (!body || !providedSig) return null;

  const expectedSig = sign(secret, body);
  const provided = Buffer.from(providedSig);
  const expected = Buffer.from(expectedSig);
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  let wire: WirePayload;
  try {
    wire = JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    return null;
  }

  if (typeof wire.s !== "string" || !wire.s) return null;
  if (typeof wire.exp !== "number" || nowMs >= wire.exp) return null;

  return { sessionId: wire.s };
}

/** Bootstraps a persistent signing secret, mirroring the cross-remote pattern. */
export async function getSessionToolsSecret(storage: Pick<Storage, "settings">): Promise<string> {
  return storage.settings.getOrCreate(SESSION_TOOLS_SECRET_SETTING, () =>
    randomBytes(32).toString("hex"),
  );
}
