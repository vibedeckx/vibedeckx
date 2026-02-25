"use client";

import { useCallback, useEffect, useState, useRef } from "react";
import { Plus, X, Terminal, Monitor, Cloud, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ExecutorOutput } from "@/components/executor/executor-output";
import { useTerminals } from "@/hooks/use-terminals";
import { useExecutorLogs } from "@/hooks/use-executor-logs";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import type { Project } from "@/lib/api";

interface TerminalPanelProps {
  projectId: string | null;
  selectedBranch?: string | null;
  project?: Project | null;
}

function TerminalInstance({
  terminalId,
  onExit,
}: {
  terminalId: string;
  onExit: (id: string) => void;
}) {
  const { logs, sendInput, sendResize, exitCode } = useExecutorLogs(terminalId);

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
    />
  );
}

export function TerminalPanel({ projectId, selectedBranch, project }: TerminalPanelProps) {
  const {
    terminals,
    activeTerminalId,
    createTerminal,
    closeTerminal,
    setActiveTerminal,
    removeTerminal,
  } = useTerminals(projectId, selectedBranch);

  const [showLocationMenu, setShowLocationMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const hasBothPaths = !!(project?.path && project?.remote_url);
  const defaultLocation = hasBothPaths && project?.executor_mode === "remote" ? "remote" : "local";

  const handleCreateDefault = useCallback(() => {
    createTerminal(hasBothPaths ? defaultLocation : undefined);
  }, [createTerminal, hasBothPaths, defaultLocation]);

  const handleCreateAt = useCallback(
    (location: "local" | "remote") => {
      setShowLocationMenu(false);
      createTerminal(location);
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
        Select a project to use the terminal
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center h-10 border-b px-2 gap-1 shrink-0">
        <ScrollArea className="flex-1">
          <div className="flex items-center gap-1">
            {terminals.map((t) => {
              const isRemote = t.location === "remote" || t.id.startsWith("remote-");
              const TabIcon = hasBothPaths
                ? isRemote
                  ? Cloud
                  : Monitor
                : Terminal;

              return (
                <button
                  key={t.id}
                  onClick={() => setActiveTerminal(t.id)}
                  className={cn(
                    "flex items-center gap-1.5 px-2.5 py-1 rounded text-xs whitespace-nowrap transition-colors",
                    activeTerminalId === t.id
                      ? "bg-accent text-accent-foreground"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent/50"
                  )}
                >
                  <TabIcon className="h-3 w-3" />
                  {t.name}
                  <span
                    role="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTerminal(t.id);
                    }}
                    className="ml-1 hover:text-destructive"
                  >
                    <X className="h-3 w-3" />
                  </span>
                </button>
              );
            })}
          </div>
          <ScrollBar orientation="horizontal" />
        </ScrollArea>

        {hasBothPaths ? (
          <div className="relative shrink-0" ref={menuRef}>
            <div className="flex items-center">
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 rounded-r-none"
                onClick={handleCreateDefault}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-4 rounded-l-none border-l border-border/50"
                onClick={() => setShowLocationMenu((v) => !v)}
              >
                <ChevronDown className="h-3 w-3" />
              </Button>
            </div>
            {showLocationMenu && (
              <div className="absolute right-0 top-full mt-1 z-50 min-w-[160px] rounded-md border bg-popover p-1 shadow-md">
                <button
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground transition-colors"
                  onClick={() => handleCreateAt("local")}
                >
                  <Monitor className="h-3.5 w-3.5" />
                  Local Terminal
                </button>
                <button
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-xs hover:bg-accent hover:text-accent-foreground transition-colors"
                  onClick={() => handleCreateAt("remote")}
                >
                  <Cloud className="h-3.5 w-3.5" />
                  Remote Terminal
                </button>
              </div>
            )}
          </div>
        ) : (
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={handleCreateDefault}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>

      {/* Terminal content */}
      <div className="flex-1 overflow-hidden bg-zinc-950">
        {activeTerminalId ? (
          <TerminalInstance
            key={activeTerminalId}
            terminalId={activeTerminalId}
            onExit={handleExit}
          />
        ) : (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground gap-3">
            <Terminal className="h-8 w-8" />
            <p className="text-sm">No terminal open</p>
            <Button variant="outline" size="sm" onClick={handleCreateDefault}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              New Terminal
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
