import type { FastifyReply, FastifyRequest } from "fastify";
import { requireAuth } from "../server.js";
import { resolveUserId } from "../utils/resolve-user-id.js";

/**
 * Authentication boundary for browser/user-facing routes.
 *
 * Solo mode has a real tenant — the canonical `local` owner — so an absent
 * Clerk identity must never become an unscoped repository read. Trusted
 * provider protocols such as `/api/path/*` deliberately call `requireAuth`
 * directly when they need its raw API-key/solo `undefined` semantics.
 */
export function requireUserFacingUserId(
  request: FastifyRequest,
  reply: FastifyReply,
): string | null {
  const authResult = requireAuth(request, reply);
  return authResult === null ? null : resolveUserId(authResult);
}

/**
 * User-facing scope for a route that is also an authenticated server-proxy
 * transport. In solo mode the caller owns only `local`; when auth is enabled,
 * `requireAuth` returns undefined only for an API key that the global hook has
 * already validated, so that trusted transport keeps its unscoped semantics.
 */
export function requireUserFacingOrTrustedProxyUserId(
  request: FastifyRequest,
  reply: FastifyReply,
): string | undefined | null {
  const authResult = requireAuth(request, reply);
  if (authResult === null) return null;
  return authResult === undefined && request.server.authEnabled
    ? undefined
    : resolveUserId(authResult);
}
