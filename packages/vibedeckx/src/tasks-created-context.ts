/**
 * The `<vtasks-created>` note the hub appends to a user message: the tasks the
 * user created from this session's propose_task cards since the agent was last
 * told, with their ids. A propose_task call returns before the user confirms
 * anything, so this is the only way the agent learns which proposals became
 * tasks — and the ids it can pass as `parent_task_id` to file sub-tasks.
 *
 * Unlike `<vremotes>` it is sent once per task: each task is marked reported
 * as soon as it rides out on a message. The UI hides the block entirely — it
 * is context for the agent, not something the user said.
 */
import type { Storage } from "./storage/types.js";

/** Strip the block from text destined for a title prompt or a UI preview. */
export const VTASKS_CREATED_BLOCK_RE = /<vtasks-created(?:\s[^>]*)?>[\s\S]*?<\/vtasks-created>/g;

type ContextStorage = Pick<Storage, "tasks" | "projects">;

const attr = (value: string) => value.replace(/[\r\n]+/g, " ").replace(/[&<>"]/g, (c) => (
  c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"
));

/**
 * The note for `sessionId`'s unreported tasks plus their ids, or `null` when
 * there are none. Tasks in a project `userId` can't see are left out — the
 * caller may not own the session it is posting to.
 */
export async function buildTasksCreatedContext(
  storage: ContextStorage,
  sessionId: string,
  userId: string | undefined,
): Promise<{ block: string; ids: string[] } | null> {
  const tasks = await storage.tasks.listUnreportedBySourceSession(sessionId);
  if (tasks.length === 0) return null;
  const owned = new Map<string, boolean>();
  const visible = [];
  for (const task of tasks) {
    if (!owned.has(task.project_id)) {
      owned.set(task.project_id, !!(await storage.projects.getById(task.project_id, userId)));
    }
    if (owned.get(task.project_id)) visible.push(task);
  }
  if (visible.length === 0) return null;

  const lines = visible.map((task) =>
    `<task id="${attr(task.id)}" title="${attr(task.title)}"${task.parent_id ? ` parent_id="${attr(task.parent_id)}"` : ""} />`);
  return {
    block: [
      '<vtasks-created note="Tasks the user created from your earlier propose_task proposals.'
        + ' For reference only, no action needed. Pass an id as parent_task_id to file sub-tasks under it.">',
      ...lines,
      "</vtasks-created>",
    ].join("\n"),
    ids: visible.map((task) => task.id),
  };
}
