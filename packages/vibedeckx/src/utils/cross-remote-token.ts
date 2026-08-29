import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import type { Storage } from "../storage/types.js";

export const CROSS_REMOTE_SECRET_SETTING = "cross_remote_token_secret";
// Backstop only; live checks (isSessionUsable + tier) do the real revocation.
// Must exceed the realistic lifetime of a resident agent process: the token is
// baked into --mcp-config at spawn and cannot rotate while the process lives.
export const CROSS_REMOTE_TOKEN_TTL_MS = 7 * 86_400_000;

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

/**
 * Verification with the failure mode surfaced: "expired" means the signature
 * checked out and only `exp` failed — the payload is trustworthy and can be
 * used to notify the token's owner. Any other failure is "invalid" and the
 * payload must not be trusted at all.
 */
export type CrossRemoteTokenVerification =
  | { status: "ok"; payload: CrossRemoteTokenPayload }
  | { status: "expired"; payload: CrossRemoteTokenPayload; exp: number }
  | { status: "invalid" };

export function verifyCrossRemoteTokenDetailed(
  secret: string,
  token: string,
  nowMs: number,
): CrossRemoteTokenVerification {
  const invalid = { status: "invalid" } as const;
  const parts = token.split(".");
  if (parts.length !== 2) return invalid;
  const [body, providedSig] = parts;
  if (!body || !providedSig) return invalid;

  const expectedSig = sign(secret, body);
  const provided = Buffer.from(providedSig);
  const expected = Buffer.from(expectedSig);
  if (provided.length !== expected.length) return invalid;
  if (!timingSafeEqual(provided, expected)) return invalid;

  let wire: WirePayload;
  try {
    wire = JSON.parse(Buffer.from(body, "base64url").toString());
  } catch {
    return invalid;
  }

  if (typeof wire.u !== "string" || typeof wire.s !== "string" || typeof wire.exp !== "number") return invalid;
  if (wire.src !== null && typeof wire.src !== "string") return invalid;
  // Empty ownership is never a valid signed principal. Reject it here as well as
  // relying on repository scoping, so later lookup changes cannot widen access.
  if (!wire.u || !wire.s) return invalid;

  const payload: CrossRemoteTokenPayload = { userId: wire.u, sessionId: wire.s, sourceRemoteServerId: wire.src };
  if (nowMs >= wire.exp) return { status: "expired", payload, exp: wire.exp };
  return { status: "ok", payload };
}

export function verifyCrossRemoteToken(
  secret: string,
  token: string,
  nowMs: number,
): CrossRemoteTokenPayload | null {
  const result = verifyCrossRemoteTokenDetailed(secret, token, nowMs);
  return result.status === "ok" ? result.payload : null;
}

/** Bootstraps a persistent signing secret, mirroring the reverse-connect machine-key pattern. */
export async function getCrossRemoteSecret(storage: Pick<Storage, "settings">): Promise<string> {
  return storage.settings.getOrCreate(CROSS_REMOTE_SECRET_SETTING, () =>
    randomBytes(32).toString("hex"),
  );
}
