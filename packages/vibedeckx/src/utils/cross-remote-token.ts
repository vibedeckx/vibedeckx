import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { Storage } from "../storage/types.js";

export const CROSS_REMOTE_SECRET_SETTING = "cross_remote_token_secret";
export const CROSS_REMOTE_TOKEN_TTL_MS = 86_400_000; // 24h backstop; live checks do the real revocation

export interface CrossRemoteTokenPayload {
  userId: string;
  sessionId: string;
  /** null when the agent runs on the server itself rather than on a remote. */
  sourceRemoteServerId: string | null;
}

interface WirePayload {
  u: string;
  s: string;
  src: string | null;
  exp: number;
}

const sign = (secret: string, body: string): string =>
  createHmac("sha256", secret).update(body).digest("base64url");

export interface RemoteMcpHandlePayload {
  userId: string;
  sessionId: string;
  remoteId: string;
  workerHandle: string;
  serverLabel: string;
}

interface McpHandleWire {
  u: string; s: string; r: string; h: string; n: string; exp: number;
}

export function signRemoteMcpHandle(
  secret: string,
  payload: RemoteMcpHandlePayload,
  nowMs: number,
  ttlMs = CROSS_REMOTE_TOKEN_TTL_MS,
): string {
  const wire: McpHandleWire = {
    u: payload.userId, s: payload.sessionId, r: payload.remoteId,
    h: payload.workerHandle, n: payload.serverLabel, exp: nowMs + ttlMs,
  };
  const body = Buffer.from(JSON.stringify(wire)).toString("base64url");
  return `mcp.${body}.${sign(secret, `mcp:${body}`)}`;
}

export function verifyRemoteMcpHandle(secret: string, handle: string, nowMs: number): RemoteMcpHandlePayload | null {
  const parts = handle.split(".");
  if (parts.length !== 3) return null;
  const [prefix, body, providedSig] = parts;
  if (prefix !== "mcp" || !body || !providedSig) return null;
  const expectedSig = sign(secret, `mcp:${body}`);
  const provided = Buffer.from(providedSig);
  const expected = Buffer.from(expectedSig);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
  let wire: McpHandleWire;
  try { wire = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { return null; }
  if (![wire.u, wire.s, wire.r, wire.h, wire.n].every((v) => typeof v === "string" && v.length > 0)) return null;
  if (typeof wire.exp !== "number" || nowMs >= wire.exp) return null;
  return { userId: wire.u, sessionId: wire.s, remoteId: wire.r, workerHandle: wire.h, serverLabel: wire.n };
}

export function signCrossRemoteToken(
  secret: string,
  payload: CrossRemoteTokenPayload,
  nowMs: number,
  ttlMs: number = CROSS_REMOTE_TOKEN_TTL_MS,
): string {
  const wire: WirePayload = {
    u: payload.userId,
    s: payload.sessionId,
    src: payload.sourceRemoteServerId,
    exp: nowMs + ttlMs,
  };
  const body = Buffer.from(JSON.stringify(wire)).toString("base64url");
  return `${body}.${sign(secret, body)}`;
}

export function verifyCrossRemoteToken(
  secret: string,
  token: string,
  nowMs: number,
): CrossRemoteTokenPayload | null {
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

  if (typeof wire.u !== "string" || typeof wire.s !== "string" || typeof wire.exp !== "number") return null;
  if (wire.src !== null && typeof wire.src !== "string") return null;
  // Empty ownership is never a valid signed principal. Reject it here as well as
  // relying on repository scoping, so later lookup changes cannot widen access.
  if (!wire.u || !wire.s) return null;
  if (nowMs >= wire.exp) return null;

  return { userId: wire.u, sessionId: wire.s, sourceRemoteServerId: wire.src };
}

/** Bootstraps a persistent signing secret, mirroring the reverse-connect machine-key pattern. */
export async function getCrossRemoteSecret(storage: Pick<Storage, "settings">): Promise<string> {
  return storage.settings.getOrCreate(CROSS_REMOTE_SECRET_SETTING, () =>
    randomBytes(32).toString("hex"),
  );
}
