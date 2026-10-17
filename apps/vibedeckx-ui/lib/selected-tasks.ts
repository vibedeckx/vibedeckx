import type { ContentPart } from "@/hooks/use-agent-session";
import type { Task } from "@/lib/api";

/**
 * The composer's Select task: tasks the user picked from the project's task
 * list to discuss, work on or change in this message. Sent as a
 * `<vselected-tasks>` block appended to the message, carrying each task's
 * content as of picking (not refetched on send) — so the agent needs no
 * get_task call to read it, and sessions without the task tools (a worker's
 * proposals-only fallback) can still use it. Each task also lists its direct
 * sub-tasks (id, title, status), taken from the same list the picker loaded.
 * The transcript shows the block as a header meta, and the hub strips it from
 * titles (utils/conversation-title.ts).
 */
export const VSELECTED_TASKS_MARKER_RE = /<vselected-tasks(?:\s[^>]*)?>[\s\S]*?<\/vselected-tasks>/g;

const NOTE =
  "Tasks the user selected from the project's task list for this message, with their content as of selection."
  + " Act on what the user says about them. To change one, propose it with propose_task_update and its id;"
  + " to file sub-tasks, pass its id as parent_task_id to propose_task. Never change a task unless the user asks."
  + " A task's existing direct sub-tasks are listed as <subtask> entries; read one in full with get_task when available."
  + " When you mention one to the user, link it as [title](#ref:task:<id>).";

const escapeAttr = (value: string) => value.replace(/[\r\n]+/g, " ").replace(/[&<>"]/g, (c) => (
  c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"
));
const unescapeAttr = (value: string) =>
  value.replace(/&(amp|lt|gt|quot);/g, (_m, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"' })[e]!);

/** A description may itself contain a closing tag; neutralize ours so it can't end the block early. */
const guardBody = (text: string) => text.replace(/<\/(task|vselected-tasks)>/gi, "<\\/$1>");

export type SelectedTaskSubtask = Pick<Task, "id" | "title" | "status">;

/** A picked task as the block needs it: the task plus its direct sub-tasks as of picking. */
export type SelectedTask = Pick<Task, "id" | "title" | "status" | "priority" | "description"> & {
  subtasks?: SelectedTaskSubtask[];
};

/** The direct sub-tasks of `parentId` in a loaded task list, in list order. */
export function directSubtasks(tasks: Pick<Task, "id" | "title" | "status" | "parent_id">[], parentId: string): SelectedTaskSubtask[] {
  return tasks.filter((t) => t.parent_id === parentId).map(({ id, title, status }) => ({ id, title, status }));
}

export function buildSelectedTasksBlock(tasks: SelectedTask[]): string {
  return [
    `<vselected-tasks note="${escapeAttr(NOTE)}">`,
    ...tasks.map((task) => [
      `<task id="${escapeAttr(task.id)}" title="${escapeAttr(task.title)}" status="${task.status}" priority="${task.priority}">`,
      guardBody(task.description?.trim() || "(no description)"),
      ...(task.subtasks ?? []).map((sub) =>
        `<subtask id="${escapeAttr(sub.id)}" title="${escapeAttr(sub.title)}" status="${sub.status}" />`),
      "</task>",
    ].join("\n")),
    "</vselected-tasks>",
  ].join("\n");
}

/** Append the block to composed message content, after any text and markers. */
export function appendSelectedTasks(
  content: string | ContentPart[],
  tasks: SelectedTask[],
): string | ContentPart[] {
  if (tasks.length === 0) return content;
  const block = buildSelectedTasksBlock(tasks);
  if (typeof content === "string") return content.length > 0 ? `${content}\n\n${block}` : block;
  return [...content, { type: "text", text: block }];
}

export interface SelectedTaskRef {
  id: string;
  title: string;
}

/** Pull the block out of message text; `refs` lists the tasks it named, null when there was none. */
export function takeSelectedTasksMarker(text: string): { text: string; refs: SelectedTaskRef[] | null } {
  let refs: SelectedTaskRef[] | null = null;
  const stripped = text.replace(new RegExp(VSELECTED_TASKS_MARKER_RE.source, "g"), (block) => {
    refs ??= [];
    for (const m of block.matchAll(/<task id="([^"]*)" title="([^"]*)"/g)) {
      refs.push({ id: unescapeAttr(m[1]), title: unescapeAttr(m[2]) });
    }
    return "";
  });
  return refs === null ? { text, refs: null } : { text: stripped.trimEnd(), refs };
}
