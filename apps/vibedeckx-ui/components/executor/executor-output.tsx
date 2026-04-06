"use client";

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import type { LogMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

interface ExecutorOutputProps {
  logs: LogMessage[];
  isPty: boolean;
  className?: string;
  onInput?: (data: string) => void;
  onResize?: (cols: number, rows: number) => void;
  muteInput?: boolean;
}

// Always use xterm.js for rendering to properly interpret ANSI escape codes
export function ExecutorOutput({
  logs,
  isPty,
  className,
  onInput,
  onResize,
  muteInput,
}: ExecutorOutputProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastLogIndexRef = useRef(0);
  const muteInputRef = useRef(muteInput);
  muteInputRef.current = muteInput;

  // Initialize terminal
  useEffect(() => {
    if (!containerRef.current || terminalRef.current) return;

    const terminal = new Terminal({
      cursorBlink: isPty, // Only blink cursor in PTY mode
      cursorStyle: isPty ? "block" : "underline",
      disableStdin: !isPty, // Disable input in non-PTY mode
convertEol: true, // Convert \n to \r\n for proper line handling on macOS
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
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
        if (!muteInputRef.current) {
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

    // Only write new logs since last update
    for (let i = lastLogIndexRef.current; i < logs.length; i++) {
      const log = logs[i];
      if (log.type === "pty") {
        // PTY output - write directly (already has proper formatting)
        terminalRef.current.write(log.data);
      } else if (log.type === "stdout" || log.type === "stderr") {
        // Regular process output - write with ANSI code interpretation
        terminalRef.current.write(log.data);
      }
    }
    lastLogIndexRef.current = logs.length;
  }, [logs]);

  // Handle container resize
  useEffect(() => {
    if (!containerRef.current || !fitAddonRef.current) return;

    const resizeObserver = new ResizeObserver(() => {
      try {
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

  return (
    <div
      ref={containerRef}
      className={cn("h-[300px] rounded-md border bg-zinc-950 overflow-hidden", className)}
    />
  );
}
