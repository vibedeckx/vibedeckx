"use client";

import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/format-duration";
import { keepBackgroundTaskRunning, stopBackgroundTask, type BackgroundTask } from "@/lib/api";

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
 * `local_bash` is a real OS process; `local_agent` (Claude Code) and
 * `codex_subagent` (Codex) are extra LLM threads inside the CLI process.
 * Calling both "processes" would be wrong for half of them, and the two need
 * different handling — only a process can hang forever on a bad exit
 * condition — so the difference has to survive all the way to the screen.
 */
type TaskKind = "process" | "agent" | "other";

const KIND_ORDER: TaskKind[] = ["process", "agent", "other"];

/** Row badge. The summary wording alone reads as a generic "something is running". */
const KIND_BADGE: Record<TaskKind, string> = { process: "进程", agent: "子 agent", other: "任务" };

const KIND_NOUN: Record<TaskKind, string> = {
  process: "后台进程",
  agent: "后台子 agent",
  other: "后台任务",
};

/**
 * Both the summary line and the row badge derive from this, so they cannot
 * disagree — `codex_subagent` used to be counted as a generic task while the
 * row drew it with a terminal icon.
 */
function kindOf(task: BackgroundTask): TaskKind {
  if (task.taskType === "local_bash") return "process";
  if (task.taskType === "local_agent" || task.taskType === "codex_subagent") return "agent";
  return "other";
}

function summarize(tasks: BackgroundTask[]): string {
  const parts = KIND_ORDER.flatMap((kind) => {
    const n = tasks.filter((t) => kindOf(t) === kind).length;
    return n ? [`${n} 个${KIND_NOUN[kind]}`] : [];
  });
  return `${parts.join(" · ")}运行中`;
}

/**
 * Counts down to `at`, or null once it passes. Rendered as m:ss because this
 * is a deadline the user may want to beat, not an elapsed reading.
 */
function formatCountdown(now: number, at: number): string | null {
  const left = Math.round((at - now) / 1000);
  if (left <= 0) return null;
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
}

interface BackgroundTasksBarProps {
  /** The live session, or null before one exists — no session, no button. */
  sessionId: string | null;
  tasks: BackgroundTask[];
  /**
   * Server-reported: the agent already finished answering and the turn is held
   * open ONLY by these tasks. This is the case worth explaining — the session
   * can sit at "running" indefinitely while the agent is long done, and
   * nothing else on screen says why. Not derivable client-side.
   */
  turnParked: boolean;
  /**
   * Epoch ms when the parked turn will be closed anyway, or null when nothing
   * is parked or the user vouched for every task. Absolute rather than a
   * remaining duration so the countdown survives a reload untouched.
   */
  parkDeadlineAt: number | null;
  /**
   * Server-reported: whether this agent can stop a single task (Claude Code
   * can, Codex cannot). Not inferred from the agent type here — a client
   * guessing would drift the day Codex gains the primitive, and would render a
   * button that is dead on arrival until the first click failed.
   */
  canStopTasks: boolean;
  /**
   * The agent is mid-turn. Distinguishes "tasks running alongside a working
   * agent" from "tasks that outlived a turn already closed on the deadline" —
   * both have `turnParked === false` and nothing else tells them apart.
   */
  agentWorking: boolean;
}

export function BackgroundTasksBar({
  sessionId, tasks, turnParked, parkDeadlineAt, canStopTasks, agentWorking,
}: BackgroundTasksBarProps) {
  const [expanded, setExpanded] = useState(false);
  // Per task id: a click is in flight. Per-task rather than one flag because
  // each row acts on its own task, and one pending request must not grey out
  // the others.
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const now = useNow(tasks.length > 0);

  if (tasks.length === 0) return null;

  const longest = tasks.reduce((max, t) => Math.max(max, elapsed(now, t.startedAt)), 0);
  const countdown = parkDeadlineAt === null ? null : formatCountdown(now, parkDeadlineAt);
  const vouchedFor = tasks.some((t) => t.sanctioned);
  // Four states, and the honest label for each. The one worth naming loudest
  // is "counting down": the agent is done, and until the deadline lands
  // nothing else on screen distinguishes this from an agent still at work.
  const note = countdown
    ? `${countdown} 后自动收尾本轮`
    : turnParked && vouchedFor
      ? "已设为保持运行"
      : turnParked
        ? "本轮已答完"
        : agentWorking
          ? "与 agent 并行运行"
          : "本轮已收尾";

  const run = async (taskId: string, action: (id: string) => Promise<unknown>) => {
    if (!sessionId) return;
    setBusy((prev) => new Set(prev).add(taskId));
    try {
      return await action(taskId);
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
    }
  };

  const keep = (taskId: string) => run(taskId, (id) => keepBackgroundTaskRunning(sessionId!, id));

  // Nothing is updated here on success: the agent's own task snapshot drains
  // the ledger, which closes the parked turn through the normal path.
  const stop = (taskId: string) => run(taskId, (id) => stopBackgroundTask(sessionId!, id));

  return (
    <div
      className={cn(
        "mb-2 rounded-lg border text-xs",
        countdown ? "border-amber-500/40 bg-amber-500/5" : "border-border/60 bg-muted/30",
      )}
    >
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
        <span className={cn("shrink-0", countdown ? "text-amber-600 dark:text-amber-500" : "text-muted-foreground/70")}>
          {note}
        </span>
        <ChevronDown
          className={cn("ml-auto h-3.5 w-3.5 shrink-0 transition-transform", expanded && "rotate-180")}
        />
      </button>

      {expanded && (
        <ul className="border-t border-border/60 px-3 py-2">
          {tasks.map((task) => (
            <li key={task.taskId} className="flex items-baseline gap-2 py-1">
              <span className="inline-flex min-w-14 shrink-0 justify-center rounded border border-border/60 bg-background/60 px-1 py-px text-[10px] leading-tight text-muted-foreground">
                {KIND_BADGE[kindOf(task)]}
              </span>
              <span className="min-w-0 flex-1 truncate text-foreground/90">
                {task.description || task.taskId}
              </span>
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {formatDuration(elapsed(now, task.startedAt))}
              </span>
              {/* Per row, because the decision is per task: one of three may be
                  a stuck poller while the others are a real build.

                  The two conditions differ on purpose. Vouching only means
                  something while a deadline is running — there is nothing to
                  defuse otherwise. Stopping is meaningful in every state, and
                  must stay reachable after vouching: someone who vouched for a
                  build 40 minutes ago and now sees it was stuck would
                  otherwise have no way out but stopping the whole session. */}
              {sessionId && (
                <span className="flex shrink-0 gap-1">
                  {countdown && !task.sanctioned && (
                    <button
                      type="button"
                      onClick={() => keep(task.taskId)}
                      disabled={busy.has(task.taskId)}
                      className="rounded border border-border/60 px-1.5 py-px text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                    >
                      保持运行
                    </button>
                  )}
                  {canStopTasks && (
                    <button
                      type="button"
                      onClick={() => stop(task.taskId)}
                      disabled={busy.has(task.taskId)}
                      className="rounded border border-border/60 px-1.5 py-px text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                    >
                      结束
                    </button>
                  )}
                </span>
              )}
            </li>
          ))}
          <li className="pt-1.5 text-muted-foreground/70">
            {countdown
              ? "agent 已经答完这一轮,是这些任务让会话保持「运行中」。到点会先把本轮收尾,任务本身继续运行。"
              : turnParked && vouchedFor
                ? "已按你的选择等待这些任务结束,不会自动收尾。"
                : turnParked
                  ? "agent 已经答完这一轮,是这些任务让会话保持「运行中」。"
                  : agentWorking
                    ? "agent 仍在工作,这些任务与它并行运行。"
                    : "本轮已经收尾,这些任务比它活得更久 —— 结束它们不会影响已完成的这一轮。"}
          </li>
          {!canStopTasks && (
            <li className="pt-1 text-muted-foreground/70">
              这个 agent 不支持单独停止后台任务 —— 停止会话可一并结束它们。
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
