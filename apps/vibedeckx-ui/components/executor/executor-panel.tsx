"use client";

import { useCallback, useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button } from "@/components/ui/button";
import { Plus, Terminal, Monitor } from "lucide-react";
import { ExecutorItem } from "./executor-item";
import { ExecutorForm } from "./executor-form";
import { ExecutorLogsProvider } from "@/hooks/executor-logs-context";
import { useExecutors } from "@/hooks/use-executors";
import { ExecutionModeToggle, type ExecutionModeTarget } from "@/components/ui/execution-mode-toggle";
import { remoteConnectionIcon } from "@/hooks/use-project-remotes";
import { useProjectRemotesContext } from "@/hooks/project-remotes-context";
import { useFocusRegion } from "@/components/locate/focus-region";
import { useLocateScope, useLocateEngagement, isInOverlay } from "@/components/locate/locate-context";
import { isEditableTarget } from "@/lib/editable-target";
import type { Project, ExecutionMode } from "@/lib/api";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type CollisionDetection,
  type DroppableContainer,
  closestCenter,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";

interface ExecutorPanelProps {
  projectId: string | null;
  selectedBranch?: string | null;
  project?: Project | null;
  onExecutorModeChange?: (mode: ExecutionMode) => void;
  /** True while this panel is the visible right-panel tab (gates type-to-locate). */
  locateActive?: boolean;
}

// Custom collision detection that only considers the header region (52px) of each item
const HEADER_HEIGHT = 52;

const headerOnlyCollision: CollisionDetection = (args) => {
  const { droppableContainers, pointerCoordinates } = args;

  if (!pointerCoordinates) {
    return closestCenter(args);
  }

  // Find containers where pointer is within the header region
  const collisions: { id: string; data: { droppableContainer: DroppableContainer } }[] = [];

  for (const container of droppableContainers) {
    const rect = container.rect.current;
    if (!rect) continue;

    // Check if pointer is within the header region (top HEADER_HEIGHT pixels)
    const headerTop = rect.top;
    const headerBottom = rect.top + HEADER_HEIGHT;

    if (
      pointerCoordinates.x >= rect.left &&
      pointerCoordinates.x <= rect.right &&
      pointerCoordinates.y >= headerTop &&
      pointerCoordinates.y <= headerBottom
    ) {
      collisions.push({
        id: container.id as string,
        data: { droppableContainer: container },
      });
    }
  }

  if (collisions.length > 0) {
    return collisions;
  }

  // Fallback: find the closest header region
  let closest: { id: string; distance: number; data: { droppableContainer: DroppableContainer } } | null = null;

  for (const container of droppableContainers) {
    const rect = container.rect.current;
    if (!rect) continue;

    const headerCenterY = rect.top + HEADER_HEIGHT / 2;
    const centerX = rect.left + rect.width / 2;
    const distance = Math.sqrt(
      Math.pow(pointerCoordinates.x - centerX, 2) +
      Math.pow(pointerCoordinates.y - headerCenterY, 2)
    );

    if (!closest || distance < closest.distance) {
      closest = {
        id: container.id as string,
        distance,
        data: { droppableContainer: container },
      };
    }
  }

  return closest ? [{ id: closest.id, data: closest.data }] : [];
};

export function ExecutorPanel({ projectId, selectedBranch, project, onExecutorModeChange, locateActive }: ExecutorPanelProps) {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [openExecutors, setOpenExecutors] = useState<Set<string>>(new Set());
  const { remotes } = useProjectRemotesContext();
  const { region } = useFocusRegion();

  // Build execution mode targets from local path + project remotes
  const executorTargets: ExecutionModeTarget[] = [];
  if (project?.path) executorTargets.push({ id: "local", label: "Local", icon: Monitor });
  for (const r of remotes) {
    executorTargets.push({ id: r.remote_server_id, label: r.server_name, icon: remoteConnectionIcon(r) });
  }

  const {
    executors,
    loading: executorsLoading,
    createExecutor,
    updateExecutor,
    deleteExecutor,
    startExecutor,
    stopExecutor,
    markProcessFinished,
    reorderExecutors,
  } = useExecutors(projectId, selectedBranch, project?.executor_mode);

  const loading = executorsLoading;

  // Two gates, deliberately separate. The mark is shown whenever the tab is
  // visible with rows: a persisted tab restored on page load never claims the
  // focus region (RightPanel won't steal focus for a programmatic tab change),
  // and that path must still open with a current executor. Acting on it needs
  // the stronger gate — the right panel actually holding the keyboard.
  const listVisible = Boolean(locateActive && executors.length > 0);
  const keyboardActive = listVisible && region === "right-panel";

  const revealExecutor = useCallback((id: string) => {
    document.querySelector(`[data-locate-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
  }, []);
  // Enter = press the row's Start/Stop button, exactly as a click would
  // (ExecutorItem owns that logic, so we click the marked DOM button).
  const commitExecutor = useCallback((id: string) => {
    const row = document.querySelector(`[data-locate-id="${CSS.escape(id)}"]`);
    row?.scrollIntoView({ block: "nearest" });
    row?.querySelector<HTMLButtonElement>("[data-locate-action]")?.click();
  }, []);
  const openExecutorOutput = useCallback(
    (id: string) => {
      setOpenExecutors((prev) => new Set(prev).add(id));
      requestAnimationFrame(() => revealExecutor(id));
    },
    [revealExecutor],
  );

  // The current executor: a cursor that exists even with no query typed, so
  // entering the tab always has something marked to act on. Stored loosely and
  // resolved against the live list — a stale id (branch/target switch, delete)
  // falls back to the first row, while an id that survives keeps the mark
  // across tab switches and after Enter fires the row's action.
  const [cursorId, setCursorId] = useState<string | null>(null);
  const currentExecutorId = useMemo(() => {
    if (executors.length === 0) return null;
    if (cursorId && executors.some((e) => e.id === cursorId)) return cursorId;
    return executors[0].id;
  }, [cursorId, executors]);

  // Type-to-locate over the executor list. Outranks the sidebar workspace
  // scope (priority 0) exactly while the keyboard is here — an idle Esc
  // releases the region and typing goes back to locating workspaces.
  const executorLocate = useLocateEngagement("executors");
  useLocateScope(
    {
      id: "executors",
      label: "Executors",
      priority: 10,
      getItems: () => executors.map((e) => ({ id: e.id, text: e.name })),
      onCommit: (item) => commitExecutor(item.id),
      // Space = reveal the output area.
      onSecondaryCommit: (item) => openExecutorOutput(item.id),
    },
    keyboardActive,
  );

  // A locate query drives the mark while it is engaged, and hands the cursor
  // over on the way out: whatever ↑↓ landed on stays the current executor once
  // the query disengages (by commit or Esc). Adjusting state during render
  // (React's documented pattern) rather than in an effect keeps the mark from
  // flickering back to the old cursor for a frame.
  const locateSelectedId = executorLocate?.selectedId ?? null;
  const [seenLocateId, setSeenLocateId] = useState<string | null>(null);
  if (locateSelectedId !== seenLocateId) {
    // Tracking null too, so a later query that lands on the same row as an
    // earlier one still moves the cursor.
    setSeenLocateId(locateSelectedId);
    if (locateSelectedId !== null) setCursorId(locateSelectedId);
  }
  // Keep the marked row visible while ↑↓ walks past the fold.
  useEffect(() => {
    if (locateSelectedId === null) return;
    revealExecutor(locateSelectedId);
  }, [locateSelectedId, revealExecutor]);

  // While a query is engaged its own selection is the mark (which may be
  // nothing, when the query matches no row); otherwise it's the cursor.
  const markedExecutorId = executorLocate ? executorLocate.selectedId : listVisible ? currentExecutorId : null;

  const targetIds = useMemo(
    () => [...(project?.path ? ["local"] : []), ...remotes.map((r) => r.remote_server_id)],
    [project?.path, remotes],
  );
  const activeTargetId = project?.executor_mode ?? "local";
  const locateEngaged = executorLocate !== null;

  // Idle keyboard commands — same layering guards as type-to-locate, and off
  // while a query is engaged so the locate controller keeps its own ↑↓/Enter.
  // ↑↓ move the cursor, Enter fires the current executor's Start/Stop, ←/→
  // cycle the executor target (Local / remotes).
  useEffect(() => {
    if (!keyboardActive || locateEngaged) return;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (isEditableTarget(event.target) || isInOverlay(event.target)) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        if (targetIds.length < 2 || !onExecutorModeChange) return;
        event.preventDefault();
        const index = targetIds.indexOf(activeTargetId);
        const step = event.key === "ArrowRight" ? 1 : -1;
        onExecutorModeChange(targetIds[(index + step + targetIds.length) % targetIds.length] as ExecutionMode);
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const index = executors.findIndex((e) => e.id === currentExecutorId);
        const step = event.key === "ArrowDown" ? 1 : -1;
        const next = executors[(index + step + executors.length) % executors.length];
        setCursorId(next.id);
        revealExecutor(next.id);
        return;
      }
      // A focused button already turns Enter into its own click; only the
      // idle panel (or a plain row) delegates it to the cursor.
      if (event.key === "Enter" && currentExecutorId) {
        if (event.target instanceof Element && event.target.closest("button,a,[role='button']")) return;
        event.preventDefault();
        commitExecutor(currentExecutorId);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    keyboardActive,
    locateEngaged,
    targetIds,
    activeTargetId,
    onExecutorModeChange,
    executors,
    currentExecutorId,
    revealExecutor,
    commitExecutor,
  ]);

  // Clicking a row makes it current, so the mark never sits somewhere the
  // user has visibly moved on from.
  const handleListPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const row = event.target instanceof Element ? event.target.closest("[data-locate-id]") : null;
    const id = row?.getAttribute("data-locate-id");
    if (id) setCursorId(id);
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 8,
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = executors.findIndex((e) => e.id === active.id);
      const newIndex = executors.findIndex((e) => e.id === over.id);
      const newOrder = [...executors];
      const [moved] = newOrder.splice(oldIndex, 1);
      newOrder.splice(newIndex, 0, moved);
      reorderExecutors(newOrder.map((e) => e.id));
    }
  };

  if (!projectId) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <div className="mx-auto w-10 h-10 rounded-xl bg-muted flex items-center justify-center mb-3">
            <Terminal className="h-5 w-5 text-muted-foreground/50" />
          </div>
          <p className="text-sm">Select a project to manage executors</p>
        </div>
      </div>
    );
  }

  return (
    <ExecutorLogsProvider
      key={`${projectId ?? "none"}-${project?.executor_mode ?? "local"}`}
      projectId={projectId}
    >
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border/60 h-10">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold flex items-center gap-2 text-foreground">
            <Terminal className="h-3.5 w-3.5" />
            Executors
          </h2>
          {executorTargets.length > 1 && onExecutorModeChange && (
            <ExecutionModeToggle
              targets={executorTargets}
              activeTarget={project?.executor_mode ?? "local"}
              onTargetChange={onExecutorModeChange}
            />
          )}
        </div>
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setCreateDialogOpen(true)}>
          <Plus className="h-3 w-3 mr-1" />
          Add
        </Button>
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="p-4 space-y-3" onPointerDown={handleListPointerDown}>
          {loading ? (
            <div className="text-center text-muted-foreground py-8">
              Loading executors...
            </div>
          ) : executors.length === 0 ? (
            <div className="text-center text-muted-foreground py-8">
              <p>No executors configured</p>
              <p className="text-sm mt-1">
                Add an executor to run commands like &quot;npm run dev&quot;
              </p>
            </div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={headerOnlyCollision}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={executors.map((e) => e.id)}
                strategy={verticalListSortingStrategy}
              >
                {executors.map((executor) => (
                  <ExecutorItem
                    key={`${executor.id}-${project?.executor_mode ?? "local"}`}
                    executor={executor}
                    executorMode={project?.executor_mode ?? "local"}
                    locateQuery={executorLocate?.query ?? null}
                    locateMatch={executorLocate?.matchSet.has(executor.id) ?? false}
                    keyboardSelected={markedExecutorId === executor.id}
                    isOpen={openExecutors.has(executor.id)}
                    onOpenChange={(open) => setOpenExecutors(prev => {
                      const next = new Set(prev);
                      if (open) next.add(executor.id); else next.delete(executor.id);
                      return next;
                    })}
                    onStart={() => startExecutor(executor.id)}
                    onStop={(processId) => stopExecutor(executor.id, processId || executor.currentProcessId || undefined)}
                    onUpdate={(data) => updateExecutor(executor.id, data)}
                    onDelete={() => deleteExecutor(executor.id)}
                    onProcessFinished={(processId) => markProcessFinished(executor.id, processId)}
                  />
                ))}
              </SortableContext>
            </DndContext>
          )}
        </div>
      </div>

      <ExecutorForm
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onSubmit={async (data) => {
          await createExecutor(data);
        }}
      />
    </div>
    </ExecutorLogsProvider>
  );
}
