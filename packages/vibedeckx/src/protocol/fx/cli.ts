import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import type { SpawnConfig } from "../../agent-provider.js";

const permissionOverrideCache = new Map<string, { fingerprint: string; supported: boolean }>();

/** Probe ACP itself: interactive flags are not necessarily supported by ACP. */
export function supportsFxPermissionOverride(binary: string): boolean {
  let fingerprint = binary;
  try {
    const stat = statSync(binary);
    fingerprint = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch { /* Missing binaries still get the usual spawn failure. */ }
  const cached = permissionOverrideCache.get(binary);
  if (cached?.fingerprint === fingerprint) return cached.supported;
  let supported = false;
  try {
    const help = execFileSync(binary, ["acp", "--help"], {
      encoding: "utf8", timeout: 5000, env: { ...process.env, FX_AUTO_UPGRADE: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    supported = /--permission-mode\s+<mode>/.test(help);
  } catch { /* Handshake validates the starting mode when probing fails. */ }
  permissionOverrideCache.set(binary, { fingerprint, supported });
  return supported;
}

export function buildFxSpawnConfig(binary: string | null, model?: string | null, logFile?: string): SpawnConfig {
  const args = ["acp"];
  // 0.0.17 supports a process-local override. 0.0.16 does not: its native
  // starting mode is checked in the handshake, without writing global settings.
  if (binary && supportsFxPermissionOverride(binary)) args.push("--permission-mode", "auto");
  if (model?.trim()) args.push("--model", model.trim());
  if (logFile) args.push("--log-file", logFile);
  // Use the original profile and its credential locks. Never copy refresh tokens.
  return { command: binary ?? "fx", args, env: { FX_AUTO_UPGRADE: "0" }, shell: false };
}
