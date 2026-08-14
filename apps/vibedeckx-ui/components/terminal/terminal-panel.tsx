"use client";

import { useCallback, useEffect, useState, useRef, type Ref } from "react";
import { Plus, X, Terminal, Monitor, Cloud } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ExecutorOutput, type TerminalFocusHandle } from "@/components/executor/executor-output";
import { useTerminals } from "@/hooks/use-terminals";
import { useExecutorLogs } from "@/hooks/use-executor-logs";
import { useProjectRemotesContext } from "@/hooks/project-remotes-context";
import type { Project } from "@/lib/api";

interface TerminalPanelProps {
  projectId: string | null;
  selectedBranch?: string | null;
  project?: Project | null;
  // Whether the Terminal tab is the one on screen. The panel stays mounted
  // (hidden via CSS) behind other tabs, so this is what tells it when to hand
  // keyboard focus to the active shell.
  active?: boolean;
}

function TerminalInstance({
  terminalId,
  onExit,
  focusHandle,
}: {
  terminalId: string;
  onExit: (id: string) => void;
  focusHandle: Ref<TerminalFocusHandle>;
}) {
  const { logs, sendInput, sendResize, exitCode, replayingHistory } = useExecutorLogs(terminalId);

  // When shell exits, notify parent
  useEffect(() => {
    if (exitCode !== null) {
      onExit(terminalId);
    }
  }, [exitCode, onExit, terminalId]);

  return (
    <ExecutorOutput
      logs={logs}
      isPty={true}
      className="h-full rounded-none border-0"
      onInput={sendInput}
      onResize={sendResize}
      muteInput={replayingHistory}
      focusHandle={focusHandle}
    />
  );
}

export function TerminalPanel({ projectId, selectedBranch, project, active = true }: TerminalPanelProps) {
  const {
    terminals,
    activeTerminalId,
    createTerminal,
    closeTerminal,
    setActiveTerminal,
    removeTerminal,
  } = useTerminals(projectId, selectedBranch);

  const { remotes } = useProjectRemotesContext();

  // Give the visible shell keyboard focus when the tab is opened (⌃⇧T /
  // Ctrl+Alt+T or a click on the tab button) and whenever the shown terminal
  // changes while the tab is open — switching or creating a terminal should
  // leave you able to type right away instead of needing a click. Nothing
  // happens while the panel is hidden, so background terminals never grab
  // focus from the composer. The tab's `hidden` class is already off the DOM
  // by the time effects run, so focus() lands on a visible textarea.
  const focusHandleRef = useRef<TerminalFocusHandle | null>(null);
  useEffect(() => {
    if (!active || !activeTerminalId) return;
    focusHandleRef.current?.focus();
  }, [active, activeTerminalId]);

  const [showLocationMenu, setShowLocationMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const hasLocal = !!project?.path;
  const hasRemotes = remotes.length > 0;
  const hasMultipleTargets = (hasLocal && hasRemotes) || remotes.length > 1;
  const defaultLocation: "local" | "remote" =
    !hasLocal && hasRemotes ? "remote" :
    hasMultipleTargets && project?.executor_mode !== "local" ? "remote" : "local";

  const handleCreateDefault = useCallback(() => {
    createTerminal(defaultLocation);
  }, [createTerminal, defaultLocation]);

  const handleCreateAt = useCallback(
    (location: "local" | "remote", remoteServerId?: string) => {
      setShowLocationMenu(false);
      createTerminal(location, remoteServerId);
    },
    [createTerminal]
  );

  // Click-outside to close the dropdown menu
  useEffect(() => {
    if (!showLocationMenu) return;
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowLocationMenu(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showLocationMenu]);

  const handleExit = useCallback(
    (id: string) => {
      removeTerminal(id);
    },
    [removeTerminal]
  );

  if (!projectId) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <div className="mx-auto w-10 h-10 rounded-xl bg-muted flex items-center justify-center mb-3">
            <Terminal className="h-5 w-5 text-muted-foreground/50" />
          </div>
          <p className="text-sm">Select a project to use the terminal</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center h-10 border-b border-border/60 px-2 gap-1 shrink-0 bg-muted/20">
        <div className="flex-1 min-w-0 flex items-center gap-1 overflow-hidden">
          {terminals.map((t) => {
            const isRemote = t.location === "remote" || t.id.startsWith("remote-");
            const TabIcon = hasMultipleTargets
              ? isRemote
                ? Cloud
                : Monitor
              : Terminal;
            const isActive = activeTerminalId === t.id;

            return (
              <button
                key={t.id}
                onClick={() => setActiveTerminal(t.id)}
                title={t.name}
                className={cn(
                  "group flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-all duration-150 border flex-1 min-w-0 basis-0 max-w-[180px]",
                  isActive
                    ? "bg-background text-foreground border-border shadow-sm"
                    : "text-muted-foreground hover:text-foreground bg-muted/40 hover:bg-background/60 border-border/30 hover:border-border/60"
                )}
              >
                <TabIcon className="h-3 w-3 shrink-0" />
                <span className="truncate flex-1 text-left">{t.name}</span>
                <span
                  role="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTerminal(t.id);
                  }}
                  className={cn(
                    "shrink-0 rounded-sm p-0.5 hover:bg-destructive/10 hover:text-destructive",
                    isActive
                      ? "opacity-80 hover:opacity-100"
                      : "opacity-0 group-hover:opacity-80 hover:!opacity-100"
                  )}
                >
                  <X className="h-3 w-3" />
                </span>
              </button>
            );
          })}
        </div>

        <div className="relative shrink-0" ref={menuRef}>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6"
            onClick={hasMultipleTargets ? () => setShowLocationMenu((v) => !v) : handleCreateDefault}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
          {hasMultipleTargets && showLocationMenu && (
            <div className="absolute right-0 top-full mt-1 z-50 min-w-[160px] rounded-md border bg-popover p-1 shadow-md">
              {hasLocal && (
                <button
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground transition-colors"
                  onClick={() => handleCreateAt("local")}
                >
                  <Monitor className="h-3.5 w-3.5" />
                  Local Terminal
                </button>
              )}
              {remotes.map((r) => (
                <button
                  key={r.remote_server_id}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground transition-colors"
                  onClick={() => handleCreateAt("remote", r.remote_server_id)}
                >
                  <Cloud className="h-3.5 w-3.5" />
                  {r.server_name} Terminal
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Terminal content */}
      <div className="flex-1 overflow-hidden bg-zinc-950">
        {activeTerminalId ? (
          <TerminalInstance
            key={activeTerminalId}
            terminalId={activeTerminalId}
            onExit={handleExit}
            focusHandle={focusHandleRef}
          />
        ) : (
          <div className="h-full flex items-center justify-center text-muted-foreground">
            <Terminal className="h-10 w-10 text-muted-foreground/70" />
          </div>
        )}
      </div>
    </div>
  );
}
