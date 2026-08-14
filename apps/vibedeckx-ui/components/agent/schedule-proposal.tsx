"use client";

import { useMemo, useState } from "react";
import { CalendarClock, CheckCircle2, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api } from "@/lib/api";
import { noteScheduleCreated, useProposedSchedule } from "@/hooks/use-proposed-schedule";
import { useAgentConversation } from "./agent-conversation";

/**
 * Canonical name both CLIs' proposals arrive under. Mirrors
 * CANONICAL_PROPOSE_SCHEDULE_TOOL in packages/vibedeckx/src/session-tools-mcp.ts,
 * which is where the Codex provider normalizes its own reported shape onto it.
 */
export const PROPOSE_SCHEDULE_TOOL = "mcp__vibedeckx__propose_schedule";

interface ScheduleProposalUIProps {
  input: unknown;
  /** tool_use id — the proposal's stable identity across reloads and devices. */
  toolUseId?: string;
}

interface ProposalFields {
  name: string;
  cronExpr: string;
  prompt: string;
  timezone: string;
}

function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function readProposal(input: unknown): ProposalFields {
  const raw = typeof input === "string" ? tryParse(input) : input;
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (value: unknown): string => (typeof value === "string" ? value : "");
  return {
    name: str(obj.name).trim(),
    cronExpr: str(obj.cron_expr).trim(),
    prompt: str(obj.prompt),
    // The model may suggest a timezone; absent one, the cron means what the
    // person reading the card would assume it means.
    timezone: str(obj.timezone).trim() || browserTimezone(),
  };
}

function tryParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Confirmation card for an agent's `propose_schedule` call.
 *
 * The proposal itself created nothing — the agent's call is fire-and-forget and
 * its turn ended long before anyone read this. Everything authoritative
 * (project, execution target, agent provider) comes from the session this card
 * lives in, never from the model's arguments; only the creative fields (what to
 * call it, how often, what to check) are the model's, and all of them stay
 * editable. See docs/schedule-proposal-tool-design.md.
 */
export function ScheduleProposalUI({ input, toolUseId }: ScheduleProposalUIProps) {
  const { sessionId, projectId, branch, target, targetLabel, agentType, openSchedule } =
    useAgentConversation();

  const proposal = useMemo(() => readProposal(input), [input]);
  const [fields, setFields] = useState<ProposalFields>(proposal);
  const [branchValue, setBranchValue] = useState<string>(branch ?? "");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { schedule: created, loading } = useProposedSchedule(projectId, sessionId, toolUseId);

  // Missing identity means there is nothing to create against (or nothing to
  // recover state by) — show the proposal as plain text rather than a button
  // that cannot work.
  const canCreate = !!projectId && !!sessionId && !!toolUseId;

  const handleCreate = async () => {
    if (!canCreate || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const schedule = await api.createSchedule(projectId, {
        name: fields.name || "Scheduled check",
        cron_expr: fields.cronExpr,
        timezone: fields.timezone,
        target,
        run_type: "prompt",
        // Codex sessions must not create Claude-provider runs: the follow-up
        // check should be run by the same agent that proposed it.
        prompt_provider: agentType === "codex" ? "codex" : "claude",
        content: fields.prompt,
        cwd_mode: "branch",
        branch: branchValue.trim() ? branchValue.trim() : null,
        source: { session_id: sessionId, tool_use_id: toolUseId },
      });
      noteScheduleCreated(projectId, schedule);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create schedule");
    } finally {
      setSubmitting(false);
    }
  };

  if (created) {
    return (
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
        <div className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-4 w-4 flex-shrink-0 text-emerald-500" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground break-words">{created.name}</p>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground break-all">
              {created.cron_expr} · {created.timezone}
              {created.branch ? ` · ${created.branch}` : ""}
            </p>
          </div>
          {openSchedule && (
            <Button variant="ghost" size="sm" className="flex-shrink-0" onClick={() => openSchedule(created.id)}>
              <ExternalLink className="mr-1 h-3.5 w-3.5" />
              View
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border bg-muted/30 p-3">
      <div className="space-y-2">
        <Input
          value={fields.name}
          onChange={(e) => setFields((f) => ({ ...f, name: e.target.value }))}
          placeholder="Name"
          className="h-8 text-sm"
          aria-label="Schedule name"
          disabled={submitting}
        />
        <div className="flex gap-2">
          <Input
            value={fields.cronExpr}
            onChange={(e) => setFields((f) => ({ ...f, cronExpr: e.target.value }))}
            placeholder="0 9 * * *"
            className="h-8 font-mono text-xs"
            aria-label="Cron expression"
            disabled={submitting}
          />
          <Input
            value={branchValue}
            onChange={(e) => setBranchValue(e.target.value)}
            placeholder="main worktree"
            className="h-8 font-mono text-xs"
            aria-label="Branch"
            disabled={submitting}
          />
        </div>
        <Textarea
          value={fields.prompt}
          onChange={(e) => setFields((f) => ({ ...f, prompt: e.target.value }))}
          placeholder="What the scheduled agent should check"
          className="min-h-24 text-xs"
          aria-label="Check prompt"
          disabled={submitting}
        />
      </div>

      <p className="mt-2 text-xs text-muted-foreground">
        Runs on {targetLabel} · {fields.timezone}
      </p>

      {error && <p className="mt-2 text-xs text-red-500 break-words">{error}</p>}

      <div className="mt-3 flex items-center gap-2">
        <Button size="sm" onClick={handleCreate} disabled={!canCreate || submitting || loading}>
          {submitting ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <CalendarClock className="mr-1 h-3.5 w-3.5" />}
          {error ? "Retry" : "Create schedule"}
        </Button>
        {/* The whole of v1's de-duplication: a glance at what already exists,
            one click away, before confirming. */}
        {openSchedule && (
          <Button variant="ghost" size="sm" onClick={() => openSchedule(null)} disabled={submitting}>
            View existing schedules
          </Button>
        )}
      </div>
    </div>
  );
}
