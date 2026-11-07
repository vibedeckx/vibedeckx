import { randomBytes } from "crypto";
import type { Kysely } from "kysely";
import type { DB } from "../schema.js";
import type { PreviewLink, Storage } from "../types.js";

/**
 * Slug alphabet: lowercase letters and digits that survive being read aloud
 * (no 0/o, 1/l/i). Slugs are DNS labels, so nothing else is allowed anyway.
 */
const SLUG_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const SLUG_LENGTH = 10;

export function generatePreviewSlug(): string {
  const bytes = randomBytes(SLUG_LENGTH);
  let out = "";
  for (let i = 0; i < SLUG_LENGTH; i++) out += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
  return out;
}

/** Local-machine sentinel for `target_id`, matching workspace_checkouts. */
export const LOCAL_PREVIEW_TARGET = "local";

/**
 * Preview links (docs/preview-links-design.md): one row per
 * (project, machine, port), addressed by the slug that becomes its hostname.
 * Reads by slug are unscoped — the preview proxy has only the hostname and
 * checks the row's `user_id` against the cookie itself.
 */
export const createPreviewLinkRepo = (kdb: Kysely<DB>): Pick<Storage, "previewLinks"> => ({
  previewLinks: {
    getBySlug: async (slug) => {
      const row = await kdb.selectFrom("preview_links").selectAll().where("slug", "=", slug).executeTakeFirst();
      return row ?? undefined;
    },

    listByProject: async (projectId, userId) => {
      let query = kdb.selectFrom("preview_links").selectAll().where("project_id", "=", projectId);
      if (userId !== undefined) query = query.where("user_id", "=", userId);
      return query.orderBy("created_at", "asc").orderBy("slug", "asc").execute();
    },

    upsert: async ({ projectId, targetId, port, userId }) => {
      const existing = await kdb
        .selectFrom("preview_links")
        .selectAll()
        .where("project_id", "=", projectId)
        .where("target_id", "=", targetId)
        .where("port", "=", port)
        .executeTakeFirst();
      if (existing) {
        // The link is the project's, not the minter's: a second user of the
        // same project (hosted mode never has one today) would still need the
        // cookie to match, so record who last asked for it.
        if (existing.user_id !== userId) {
          await kdb.updateTable("preview_links").set({ user_id: userId }).where("slug", "=", existing.slug).execute();
          return { ...existing, user_id: userId };
        }
        return existing;
      }
      const link: PreviewLink = {
        slug: generatePreviewSlug(),
        project_id: projectId,
        target_id: targetId,
        port,
        user_id: userId,
        created_at: new Date().toISOString(),
        last_used_at: null,
      };
      await kdb.insertInto("preview_links").values(link).execute();
      return link;
    },

    touch: async (slug) => {
      await kdb
        .updateTable("preview_links")
        .set({ last_used_at: new Date().toISOString() })
        .where("slug", "=", slug)
        .execute();
    },

    delete: async (slug, userId) => {
      let query = kdb.deleteFrom("preview_links").where("slug", "=", slug);
      if (userId !== undefined) query = query.where("user_id", "=", userId);
      const result = await query.executeTakeFirst();
      return (result?.numDeletedRows ?? 0n) > 0n;
    },

    deleteByTarget: async (targetId) => {
      await kdb.deleteFrom("preview_links").where("target_id", "=", targetId).execute();
    },
  },
});
