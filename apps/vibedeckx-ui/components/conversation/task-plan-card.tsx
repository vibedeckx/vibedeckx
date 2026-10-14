"use client";

import { CheckCircle2, Circle, Loader2, XCircle, MinusCircle } from "lucide-react";

export interface TaskPlan {
  planId?: string;
  goal: string;
  completionCriteria: string[];
  steps: { id: string; title: string; status: "pending" | "in_progress" | "completed" | "failed" | "skipped"; result?: string }[];
}

export function parseTaskPlan(value: unknown): TaskPlan | null {
  if (!value || typeof value !== "object") return null;
  const plan = value as TaskPlan;
  if (typeof plan.goal !== "string" || !Array.isArray(plan.completionCriteria) ||
      !plan.completionCriteria.every((criterion) => typeof criterion === "string") ||
      !Array.isArray(plan.steps) || !plan.steps.every((step) => step &&
        typeof step.id === "string" && typeof step.title === "string" &&
        ["pending", "in_progress", "completed", "failed", "skipped"].includes(step.status) &&
        (step.result === undefined || typeof step.result === "string")) ||
      (plan.planId !== undefined && typeof plan.planId !== "string")) return null;
  return plan;
}

export function readPlanResult(output: string): TaskPlan | null {
  try {
    const result = JSON.parse(output);
    return result.success ? parseTaskPlan(result.plan) : null;
  } catch { return null; }
}

const icons = { pending: Circle, in_progress: Loader2, completed: CheckCircle2, failed: XCircle, skipped: MinusCircle };
const labels = { pending: "Pending", in_progress: "In progress", completed: "Completed", failed: "Failed", skipped: "Skipped" };

export function TaskPlanCard({ plan, draft = false }: { plan: TaskPlan; draft?: boolean }) {
  const done = plan.steps.filter((step) => step.status === "completed" || step.status === "skipped").length;
  return (
    <div className="rounded-lg border bg-muted/20 p-3 space-y-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <span className="font-medium break-words">{plan.goal}</span>
        <span className="shrink-0 text-xs text-muted-foreground">{draft ? "Plan draft" : `${done}/${plan.steps.length}`}</span>
      </div>
      <div className="text-xs text-muted-foreground space-y-1">
        <div className="font-medium">Completion criteria</div>
        {plan.completionCriteria.map((criterion, index) => <div key={index} className="break-words">• {criterion}</div>)}
      </div>
      <ol className="space-y-2">
        {plan.steps.map((step) => {
          const Icon = icons[step.status];
          return (
            <li key={step.id} className="flex gap-2">
              <Icon aria-label={labels[step.status]} className={`mt-0.5 h-4 w-4 shrink-0 ${step.status === "in_progress" ? "animate-spin text-primary" : step.status === "completed" ? "text-emerald-600" : step.status === "failed" ? "text-destructive" : "text-muted-foreground"}`} />
              <div className="min-w-0">
                <div className="break-words">{step.title}</div>
                {step.result && <div className="text-xs text-muted-foreground whitespace-pre-wrap break-words">{step.result}</div>}
              </div>
            </li>
          );
        })}
      </ol>
      {draft && <p className="text-xs text-muted-foreground">To change this plan, decline it and describe the changes in chat.</p>}
    </div>
  );
}
