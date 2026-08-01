import type { ProjectChatOperationPayload, ProjectChatOperationStatus } from "./storage/types.js";
import { sanitizeProjectChatPublicError } from "./project-chat-public-error.js";

export type PublicProjectChatFailureCode = "failed" | "timeout" | "remote_offline" | "deleted_target";

export type PublicProjectChatOperation = {
  version: 1;
  operationId: string;
  status: ProjectChatOperationStatus;
  failure?: { code: PublicProjectChatFailureCode; message: string };
} & (
  | { kind: "task_create" | "task_update"; taskId: string; title?: string }
  | { kind: "agent_session_create"; sessionId: string; target?: string; branch?: string | null; instruction?: string; sessionAvailable: boolean }
  | { kind: "agent_instruction"; sessionId: string; instruction?: string }
  | { kind: "schedule_run"; scheduleId: string; runId: string; runAvailable: boolean }
  | { kind: "workspace_selection"; requestId: string; candidates: Array<{ id: string; target: string; branch: string | null }> }
);

function publicFailureCode(error: string): PublicProjectChatFailureCode {
  const normalized = error.toLowerCase();
  if (/\btimeout\b|\btimed\s+out\b/.test(normalized)) return "timeout";
  if (/\boffline\b|\bdisconnected\b/.test(normalized)
    || (/\bremote\b/.test(normalized) && /\bunavailable\b/.test(normalized))) return "remote_offline";
  if (/\bno longer\b|\bnot found\b|\bdeleted\b/.test(normalized)) return "deleted_target";
  return "failed";
}

const boundedPublicText = (value: string, limit: number): string => value.length <= limit
  ? value
  : `${value.slice(0, Math.max(0, limit - 1))}…`;

function publicFailureMessage(code: PublicProjectChatFailureCode): string {
  switch (code) {
    case "timeout": return "Operation timed out. Review the target and try again.";
    case "remote_offline": return "The selected remote server is offline. Check its connection and try again.";
    case "deleted_target": return "The target no longer exists or is unavailable.";
    case "failed": return "Operation failed. Review the target and try again.";
  }
}

export function projectChatPublicOperation(payload: ProjectChatOperationPayload): PublicProjectChatOperation {
  const base = {
    version: 1 as const,
    operationId: payload.operationId,
    status: payload.status,
  };
  switch (payload.kind) {
    case "task_create":
    case "task_update":
      return {
        ...base, kind: payload.kind, taskId: payload.taskId,
        ...(payload.title === undefined ? {} : { title: boundedPublicText(payload.title, 512) }),
      };
    case "agent_session_create":
      return {
        ...base, kind: payload.kind, sessionId: payload.sessionId,
        ...(payload.target === undefined ? {} : { target: boundedPublicText(payload.target, 512) }),
        ...(payload.branch === undefined ? {} : {
          branch: payload.branch === null ? null : boundedPublicText(payload.branch, 512),
        }),
        ...(payload.instruction === undefined ? {} : {
          instruction: boundedPublicText(payload.instruction, 512),
        }),
        sessionAvailable: payload.initialInstructionDelivery === "confirmed",
      };
    case "agent_instruction":
      return {
        ...base, kind: payload.kind, sessionId: payload.sessionId,
        ...(payload.instruction === undefined ? {} : {
          instruction: boundedPublicText(payload.instruction, 512),
        }),
      };
    case "schedule_run":
      return {
        ...base, kind: payload.kind, scheduleId: payload.scheduleId, runId: payload.runId,
        runAvailable: payload.contextConfirmed === true,
      };
    case "workspace_selection":
      return {
        ...base, kind: payload.kind, requestId: payload.requestId,
        candidates: payload.candidates.map(({ id, target, branch }) => ({
          id, target: boundedPublicText(target, 512),
          branch: branch === null ? null : boundedPublicText(branch, 512),
        })),
      };
  }
}

export function projectChatPublicOperationContent(
  payload: ProjectChatOperationPayload,
  error: string | null = null,
): string {
  const publicPayload = projectChatPublicOperation(payload);
  const failureCode = publicFailureCode(sanitizeProjectChatPublicError(error ?? "", "Operation failed"));
  return JSON.stringify({
    ...publicPayload,
    ...(payload.status === "failed"
      ? { failure: { code: failureCode, message: publicFailureMessage(failureCode) } }
      : {}),
  });
}
