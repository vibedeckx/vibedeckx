import { readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/** Long pastes (`paste-file.ts`): one `<uuid>.txt` per paste. */
export const PASTE_DIR = path.join(tmpdir(), "vibedeckx-pastes");
/** Composer attachments (`attachment-file.ts`): one `<uuid>/<name>` per upload. */
export const ATTACHMENT_DIR = path.join(tmpdir(), "vibedeckx-attachments");

/** Temp entries older than this are removed by the opportunistic sweep. */
export const TEMP_FILE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_MIN_INTERVAL_MS = 60 * 60 * 1000;

let lastSweepAt = 0;

/**
 * Remove paste and attachment temp entries older than `maxAgeMs`. Not a timer:
 * both writers call it after each write, and it runs at most once per hour per
 * process unless `force` is set. Errors are swallowed because cleanup must
 * never fail an upload.
 */
export async function sweepStaleTempFiles(opts: { maxAgeMs?: number; force?: boolean; now?: number } = {}): Promise<number> {
  const now = opts.now ?? Date.now();
  if (!opts.force && now - lastSweepAt < SWEEP_MIN_INTERVAL_MS) return 0;
  lastSweepAt = now;
  const maxAgeMs = opts.maxAgeMs ?? TEMP_FILE_MAX_AGE_MS;
  let removed = 0;
  for (const dir of [ATTACHMENT_DIR, PASTE_DIR]) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry);
      try {
        const info = await stat(full);
        if (now - info.mtimeMs <= maxAgeMs) continue;
        await rm(full, { recursive: true, force: true });
        removed++;
      } catch {
        // best effort
      }
    }
  }
  return removed;
}
