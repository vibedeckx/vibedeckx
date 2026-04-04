"use client";

import { useCallback, useEffect, useRef } from "react";
import { Globe, RefreshCw, ExternalLink } from "lucide-react";
import {
  WebPreview,
  WebPreviewNavigation,
  WebPreviewNavigationButton,
  WebPreviewUrl,
} from "@/components/ai-elements/web-preview";
import type { Project } from "@/lib/api";
import { useBrowserFrames } from "./browser-frames-provider";

interface PreviewPanelProps {
  projectId: string | null;
  selectedBranch?: string | null;
  project?: Project | null;
}

export function PreviewPanel({ projectId }: PreviewPanelProps) {
  const iframeHostRef = useRef<HTMLDivElement>(null);
  const releaseRef = useRef<(() => void) | null>(null);
  const { addFrame, updateFrameUrl, refreshFrame, hasFrame, claimFrame, getFrameUrl } = useBrowserFrames();

  const frameUrl = projectId ? getFrameUrl(projectId) : undefined;

  // Claim/release the global iframe into our host div when a frame exists
  useEffect(() => {
    if (projectId && frameUrl && iframeHostRef.current) {
      const timer = setTimeout(() => {
        if (iframeHostRef.current) {
          releaseRef.current?.();
          releaseRef.current = claimFrame(projectId, iframeHostRef.current);
        }
      }, 50);
      return () => {
        clearTimeout(timer);
        releaseRef.current?.();
        releaseRef.current = null;
      };
    }
    return () => {
      releaseRef.current?.();
      releaseRef.current = null;
    };
  }, [projectId, frameUrl, claimFrame]);

  const handleRefresh = useCallback(() => {
    if (!projectId) return;
    refreshFrame(projectId);
  }, [projectId, refreshFrame]);

  const handleOpenExternal = useCallback(() => {
    if (frameUrl) window.open(frameUrl, "_blank");
  }, [frameUrl]);

  const handleUrlSubmit = useCallback(
    (newUrl: string) => {
      if (!projectId) return;
      if (hasFrame(projectId)) {
        updateFrameUrl(projectId, newUrl);
      } else {
        addFrame(projectId, newUrl);
      }
    },
    [projectId, hasFrame, updateFrameUrl, addFrame],
  );

  return (
    <div className="h-full flex flex-col">
      <WebPreview defaultUrl={frameUrl ?? ""} onUrlChange={handleUrlSubmit} className="h-full">
        <WebPreviewNavigation className="h-10 p-1.5 gap-0.5">
          <WebPreviewNavigationButton tooltip="Refresh" onClick={handleRefresh} disabled={!frameUrl}>
            <RefreshCw className="h-3.5 w-3.5" />
          </WebPreviewNavigationButton>
          <WebPreviewNavigationButton tooltip="Open in browser" onClick={handleOpenExternal} disabled={!frameUrl}>
            <ExternalLink className="h-3.5 w-3.5" />
          </WebPreviewNavigationButton>
          <WebPreviewUrl className="h-7 text-xs" />
        </WebPreviewNavigation>

        {frameUrl ? (
          <div ref={iframeHostRef} className="flex-1 bg-white" />
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            <div className="flex flex-col items-center gap-2">
              <Globe className="h-8 w-8 opacity-40" />
              <p className="text-sm">Enter a URL above to preview</p>
            </div>
          </div>
        )}
      </WebPreview>
    </div>
  );
}
