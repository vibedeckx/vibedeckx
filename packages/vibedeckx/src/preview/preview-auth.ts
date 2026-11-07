import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Credentials for a preview origin (docs/preview-links-design.md §Auth).
 *
 * The app's Bearer token lives in memory and cannot follow a top-level
 * navigation to another origin, so a preview tab authenticates in two steps:
 * a one-time ticket in the URL the app opens (consumed on the first request,
 * so the previewed page never sees it in `location`), exchanged for a signed
 * HttpOnly cookie scoped to that one preview host. The cookie authorizes one
 * slug only: leaking it leaks that preview, not the account.
 */

export const PREVIEW_COOKIE_NAME = "vdx_preview";
const TICKET_TTL_MS = 60_000;
const COOKIE_TTL_MS = 12 * 60 * 60 * 1000;

interface Ticket {
  slug: string;
  userId: string;
  expiresAt: number;
}

interface CookiePayload {
  s: string;
  u: string;
  e: number;
}

export class PreviewAuth {
  private readonly tickets = new Map<string, Ticket>();
  private secret: Promise<string> | null = null;

  constructor(
    private readonly loadSecret: () => Promise<string>,
    private readonly now: () => number = Date.now,
  ) {}

  /** A fresh single-use ticket for one slug; valid for a minute. */
  mintTicket(slug: string, userId: string): string {
    this.pruneTickets();
    const token = randomBytes(32).toString("base64url");
    this.tickets.set(token, { slug, userId, expiresAt: this.now() + TICKET_TTL_MS });
    return token;
  }

  /** Burns the ticket; null when unknown, expired, or minted for another slug. */
  consumeTicket(token: string, slug: string): { userId: string } | null {
    const ticket = this.tickets.get(token);
    if (!ticket) return null;
    this.tickets.delete(token);
    if (ticket.expiresAt < this.now() || ticket.slug !== slug) return null;
    return { userId: ticket.userId };
  }

  async issueCookieValue(slug: string, userId: string): Promise<string> {
    const payload: CookiePayload = { s: slug, u: userId, e: this.now() + COOKIE_TTL_MS };
    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${encoded}.${await this.sign(encoded)}`;
  }

  /** The user the cookie vouches for on this slug, or null. */
  async verifyCookieValue(value: string | undefined, slug: string): Promise<string | null> {
    if (!value) return null;
    const dot = value.lastIndexOf(".");
    if (dot <= 0) return null;
    const encoded = value.slice(0, dot);
    const signature = value.slice(dot + 1);
    const expected = await this.sign(encoded);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    let payload: CookiePayload;
    try {
      payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as CookiePayload;
    } catch {
      return null;
    }
    if (payload.s !== slug || typeof payload.u !== "string" || typeof payload.e !== "number") return null;
    if (payload.e < this.now()) return null;
    return payload.u;
  }

  cookieMaxAgeSeconds(): number {
    return Math.floor(COOKIE_TTL_MS / 1000);
  }

  private async sign(data: string): Promise<string> {
    this.secret ??= this.loadSecret();
    return createHmac("sha256", await this.secret).update(data).digest("base64url");
  }

  private pruneTickets(): void {
    const now = this.now();
    for (const [token, ticket] of this.tickets) {
      if (ticket.expiresAt < now) this.tickets.delete(token);
    }
  }
}

/** `name=value; other=1` → map. Tolerates the junk real browsers send. */
export function parseCookieHeader(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    out.set(name, part.slice(eq + 1).trim());
  }
  return out;
}

/** The cookie header a dev server should see: everything but ours. */
export function stripPreviewCookies(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const kept = header
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !part.startsWith(`${PREVIEW_COOKIE_NAME}=`) && !part.startsWith("vdx_"));
  return kept.length > 0 ? kept.join("; ") : undefined;
}
