/**
 * Preview-host configuration (docs/preview-links-design.md §Host configuration).
 *
 * A preview link is served at `<slug>.<hostname>[:port]`. The hostname is a
 * separate registrable domain in production (never a subdomain of the app:
 * Clerk cookies set on the app's parent domain would otherwise ride along to
 * previews) and `preview.localhost` by default in solo mode, which browsers
 * resolve to loopback without any DNS setup.
 */

export interface PreviewHostConfig {
  /** Registrable preview domain, lowercase, no scheme, no port (`vdxpreview.dev`). */
  hostname: string;
  /** Port the browser must put in the URL; null when the scheme's default. */
  port: number | null;
  scheme: "http" | "https";
}

const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const SLUG_RE = /^[a-z0-9]{4,32}$/;

export class PreviewHostConfigError extends Error {}

/**
 * Resolve the preview host from the flag/env value. Returns null when preview
 * links are disabled: no value under `--auth` (fail closed — the old
 * same-origin proxy is exactly what must never be the fallback). Solo mode
 * without a value defaults to `preview.localhost:<listen port>`.
 */
export function resolvePreviewHostConfig(opts: {
  value: string | undefined;
  authEnabled: boolean;
  tls: boolean;
  publicUrl: string | undefined;
  listenPort: number;
}): PreviewHostConfig | null {
  const scheme = schemeFor(opts);
  const raw = opts.value?.trim();
  if (!raw) {
    if (opts.authEnabled) return null;
    return { hostname: "preview.localhost", port: defaultPortOr(scheme, opts.listenPort), scheme };
  }
  const withoutScheme = raw.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const [hostPart, portPart, ...rest] = withoutScheme.split(":");
  if (rest.length > 0) throw new PreviewHostConfigError(`Invalid preview host "${raw}": expected host[:port]`);
  const hostname = hostPart.toLowerCase();
  if (!HOSTNAME_RE.test(hostname) || hostname.startsWith("*")) {
    throw new PreviewHostConfigError(`Invalid preview host "${raw}": not a hostname (no scheme, path or wildcard)`);
  }
  let port: number | null = null;
  if (portPart !== undefined) {
    port = Number(portPart);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new PreviewHostConfigError(`Invalid preview host "${raw}": bad port`);
    }
    port = defaultPortOr(scheme, port);
  }
  return { hostname, port, scheme };
}

function schemeFor(opts: { tls: boolean; publicUrl: string | undefined }): "http" | "https" {
  const publicUrl = opts.publicUrl?.trim();
  if (publicUrl) {
    try {
      return new URL(publicUrl).protocol === "https:" ? "https" : "http";
    } catch {
      // Fall through to the TLS answer; the public URL is validated elsewhere.
    }
  }
  return opts.tls ? "https" : "http";
}

function defaultPortOr(scheme: "http" | "https", port: number): number | null {
  return (scheme === "https" && port === 443) || (scheme === "http" && port === 80) ? null : port;
}

/** `k7f2qa.vdxpreview.dev:8444` → `k7f2qa`; anything not a one-label child of the preview host → null. */
export function previewSlugFromHost(hostHeader: string | undefined, config: PreviewHostConfig): string | null {
  if (!hostHeader) return null;
  const host = hostHeader.trim().toLowerCase();
  // Strip a port; IPv6 literals can't be preview hosts, so a bare split is fine.
  const hostname = host.startsWith("[") ? host : host.split(":")[0];
  const suffix = `.${config.hostname}`;
  if (!hostname.endsWith(suffix)) return null;
  const slug = hostname.slice(0, -suffix.length);
  return SLUG_RE.test(slug) ? slug : null;
}

export function previewOrigin(slug: string, config: PreviewHostConfig): string {
  return `${config.scheme}://${slug}.${config.hostname}${config.port ? `:${config.port}` : ""}`;
}

export function isValidPreviewSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}
