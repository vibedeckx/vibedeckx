"use client";

import { createContext, useContext, useState, useCallback, useEffect, useRef } from "react";
import { api } from "@/lib/api";

// ============ Global iframe command bridge ============
// Allows use-chat-session hook to send commands to iframes without prop drilling.

type CommandResultCallback = (result: Record<string, unknown>) => void;

const pendingCommands = new Map<string, CommandResultCallback>();
let iframeRefsGlobal: Map<string, HTMLIFrameElement> | null = null;
let addFrameGlobal: ((projectId: string, url: string) => void) | null = null;

/**
 * Open a preview iframe for a project from anywhere (e.g. use-chat-session hook).
 * Called when the backend sends an openPreviewFrame WebSocket message.
 */
export function openPreviewFrame(projectId: string, url: string): void {
  addFrameGlobal?.(projectId, url);
}

/**
 * Send a command to a project's iframe via postMessage.
 * Returns the result or null on timeout.
 * Called from use-chat-session.ts when the backend sends a browserCommand.
 */
export function sendCommandToIframe(
  projectId: string,
  command: Record<string, unknown>,
  timeoutMs = 4000,
): Promise<Record<string, unknown> | null> {
  const iframe = iframeRefsGlobal?.get(projectId);
  if (!iframe?.contentWindow) return Promise.resolve(null);

  const id = command.id as string;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      resolve(null);
    }, timeoutMs);

    pendingCommands.set(id, (result) => {
      clearTimeout(timer);
      pendingCommands.delete(id);
      resolve(result);
    });

    iframe.contentWindow!.postMessage(command, "*");
  });
}

// ============ Types ============

interface BrowserFrame {
  projectId: string;
  url: string;
  iframeKey: number;
}

interface BrowserFramesContextValue {
  /** Register a frame (called when browser session starts) */
  addFrame: (projectId: string, url: string) => void;
  /** Remove a frame (called when browser session stops) */
  removeFrame: (projectId: string) => void;
  /** Update the URL of an existing frame */
  updateFrameUrl: (projectId: string, url: string) => void;
  /** Refresh the iframe (increment key to force reload) */
  refreshFrame: (projectId: string) => void;
  /** Check if a frame is active for a project */
  hasFrame: (projectId: string) => boolean;
  /** Get the current URL for a project's frame */
  getFrameUrl: (projectId: string) => string | undefined;
  /** Get the iframe element for a project (for DOM reparenting or postMessage) */
  getIframeElement: (projectId: string) => HTMLIFrameElement | null;
  /**
   * Claim the iframe for display — moves it from the hidden container into
   * the given host element. Returns a release function that moves it back.
   */
  claimFrame: (projectId: string, hostElement: HTMLElement) => (() => void) | null;
}

const BrowserFramesContext = createContext<BrowserFramesContextValue | null>(null);

export function useBrowserFrames() {
  const ctx = useContext(BrowserFramesContext);
  if (!ctx) throw new Error("useBrowserFrames must be used within BrowserFramesProvider");
  return ctx;
}

// ============ Provider ============

export function BrowserFramesProvider({ children }: { children: React.ReactNode }) {
  const [frames, setFrames] = useState<Map<string, BrowserFrame>>(new Map());
  const iframeRefs = useRef<Map<string, HTMLIFrameElement>>(new Map());
  const hiddenContainerRef = useRef<HTMLDivElement>(null);

  const addFrame = useCallback((projectId: string, url: string) => {
    setFrames((prev) => {
      const next = new Map(prev);
      next.set(projectId, { projectId, url, iframeKey: 0 });
      return next;
    });
  }, []);

  const removeFrame = useCallback((projectId: string) => {
    setFrames((prev) => {
      const next = new Map(prev);
      next.delete(projectId);
      return next;
    });
    iframeRefs.current.delete(projectId);
  }, []);

  const updateFrameUrl = useCallback((projectId: string, url: string) => {
    setFrames((prev) => {
      const existing = prev.get(projectId);
      if (!existing) return prev;
      const next = new Map(prev);
      next.set(projectId, { ...existing, url, iframeKey: existing.iframeKey + 1 });
      return next;
    });
  }, []);

  const refreshFrame = useCallback((projectId: string) => {
    setFrames((prev) => {
      const existing = prev.get(projectId);
      if (!existing) return prev;
      const next = new Map(prev);
      next.set(projectId, { ...existing, iframeKey: existing.iframeKey + 1 });
      return next;
    });
  }, []);

  const hasFrame = useCallback((projectId: string) => {
    return frames.has(projectId);
  }, [frames]);

  const getFrameUrl = useCallback((projectId: string) => {
    return frames.get(projectId)?.url;
  }, [frames]);

  const getIframeElement = useCallback((projectId: string) => {
    return iframeRefs.current.get(projectId) ?? null;
  }, []);

  const claimFrame = useCallback((projectId: string, hostElement: HTMLElement) => {
    const iframe = iframeRefs.current.get(projectId);
    if (!iframe) return null;

    // Move iframe from hidden container into the host element
    iframe.style.width = "100%";
    iframe.style.height = "100%";
    iframe.style.display = "block";
    hostElement.appendChild(iframe);

    // Return release function
    return () => {
      iframe.style.width = "1px";
      iframe.style.height = "1px";
      iframe.style.display = "block";
      // Move back to hidden container
      hiddenContainerRef.current?.appendChild(iframe);
    };
  }, []);

  // Expose iframe refs and addFrame globally for cross-component access
  useEffect(() => {
    iframeRefsGlobal = iframeRefs.current;
    addFrameGlobal = addFrame;
    return () => { iframeRefsGlobal = null; addFrameGlobal = null; };
  }, [addFrame]);

  // Listen for postMessages from all proxied iframes (errors + command results)
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (!event.data?.type) return;

      if (event.data.type === "vibedeckx-browser-error" && event.data.projectId) {
        api.reportBrowserError(event.data.projectId, event.data.error).catch(() => {});
      } else if (event.data.type === "vibedeckx-result" && event.data.id) {
        // Route command result to pending promise
        const callback = pendingCommands.get(event.data.id);
        if (callback) callback(event.data);
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  const contextValue: BrowserFramesContextValue = {
    addFrame,
    removeFrame,
    updateFrameUrl,
    refreshFrame,
    hasFrame,
    getFrameUrl,
    getIframeElement,
    claimFrame,
  };

  return (
    <BrowserFramesContext.Provider value={contextValue}>
      {children}
      {/* Hidden container for iframes not currently claimed by a PreviewPanel */}
      <div
        ref={hiddenContainerRef}
        style={{ position: "fixed", width: 0, height: 0, overflow: "hidden", pointerEvents: "none" }}
        aria-hidden
      >
        {[...frames.values()].map((frame) => (
          <iframe
            key={`${frame.projectId}-${frame.iframeKey}`}
            ref={(el) => {
              if (el) {
                iframeRefs.current.set(frame.projectId, el);
              }
            }}
            src={api.getBrowserProxyUrl(frame.projectId, frame.url)}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation"
            title={`Browser preview: ${frame.projectId}`}
            style={{ width: 1, height: 1 }}
          />
        ))}
      </div>
    </BrowserFramesContext.Provider>
  );
}
