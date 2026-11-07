import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createSqliteStorage } from "./sqlite.js";
import type { Storage } from "./types.js";

/** docs/preview-links-design.md §Storage */
describe("previewLinks", () => {
  let dir: string;
  let storage: Storage;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "vdx-preview-links-"));
    storage = await createSqliteStorage(path.join(dir, "test.sqlite"));
    await storage.projects.create({ id: "p1", name: "One", path: dir }, "user-1");
  });

  afterEach(async () => {
    await storage.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("upsert reuses the row for the same machine+port and mints distinct slugs otherwise", async () => {
    const a = await storage.previewLinks.upsert({ projectId: "p1", targetId: "local", port: 3000, userId: "user-1" });
    const again = await storage.previewLinks.upsert({ projectId: "p1", targetId: "local", port: 3000, userId: "user-1" });
    const b = await storage.previewLinks.upsert({ projectId: "p1", targetId: "local", port: 5173, userId: "user-1" });
    expect(again.slug).toBe(a.slug);
    expect(b.slug).not.toBe(a.slug);
    expect(a.slug).toMatch(/^[a-z0-9]{10}$/);
    expect(await storage.previewLinks.getBySlug(a.slug)).toMatchObject({ project_id: "p1", target_id: "local", port: 3000, user_id: "user-1" });
    // Ordered by created_at, then slug: back-to-back upserts usually share a
    // millisecond, so the random slug decides — not insertion order.
    const expected = [a, b].sort((x, y) => x.created_at.localeCompare(y.created_at) || x.slug.localeCompare(y.slug));
    expect((await storage.previewLinks.listByProject("p1", "user-1")).map((l) => l.slug)).toEqual(expected.map((l) => l.slug));
    expect(await storage.previewLinks.listByProject("p1", "someone-else")).toEqual([]);
  });

  it("touch records use; delete is scoped to the user", async () => {
    const a = await storage.previewLinks.upsert({ projectId: "p1", targetId: "local", port: 3000, userId: "user-1" });
    expect(a.last_used_at).toBeNull();
    await storage.previewLinks.touch(a.slug);
    expect((await storage.previewLinks.getBySlug(a.slug))?.last_used_at).toBeTruthy();
    expect(await storage.previewLinks.delete(a.slug, "user-2")).toBe(false);
    expect(await storage.previewLinks.delete(a.slug, "user-1")).toBe(true);
    expect(await storage.previewLinks.getBySlug(a.slug)).toBeUndefined();
  });

  it("leaves with its project and with its machine", async () => {
    const server = await storage.remoteServers.create({ name: "box" }, "user-1");
    const onBox = await storage.previewLinks.upsert({ projectId: "p1", targetId: server.id, port: 3000, userId: "user-1" });
    const onLocal = await storage.previewLinks.upsert({ projectId: "p1", targetId: "local", port: 3000, userId: "user-1" });

    await storage.remoteServers.delete(server.id, "user-1");
    expect(await storage.previewLinks.getBySlug(onBox.slug)).toBeUndefined();
    expect(await storage.previewLinks.getBySlug(onLocal.slug)).toBeDefined();

    await storage.projects.delete("p1", "user-1");
    expect(await storage.previewLinks.getBySlug(onLocal.slug)).toBeUndefined();
  });
});
