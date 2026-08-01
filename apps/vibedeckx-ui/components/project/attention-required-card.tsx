"use client";

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ExternalLink, RotateCcw } from "lucide-react";
import type { ProjectActivityAttentionItem } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { ActivityCard, ActivityCardCount, ActivityCardTitle } from "./activity-card";

interface AttentionRequiredCardProps {
  scopeKey: string;
  items: ProjectActivityAttentionItem[];
  onOpenAgentSession: (sessionId: string, target: string, branch: string | null) => void;
  onOpenScheduleRun: (runId: string, scheduleId?: string) => void;
  onRunScheduleAgain: (runId: string) => Promise<void> | void;
}

export function AttentionRequiredCard({
  scopeKey,
  items,
  onOpenAgentSession,
  onOpenScheduleRun,
  onRunScheduleAgain,
}: AttentionRequiredCardProps) {
  const runningRef = useRef(new Set<string>());
  const [running, setRunning] = useState<Set<string>>(() => new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const scopeGenerationRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    scopeGenerationRef.current += 1;
    runningRef.current.clear();
    setRunning(new Set());
    setActionError(null);
  }, [scopeKey]);

  const runAgain = async (runId: string) => {
    if (runningRef.current.has(runId)) return;
    const scopeGeneration = scopeGenerationRef.current;
    runningRef.current.add(runId);
    setRunning(new Set(runningRef.current));
    setActionError(null);
    try {
      await onRunScheduleAgain(runId);
    } catch (reason) {
      if (mountedRef.current && scopeGenerationRef.current === scopeGeneration) {
        setActionError(reason instanceof Error ? reason.message : "Failed to start schedule run");
      }
    } finally {
      if (scopeGenerationRef.current === scopeGeneration) {
        runningRef.current.delete(runId);
        if (mountedRef.current) setRunning(new Set(runningRef.current));
      }
    }
  };

  if (items.length === 0) {
    return (
      <div
        data-testid="attention-all-clear"
        className="flex flex-wrap items-center gap-2 rounded-[10px] border border-emerald-500/25 bg-emerald-500/5 px-3.5 py-3 text-[12.5px] text-emerald-700 dark:text-emerald-300"
      >
        <CheckCircle2 className="size-4 shrink-0" aria-hidden="true" />
        <span className="font-medium">All clear</span>
        <span className="text-muted-foreground">No failures need attention.</span>
      </div>
    );
  }

  return (
    <ActivityCard className="border-destructive/30">
      <ActivityCardTitle
        icon={<AlertTriangle className="size-3 text-destructive" aria-hidden="true" />}
        trailing={<ActivityCardCount className="text-destructive">{items.length}</ActivityCardCount>}
        className="border-b-destructive/20 bg-destructive/8"
      >
        Attention Required
      </ActivityCardTitle>

      {actionError ? (
        <p role="alert" className="border-b border-border/60 px-3.5 py-2 text-[12.5px] text-destructive">
          {actionError}
        </p>
      ) : null}

      {items.map((item) => (
        <div
          key={`${item.type}:${item.entityId}`}
          className="flex flex-wrap items-center gap-2.5 border-b border-border/60 px-3.5 py-2.5 last:border-b-0"
        >
          <span className="min-w-35 flex-1">
            <span className="block truncate text-[12.5px] font-medium">{item.title}</span>
            <span className="mt-0.5 block font-mono text-[10.5px] capitalize text-destructive">
              {item.status.replaceAll("_", " ")}
            </span>
          </span>
          <span className="flex shrink-0 gap-1.5">
            {item.type === "agent_session" ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label={`Open agent session: ${item.title}`}
                onClick={() => onOpenAgentSession(
                  item.entityId,
                  item.workspace?.target ?? item.target ?? "local",
                  item.workspace?.branch ?? null,
                )}
              >
                <ExternalLink className="size-3" aria-hidden="true" />
                Open session
              </Button>
            ) : (
              <>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`View output: ${item.title}`}
                  onClick={() => onOpenScheduleRun(item.entityId, undefined)}
                >
                  View output
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={`Run again: ${item.title}`}
                  disabled={running.has(item.entityId)}
                  onClick={() => void runAgain(item.entityId)}
                >
                  <RotateCcw className="size-3" aria-hidden="true" />
                  {running.has(item.entityId) ? "Starting…" : "Run again"}
                </Button>
              </>
            )}
          </span>
        </div>
      ))}
    </ActivityCard>
  );
}
