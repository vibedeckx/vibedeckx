"use client";

import { cn } from "@/lib/utils";
import { Bot, User, Wrench, Brain, AlertCircle, Info, HelpCircle, FileCheck, ListTodo, FileText, Terminal, Search, FolderSearch, Workflow, FilePenLine, Globe, Sparkles, FilePlus2, Globe2, ShieldAlert } from "lucide-react";
import type { AgentMessage, ContentPart } from "@/hooks/use-agent-session";
import { MessageResponse } from "@/components/ai-elements/message";
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
import { ReadToolUseUI, ReadToolResultUI, WriteToolUseUI, WriteToolResultUI } from "./file-tools";
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
import { VPasteChip, splitVPasteMarkers } from "./vpaste-chip";
import { Fragment } from "react";

interface AgentMessageProps {
  message: AgentMessage;
  messageIndex: number;
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

export function AgentMessageItem({ message, messageIndex }: AgentMessageProps) {
  const body = renderBody(message, messageIndex);
  if (!body) return null;
  return (
    <div className="group relative">
      {body}
      <span className="pointer-events-none absolute right-0 top-3 text-xs tabular-nums text-muted-foreground opacity-0 transition-opacity duration-150 group-hover:opacity-100">
        {formatTimestamp(message.timestamp)}
      </span>
    </div>
  );
}

function renderBody(message: AgentMessage, messageIndex: number) {
  switch (message.type) {
    case "user":
      return <UserMessage content={message.content} />;

    case "assistant":
      return <AssistantMessage content={message.content} />;

    case "tool_use":
      return <ToolUseMessage tool={message.tool} input={message.input} messageIndex={messageIndex} />;

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
        <div className="flex gap-3 py-3">
          <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-amber-500/10 flex items-center justify-center">
            <ShieldAlert className="w-4 h-4 text-amber-500" />
          </div>
          <div className="flex-1 min-w-0 overflow-hidden">
            <p className="text-sm font-medium text-amber-500 mb-1">
              {message.requestType === "command" ? "Command Approval" : "File Change Approval"}
            </p>
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
          </div>
        </div>
      );

    default:
      return null;
  }
}

function renderTextWithVPaste(text: string) {
  const segments = splitVPasteMarkers(text);
  if (segments.length === 1 && segments[0].kind === "text") {
    return <MessageResponse>{text ?? ""}</MessageResponse>;
  }
  return (
    <div className="text-sm text-foreground break-words">
      {segments.map((seg, i) =>
        seg.kind === "text" ? (
          <Fragment key={i}>
            <MessageResponse>{seg.text}</MessageResponse>
          </Fragment>
        ) : (
          <VPasteChip key={i} path={seg.path} size={seg.size} />
        )
      )}
    </div>
  );
}

function UserMessage({ content }: { content: string | ContentPart[] }) {
  return (
    <div className="flex gap-3 py-3">
      <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center">
        <User className="w-3.5 h-3.5 text-primary" />
      </div>
      <div className="flex-1 min-w-0 overflow-hidden">
        <p className="text-sm font-medium text-foreground mb-1">You</p>
        <div className="text-sm text-foreground prose prose-sm dark:prose-invert max-w-none break-words [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_code]:break-all [&_p]:break-words">
          {typeof content === "string" ? (
            renderTextWithVPaste(content)
          ) : (
            content.map((part, i) =>
              part.type === "text" ? (
                <Fragment key={i}>{renderTextWithVPaste(part.text)}</Fragment>
              ) : (
                <img
                  key={i}
                  src={`data:${part.mediaType};base64,${part.data}`}
                  alt="Attached image"
                  className="max-w-sm rounded-lg mt-2"
                />
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

function AssistantMessage({ content }: { content: string }) {
  const agentType = useAgentType();
  const isCodex = agentType === "codex";
  const label = isCodex ? "Codex" : "Claude";
  const iconBg = isCodex ? "bg-green-500/10" : "bg-violet-500/10";
  const iconColor = isCodex ? "text-green-500" : "text-violet-500";
  const textColor = isCodex ? "text-green-500" : "text-violet-500";

  return (
    <div className="flex gap-3 py-3">
      <div className={`flex-shrink-0 w-7 h-7 rounded-lg ${iconBg} flex items-center justify-center`}>
        <Bot className={`w-3.5 h-3.5 ${iconColor}`} />
      </div>
      <div className="flex-1 min-w-0 overflow-hidden">
        <p className={`text-sm font-medium ${textColor} mb-1`}>{label}</p>
        <div className="text-sm text-foreground prose prose-sm dark:prose-invert max-w-none break-words [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_code]:break-all [&_p]:break-words">
          <MessageResponse>{content ?? ""}</MessageResponse>
        </div>
      </div>
    </div>
  );
}

function ToolUseMessage({ tool, input, messageIndex }: { tool: string; input: unknown; messageIndex: number }) {
  if (tool === "AskUserQuestion") {
    return (
      <div className="flex gap-3 py-3">
        <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-violet-500/10 flex items-center justify-center">
          <HelpCircle className="w-4 h-4 text-violet-500" />
        </div>
        <div className="flex-1 min-w-0 overflow-hidden">
          <p className="text-sm font-medium text-violet-500 mb-1">Question</p>
          <AskUserQuestion input={input} messageIndex={messageIndex} />
        </div>
      </div>
    );
  }

  if (tool === "ExitPlanMode") {
    return (
      <div className="flex gap-3 py-3">
        <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-green-500/10 flex items-center justify-center">
          <FileCheck className="w-4 h-4 text-green-500" />
        </div>
        <div className="flex-1 min-w-0 overflow-hidden">
          <p className="text-sm font-medium text-green-500 mb-1">Plan Ready</p>
          <ExitPlanModeUI input={input} messageIndex={messageIndex} />
        </div>
      </div>
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
      <div className="flex gap-3 py-3">
        <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-cyan-500/10 flex items-center justify-center">
          <ListTodo className="w-4 h-4 text-cyan-500" />
        </div>
        <div className="flex-1 min-w-0 overflow-hidden">
          <p className="text-sm font-medium text-cyan-500 mb-1">{taskTool.label}</p>
          {taskTool.ui}
        </div>
      </div>
    );
  }

  if (tool === "Read") {
    return (
      <div className="flex gap-3 py-3">
        <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-sky-500/10 flex items-center justify-center">
          <FileText className="w-4 h-4 text-sky-500" />
        </div>
        <div className="flex-1 min-w-0 overflow-hidden">
          <p className="text-sm font-medium text-sky-500 mb-1">Read File</p>
          <ReadToolUseUI input={input} />
        </div>
      </div>
    );
  }

  if (tool === "Edit") {
    return (
      <div className="flex gap-3 py-3">
        <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-sky-500/10 flex items-center justify-center">
          <FilePenLine className="w-4 h-4 text-sky-500" />
        </div>
        <div className="flex-1 min-w-0 overflow-hidden">
          <p className="text-sm font-medium text-sky-500 mb-1">Edit File</p>
          <EditToolUseUI input={input} />
        </div>
      </div>
    );
  }

  if (tool === "Write") {
    return (
      <div className="flex gap-3 py-3">
        <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-sky-500/10 flex items-center justify-center">
          <FilePlus2 className="w-4 h-4 text-sky-500" />
        </div>
        <div className="flex-1 min-w-0 overflow-hidden">
          <p className="text-sm font-medium text-sky-500 mb-1">Write File</p>
          <WriteToolUseUI input={input} />
        </div>
      </div>
    );
  }

  if (tool === "Bash") {
    return (
      <div className="flex gap-3 py-3">
        <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-emerald-500/10 flex items-center justify-center">
          <Terminal className="w-4 h-4 text-emerald-500" />
        </div>
        <div className="flex-1 min-w-0 overflow-hidden">
          <p className="text-sm font-medium text-emerald-500 mb-1">Run Command</p>
          <BashToolUseUI input={input} />
        </div>
      </div>
    );
  }

  if (tool === "Grep") {
    return (
      <div className="flex gap-3 py-3">
        <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-orange-500/10 flex items-center justify-center">
          <Search className="w-4 h-4 text-orange-500" />
        </div>
        <div className="flex-1 min-w-0 overflow-hidden">
          <p className="text-sm font-medium text-orange-500 mb-1">Search</p>
          <GrepToolUseUI input={input} />
        </div>
      </div>
    );
  }

  if (tool === "Glob") {
    return (
      <div className="flex gap-3 py-3">
        <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-teal-500/10 flex items-center justify-center">
          <FolderSearch className="w-4 h-4 text-teal-500" />
        </div>
        <div className="flex-1 min-w-0 overflow-hidden">
          <p className="text-sm font-medium text-teal-500 mb-1">Glob</p>
          <GlobToolUseUI input={input} />
        </div>
      </div>
    );
  }

  if (tool === "Task" || tool === "Agent") {
    return (
      <div className="flex gap-3 py-3">
        <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-purple-500/10 flex items-center justify-center">
          <Workflow className="w-4 h-4 text-purple-500" />
        </div>
        <div className="flex-1 min-w-0 overflow-hidden">
          <p className="text-sm font-medium text-purple-500 mb-1">Agent</p>
          <SubagentToolUseUI input={input} />
        </div>
      </div>
    );
  }

  if (tool === "TaskOutput") {
    return (
      <div className="flex gap-3 py-3">
        <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-purple-500/10 flex items-center justify-center">
          <Workflow className="w-4 h-4 text-purple-500" />
        </div>
        <div className="flex-1 min-w-0 overflow-hidden">
          <p className="text-sm font-medium text-purple-500 mb-1">Task Output</p>
          <TaskOutputToolUseUI input={input} />
        </div>
      </div>
    );
  }

  if (tool === "WebFetch") {
    return (
      <div className="flex gap-3 py-3">
        <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-blue-500/10 flex items-center justify-center">
          <Globe className="w-4 h-4 text-blue-500" />
        </div>
        <div className="flex-1 min-w-0 overflow-hidden">
          <p className="text-sm font-medium text-blue-500 mb-1">Fetch Web Page</p>
          <WebFetchToolUseUI input={input} />
        </div>
      </div>
    );
  }

  if (tool === "WebSearch") {
    return (
      <div className="flex gap-3 py-3">
        <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-indigo-500/10 flex items-center justify-center">
          <Globe2 className="w-4 h-4 text-indigo-500" />
        </div>
        <div className="flex-1 min-w-0 overflow-hidden">
          <p className="text-sm font-medium text-indigo-500 mb-1">Web Search</p>
          <WebSearchToolUseUI input={input} />
        </div>
      </div>
    );
  }

  if (tool === "Skill") {
    return (
      <div className="flex gap-3 py-3">
        <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-pink-500/10 flex items-center justify-center">
          <Sparkles className="w-4 h-4 text-pink-500" />
        </div>
        <div className="flex-1 min-w-0 overflow-hidden">
          <p className="text-sm font-medium text-pink-500 mb-1">Skill</p>
          <SkillToolUseUI input={input} />
        </div>
      </div>
    );
  }

  if (tool === "FileChange") {
    return (
      <div className="flex gap-3 py-3">
        <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-sky-500/10 flex items-center justify-center">
          <FilePenLine className="w-4 h-4 text-sky-500" />
        </div>
        <div className="flex-1 min-w-0 overflow-hidden">
          <p className="text-sm font-medium text-sky-500 mb-1">File Changes</p>
          <FileChangeToolUseUI input={input} />
        </div>
      </div>
    );
  }

  const inputStr = typeof input === "string" ? input : JSON.stringify(input, null, 2);

  return (
    <div className="flex gap-3 py-3">
      <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-amber-500/10 flex items-center justify-center">
        <Wrench className="w-4 h-4 text-amber-500" />
      </div>
      <div className="flex-1 min-w-0 overflow-hidden">
        <p className="text-sm font-medium text-amber-500 mb-1 break-words">Tool: {tool}</p>
        <details open>
          <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
            Input
          </summary>
          <pre className="mt-1 text-xs bg-muted/50 p-2 rounded overflow-x-auto max-w-full whitespace-pre-wrap break-all">
            {inputStr.length > 500 ? inputStr.substring(0, 500) + "..." : inputStr}
          </pre>
        </details>
      </div>
    </div>
  );
}

function ToolResultMessage({ tool, output }: { tool: string; output: string }) {
  // Task tool results get custom rendering
  const isTaskTool = ["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"].includes(tool);
  if (isTaskTool) {
    const taskListResult = tool === "TaskList" ? <TaskListResultUI output={output} /> : null;
    return (
      <div className="flex gap-3 py-3 pl-11">
        <div className="flex-1 min-w-0 overflow-hidden">
          <p className="text-xs text-muted-foreground mb-1">Result ({tool})</p>
          {taskListResult || (
            <details>
              <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                Output
              </summary>
              <pre className="mt-1 text-xs bg-muted/50 p-2 rounded overflow-x-auto max-h-48 overflow-y-auto max-w-full whitespace-pre-wrap break-all">
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

  const isLong = output.length > 200;

  return (
    <div className="flex gap-3 py-3 pl-11">
      <div className="flex-1 min-w-0 overflow-hidden">
        <p className="text-xs text-muted-foreground mb-1">Result{tool ? ` (${tool})` : ""}</p>
        <details className={cn(!isLong && "open")}>
          <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
            Output
          </summary>
          <pre className="mt-1 text-xs bg-muted/50 p-2 rounded overflow-x-auto max-h-48 overflow-y-auto max-w-full whitespace-pre-wrap break-all">
            {output.length > 1000 ? output.substring(0, 1000) + "..." : output}
          </pre>
        </details>
      </div>
    </div>
  );
}

function ThinkingMessage({ content }: { content: string }) {
  return (
    <div className="flex gap-3 py-3">
      <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-blue-500/10 flex items-center justify-center">
        <Brain className="w-3.5 h-3.5 text-blue-500" />
      </div>
      <div className="flex-1 min-w-0 overflow-hidden">
        <details>
          <summary className="text-xs font-medium text-blue-500 cursor-pointer hover:underline">
            Thinking...
          </summary>
          <div className="mt-2 text-xs text-muted-foreground whitespace-pre-wrap break-words bg-blue-500/5 p-2 rounded-md overflow-hidden">
            {(content ?? "").length > 500 ? (content ?? "").substring(0, 500) + "..." : content ?? ""}
          </div>
        </details>
      </div>
    </div>
  );
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <div className="flex gap-3 py-3">
      <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-red-500/10 flex items-center justify-center">
        <AlertCircle className="w-3.5 h-3.5 text-red-500" />
      </div>
      <div className="flex-1 min-w-0 overflow-hidden">
        <p className="text-sm font-medium text-red-500 mb-1">Error</p>
        <p className="text-sm text-red-500/80 break-words">{message}</p>
      </div>
    </div>
  );
}

function SystemMessage({ content }: { content: string }) {
  return (
    <div className="flex gap-3 py-2">
      <div className="flex-shrink-0 w-7 h-7 rounded-lg bg-gray-500/10 flex items-center justify-center">
        <Info className="w-3.5 h-3.5 text-gray-500" />
      </div>
      <div className="flex-1 min-w-0 overflow-hidden">
        <p className="text-xs text-muted-foreground break-words">{content ?? ""}</p>
      </div>
    </div>
  );
}
