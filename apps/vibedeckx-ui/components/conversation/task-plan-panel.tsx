"use client";

import { useId, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronRight, Circle, Loader2, TriangleAlert } from "lucide-react";
import type { AgentMessage } from "@/hooks/use-chat-session";
import { TaskPlanCard, parseTaskPlan, readPlanResult, type TaskPlan } from "./task-plan-card";
import { ToolApprovalCard } from "./tool-approval-card";

type PlanApproval = Extract<AgentMessage, { type: "tool_approval_request" }>;
export interface PinnedTaskPlan {
  key: string;
  plan: TaskPlan;
  approval?: PlanApproval;
  /** The watchdog gave up on this plan; the user has to re-drive it. */
  stalled?: boolean;
}

/** Prefix of the system entry the backend pushes when it gives up on a plan. */
export const PLAN_STALLED_PREFIX = "[Plan Stalled]";
/** Prefix of the synthetic user message that re-drives an unfinished plan. */
export const PLAN_CONTINUATION_PREFIX = "[Plan Continuation]";

/** The same snapshots drive the pinned panel and the cards in chat history. */
export function collectTaskPlans(messages: AgentMessage[]) {
  const history = new Map<string, { plan: TaskPlan; firstIndex: number }>();
  let current: PinnedTaskPlan | null = null;
  // The backend's stall marker applies to the plan on screen until the plan is
  // updated again or the user speaks (which resets the stall server-side).
  let stalled = false;
  // The user's reply also clears `waitingOn` server-side before any new
  // setPlan snapshot arrives; mirror that so the card stops asking.
  let answered = false;
  for (const [index, message] of messages.entries()) {
    if (message.type === "tool_result" && message.tool === "setPlan") {
      const plan = readPlanResult(message.output);
      if (!plan?.planId) continue;
      history.set(plan.planId, { plan, firstIndex: history.get(plan.planId)?.firstIndex ?? index });
      current = { key: `plan:${plan.planId}`, plan };
      stalled = false;
      answered = false;
    } else if (message.type === "tool_approval_request" && message.tool === "setPlan") {
      const plan = parseTaskPlan(message.input);
      if (plan) current = { key: `approval:${message.approvalId}`, plan, approval: message };
      stalled = false;
    } else if (message.type === "system" && message.content.startsWith(PLAN_STALLED_PREFIX)) {
      stalled = true;
    } else if (message.type === "user" && !message.content.startsWith("[")) {
      stalled = false;
      answered = true;
    }
  }
  if (current && stalled && !current.approval) current = { ...current, stalled: true };
  if (current && answered && !current.approval && current.plan.waitingOn) {
    const { waitingOn: _answered, ...plan } = current.plan;
    void _answered;
    current = { ...current, plan };
  }
  return { current, history };
}

export function TaskPlanPanel({ task, sessionId }: { task: PinnedTaskPlan; sessionId: string }) {
  const { plan, approval } = task;
  const bodyId = useId();
  const done = plan.steps.filter((step) => step.status === "completed" || step.status === "skipped").length;
  const completed = !approval && plan.steps.length > 0 && done === plan.steps.length;
  // A preference applies to the current phase. Completion defaults to collapsed,
  // but the user can still reopen the result. Progress updates keep the choice.
  const [choice, setChoice] = useState<{ completed: boolean; expanded: boolean } | null>(null);
  const expanded = choice?.completed === completed ? choice.expanded : !completed;
  const running = plan.steps.find((step) => step.status === "in_progress");
  const failed = plan.steps.find((step) => step.status === "failed");
  const next = plan.steps.find((step) => step.status === "pending");
  const waiting = approval && !approval.resolved;
  const stalled = Boolean(task.stalled) && !completed;
  const summary = waiting ? "Needs confirmation"
    : approval?.resolved === "denied" ? "Plan declined"
    : approval?.resolved === "approved" ? "Confirmed"
    : completed ? "Completed"
    : stalled ? "Stalled · send a message to continue"
    : plan.waitingOn ? `Waiting for you: ${plan.waitingOn}`
    : running ? running.title
    : failed ? `Failed · ${failed.title}`
    : next ? `Next: ${next.title}` : "Task plan";
  const StatusIcon = waiting || approval?.resolved === "denied" || failed || stalled || plan.waitingOn ? TriangleAlert : approval ? Circle : completed ? CheckCircle2 : running ? Loader2 : Circle;

  return (
    <section aria-label="Current task plan" className="mb-2 overflow-hidden rounded-lg border bg-muted/20">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/50"
        aria-label={expanded ? "Collapse task plan" : "Expand task plan"}
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={() => setChoice({ completed, expanded: !expanded })}
      >
        {expanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
        <StatusIcon className={`h-3 w-3 shrink-0 ${StatusIcon === Loader2 ? "animate-spin" : ""} ${waiting || stalled || plan.waitingOn ? "text-amber-500" : completed ? "text-emerald-600" : failed ? "text-destructive" : ""}`} />
        <span className="min-w-0 flex-1 truncate text-xs font-medium" title={plan.goal}>{plan.goal}</span>
        <span className="max-w-[45%] truncate text-xs text-muted-foreground" aria-live="polite" title={summary}>{summary}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{done}/{plan.steps.length}</span>
      </button>
      {expanded && (
        <div id={bodyId} className="max-h-[min(16rem,35dvh)] overflow-y-auto overscroll-contain border-t p-2">
          {approval ? (
            <ToolApprovalCard
              key={approval.approvalId}
              sessionId={sessionId}
              approvalId={approval.approvalId}
              tool="setPlan"
              input={approval.input}
              resolved={approval.resolved}
              embedded
            />
          ) : <TaskPlanCard plan={plan} />}
        </div>
      )}
    </section>
  );
}
