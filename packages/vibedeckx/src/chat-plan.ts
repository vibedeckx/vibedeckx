import { randomUUID } from "crypto";
import { z } from "zod";

export const chatPlanSchema = z.object({
  planId: z.string().optional().describe("Omit for a new task; reuse the returned ID for progress updates."),
  goal: z.string().trim().min(1).max(500),
  completionCriteria: z.array(z.string().trim().min(1).max(500)).min(1).max(12),
  requireConfirmation: z.boolean().default(true).describe("False only for explicit user-specified steps; broad goals need confirmation."),
  steps: z.array(z.object({
    id: z.string().min(1).max(80),
    title: z.string().trim().min(1).max(300),
    status: z.enum(["pending", "in_progress", "completed", "failed", "skipped"]).default("pending"),
    result: z.string().max(2000).optional(),
  })).min(1).max(20),
}).refine((plan) => new Set(plan.steps.map((step) => step.id)).size === plan.steps.length, {
  message: "Step IDs must be unique", path: ["steps"],
}).refine((plan) => plan.planId || plan.steps.every((step) => step.status === "pending"), {
  message: "New plans must start with pending steps", path: ["steps"],
}).refine((plan) => plan.steps.every((step) =>
  !["completed", "failed", "skipped"].includes(step.status) || step.result?.trim()), {
  message: "Finished steps need a result or reason", path: ["steps"],
});

export type ChatPlanInput = z.infer<typeof chatPlanSchema>;
export type ChatPlan = ChatPlanInput & { planId: string };

/** Session-local MVP. Conversation tool results are the reconnect snapshot. */
export class ChatPlanState {
  current: ChatPlan | null = null;
  blocked = false;

  needsConfirmation(input: ChatPlanInput): boolean {
    const samePlan = input.planId && input.planId === this.current?.planId;
    // Invalid IDs must reach execute as a recoverable tool result, not throw
    // inside the SDK approval predicate (which emits an unhandled stream error).
    if (input.planId && !samePlan) return false;
    const scope = (plan: ChatPlanInput) => JSON.stringify([
      plan.goal, plan.completionCriteria, plan.steps.map(({ id, title }) => ({ id, title })),
    ]);
    const changed = samePlan && this.current && scope(input) !== scope(this.current);
    const needsApproval = this.blocked || Boolean(changed) || (!samePlan && input.requireConfirmation);
    if (needsApproval) this.blocked = true;
    return needsApproval;
  }

  apply(input: ChatPlanInput): ChatPlan {
    // Called only after the SDK's approval boundary has been satisfied.
    if (input.planId && input.planId !== this.current?.planId) throw new Error("Unknown plan ID.");
    this.current = { ...input, planId: input.planId ?? randomUUID() };
    this.blocked = false;
    return this.current;
  }
}
