"use client";

import { useEffect, useMemo, useState } from "react";
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

  // Type-to-locate over the executor list. Outranks the sidebar workspace
  // scope (priority 0) exactly while this tab is showing AND the right panel
  // holds the keyboard focus region — an idle Esc releases the region and
  // typing goes back to locating workspaces.
  const executorLocate = useLocateEngagement("executors");
  useLocateScope(
    {
      id: "executors",
      label: "Executors",
      priority: 10,
      getItems: () => executors.map((e) => ({ id: e.id, text: e.name })),
      // Enter = press the row's Start/Stop button, exactly as a click would
      // (ExecutorItem owns that logic, so we click the marked DOM button).
      onCommit: (item) => {
        const row = document.querySelector(`[data-locate-id="${CSS.escape(item.id)}"]`);
        row?.scrollIntoView({ block: "nearest" });
        row?.querySelector<HTMLButtonElement>("[data-locate-action]")?.click();
      },
      // Space = reveal the output area.
      onSecondaryCommit: (item) => {
        setOpenExecutors((prev) => new Set(prev).add(item.id));
        requestAnimationFrame(() => {
          document
            .querySelector(`[data-locate-id="${CSS.escape(item.id)}"]`)
            ?.scrollIntoView({ block: "nearest" });
        });
      },
    },
    Boolean(locateActive && region === "right-panel" && executors.length > 0),
  );

  // Keep the locate candidate visible while ↑↓ cycles through matches.
  const locateSelectedId = executorLocate?.selectedId ?? null;
  useEffect(() => {
    if (locateSelectedId === null) return;
    document
      .querySelector(`[data-locate-id="${CSS.escape(locateSelectedId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [locateSelectedId]);

  // ←/→ cycle the executor target (Local / remotes) while this tab holds the
  // keyboard focus region — same layering guards as type-to-locate. Idle
  // only: while a locate query is engaged the arrows stay out of the way.
  const targetIds = useMemo(
    () => [...(project?.path ? ["local"] : []), ...remotes.map((r) => r.remote_server_id)],
    [project?.path, remotes],
  );
  const activeTargetId = project?.executor_mode ?? "local";
  const locateEngaged = executorLocate !== null;
  useEffect(() => {
    if (!locateActive || region !== "right-panel" || locateEngaged) return;
    if (targetIds.length < 2 || !onExecutorModeChange) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (isEditableTarget(event.target) || isInOverlay(event.target)) return;
      event.preventDefault();
      const index = targetIds.indexOf(activeTargetId);
      const step = event.key === "ArrowRight" ? 1 : -1;
      const next = targetIds[(index + step + targetIds.length) % targetIds.length];
      onExecutorModeChange(next as ExecutionMode);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [locateActive, region, locateEngaged, targetIds, activeTargetId, onExecutorModeChange]);

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
        <div className="p-4 space-y-3">
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
                    locateSelected={executorLocate?.selectedId === executor.id}
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
