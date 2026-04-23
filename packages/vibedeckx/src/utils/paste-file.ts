import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const PASTE_DIR = path.join(tmpdir(), "vibedeckx-pastes");

export interface WrittenPaste {
  path: string;
  size: number;
}

export async function writePasteToTempFile(content: string): Promise<WrittenPaste> {
  await mkdir(PASTE_DIR, { recursive: true });
  const filePath = path.join(PASTE_DIR, `${randomUUID()}.txt`);
  await writeFile(filePath, content, "utf8");
  return { path: filePath, size: Buffer.byteLength(content, "utf8") };
}
