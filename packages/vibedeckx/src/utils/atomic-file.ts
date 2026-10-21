import { spawnSync } from "node:child_process";
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

/**
 * Windows ignores POSIX modes: a new file inherits its directory's ACL. Strip
 * the inherited entries and grant only the current user. Throws if icacls
 * fails, so a secret is never left readable by others.
 */
export function restrictToCurrentUser(filePath: string, env: NodeJS.ProcessEnv = process.env): void {
  const user = env.USERDOMAIN ? `${env.USERDOMAIN}\\${env.USERNAME}` : env.USERNAME;
  if (!user) throw new Error(`Cannot restrict ${filePath}: USERNAME is not set`);
  const result = spawnSync("icacls", [filePath, "/inheritance:r", "/grant:r", `${user}:F`], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    const detail = (result.error?.message ?? `${result.stderr ?? ""}${result.stdout ?? ""}`).trim();
    throw new Error(`Restricting access to ${filePath} failed${detail ? `: ${detail}` : ""}`);
  }
}

export interface AtomicWriteOptions {
  mode?: number;
  /** Windows: readable by the current user only (the ACL counterpart of mode 0600). */
  private?: boolean;
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
    // Before the rename, so the file is never visible with the inherited ACL;
    // a rename within the volume keeps the file's own ACL.
    if (options.private && process.platform === "win32") restrictToCurrentUser(tempPath);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
  if (durable) fsyncDirectory(directory);
}
