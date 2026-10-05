"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Plus } from "lucide-react";
import { TaskTable } from "./task-table";
import { TaskDetailPanel } from "./task-detail-panel";
import { TaskDraftPanel, EMPTY_TASK_DRAFT, isDraftEmpty, type TaskDraft } from "./task-draft-panel";
import type { PendingTask } from "./task-row";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { PageHeader, FilterBar, FilterChip } from "@/components/layout";
import type { Task, TaskStatus, TaskPriority, Worktree } from "@/lib/api";

type StatusFilter = "all" | TaskStatus | "archived";

type Panel = { kind: "task"; taskId: string } | { kind: "draft" };
type ShownPanel = { kind: "task"; task: Task } | { kind: "draft"; draft: TaskDraft };

const CREATE_MORE_KEY = "vibedeckx:tasks:create-more";

const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "todo", label: "Todo" },
  { value: "in_progress", label: "Doing" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
  { value: "archived", label: "Archived" },
];

const motionAllowed = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface TasksViewProps {
  /** The view is kept mounted while hidden; only the visible one may own keys. */
  active?: boolean;
  projectId: string | null;
  tasks: Task[];
  loading: boolean;
  worktrees: Worktree[];
  onCreateTask: (opts: { title?: string; description: string; status?: TaskStatus; priority?: TaskPriority; assigned_branch?: string | null }) => Promise<Task | null>;
  onUpdateTask: (id: string, opts: { title?: string; description?: string | null; status?: TaskStatus; priority?: TaskPriority; assigned_branch?: string | null }) => Promise<Task | null>;
  onDeleteTask: (id: string) => Promise<void>;
  onArchiveTask: (id: string) => Promise<void>;
  onUnarchiveTask: (id: string) => Promise<void>;
  /** Jump to the conversation a proposed task came from, at its card. */
  onOpenSourceSession?: (task: Task) => void;
}

export function TasksView({ active = true, projectId, tasks, loading, worktrees, onCreateTask, onUpdateTask, onDeleteTask, onArchiveTask, onUnarchiveTask, onOpenSourceSession }: TasksViewProps) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  // Panel, draft, pending creates and the flash are all keyed by project, so
  // switching projects closes the panel and drops the draft.
  const [panelState, setPanelState] = useState<{ projectId: string | null; panel: Panel } | null>(null);
  const panel = panelState?.projectId === projectId ? panelState.panel : null;
  const selectedTaskId = panel?.kind === "task" ? panel.taskId : null;
  // Looked up across all tasks, not the filtered list: archiving or re-statusing
  // the open task from the panel keeps it open. A deleted task closes it.
  const selectedTask = selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) ?? null : null;
  const draftOpen = panel?.kind === "draft";
  const selectTask = useCallback(
    (taskId: string | null) => setPanelState(taskId ? { projectId, panel: { kind: "task", taskId } } : null),
    [projectId],
  );

  // The draft outlives a closed panel (✕ / Esc / opening a task) until it is
  // created or discarded.
  const [draftState, setDraftState] = useState<{ projectId: string | null; draft: TaskDraft } | null>(null);
  const draft = draftState?.projectId === projectId ? draftState.draft : EMPTY_TASK_DRAFT;
  const [createError, setCreateError] = useState<string | null>(null);
  const [focusNonce, setFocusNonce] = useState(0);
  const [createMore, setCreateMore] = useState(
    () => typeof window !== "undefined" && window.localStorage.getItem(CREATE_MORE_KEY) === "1",
  );
  const [pending, setPending] = useState<(PendingTask & { projectId: string | null })[]>([]);
  const [flash, setFlash] = useState<{ projectId: string | null; taskId: string } | null>(null);
  const flashTaskId = flash?.projectId === projectId ? flash.taskId : null;
  const pendingKey = useRef(0);

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(timer);
  }, [flash]);

  const openDraft = () => {
    setPanelState({ projectId, panel: { kind: "draft" } });
    setFocusNonce((n) => n + 1);
  };

  const updateDraft = (patch: Partial<TaskDraft>) =>
    setDraftState({ projectId, draft: { ...draft, ...patch } });

  const handleCreateMoreChange = (value: boolean) => {
    setCreateMore(value);
    window.localStorage.setItem(CREATE_MORE_KEY, value ? "1" : "0");
  };

  const handleCreate = async () => {
    const snapshot = draft;
    const description = snapshot.description.trim();
    if (!description) return;
    const createProjectId = projectId;
    const key = `pending-${++pendingKey.current}`;
    const title = snapshot.title.trim() || null;
    setPending((prev) => [...prev, { key, projectId: createProjectId, title, description, status: snapshot.status, priority: snapshot.priority }]);
    setCreateError(null);
    setDraftState(null);
    // Create more keeps the panel on a fresh draft; otherwise the panel closes
    // and the new row in the list is the confirmation.
    if (createMore) setFocusNonce((n) => n + 1);
    else setPanelState(null);

    const task = await onCreateTask({
      title: title ?? undefined,
      description,
      status: snapshot.status,
      priority: snapshot.priority,
      assigned_branch: snapshot.assigned_branch,
    });
    setPending((prev) => prev.filter((p) => p.key !== key));
    if (task) {
      setFlash({ projectId: createProjectId, taskId: task.id });
      return;
    }
    // Put the draft back (unless a newer one is already being written) and
    // reopen it with the error, so nothing typed is lost.
    setDraftState((current) =>
      current && current.projectId === createProjectId && !isDraftEmpty(current.draft)
        ? current
        : { projectId: createProjectId, draft: snapshot },
    );
    setPanelState((current) => current ?? { projectId: createProjectId, panel: { kind: "draft" } });
    setCreateError("Couldn't create the task. Your draft is restored, try again.");
  };

  const handleDiscard = () => {
    setDraftState(null);
    setCreateError(null);
    setPanelState(null);
  };

  const handleAssign = (taskId: string, branch: string | null) => {
    onUpdateTask(taskId, { assigned_branch: branch });
  };

  const activeTasks = useMemo(() => tasks.filter((t) => t.archived_at === null), [tasks]);
  const archivedTasks = useMemo(() => tasks.filter((t) => t.archived_at !== null), [tasks]);

  // Counts per chip. Status counts come from active tasks; "archived" counts the archived bucket.
  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = { all: activeTasks.length, todo: 0, in_progress: 0, done: 0, cancelled: 0, archived: archivedTasks.length };
    for (const t of activeTasks) c[t.status]++;
    return c;
  }, [activeTasks, archivedTasks]);

  const filteredTasks = useMemo(() => {
    if (statusFilter === "archived") return archivedTasks;
    if (statusFilter === "all") return activeTasks;
    return activeTasks.filter((t) => t.status === statusFilter);
  }, [activeTasks, archivedTasks, statusFilter]);

  const archivedView = statusFilter === "archived";

  const visiblePending = useMemo(
    () => pending.filter((p) => p.projectId === projectId && (statusFilter === "all" || statusFilter === p.status)),
    [pending, projectId, statusFilter],
  );

  // What the side panel shows. After it closes, the last content stays
  // mounted (as a snapshot) while the panel animates shut.
  const openPanel = useMemo<ShownPanel | null>(
    () => (draftOpen ? { kind: "draft", draft } : selectedTask ? { kind: "task", task: selectedTask } : null),
    [draftOpen, draft, selectedTask],
  );
  const [exitingPanel, setExitingPanel] = useState<ShownPanel | null>(null);
  if (openPanel && openPanel !== exitingPanel) setExitingPanel(openPanel);
  // Nothing animates without motion (or matchMedia), so drop the snapshot at once.
  else if (!openPanel && exitingPanel && !motionAllowed()) setExitingPanel(null);
  const closing = !openPanel && exitingPanel !== null;
  const shownPanel = openPanel ?? exitingPanel;

  // Backstop for an animationend that never comes.
  useEffect(() => {
    if (!closing) return;
    const timer = setTimeout(() => setExitingPanel(null), 400);
    return () => clearTimeout(timer);
  }, [closing]);

  const assignedBranches = useMemo(
    () => new Set(tasks.filter((t) => t.assigned_branch !== null).map((t) => t.assigned_branch)),
    [tasks]
  );

  if (!projectId) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        <div className="text-center">
          <div className="mx-auto w-10 h-10 rounded-xl bg-muted flex items-center justify-center mb-3">
            <Plus className="h-5 w-5 text-muted-foreground/50" />
          </div>
          <p className="text-sm">Select a project to view tasks.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Tasks"
        count={activeTasks.length}
        actions={
          <Button size="sm" onClick={openDraft} className="shadow-sm">
            <Plus className="h-3.5 w-3.5 mr-1.5" />
            New Task
          </Button>
        }
      />

      <FilterBar>
        {STATUS_FILTERS.map((f) => (
          <FilterChip
            key={f.value}
            active={statusFilter === f.value}
            count={counts[f.value]}
            onClick={() => setStatusFilter(f.value)}
          >
            {f.label}
          </FilterChip>
        ))}
      </FilterBar>

      <div className="flex-1 min-h-0">
        <ResizablePanelGroup direction="horizontal" autoSaveId="task-detail-panels">
          <ResizablePanel id="task-list" order={1} minSize={30}>
            {/* Container for the table's width queries: as the panel is dragged
                wider, Priority then Status drop out instead of scrolling sideways. */}
            <div className="@container h-full overflow-y-auto overflow-x-hidden px-5 edge-scrollbar">
              {loading ? (
                <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
                  Loading tasks...
                </div>
              ) : (
                <TaskTable
                  tasks={filteredTasks}
                  onUpdate={onUpdateTask}
                  onDelete={onDeleteTask}
                  onArchive={onArchiveTask}
                  onUnarchive={onUnarchiveTask}
                  archivedView={archivedView}
                  worktrees={worktrees}
                  onAssign={handleAssign}
                  onOpenSourceSession={onOpenSourceSession}
                  panelOpen={selectedTask !== null || draftOpen}
                  selectedTaskId={selectedTask?.id ?? null}
                  keyboardActive={active}
                  onSelect={selectTask}
                  pendingTasks={visiblePending}
                  flashTaskId={flashTaskId}
                  assignedBranches={assignedBranches}
                />
              )}
            </div>
          </ResizablePanel>
          {shownPanel && (
            <>
              <ResizableHandle />
              <ResizablePanel
                id="task-detail"
                order={2}
                defaultSize={40}
                minSize={25}
                className={closing ? "motion-safe:animate-side-panel-out" : "motion-safe:animate-side-panel-in"}
                onAnimationEnd={(e) => {
                  if (e.target === e.currentTarget && closing) setExitingPanel(null);
                }}
              >
                {/* Inert while closing: the stale copy can't be edited, and a
                    focused field blurs (and saves) right away. */}
                <div className="h-full" inert={closing}>
                  {shownPanel.kind === "draft" ? (
                    <TaskDraftPanel
                      draft={shownPanel.draft}
                      onChange={updateDraft}
                      onCreate={handleCreate}
                      onDiscard={handleDiscard}
                      onClose={() => selectTask(null)}
                      createMore={createMore}
                      onCreateMoreChange={handleCreateMoreChange}
                      error={createError}
                      focusNonce={focusNonce}
                      worktrees={worktrees}
                      assignedBranches={assignedBranches}
                    />
                  ) : (
                    <TaskDetailPanel
                      key={shownPanel.task.id}
                      task={shownPanel.task}
                      onUpdate={onUpdateTask}
                      onAssign={handleAssign}
                      onArchive={onArchiveTask}
                      onUnarchive={onUnarchiveTask}
                      onDelete={onDeleteTask}
                      onClose={() => selectTask(null)}
                      worktrees={worktrees}
                      assignedBranches={assignedBranches}
                      onOpenSourceSession={onOpenSourceSession}
                    />
                  )}
                </div>
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </div>
    </div>
  );
}
