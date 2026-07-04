"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { Circle, Square, Info, Copy } from "lucide-react";
import { toast } from "sonner";
import type { LogMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useTerminalSettings } from "@/hooks/use-terminal-settings";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Strip ANSI escape sequences (CSI, OSC, and single-char escapes) for
// clipboard-friendly plain text.
const ANSI_REGEX =
  // eslint-disable-next-line no-control-regex
  /\x1B(?:\][^\x07]*(?:\x07|\x1B\\)|[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

function stripAnsi(input: string): string {
  return input.replace(ANSI_REGEX, "");
}

interface ExecutorOutputProps {
  logs: LogMessage[];
  isPty: boolean;
  className?: string;
  onInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  muteInput?: boolean;
  // Debug/identification metadata for the process this window is rendering.
  // Surfaced via the info button so the processId can be matched against the
  // `[diag:mux]` / SSE console logs and the `/api/executor-logs/stream` frames.
  processId?: string | null;
  executorId?: string;
  target?: string;
  status?: string;
  exitCode?: number | null;
}

// Always use xterm.js for rendering to properly interpret ANSI escape codes
export function ExecutorOutput({
  logs,
  isPty,
  className,
  onInput,
  onResize,
  muteInput,
  processId,
  executorId,
  target,
  status,
  exitCode,
}: ExecutorOutputProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastLogIndexRef = useRef(0);
  // Count of replayed-history chunks still queued in xterm's write buffer.
  // xterm parses write() data asynchronously (12ms time slices), so responses
  // it generates to query sequences embedded in replayed history (DA1, CPR,
  // OSC 10/11, DECRQM…) are emitted via onData AFTER history_end has flipped
  // muteInput back to false. Forwarding those responses to the idle shell
  // makes readline echo them as garbage ("0;276;0c10;rgb:fafa/…"), which then
  // lands in the server-side log history and replays forever. The counter is
  // incremented before each historical write and decremented in that write's
  // parse-completion callback — which xterm fires strictly after all onData
  // events for the chunk — so the mute covers exactly the replayed bytes.
  const historyParseMuteRef = useRef(0);
  const muteInputRef = useRef(muteInput);
  if (muteInputRef.current !== muteInput) {
    console.log(`[ExecutorOutput] muteInput changed: ${muteInputRef.current} → ${muteInput}`);
  }
  muteInputRef.current = muteInput;

  const { settings: terminalSettings } = useTerminalSettings();
  const initialSettingsRef = useRef(terminalSettings);

  const [isCapturing, setIsCapturing] = useState(false);
  const captureStartRef = useRef(0);
  const logsRef = useRef(logs);
  logsRef.current = logs;

  const handleCaptureToggle = async () => {
    if (!isCapturing) {
      captureStartRef.current = logsRef.current.length;
      setIsCapturing(true);
      return;
    }

    const current = logsRef.current;
    // If logs were reset since capture started, fall back to capturing all.
    const startIdx = Math.min(captureStartRef.current, current.length);
    const captured = current
      .slice(startIdx)
      .map((log) =>
        log.type === "stdout" || log.type === "stderr" || log.type === "pty"
          ? log.data
          : ""
      )
      .join("");
    setIsCapturing(false);

    const text = stripAnsi(captured);
    if (!text) {
      toast.info("Capture stopped — no output to copy");
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied captured output to clipboard");
    } catch {
      toast.error("Failed to copy to clipboard");
    }
  };

  // Initialize terminal
  useEffect(() => {
    if (!containerRef.current || terminalRef.current) return;

    const initial = initialSettingsRef.current;
    const terminal = new Terminal({
      cursorBlink: isPty, // Only blink cursor in PTY mode
      cursorStyle: isPty ? "block" : "underline",
      disableStdin: !isPty, // Disable input in non-PTY mode
convertEol: true, // Convert \n to \r\n for proper line handling on macOS
      fontSize: initial.fontSize,
      fontFamily: initial.fontFamily,
      scrollback: initial.scrollback,
      theme: {
        background: "#09090b",
        foreground: "#fafafa",
        cursor: isPty ? "#fafafa" : "#09090b", // Hide cursor in non-PTY mode
        cursorAccent: "#09090b",
        selectionBackground: "#3f3f46",
        black: "#09090b",
        red: "#f87171",
        green: "#4ade80",
        yellow: "#facc15",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#fafafa",
        brightBlack: "#71717a",
        brightRed: "#fca5a5",
        brightGreen: "#86efac",
        brightYellow: "#fde047",
        brightBlue: "#93c5fd",
        brightMagenta: "#d8b4fe",
        brightCyan: "#67e8f9",
        brightWhite: "#ffffff",
      },
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);

    terminal.open(containerRef.current);

    // Delay fit to ensure container is ready
    setTimeout(() => {
      try {
        // Skip fit while the container is hidden (0×0): fitting against no size
        // resizes xterm to a tiny column count and tells the PTY it is narrow,
        // corrupting the prompt wrap. The ResizeObserver re-fits once visible.
        const el = containerRef.current;
        if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
        fitAddon.fit();
        if (isPty) {
          onResize?.(terminal.cols, terminal.rows);
        }
      } catch {
        // Ignore fit errors
      }
    }, 0);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Handle user input (only in PTY mode)
    if (isPty && onInput) {
      terminal.onData((data) => {
        if (!muteInputRef.current && historyParseMuteRef.current === 0) {
          onInput(data);
        }
      });
    }

    // Handle resize (only in PTY mode)
    if (isPty && onResize) {
      terminal.onResize(({ cols, rows }) => {
        onResize(cols, rows);
      });
    }

    return () => {
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
      lastLogIndexRef.current = 0;
      // Disposing drops queued write callbacks — a stuck counter would mute
      // the next terminal instance forever.
      historyParseMuteRef.current = 0;
    };
  }, [isPty, onInput, onResize]);

  // Write new logs to terminal
  useEffect(() => {
    if (!terminalRef.current) return;

    // Logs were cleared (e.g., on WebSocket reconnect) — reset terminal
    if (logs.length < lastLogIndexRef.current) {
      terminalRef.current.reset();
      lastLogIndexRef.current = 0;
    }

    // Coalesce all new logs into a single write. Writing each entry with its
    // own terminal.write() call floods xterm's internal WriteBuffer — when a
    // large backlog arrives at once (e.g. full-history replay on WS reconnect)
    // the queued-chunk count exceeds xterm's discard limit and it throws
    // "write data discarded, use flow control to avoid losing data", which
    // bubbles out of React's commit phase into the error boundary. One write
    // per effect run keeps the buffer to a single chunk.
    // Historical (replayed) bytes are written separately from live bytes so
    // the history-parse mute counter covers exactly the replay. Within one
    // batch all historical entries precede live ones (history only exists at
    // the start of a connection), so writing hist-then-live preserves order.
    let pendingHistorical = "";
    let pendingLive = "";
    for (let i = lastLogIndexRef.current; i < logs.length; i++) {
      const log = logs[i];
      // PTY/stdout/stderr are all written verbatim (ANSI interpreted by xterm).
      if (log.type === "pty" || log.type === "stdout" || log.type === "stderr") {
        if (log.historical) {
          pendingHistorical += log.data;
        } else {
          pendingLive += log.data;
        }
      }
    }
    lastLogIndexRef.current = logs.length;
    if (pendingHistorical) {
      historyParseMuteRef.current++;
      try {
        terminalRef.current.write(pendingHistorical, () => {
          historyParseMuteRef.current = Math.max(0, historyParseMuteRef.current - 1);
        });
      } catch (err) {
        historyParseMuteRef.current = Math.max(0, historyParseMuteRef.current - 1);
        // Last-resort guard: never let a terminal write crash the React tree.
        console.error("[ExecutorOutput] terminal write failed", err);
      }
    }
    if (pendingLive) {
      try {
        terminalRef.current.write(pendingLive);
      } catch (err) {
        console.error("[ExecutorOutput] terminal write failed", err);
      }
    }
  }, [logs]);

  // Apply live terminal settings changes (font, scrollback) without remounting
  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    terminal.options.fontSize = terminalSettings.fontSize;
    terminal.options.fontFamily = terminalSettings.fontFamily;
    terminal.options.scrollback = terminalSettings.scrollback;
    try {
      fitAddonRef.current?.fit();
    } catch {
      // Ignore fit errors
    }
  }, [terminalSettings.fontSize, terminalSettings.fontFamily, terminalSettings.scrollback]);

  // Handle container resize
  useEffect(() => {
    if (!containerRef.current || !fitAddonRef.current) return;

    const resizeObserver = new ResizeObserver(() => {
      try {
        // Don't fit against a hidden (0×0) container — that would push a tiny
        // width to the PTY and corrupt the wrap. When the panel becomes visible
        // again the observer fires for the 0→real transition and fit() re-syncs.
        const el = containerRef.current;
        if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
        fitAddonRef.current?.fit();
      } catch {
        // Ignore resize errors
      }
    });

    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  const statusLabel =
    status === "closed" && exitCode !== null
      ? `closed · exit ${exitCode}`
      : status ?? null;

  const infoRows: Array<{ label: string; value: string | null }> = [
    { label: "Process", value: processId ?? null },
    { label: "Executor", value: executorId ?? null },
    { label: "Target", value: target ?? null },
    { label: "Status", value: statusLabel },
  ];

  const copyValue = (label: string, value: string | null) => {
    if (!value) return;
    void navigator.clipboard.writeText(value);
    toast.success(`${label} copied`);
  };

  return (
    <div
      className={cn(
        "relative h-[300px] rounded-md border bg-zinc-950 overflow-hidden",
        className
      )}
    >
      <div ref={containerRef} className="h-full w-full" />
      <div className="absolute top-2 right-3 z-10 flex items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              title="Process info"
              aria-label="Show process info"
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded",
                "bg-zinc-900/70 backdrop-blur-sm border border-zinc-700/60",
                "text-zinc-400 hover:text-zinc-100 hover:border-zinc-500 transition-colors"
              )}
            >
              <Info className="h-3 w-3" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Process info
            </DropdownMenuLabel>
            {infoRows.map((row) => (
              <DropdownMenuItem
                key={row.label}
                disabled={!row.value}
                // Keep the menu open after copying so several values can be
                // grabbed in one pass.
                onSelect={(e) => {
                  e.preventDefault();
                  copyValue(row.label, row.value);
                }}
                className="flex items-center justify-between gap-3 font-mono text-xs"
              >
                <span className="shrink-0 text-muted-foreground">{row.label}</span>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate">{row.value ?? "—"}</span>
                  {row.value && <Copy className="h-3 w-3 shrink-0 opacity-60" />}
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <button
          type="button"
          onClick={handleCaptureToggle}
          title={isCapturing ? "Stop capture & copy to clipboard" : "Start capturing output"}
          aria-label={isCapturing ? "Stop capture and copy" : "Start capturing output"}
          className={cn(
            "flex h-6 w-6 items-center justify-center rounded",
            "bg-zinc-900/70 backdrop-blur-sm border border-zinc-700/60",
            "text-zinc-400 hover:text-zinc-100 hover:border-zinc-500 transition-colors",
            isCapturing && "text-red-400 border-red-500/70 hover:text-red-300"
          )}
        >
          {isCapturing ? (
            <Square className="h-3 w-3 fill-current" />
          ) : (
            <Circle className="h-3 w-3" />
          )}
        </button>
      </div>
    </div>
  );
}
