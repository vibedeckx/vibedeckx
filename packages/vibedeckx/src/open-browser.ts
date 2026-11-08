import type { ChildProcess } from "node:child_process";
import open from "open";

/**
 * Auto-open the UI for a local, interactive start. Skipped under TLS (the cert
 * is for the public domain, so https://localhost would just warn), in API-only
 * mode (nothing to show) and under --auth (a hosted server behind a proxy: no
 * desktop to open). Never fatal: without a browser (containers, SSH) `open`
 * spawns a missing xdg-open, whose unhandled 'error' event would otherwise
 * crash the server right after it started listening.
 */
export async function maybeOpenBrowser(
  opts: { url: string; tls: boolean; hasUi: boolean; authEnabled: boolean },
  openUrl: (url: string) => Promise<ChildProcess> = open,
): Promise<void> {
  if (opts.tls || !opts.hasUi || opts.authEnabled) return;
  try {
    const child = await openUrl(opts.url);
    child.on("error", () => {});
  } catch {
    // Opening a browser is a convenience; the server keeps running.
  }
}
