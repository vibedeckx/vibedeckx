import { chmod, mkdir, open } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const PASTE_DIR = path.join(tmpdir(), "vibedeckx-pastes");

// Pastes can contain secrets (API keys, .env contents, tokens). Restrict the
// directory and each file to the vibedeckx process owner only, and refuse to
// follow a pre-existing symlink at the target path.
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const FILE_FLAGS = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW;

export interface WrittenPaste {
  path: string;
  size: number;
}

export async function writePasteToTempFile(content: string): Promise<WrittenPaste> {
  await mkdir(PASTE_DIR, { recursive: true, mode: DIR_MODE });
  // mkdir's mode is ignored when the directory already exists; chmod ensures
  // existing dirs created under a permissive umask get tightened too.
  await chmod(PASTE_DIR, DIR_MODE);
  const filePath = path.join(PASTE_DIR, `${randomUUID()}.txt`);
  const handle = await open(filePath, FILE_FLAGS, FILE_MODE);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  return { path: filePath, size: Buffer.byteLength(content, "utf8") };
}
