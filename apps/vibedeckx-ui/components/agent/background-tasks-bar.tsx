"use client";

import { useEffect, useState } from "react";
import { Bot, ChevronDown, ListTodo, Terminal } from "lucide-react";
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

const KIND_LABEL: Record<TaskKind, string> = { process: "Process", agent: "Subagent", other: "Task" };

const KIND_NOUN: Record<TaskKind, [singular: string, plural: string]> = {
  process: ["background process", "background processes"],
  agent: ["background subagent", "background subagents"],
  other: ["background task", "background tasks"],
};

/**
 * Both the summary line and the row icon derive from this, so they cannot
 * disagree — `codex_subagent` used to be counted as a generic task while the
 * row drew it with a terminal icon.
 */
function kindOf(task: BackgroundTask): TaskKind {
  if (task.taskType === "local_bash") return "process";
  if (task.taskType === "local_agent" || task.taskType === "codex_subagent") return "agent";
  return "other";
}

function TaskKindIcon({ kind }: { kind: TaskKind }) {
  const className = "h-3.5 w-3.5";
  if (kind === "process") return <Terminal className={className} aria-hidden="true" />;
  if (kind === "agent") return <Bot className={className} aria-hidden="true" />;
  return <ListTodo className={className} aria-hidden="true" />;
}

function summarize(tasks: BackgroundTask[]): string {
  const parts = KIND_ORDER.flatMap((kind) => {
    const n = tasks.filter((t) => kindOf(t) === kind).length;
    return n ? [`${n} ${KIND_NOUN[kind][n === 1 ? 0 : 1]}`] : [];
  });
  return `${parts.join(" · ")} running`;
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
  // Amber marks a turn that is still open — the session is being held, whether
  // by a countdown, by a vouched-for wait, or by the agent itself. Once the
  // turn has closed the tasks are orphans nobody is waiting on, and the bar
  // goes grey. `turnParked` covers the countdown too: a deadline only exists
  // while a completion is parked.
  const turnOpen = turnParked || agentWorking;
  const note = countdown
    ? `${countdown} until this turn closes automatically`
    : turnParked && vouchedFor
      ? "Waiting for these tasks"
      : turnParked
        ? "Response complete"
        : agentWorking
          ? "Running alongside the agent"
          : "This turn has closed";

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
        turnOpen ? "border-amber-500/40 bg-amber-500/5" : "border-border/60 bg-muted/30",
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-muted-foreground transition-colors hover:text-foreground"
      >
        {/* Follows the container: amber while the turn is open, muted once it
          has closed. The pulse itself survives either way — the tasks really
          are still running, which is the one thing that never changes here. */}
        <span className="relative flex h-1.5 w-1.5 shrink-0">
          <span
            className={cn(
              "absolute inline-flex h-full w-full animate-ping rounded-full",
              turnOpen ? "bg-amber-500/60" : "bg-muted-foreground/40",
            )}
          />
          <span
            className={cn(
              "relative inline-flex h-1.5 w-1.5 rounded-full",
              turnOpen ? "bg-amber-500" : "bg-muted-foreground/70",
            )}
          />
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
          {tasks.map((task) => {
            const kind = kindOf(task);
            const kindLabel = KIND_LABEL[kind];
            return (
              <li key={task.taskId} className="flex items-baseline gap-2 py-1">
                <span
                  className="inline-flex h-4 w-4 shrink-0 items-center justify-center self-center text-muted-foreground"
                  aria-label={kindLabel}
                  title={kindLabel}
                >
                  <TaskKindIcon kind={kind} />
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
                    {/* The two buttons act on different things — the turn and
                      the task — and "Keep running" next to "Stop" read as a
                      pair about the task, as if one resumed what the other
                      killed. The labels name their object instead. */}
                    {countdown && !task.sanctioned && (
                      <button
                        type="button"
                        onClick={() => keep(task.taskId)}
                        disabled={busy.has(task.taskId)}
                        title="Keep this turn open until this task finishes, instead of closing it when the timer runs out"
                        className="rounded border border-border/60 px-1.5 py-px text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                      >
                        Keep waiting
                      </button>
                    )}
                    {canStopTasks && (
                      <button
                        type="button"
                        onClick={() => stop(task.taskId)}
                        disabled={busy.has(task.taskId)}
                        title="End this background task now"
                        className="rounded border border-border/60 px-1.5 py-px text-[11px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                      >
                        Stop task
                      </button>
                    )}
                  </span>
                )}
              </li>
            );
          })}
          <li className="pt-1.5 text-muted-foreground/70">
            {countdown
              ? "The agent has already answered — these tasks are the only thing keeping this turn open. When the timer runs out the turn closes on its own, and the tasks keep running in the background."
              : turnParked && vouchedFor
                ? "You chose to keep waiting for these tasks, so this turn stays open until they finish."
                : turnParked
                  ? "The agent has already answered — these tasks are the only thing keeping this turn open."
                  : agentWorking
                    ? "The agent is still working. These tasks are running alongside it."
                    : "This turn has closed, but these tasks are still running. Stopping them will not affect the completed turn."}
          </li>
          {!canStopTasks && (
            <li className="pt-1 text-muted-foreground/70">
              This agent cannot stop individual background tasks. Stop the session to end them all.
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
