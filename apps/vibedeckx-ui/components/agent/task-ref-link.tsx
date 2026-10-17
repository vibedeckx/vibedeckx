"use client";

import type { ReactNode } from "react";
import { ListTodo } from "lucide-react";
import { useProposedTasks } from "@/hooks/use-proposed-tasks";
import type { SelectedTaskRef } from "@/lib/selected-tasks";
import { useOptionalAgentConversation } from "./agent-conversation";

const TASK_REF_PREFIX = "#ref:task:";

/** The task id of an agent's `[title](#ref:task:<id>)` link, or null. Same scheme as Project Chat. */
export function parseTaskRefHref(href: string | undefined): string | null {
  if (!href?.startsWith(TASK_REF_PREFIX)) return null;
  try {
    const id = decodeURIComponent(href.slice(TASK_REF_PREFIX.length));
    return id || null;
  } catch {
    return null;
  }
}

/**
 * Opens the task when it is one of this project's; otherwise (made up,
 * deleted, another project's, or outside a conversation) stays plain text.
 * A resolved link leads with a task icon unless `icon` is false (callers that
 * already show one).
 */
export function TaskRefLink({
  taskId,
  icon = true,
  children,
}: {
  taskId: string;
  icon?: boolean;
  children: ReactNode;
}) {
  const conversation = useOptionalAgentConversation();
  const { tasks } = useProposedTasks(conversation?.projectId ?? null, null, null);
  const task = tasks?.find((t) => t.id === taskId);
  const openTask = conversation?.openTask;
  if (!task || !openTask) return <>{children}</>;
  return (
    <a
      href={`${TASK_REF_PREFIX}${encodeURIComponent(taskId)}`}
      data-task-ref={taskId}
      className="cursor-pointer font-medium text-primary underline"
      onClick={(e) => {
        e.preventDefault();
        openTask(task);
      }}
    >
      {icon && <ListTodo aria-hidden className="mr-0.5 inline h-[1em] w-[1em] align-[-0.125em]" />}
      {children}
    </a>
  );
}

/** The `<vselected-tasks>` block on a user message's header: which tasks the message pointed at. */
export function SelectedTasksMeta({ refs }: { refs: SelectedTaskRef[] }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1 text-xs font-normal text-muted-foreground">
      <ListTodo className="h-3 w-3 shrink-0 self-center" />
      <span className="flex min-w-0 items-baseline gap-1 truncate">
        {refs.map((ref, i) => (
          <span key={ref.id} className="truncate">
            <TaskRefLink taskId={ref.id} icon={false}>{ref.title}</TaskRefLink>
            {i < refs.length - 1 && ","}
          </span>
        ))}
      </span>
    </span>
  );
}
