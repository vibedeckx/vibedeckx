import { describe, expect, it, vi } from "vitest";
import { listProjectChatPublicContextRefs } from "./project-chat-context.js";
import type { ProjectChatContextRef, ProjectChatThread, Storage } from "./storage/types.js";

describe("Project Chat Context projection", () => {
  it("resolves a bounded page with one batch call instead of one query per ref", async () => {
    const refs = Array.from({ length: 100 }, (_, index): ProjectChatContextRef => ({
      thread_id: "thread", entity_type: "task", entity_id: `task-${index}`,
      last_referenced_at: "2026-07-31 00:00:00",
    }));
    const listByThread = vi.fn().mockResolvedValue(refs);
    const resolveExisting = vi.fn().mockResolvedValue(
      refs.filter((_, index) => index % 2 === 0).map(({ entity_type, entity_id }) => ({
        entity_type,
        entity_id,
        navigation: { kind: "task", taskId: entity_id, label: `Task ${entity_id}` },
      })),
    );
    const storage = { projectChatContextRefs: { listByThread, resolveExisting } } as unknown as Storage;
    const thread = {
      id: "thread", project_id: "project", user_id: "user", title: null,
      created_at: "", updated_at: "", archived_at: null,
    } satisfies ProjectChatThread;

    const projected = await listProjectChatPublicContextRefs(storage, thread);

    expect(listByThread).toHaveBeenCalledWith("thread", "project", "user", 100);
    expect(resolveExisting).toHaveBeenCalledOnce();
    expect(projected.filter((ref) => !ref.deleted)).toHaveLength(50);
    expect(projected.filter((ref) => ref.deleted)).toHaveLength(50);
    expect(projected[0]).toMatchObject({
      deleted: false,
      navigation: { kind: "task", taskId: "task-0", label: "Task task-0" },
    });
    expect(projected[1]).toMatchObject({ deleted: true, navigation: null });
  });
});
