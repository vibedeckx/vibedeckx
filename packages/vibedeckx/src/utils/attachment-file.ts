import { chmod, mkdir, open } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ATTACHMENT_DIR, sweepStaleTempFiles } from "./temp-file-sweep.js";

/**
 * Non-image attachments from the composer. Unlike images, neither agent
 * protocol has a content type for arbitrary files, so the file is written to
 * the agent's execution machine and the message carries only a
 * `<vfile path name size />` marker the agent follows with its own Read/shell
 * tooling — the same shape as long pastes (`paste-file.ts`).
 *
 * Layout: `<tmp>/vibedeckx-attachments/<uuid>/<original name>`. The per-upload
 * directory keeps the user's file name (and extension — what tells Read a PDF
 * from a notebook) without collisions between uploads.
 */

/**
 * Raw-byte cap. Sized so a base64 JSON body (4/3 overhead) still fits under
 * the reverse-connect tunnel's 11 MB frame limit on the way to a worker.
 */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;


// Attachments can contain secrets just like pastes: owner-only dir and file,
// never follow a pre-existing symlink at the target path.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const FILE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;
const MAX_NAME_LENGTH = 120;

export interface WrittenAttachment {
  path: string;
  name: string;
  size: number;
}

/**
 * Reduce a client-supplied file name to a safe basename: no path segments,
 * no control characters, none of the characters that would break the
 * `<vfile name="..."/>` marker, bounded length, never empty or dot-only.
 */
export function sanitizeAttachmentName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  let name = base.replace(/[\x00-\x1f\x7f"<>]/g, "").trim();
  if (name.length > MAX_NAME_LENGTH) {
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    name = stem.slice(0, Math.max(1, MAX_NAME_LENGTH - ext.length)) + ext;
  }
  if (!name || /^\.+$/.test(name)) return "attachment";
  return name;
}

export async function writeAttachmentToTempFile(rawName: string, data: Buffer): Promise<WrittenAttachment> {
  const name = sanitizeAttachmentName(rawName);
  await mkdir(ATTACHMENT_DIR, { recursive: true, mode: DIR_MODE });
  // mkdir's mode is ignored when the directory already exists; chmod ensures
  // existing dirs created under a permissive umask get tightened too.
  await chmod(ATTACHMENT_DIR, DIR_MODE);
  const dir = path.join(ATTACHMENT_DIR, randomUUID());
  await mkdir(dir, { mode: DIR_MODE });
  const filePath = path.join(dir, name);
  const handle = await open(filePath, FILE_FLAGS, FILE_MODE);
  try {
    await handle.writeFile(data);
  } finally {
    await handle.close();
  }
  void sweepStaleTempFiles();
  return { path: filePath, name, size: data.length };
}
