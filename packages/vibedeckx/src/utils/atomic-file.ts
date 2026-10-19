import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * fsync a directory so a rename/create inside it survives a hard reset.
 * Windows cannot open directories for fsync; NTFS journals the metadata and
 * there is nothing more to do, so it is a no-op there.
 */
export function fsyncDirectory(directory: string): void {
  if (process.platform === "win32") return;
  const fd = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export interface AtomicWriteOptions {
  mode?: number;
  /** fsync file and parent directory. Off only for high-frequency, disposable files. */
  durable?: boolean;
}

/**
 * Replace `filePath` with `contents` so readers only ever see the old or the
 * complete new file: write a sibling temp file, then rename it over the target.
 * With `durable` (the default) the result also survives a hard reset.
 */
export function writeFileAtomic(
  filePath: string,
  contents: string | Buffer,
  options: AtomicWriteOptions = {},
): void {
  const durable = options.durable ?? true;
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `.${path.basename(filePath)}.tmp-${process.pid}-${randomUUID()}`,
  );
  const fd = fs.openSync(tempPath, "wx", options.mode ?? 0o644);
  try {
    try {
      fs.writeFileSync(fd, contents);
      if (options.mode !== undefined) fs.fchmodSync(fd, options.mode);
      if (durable) fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
  if (durable) fsyncDirectory(directory);
}
