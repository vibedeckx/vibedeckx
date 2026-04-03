"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Plus, Terminal, FolderPlus, Monitor, Cloud } from "lucide-react";
import { ExecutorItem } from "./executor-item";
import { ExecutorForm } from "./executor-form";
import { useExecutors } from "@/hooks/use-executors";
import { useExecutorGroups } from "@/hooks/use-executor-groups";
import { ExecutionModeToggle, type ExecutionModeTarget } from "@/components/ui/execution-mode-toggle";
import { useProjectRemotes } from "@/hooks/use-project-remotes";
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

export function ExecutorPanel({ projectId, selectedBranch, project, onExecutorModeChange }: ExecutorPanelProps) {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [openExecutors, setOpenExecutors] = useState<Set<string>>(new Set());
  const { remotes } = useProjectRemotes(project?.id ?? undefined);

  // Build execution mode targets from local path + project remotes
  const executorTargets: ExecutionModeTarget[] = [];
  if (project?.path) executorTargets.push({ id: "local", label: "Local", icon: Monitor });
  for (const r of remotes) {
    executorTargets.push({ id: r.remote_server_id, label: r.server_name, icon: Cloud });
  }

  const { activeGroup, loading: groupLoading, createGroup } = useExecutorGroups(projectId, selectedBranch);
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
  } = useExecutors(projectId, activeGroup?.id, project?.executor_mode);

  const loading = groupLoading || executorsLoading;

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
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-4 py-2 border-b border-border/60 h-10">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold flex items-center gap-2 text-foreground">
            <Terminal className="h-3.5 w-3.5" />
            {activeGroup ? activeGroup.name : "Executors"}
          </h2>
          {executorTargets.length > 1 && onExecutorModeChange && (
            <ExecutionModeToggle
              targets={executorTargets}
              activeTarget={project?.executor_mode ?? "local"}
              onTargetChange={onExecutorModeChange}
            />
          )}
        </div>
        {activeGroup && (
          <Button size="sm" onClick={() => setCreateDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-1" />
            Add
          </Button>
        )}
      </div>

      <ScrollArea className="flex-1 overflow-hidden">
        <div className="p-4 space-y-3">
          {loading ? (
            <div className="text-center text-muted-foreground py-8">
              Loading executors...
            </div>
          ) : !activeGroup ? (
            <div className="text-center text-muted-foreground py-8">
              <p>No executor group for this branch</p>
              <p className="text-sm mt-1 mb-4">
                Create a group to start adding executors
              </p>
              <Button
                size="sm"
                onClick={() => createGroup(selectedBranch ? `Executors (${selectedBranch})` : "Default")}
              >
                <FolderPlus className="h-4 w-4 mr-1" />
                Create Group
              </Button>
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
                    isOpen={openExecutors.has(executor.id)}
                    onOpenChange={(open) => setOpenExecutors(prev => {
                      const next = new Set(prev);
                      if (open) next.add(executor.id); else next.delete(executor.id);
                      return next;
                    })}
                    onStart={() => startExecutor(executor.id, selectedBranch)}
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
      </ScrollArea>

      <ExecutorForm
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onSubmit={async (data) => {
          await createExecutor(data);
        }}
      />
    </div>
  );
}
