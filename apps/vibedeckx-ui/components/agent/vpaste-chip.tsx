"use client";

import type { ReactNode } from "react";
import { CalendarClock, ClipboardPaste, FileText, ListPlus, Server } from "lucide-react";
import { useFileNavigation } from "./file-navigation-context";

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 10) return `${kb.toFixed(1)} KB`;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/**
 * The hub's `<vremotes>` block, shown as quiet metadata on the message header.
 * It records what the turn was allowed to reach — context about the message,
 * not part of what the user typed — so it stays out of the body. The block's
 * prose is written for the agent; `names` carries the same list for the UI.
 */
export function RemoteGrantMeta({ names }: { names: string }) {
  return (
    <span
      className="flex min-w-0 items-baseline gap-1 text-xs font-normal text-muted-foreground"
      title={`Remote access: ${names}`}
    >
      <Server className="w-3 h-3 shrink-0 self-center" />
      <span className="truncate">{names}</span>
    </span>
  );
}

/**
 * The Schedule chip's `<vschedule>` block, shown on the message header the same
 * way: the instruction prose is for the agent, the user only needs to see that
 * this message asked for a schedule.
 */
export function ScheduleIntentMeta() {
  return (
    <span className="flex shrink-0 items-baseline gap-1 text-xs font-normal text-muted-foreground">
      <CalendarClock className="w-3 h-3 shrink-0 self-center" />
      Schedule
    </span>
  );
}

/** The Task chip's `<vtask>` block, shown on the message header like Schedule. */
export function TaskIntentMeta() {
  return (
    <span className="flex shrink-0 items-baseline gap-1 text-xs font-normal text-muted-foreground">
      <ListPlus className="w-3 h-3 shrink-0 self-center" />
      Task
    </span>
  );
}

/**
 * Pull the `<vremotes>` block out of message text. Returns the text without it
 * (and without the blank lines the hub put in front of it), plus its names.
 */
export function takeRemotesMarker(text: string): { text: string; names: string | null } {
  const found = { names: null as string | null };
  const stripped = text.replace(new RegExp(VREMOTES_MARKER_RE.source, "g"), (_m, names: string) => {
    found.names = names;
    return "";
  });
  return found.names === null ? { text, names: null } : { text: stripped.trimEnd(), names: found.names };
}

/**
 * A long paste, shown where it was pasted: the composer lets it sit mid-sentence,
 * so it stays in the text flow as a pill sized to the line. Its file name is a
 * generated temp name that means nothing to the user; the path is in the tooltip.
 */
export function VPasteChip({ path, size }: { path: string; size: number }) {
  return (
    <OpenInFiles
      path={path}
      className="mx-0.5 inline-flex items-center gap-1 rounded-md border border-border bg-muted/50 px-1.5 align-[-0.2em] text-[0.85em] leading-[1.6]"
    >
      <ClipboardPaste className="h-[1.05em] w-[1.05em] shrink-0 text-muted-foreground" />
      <span className="font-medium">Pasted text</span>
      <span className="text-muted-foreground">{formatSize(size)}</span>
    </OpenInFiles>
  );
}

/**
 * Click opens the file in the Files tab, the way an absolute path the agent
 * mentions does (file-ref-link.tsx): the path is on the agent's machine, and
 * the Files tab resolves it through the conversation. Without a project open
 * there is nowhere to open it, so the chip stays inert.
 */
function OpenInFiles({ path, className, children }: { path: string; className: string; children: ReactNode }) {
  const { openFile, scope } = useFileNavigation();
  if (!scope) {
    return <span className={className} title={path}>{children}</span>;
  }
  return (
    <button
      type="button"
      className={`${className} cursor-pointer text-left transition-colors hover:border-foreground/25 hover:bg-muted`}
      title={`Open in Files — ${path}`}
      onClick={() => openFile(path)}
    >
      {children}
    </button>
  );
}

function extension(name: string): string | null {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : null;
}

/**
 * A file from Add files: an attachment card (icon tile, name, "type · size"),
 * shown above the message text the way chat apps show attached files.
 */
export function VFileCard({ path, size, name }: { path: string; size: number; name: string }) {
  const title = name || basename(path);
  return (
    <OpenInFiles
      path={path}
      className="inline-flex max-w-[16rem] items-center gap-2.5 rounded-lg border border-border bg-muted/40 py-1.5 pl-1.5 pr-3"
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background">
        <FileText className="h-4 w-4 text-muted-foreground" />
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-xs font-medium text-foreground">{title}</span>
        <span className="truncate text-[11px] text-muted-foreground">
          {extension(title) ?? "File"} · {formatSize(size)}
        </span>
      </span>
    </OpenInFiles>
  );
}

export const VPASTE_MARKER_RE = /<vpaste path="([^"]+)" size="(\d+)" \/>/g;
/** Uploaded non-image attachment: file on the agent's machine, referenced by path. */
export const VFILE_MARKER_RE = /<vfile path="([^"]+)" name="([^"]*)" size="(\d+)" \/>/g;
/** Hub-injected cross-remote grant context; `names` is the display list. */
export const VREMOTES_MARKER_RE = /<vremotes names="([^"]*)">[\s\S]*?<\/vremotes>/g;
const ANY_MARKER_RE = new RegExp(
  `${VPASTE_MARKER_RE.source}|${VFILE_MARKER_RE.source}|${VREMOTES_MARKER_RE.source}`,
  "g",
);

export function vfileMarker(file: { path: string; name: string; size: number }): string {
  return `<vfile path="${file.path}" name="${file.name}" size="${file.size}" />`;
}

/**
 * Split a string into an array of literal-text segments and chip descriptors.
 * Consumers render each segment in order.
 */
export type VPasteSegment =
  | { kind: "text"; text: string }
  | { kind: "chip"; path: string; size: number; name?: string }
  | { kind: "remotes"; names: string };

export function splitVPasteMarkers(text: string): VPasteSegment[] {
  const segments: VPasteSegment[] = [];
  let lastIndex = 0;
  const re = new RegExp(ANY_MARKER_RE.source, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: "text", text: text.slice(lastIndex, match.index) });
    }
    if (match[1] !== undefined) {
      segments.push({ kind: "chip", path: match[1], size: Number(match[2]) });
    } else if (match[3] !== undefined) {
      segments.push({ kind: "chip", path: match[3], name: match[4], size: Number(match[5]) });
    } else {
      segments.push({ kind: "remotes", names: match[6] });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    segments.push({ kind: "text", text: text.slice(lastIndex) });
  }
  return segments;
}
