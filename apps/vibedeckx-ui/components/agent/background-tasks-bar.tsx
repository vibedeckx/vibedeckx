"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Terminal, Bot } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/format-duration";
import type { BackgroundTask } from "@/lib/api";

/**
 * Elapsed times are the whole point here, so they have to keep moving. One
 * second rather than something coarser because `now` is only refreshed by the
 * ticks: the state is seeded at mount, but tasks usually appear much later, so
 * the first tick after they do is what makes the clock correct. `elapsed()`
 * floors at zero to keep that one stale frame from rendering a negative age.
 */
const TICK_MS = 1_000;

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

const elapsed = (now: number, startedAt: number) => Math.max(0, now - startedAt);

/**
 * `local_bash` is a real OS process; `local_agent` is a subagent inside the
 * same CLI process. Calling both "processes" would be wrong for half of them,
 * so the summary line counts them separately and only names what it can.
 */
function summarize(tasks: BackgroundTask[]): string {
  const processes = tasks.filter((t) => t.taskType === "local_bash").length;
  const agents = tasks.filter((t) => t.taskType === "local_agent").length;
  const other = tasks.length - processes - agents;
  const parts: string[] = [];
  if (processes) parts.push(`${processes} 个后台进程`);
  if (agents) parts.push(`${agents} 个后台子 agent`);
  if (other) parts.push(`${other} 个后台任务`);
  return `${parts.join(" · ")}运行中`;
}

interface BackgroundTasksBarProps {
  tasks: BackgroundTask[];
  /**
   * Server-reported: the agent already finished answering and the turn is held
   * open ONLY by these tasks. This is the case worth explaining — the session
   * can sit at "running" indefinitely while the agent is long done, and
   * nothing else on screen says why. Not derivable client-side.
   */
  turnParked: boolean;
}

export function BackgroundTasksBar({ tasks, turnParked }: BackgroundTasksBarProps) {
  const [expanded, setExpanded] = useState(false);
  const now = useNow(tasks.length > 0);

  if (tasks.length === 0) return null;

  const longest = tasks.reduce((max, t) => Math.max(max, elapsed(now, t.startedAt)), 0);

  return (
    <div className="mb-2 rounded-lg border border-border/60 bg-muted/30 text-xs">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-muted-foreground transition-colors hover:text-foreground"
      >
        <span className="relative flex h-1.5 w-1.5 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-500/60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-500" />
        </span>
        <span className="truncate">
          {summarize(tasks)}
          <span className="tabular-nums"> · {formatDuration(longest)}</span>
        </span>
        {turnParked && (
          <span className="shrink-0 text-muted-foreground/70">本轮已答完</span>
        )}
        <ChevronDown
          className={cn("ml-auto h-3.5 w-3.5 shrink-0 transition-transform", expanded && "rotate-180")}
        />
      </button>

      {expanded && (
        <ul className="border-t border-border/60 px-3 py-2">
          {tasks.map((task) => {
            const isProcess = task.taskType !== "local_agent";
            const Icon = isProcess ? Terminal : Bot;
            return (
              <li key={task.taskId} className="flex items-baseline gap-2 py-1">
                <Icon className="h-3.5 w-3.5 shrink-0 translate-y-0.5 text-muted-foreground/70" />
                <span className="min-w-0 flex-1 truncate text-foreground/90">
                  {task.description || task.taskId}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {formatDuration(elapsed(now, task.startedAt))}
                </span>
              </li>
            );
          })}
          <li className="pt-1.5 text-muted-foreground/70">
            {turnParked
              ? "agent 已经答完这一轮,是这些任务让会话保持「运行中」—— 任务结束后本轮才会收尾。停止会话可一并结束它们。"
              : "agent 仍在工作,这些任务与它并行运行。"}
          </li>
        </ul>
      )}
    </div>
  );
}
