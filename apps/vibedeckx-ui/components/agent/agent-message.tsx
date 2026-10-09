"use client";

import { cn } from "@/lib/utils";
import { Bot, User, Wrench, Brain, AlertCircle, Info, HelpCircle, FileCheck, ListTodo, FileText, Terminal, Search, FolderSearch, Workflow, FilePenLine, Globe, Sparkles, FilePlus2, Globe2, ShieldAlert, Code, Eye, CalendarClock, Copy, Check, ListPlus } from "lucide-react";
import type { AgentMessage, ContentPart } from "@/hooks/use-agent-session";
import { AgentMarkdown } from "./agent-markdown";
import { useAgentConversation } from "./agent-conversation";
import { AskUserQuestion } from "./ask-user-question";
import { ExitPlanModeUI } from "./exit-plan-mode";
import { CommandApprovalUI, FileChangeApprovalUI } from "./approval-request";
import {
  TodoWriteUI,
  TaskCreateUI,
  TaskUpdateUI,
  TaskListUI,
  TaskGetUI,
  TaskListResultUI,
} from "./task-tools";
import {
  ReadToolUseUI,
  ReadToolResultUI,
  WriteToolUseUI,
  WriteToolResultUI,
  ImageToolResultUI,
  parseImageBlocks,
} from "./file-tools";
import { BashToolUseUI, BashToolResultUI } from "./bash-tools";
import { GrepToolUseUI, GrepToolResultUI } from "./grep-tools";
import { GlobToolUseUI, GlobToolResultUI } from "./glob-tools";
import { SubagentToolUseUI, SubagentToolResultUI } from "./subagent-tools";
import { EditToolUseUI, EditToolResultUI } from "./edit-tools";
import { WebFetchToolUseUI, WebFetchToolResultUI } from "./web-fetch-tools";
import { WebSearchToolUseUI, WebSearchToolResultUI } from "./web-search-tools";
import { SkillToolUseUI, SkillToolResultUI } from "./skill-tools";
import { TaskOutputToolUseUI, TaskOutputToolResultUI } from "./task-output-tools";
import { FileChangeToolUseUI, FileChangeToolResultUI } from "./file-change-tools";
import { PROPOSE_SCHEDULE_TOOL, ScheduleProposalUI } from "./schedule-proposal";
import { PROPOSE_TASK_TOOL, TaskProposalUI } from "./task-proposal";
import { CrossRemoteToolUse, CrossRemoteToolResult, isCrossRemoteTool } from "./cross-remote-tools";
import { ZoomableImage } from "./zoomable-image";
import { SpeakButton, speakOwnerKey } from "./speak-button";
import { useTtsOwnedBy } from "@/lib/tts/tts-player";
import { MessageRow } from "./message-row";
import { VPasteChip, VFileCard, RemoteGrantMeta, ScheduleIntentMeta, TaskIntentMeta, splitVPasteMarkers, takeRemotesMarker, type VPasteSegment } from "./vpaste-chip";
import { takeScheduleMarker } from "@/lib/schedule-intent";
import { stripTasksCreatedNote, takeTaskMarker } from "@/lib/task-intent";
import { Fragment, useEffect, useMemo, useState } from "react";

interface AgentMessageProps {
  message: AgentMessage;
  messageIndex: number;
  /**
   * Persisted entry index — stable across history prepends, unlike
   * `messageIndex`. Used to tell identical assistant replies apart.
   */
  entryIndex?: number;
  // True only for the message a turn is currently streaming into; see the
  // `mode` note in agent-markdown.tsx.
  streaming?: boolean;
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  if (sameDay) return time;
  const date = d.toLocaleDateString(undefined, { year: "numeric", month: "2-digit", day: "2-digit" });
  return `${date} ${time}`;
}

export function AgentMessageItem({ message, messageIndex, entryIndex, streaming = false }: AgentMessageProps) {
  const body = renderBody(message, messageIndex, streaming, entryIndex);
  if (!body) return null;
  return (
    <div className="group relative">
      {body}
      <span className="pointer-events-none absolute right-0 top-3 conv-text-xs tabular-nums text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100">
        {formatTimestamp(message.timestamp)}
      </span>
    </div>
  );
}

function renderBody(message: AgentMessage, messageIndex: number, streaming: boolean, entryIndex?: number) {
  switch (message.type) {
    // A workflow-injected user turn is machine-authored markdown that is
    // complete the moment it lands, so it never wants the deferred path — not
    // even as the tail message of a running turn, where `streaming` is true for
    // the session but nothing is being appended to THIS message.
    case "user":
      return <UserMessage content={message.content} origin={message.origin} />;

    case "assistant":
      return <AssistantMessage content={message.content} agentType={message.agentType} streaming={streaming} entryIndex={entryIndex} />;

    case "tool_use":
      return (
        <ToolUseMessage
          tool={message.tool}
          input={message.input}
          messageIndex={messageIndex}
          toolUseId={message.toolUseId}
        />
      );

    case "tool_result":
      return <ToolResultMessage tool={message.tool} output={message.output} />;

    case "thinking":
      return <ThinkingMessage content={message.content} />;

    case "error":
      return <ErrorMessage message={message.message} />;

    case "system":
      return <SystemMessage content={message.content} />;

    case "approval_request":
      return (
        <MessageRow color="amber" icon={ShieldAlert} title={message.requestType === "command" ? "Command Approval" : "File Change Approval"}>
          {message.requestType === "command" ? (
            <CommandApprovalUI
              requestId={message.requestId}
              command={message.command}
              cwd={message.cwd}
              messageIndex={messageIndex}
            />
          ) : (
            <FileChangeApprovalUI
              requestId={message.requestId}
              changes={message.changes}
              messageIndex={messageIndex}
            />
          )}
        </MessageRow>
      );

    case "turn_end":
      return null; // rendered by agent-conversation as TurnEndDivider

    default:
      return null;
  }
}

/**
 * Take the `<vremotes>`, `<vschedule>` and `<vtask>` blocks out of user text
 * for the header, and drop the hidden `<vtasks-created>` note.
 */
function takeHeaderBlocks(text: string): {
  text: string; remoteNames: string | null; scheduled: boolean; tasked: boolean; hadNote: boolean;
} {
  const note = stripTasksCreatedNote(text);
  const remotes = takeRemotesMarker(note.text);
  const schedule = takeScheduleMarker(remotes.text);
  const task = takeTaskMarker(schedule.text);
  return { text: task.text, remoteNames: remotes.names, scheduled: schedule.found, tasked: task.found, hadNote: note.found };
}

function renderTextWithVPaste(text: string) {
  const segments = splitVPasteMarkers(text);
  if (segments.length === 1 && segments[0].kind === "text") {
    return <span className="whitespace-pre-wrap break-words">{text ?? ""}</span>;
  }
  // Files from Add files sit as a row of cards above the text. Pastes stay where
  // they were pasted — the composer lets them sit mid-sentence.
  const files: { path: string; size: number; name: string }[] = [];
  const inline: Exclude<VPasteSegment, { kind: "remotes" }>[] = [];
  for (const seg of segments) {
    if (seg.kind === "chip" && seg.name !== undefined) files.push({ path: seg.path, size: seg.size, name: seg.name });
    else if (seg.kind !== "remotes") inline.push(seg);
    // UserMessage lifts the grant block into its header before rendering.
  }
  // Drop the blank lines left where file markers were taken out.
  const first = inline[0];
  if (first?.kind === "text") inline[0] = { ...first, text: first.text.trimStart() };
  const last = inline[inline.length - 1];
  if (last?.kind === "text") inline[inline.length - 1] = { ...last, text: last.text.trimEnd() };
  const hasInline = inline.some((seg) => seg.kind === "chip" || seg.text.length > 0);
  return (
    <div
      className="text-foreground max-w-none break-words"
      style={{ fontSize: "var(--conv-font-size, 14px)" }}
    >
      {files.length > 0 && (
        <div className={`flex flex-wrap gap-2${hasInline ? " mb-2" : ""}`}>
          {files.map((file, i) => (
            <VFileCard key={i} path={file.path} size={file.size} name={file.name} />
          ))}
        </div>
      )}
      {hasInline && (
        <div className="whitespace-pre-wrap break-words">
          {inline.map((seg, i) =>
            seg.kind === "text" ? seg.text : <VPasteChip key={i} path={seg.path} size={seg.size} />
          )}
        </div>
      )}
    </div>
  );
}

function UserMessage({
  content,
  origin,
}: {
  content: string | ContentPart[];
  origin?: "workflow";
}) {
  // Workflow-injected prompts are machine-authored markdown — render them as
  // such, visually distinct from what the user actually typed.
  if (origin === "workflow" && typeof content === "string") {
    return (
      <MessageRow color="sky" icon={Workflow} title="Workflow">
        <div
          className="text-foreground prose prose-sm dark:prose-invert max-w-none break-words [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_code]:break-all [&_p]:break-words"
          style={{ fontSize: "var(--conv-font-size, 14px)" }}
        >
          <AgentMarkdown>{content}</AgentMarkdown>
        </div>
      </MessageRow>
    );
  }
  // The hub appends a `<vremotes>` block to every message of a session with
  // grants, and the Schedule / Task chips a `<vschedule>` / `<vtask>` block;
  // all belong in the header, so take them out of the body first.
  let remoteNames: string | null = null;
  let scheduled = false;
  let tasked = false;
  let body: string | ContentPart[];
  if (typeof content === "string") {
    const taken = takeHeaderBlocks(content);
    remoteNames = taken.remoteNames;
    scheduled = taken.scheduled;
    tasked = taken.tasked;
    body = taken.text;
  } else {
    body = [];
    for (const part of content) {
      if (part.type !== "text") {
        body.push(part);
        continue;
      }
      const taken = takeHeaderBlocks(part.text);
      if (taken.remoteNames !== null) remoteNames = taken.remoteNames;
      if (taken.scheduled) scheduled = true;
      if (taken.tasked) tasked = true;
      // A part that was only a block leaves nothing to render.
      const hadBlock = taken.remoteNames !== null || taken.scheduled || taken.tasked || taken.hadNote;
      if (!hadBlock || taken.text.length > 0) body.push({ ...part, text: taken.text });
    }
  }
  return (
    <div className="flex gap-3 py-3">
      <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center">
        <User className="w-4 h-4 text-primary" />
      </div>
      <div className="flex-1 min-w-0 overflow-hidden">
        {/* Baseline, not center: "You" and the smaller grant text have different
            line boxes, and centering them lifts the smaller text off the line. */}
        <p className="flex min-w-0 items-baseline gap-1.5 conv-text-sm font-medium text-foreground mb-1">
          <span className="shrink-0">You</span>
          {scheduled && (
            <>
              <span className="shrink-0 text-muted-foreground/60" aria-hidden>·</span>
              <ScheduleIntentMeta />
            </>
          )}
          {tasked && (
            <>
              <span className="shrink-0 text-muted-foreground/60" aria-hidden>·</span>
              <TaskIntentMeta />
            </>
          )}
          {remoteNames && (
            <>
              <span className="shrink-0 text-muted-foreground/60" aria-hidden>·</span>
              <RemoteGrantMeta names={remoteNames} />
            </>
          )}
        </p>
        <div
          className="text-foreground max-w-none break-words"
          style={{ fontSize: "var(--conv-font-size, 14px)" }}
        >
          {typeof body === "string" ? (
            renderTextWithVPaste(body)
          ) : (
            body.map((part, i) =>
              part.type === "text" ? (
                <Fragment key={i}>{renderTextWithVPaste(part.text)}</Fragment>
              ) : (
                <div key={i} className="mt-2">
                  <ZoomableImage
                    src={`data:${part.mediaType};base64,${part.data}`}
                    alt="Attached image"
                    className="max-w-sm rounded-lg"
                  />
                </div>
              )
            )
          )}
        </div>
      </div>
    </div>
  );
}

function useAgentType(): string {
  try {
    return useAgentConversation().agentType;
  } catch {
    return "claude-code";
  }
}

function useConversationSessionId(): string | null {
  try {
    return useAgentConversation().sessionId;
  } catch {
    return null;
  }
}

function AssistantMessage({
  content,
  agentType: messageAgentType,
  streaming = false,
  entryIndex,
}: {
  content: string;
  agentType?: string;
  streaming?: boolean;
  entryIndex?: number;
}) {
  const currentAgentType = useAgentType();
  // Identifies this message to the page-wide read-aloud player (see
  // speakOwnerKey); prefixed with the session id so a session switch can stop
  // only its own playback.
  const sessionId = useConversationSessionId();
  const speakKey = useMemo(
    () => speakOwnerKey(sessionId, content ?? "", entryIndex),
    [sessionId, content, entryIndex],
  );
  // While this message holds the player, the speak button stays pinned; keep
  // its neighbours visible too so it doesn't float after an empty gap.
  const speaking = useTtsOwnedBy(speakKey);
  const actionReveal = speaking
    ? "opacity-100"
    : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100";
  const agentType = messageAgentType ?? currentAgentType;
  const isCodex = agentType === "codex";
  const label = isCodex ? "Codex" : "Claude";
  // The agent's colour lives on its avatar only; the name stays body text like
  // every other row title.
  const iconBg = isCodex ? "bg-green-500/10" : "bg-violet-500/10";
  const iconColor = isCodex ? "text-green-500" : "text-violet-500";

  // Debug aid: toggle a single message between rendered markdown and its raw
  // source (the exact string fed to the renderer). Per-message, default rendered.
  const [showSource, setShowSource] = useState(false);

  // Copies the raw markdown source without having to open the source view.
  // `copied` flips the icon to a check briefly as confirmation.
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const handleCopy = async () => {
    if (!navigator?.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(content ?? "");
      setCopied(true);
    } catch (err) {
      console.error("Failed to copy message", err);
    }
  };

  return (
    <div className="group flex gap-3 py-3" data-speak-message="">
      <div className={`flex-shrink-0 w-7 h-7 rounded-lg ${iconBg} flex items-center justify-center`}>
        <Bot className={`w-4 h-4 ${iconColor}`} />
      </div>
      <div className="flex-1 min-w-0 overflow-hidden">
        <div className="flex items-center gap-2 mb-1">
          <p className="conv-text-sm font-medium text-foreground">{label}</p>
          <button
            type="button"
            onClick={() => setShowSource((v) => !v)}
            title={showSource ? "View rendered" : "View source"}
            aria-label={showSource ? "View rendered" : "View source"}
            aria-pressed={showSource}
            className={cn(actionReveal, "transition-opacity text-muted-foreground hover:text-foreground")}
          >
            {showSource ? <Eye className="w-3.5 h-3.5" /> : <Code className="w-3.5 h-3.5" />}
          </button>
          <button
            type="button"
            onClick={handleCopy}
            title={copied ? "Copied" : "Copy source"}
            aria-label={copied ? "Copied" : "Copy source"}
            className={cn(actionReveal, "transition-opacity text-muted-foreground hover:text-foreground")}
          >
            {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          </button>
          {!streaming && <SpeakButton ownerKey={speakKey} text={content ?? ""} />}
        </div>
        {showSource ? (
          <pre className="text-xs font-mono whitespace-pre-wrap break-words bg-muted/50 rounded-md p-3 overflow-x-auto text-foreground select-text">
            {content ?? ""}
          </pre>
        ) : (
          <div
            className="text-foreground prose prose-sm dark:prose-invert max-w-none break-words [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_code]:break-all [&_p]:break-words"
            style={{ fontSize: "var(--conv-font-size, 14px)" }}
          >
            <AgentMarkdown streaming={streaming}>{content ?? ""}</AgentMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}

function ToolUseMessage({ tool, input, messageIndex, toolUseId }: { tool: string; input: unknown; messageIndex: number; toolUseId?: string }) {
  // Both CLIs report this under the canonical name (the Codex provider
  // normalizes onto it), so one branch serves both.
  if (tool === PROPOSE_SCHEDULE_TOOL) {
    return (
      <MessageRow color="amber" icon={CalendarClock} title="Suggested scheduled check">
        <ScheduleProposalUI input={input} toolUseId={toolUseId} />
      </MessageRow>
    );
  }

  if (tool === PROPOSE_TASK_TOOL) {
    return (
      <MessageRow color="violet" icon={ListPlus} title="Proposed task">
        <TaskProposalUI input={input} toolUseId={toolUseId} />
      </MessageRow>
    );
  }

  if (tool === "ImageView") {
    const path =
      typeof input === "object" && input !== null && "path" in input && typeof input.path === "string"
        ? input.path
        : "";
    return (
      <MessageRow color="sky" icon={Eye} title="View Image">
        <p
          className="font-mono text-muted-foreground break-all"
          style={{ fontSize: "var(--conv-font-size, 12px)" }}
        >
          {path}
        </p>
      </MessageRow>
    );
  }

  if (tool === "AskUserQuestion") {
    return (
      <MessageRow color="violet" icon={HelpCircle} title="Question">
        <AskUserQuestion input={input} messageIndex={messageIndex} />
      </MessageRow>
    );
  }

  if (tool === "ExitPlanMode") {
    return (
      <MessageRow color="green" icon={FileCheck} title="Plan Ready">
        <ExitPlanModeUI input={input} messageIndex={messageIndex} />
      </MessageRow>
    );
  }

  // Task management tools
  const taskToolLabels: Record<string, { label: string; ui: React.ReactNode }> = {
    TodoWrite: { label: "Tasks", ui: <TodoWriteUI input={input} /> },
    TaskCreate: { label: "Create Task", ui: <TaskCreateUI input={input} /> },
    TaskUpdate: { label: "Update Task", ui: <TaskUpdateUI input={input} /> },
    TaskList: { label: "Task List", ui: <TaskListUI /> },
    TaskGet: { label: "Get Task", ui: <TaskGetUI input={input} /> },
  };

  const taskTool = taskToolLabels[tool];
  if (taskTool) {
    return (
      <MessageRow color="cyan" icon={ListTodo} title={taskTool.label}>
        {taskTool.ui}
      </MessageRow>
    );
  }

  if (tool === "Read") {
    return (
      <MessageRow color="sky" icon={FileText} title="Read File">
        <ReadToolUseUI input={input} />
      </MessageRow>
    );
  }

  if (tool === "Edit") {
    return (
      <MessageRow color="sky" icon={FilePenLine} title="Edit File">
        <EditToolUseUI input={input} />
      </MessageRow>
    );
  }

  if (tool === "Write") {
    return (
      <MessageRow color="sky" icon={FilePlus2} title="Write File">
        <WriteToolUseUI input={input} />
      </MessageRow>
    );
  }

  if (tool === "Bash") {
    return (
      <MessageRow color="emerald" icon={Terminal} title="Run Command">
        <BashToolUseUI input={input} />
      </MessageRow>
    );
  }

  if (tool === "Grep") {
    return (
      <MessageRow color="orange" icon={Search} title="Search">
        <GrepToolUseUI input={input} />
      </MessageRow>
    );
  }

  if (tool === "Glob") {
    return (
      <MessageRow color="teal" icon={FolderSearch} title="Glob">
        <GlobToolUseUI input={input} />
      </MessageRow>
    );
  }

  if (tool === "Task" || tool === "Agent") {
    return (
      <MessageRow color="purple" icon={Workflow} title="Agent">
        <SubagentToolUseUI input={input} />
      </MessageRow>
    );
  }

  if (tool === "TaskOutput") {
    return (
      <MessageRow color="purple" icon={Workflow} title="Task Output">
        <TaskOutputToolUseUI input={input} />
      </MessageRow>
    );
  }

  if (tool === "WebFetch") {
    return (
      <MessageRow color="blue" icon={Globe} title="Fetch Web Page">
        <WebFetchToolUseUI input={input} />
      </MessageRow>
    );
  }

  if (tool === "WebSearch") {
    return (
      <MessageRow color="indigo" icon={Globe2} title="Web Search">
        <WebSearchToolUseUI input={input} />
      </MessageRow>
    );
  }

  if (tool === "Skill") {
    return (
      <MessageRow color="pink" icon={Sparkles} title="Skill">
        <SkillToolUseUI input={input} />
      </MessageRow>
    );
  }

  if (tool === "FileChange") {
    return (
      <MessageRow color="sky" icon={FilePenLine} title="File Changes">
        <FileChangeToolUseUI input={input} />
      </MessageRow>
    );
  }

  // Every remaining MCP tool renders as raw JSON below; the cross-remote ones
  // get a card first, because their one identifying argument is a bare uuid.
  if (isCrossRemoteTool(tool)) {
    return <CrossRemoteToolUse tool={tool} input={input} />;
  }

  const inputStr = typeof input === "string" ? input : JSON.stringify(input, null, 2);

  return (
    <MessageRow color="amber" icon={Wrench} title={`Tool: ${tool}`} titleClassName="break-words">
      <details open>
        <summary className="conv-text-xs text-muted-foreground cursor-pointer hover:text-foreground">
          Input
        </summary>
        <pre
          className="mt-1 bg-muted/50 p-2 rounded overflow-x-auto max-w-full whitespace-pre-wrap break-all"
          style={{ fontSize: "var(--conv-font-size, 12px)" }}
        >
          {inputStr.length > 500 ? inputStr.substring(0, 500) + "..." : inputStr}
        </pre>
      </details>
    </MessageRow>
  );
}

function ToolResultMessage({ tool, output }: { tool: string; output: string }) {
  // The proposal's result is a fixed acknowledgement written for the agent, not
  // for the user — the card above already says everything a reader needs.
  if (tool === PROPOSE_SCHEDULE_TOOL || tool === PROPOSE_TASK_TOOL) return null;

  // The screenshot the agent just looked at (Read/ImageView on an image) —
  // shown inline regardless of tool name, so the user sees what the agent saw.
  const images = parseImageBlocks(output);
  if (images) {
    return (
      <div className="flex gap-3 py-3 pl-11">
        <div className="flex-1 min-w-0 overflow-hidden">
          <ImageToolResultUI images={images} />
        </div>
      </div>
    );
  }

  // Task tool results get custom rendering
  const isTaskTool = ["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"].includes(tool);
  if (isTaskTool) {
    const taskListResult = tool === "TaskList" ? <TaskListResultUI output={output} /> : null;
    return (
      <div className="flex gap-3 py-3 pl-11">
        <div className="flex-1 min-w-0 overflow-hidden">
          <p className="conv-text-xs text-muted-foreground mb-1">Result ({tool})</p>
          {taskListResult || (
            <details>
              <summary className="conv-text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                Output
              </summary>
              <pre
                className="mt-1 bg-muted/50 p-2 rounded overflow-x-auto max-h-48 overflow-y-auto scrollbar-none max-w-full whitespace-pre-wrap break-all"
                style={{ fontSize: "var(--conv-font-size, 12px)" }}
              >
                {output.length > 1000 ? output.substring(0, 1000) + "..." : output}
              </pre>
            </details>
          )}
        </div>
      </div>
    );
  }

  if (tool === "Read") {
    return (
      <div className="flex gap-3 py-3 pl-11">
        <div className="flex-1 min-w-0 overflow-hidden">
          <ReadToolResultUI output={output} />
        </div>
      </div>
    );
  }

  if (tool === "Edit") {
    return (
      <div className="flex gap-3 py-3 pl-11">
        <div className="flex-1 min-w-0 overflow-hidden">
          <EditToolResultUI output={output} />
        </div>
      </div>
    );
  }

  if (tool === "Write") {
    return (
      <div className="flex gap-3 py-3 pl-11">
        <div className="flex-1 min-w-0 overflow-hidden">
          <WriteToolResultUI output={output} />
        </div>
      </div>
    );
  }

  if (tool === "Bash") {
    return (
      <div className="flex gap-3 py-3 pl-11">
        <div className="flex-1 min-w-0 overflow-hidden">
          <BashToolResultUI output={output} />
        </div>
      </div>
    );
  }

  if (tool === "Grep") {
    return (
      <div className="flex gap-3 py-3 pl-11">
        <div className="flex-1 min-w-0 overflow-hidden">
          <GrepToolResultUI output={output} />
        </div>
      </div>
    );
  }

  if (tool === "Glob") {
    return (
      <div className="flex gap-3 py-3 pl-11">
        <div className="flex-1 min-w-0 overflow-hidden">
          <GlobToolResultUI output={output} />
        </div>
      </div>
    );
  }

  if (tool === "Task" || tool === "Agent") {
    return (
      <div className="flex gap-3 py-3 pl-11">
        <div className="flex-1 min-w-0 overflow-hidden">
          <SubagentToolResultUI output={output} />
        </div>
      </div>
    );
  }

  if (tool === "TaskOutput") {
    return (
      <div className="flex gap-3 py-3 pl-11">
        <div className="flex-1 min-w-0 overflow-hidden">
          <TaskOutputToolResultUI output={output} />
        </div>
      </div>
    );
  }

  if (tool === "WebFetch") {
    return (
      <div className="flex gap-3 py-3 pl-11">
        <div className="flex-1 min-w-0 overflow-hidden">
          <WebFetchToolResultUI output={output} />
        </div>
      </div>
    );
  }

  if (tool === "WebSearch") {
    return (
      <div className="flex gap-3 py-3 pl-11">
        <div className="flex-1 min-w-0 overflow-hidden">
          <WebSearchToolResultUI output={output} />
        </div>
      </div>
    );
  }

  if (tool === "Skill") {
    return (
      <div className="flex gap-3 py-3 pl-11">
        <div className="flex-1 min-w-0 overflow-hidden">
          <SkillToolResultUI output={output} />
        </div>
      </div>
    );
  }

  if (tool === "FileChange") {
    return (
      <div className="flex gap-3 py-3 pl-11">
        <div className="flex-1 min-w-0 overflow-hidden">
          <FileChangeToolResultUI output={output} />
        </div>
      </div>
    );
  }

  if (isCrossRemoteTool(tool)) {
    return (
      <div className="flex gap-3 py-3 pl-11">
        <div className="flex-1 min-w-0 overflow-hidden">
          <CrossRemoteToolResult output={output} />
        </div>
      </div>
    );
  }

  const isLong = output.length > 200;

  return (
    <div className="flex gap-3 py-3 pl-11">
      <div className="flex-1 min-w-0 overflow-hidden">
        <p className="conv-text-xs text-muted-foreground mb-1">Result{tool ? ` (${tool})` : ""}</p>
        <details className={cn(!isLong && "open")}>
          <summary className="conv-text-xs text-muted-foreground cursor-pointer hover:text-foreground">
            Output
          </summary>
          <pre
            className="mt-1 bg-muted/50 p-2 rounded overflow-x-auto max-h-48 overflow-y-auto scrollbar-none max-w-full whitespace-pre-wrap break-all"
            style={{ fontSize: "var(--conv-font-size, 12px)" }}
          >
            {output.length > 1000 ? output.substring(0, 1000) + "..." : output}
          </pre>
        </details>
      </div>
    </div>
  );
}

function ThinkingMessage({ content }: { content: string }) {
  const text = content ?? "";
  const hasContent = text.trim().length > 0;
  const display = hasContent
    ? (text.length > 500 ? text.substring(0, 500) + "..." : text)
    : "Reasoning unavailable — this model does not expose its thinking content.";
  return (
    <div className="flex gap-3 py-3">
      <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-blue-500/10 flex items-center justify-center">
        <Brain className="w-4 h-4 text-blue-500" />
      </div>
      <div className="flex-1 min-w-0 overflow-hidden">
        <details>
          <summary className="conv-text-sm font-medium text-foreground cursor-pointer hover:underline">
            Thinking...
          </summary>
          <div
            className={`mt-2 whitespace-pre-wrap break-words bg-muted/50 p-2 rounded-md overflow-hidden ${
              hasContent ? "text-muted-foreground" : "text-muted-foreground/70 italic"
            }`}
            style={{ fontSize: "var(--conv-font-size, 12px)" }}
          >
            {display}
          </div>
        </details>
      </div>
    </div>
  );
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <MessageRow color="red" icon={AlertCircle} title="Error">
      <p
        className="text-destructive/80 break-words whitespace-pre-wrap"
        style={{ fontSize: "var(--conv-font-size, 14px)" }}
      >
        {message}
      </p>
    </MessageRow>
  );
}

function SystemMessage({ content }: { content: string }) {
  return (
    <div className="flex gap-3 py-2">
      <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-muted flex items-center justify-center">
        <Info className="w-4 h-4 text-muted-foreground" />
      </div>
      <div className="flex-1 min-w-0 overflow-hidden">
        <p
          className="text-muted-foreground break-words"
          style={{ fontSize: "var(--conv-font-size, 12px)" }}
        >
          {content ?? ""}
        </p>
      </div>
    </div>
  );
}
