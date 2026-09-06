import { describe, it, expect, afterEach } from "vitest";
import { readFile, stat, utimes, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { sanitizeAttachmentName, writeAttachmentToTempFile } from "./attachment-file.js";
import { ATTACHMENT_DIR, PASTE_DIR, sweepStaleTempFiles } from "./temp-file-sweep.js";
import { writePasteToTempFile } from "./paste-file.js";

const created: string[] = [];
afterEach(async () => {
  for (const p of created.splice(0)) await rm(p, { recursive: true, force: true });
});

describe("sanitizeAttachmentName", () => {
  it("keeps a plain name and extension", () => {
    expect(sanitizeAttachmentName("report.pdf")).toBe("report.pdf");
  });
  it("strips path segments, control chars and marker-breaking chars", () => {
    expect(sanitizeAttachmentName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeAttachmentName("C:\\Users\\x\\notes.txt")).toBe("notes.txt");
    expect(sanitizeAttachmentName('a"b<c>d\x00e.csv')).toBe("abcde.csv");
  });
  it("falls back for empty or dot-only names", () => {
    expect(sanitizeAttachmentName("")).toBe("attachment");
    expect(sanitizeAttachmentName("..")).toBe("attachment");
    expect(sanitizeAttachmentName("/")).toBe("attachment");
  });
  it("bounds length while preserving the extension", () => {
    const name = sanitizeAttachmentName("x".repeat(500) + ".tar.gz");
    expect(name.length).toBeLessThanOrEqual(120);
    expect(name.endsWith(".gz")).toBe(true);
  });
});

describe("writeAttachmentToTempFile", () => {
  it("writes bytes under a per-upload dir keeping the file name, owner-only", async () => {
    const data = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
    const written = await writeAttachmentToTempFile("spec.pdf", data);
    created.push(path.dirname(written.path));
    expect(written.name).toBe("spec.pdf");
    expect(written.size).toBe(6);
    expect(path.basename(written.path)).toBe("spec.pdf");
    expect(path.dirname(path.dirname(written.path))).toBe(ATTACHMENT_DIR);
    expect(await readFile(written.path)).toEqual(data);
    const info = await stat(written.path);
    expect(info.mode & 0o777).toBe(0o600);
    const dirInfo = await stat(path.dirname(written.path));
    expect(dirInfo.mode & 0o777).toBe(0o700);
  });

  it("does not collide when the same name is uploaded twice", async () => {
    const a = await writeAttachmentToTempFile("same.txt", Buffer.from("a"));
    const b = await writeAttachmentToTempFile("same.txt", Buffer.from("b"));
    created.push(path.dirname(a.path), path.dirname(b.path));
    expect(a.path).not.toBe(b.path);
    expect((await readFile(b.path)).toString()).toBe("b");
  });
});

describe("sweepStaleTempFiles", () => {
  it("removes entries older than maxAge and keeps fresh ones", async () => {
    const fresh = await writeAttachmentToTempFile("fresh.txt", Buffer.from("f"));
    created.push(path.dirname(fresh.path));
    const staleDir = path.join(ATTACHMENT_DIR, "stale-test-" + Date.now());
    await mkdir(staleDir, { recursive: true });
    await writeFile(path.join(staleDir, "old.txt"), "o");
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await utimes(staleDir, old, old);
    created.push(staleDir);

    const removed = await sweepStaleTempFiles({ force: true });
    expect(removed).toBeGreaterThanOrEqual(1);
    await expect(stat(staleDir)).rejects.toThrow();
    await expect(stat(fresh.path)).resolves.toBeTruthy();
  });

  it("also covers the paste dir", async () => {
    const fresh = await writePasteToTempFile("keep me");
    created.push(fresh.path);
    const stale = path.join(PASTE_DIR, "stale-test-" + Date.now() + ".txt");
    await writeFile(stale, "o");
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await utimes(stale, old, old);
    created.push(stale);

    await sweepStaleTempFiles({ force: true });
    await expect(stat(stale)).rejects.toThrow();
    await expect(stat(fresh.path)).resolves.toBeTruthy();
  });

  it("is throttled without force", async () => {
    await sweepStaleTempFiles({ force: true, now: 1_000_000 });
    expect(await sweepStaleTempFiles({ now: 1_000_000 + 1000 })).toBe(0);
  });
});
