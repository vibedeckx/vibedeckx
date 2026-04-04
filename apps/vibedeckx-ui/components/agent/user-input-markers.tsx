"use client";

import { useRef, useState, useEffect, useCallback, type RefObject } from "react";
import type { AgentMessage } from "@/hooks/use-agent-session";

function findScrollParent(el: HTMLElement): HTMLElement | null {
  let parent = el.parentElement;
  while (parent) {
    const { overflowY } = getComputedStyle(parent);
    if (overflowY === "auto" || overflowY === "scroll") {
      return parent;
    }
    parent = parent.parentElement;
  }
  return null;
}

function getMessagePreview(msg: AgentMessage): string {
  if (msg.type !== "user") return "";
  const content = msg.content;
  const text =
    typeof content === "string"
      ? content
      : content
          .filter((p) => p.type === "text")
          .map((p) => (p as { type: "text"; text: string }).text)
          .join(" ");
  const hasImages =
    typeof content !== "string" && content.some((p) => p.type === "image");
  const firstLine = text.split("\n")[0] ?? "";
  const truncated =
    firstLine.length > 80 ? firstLine.slice(0, 77) + "..." : firstLine;
  return truncated || (hasImages ? "(Image)" : "");
}

interface MarkerData {
  index: number;
  position: number;
  preview: string;
}

interface UserInputMarkersProps {
  messages: AgentMessage[];
  contentRef: RefObject<HTMLDivElement | null>;
}

export function UserInputMarkers({
  messages,
  contentRef,
}: UserInputMarkersProps) {
  const [markers, setMarkers] = useState<MarkerData[]>([]);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const scrollElRef = useRef<HTMLElement | null>(null);

  const updateMarkers = useCallback(() => {
    const contentEl = contentRef.current;
    if (!contentEl) return;

    if (!scrollElRef.current) {
      scrollElRef.current = findScrollParent(contentEl);
    }
    const scrollEl = scrollElRef.current;
    if (!scrollEl) return;

    const overflow = scrollEl.scrollHeight > scrollEl.clientHeight;
    setIsOverflowing(overflow);
    if (!overflow) {
      setMarkers([]);
      return;
    }

    const userMsgEls =
      contentEl.querySelectorAll<HTMLElement>("[data-user-msg-idx]");
    const scrollRect = scrollEl.getBoundingClientRect();
    const newMarkers: MarkerData[] = [];

    userMsgEls.forEach((el) => {
      const idx = parseInt(el.dataset.userMsgIdx!, 10);
      const elRect = el.getBoundingClientRect();
      const absoluteTop = elRect.top - scrollRect.top + scrollEl.scrollTop;
      const position = absoluteTop / scrollEl.scrollHeight;
      newMarkers.push({
        index: idx,
        position: Math.max(0, Math.min(1, position)),
        preview: getMessagePreview(messages[idx]),
      });
    });

    setMarkers(newMarkers);
  }, [messages, contentRef]);

  useEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl) return;

    const scrollEl = findScrollParent(contentEl);
    if (!scrollEl) return;
    scrollElRef.current = scrollEl;

    updateMarkers();

    const resizeObserver = new ResizeObserver(updateMarkers);
    resizeObserver.observe(scrollEl);
    resizeObserver.observe(contentEl);

    return () => {
      resizeObserver.disconnect();
    };
  }, [messages, updateMarkers, contentRef]);

  const handleClick = useCallback((markerIndex: number) => {
    const contentEl = contentRef.current;
    if (!contentEl) return;

    const el = contentEl.querySelector<HTMLElement>(
      `[data-user-msg-idx="${markerIndex}"]`
    );
    if (!el) return;

    el.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [contentRef]);

  if (!isOverflowing || markers.length === 0) return null;

  return (
    <div className="absolute right-0 top-0 bottom-0 w-5 z-20 pointer-events-none">
      {markers.map((marker) => (
        <div
          key={marker.index}
          className="absolute right-0.5 -translate-y-1/2 pointer-events-auto"
          style={{ top: `${marker.position * 100}%` }}
        >
          <div
            className="w-3 h-[3px] rounded-sm bg-primary/50 hover:bg-primary cursor-pointer transition-colors"
            onClick={() => handleClick(marker.index)}
            onMouseEnter={() => setHoveredIndex(marker.index)}
            onMouseLeave={() => setHoveredIndex(null)}
          />
          {hoveredIndex === marker.index && marker.preview && (
            <div className="absolute right-full mr-2 top-1/2 -translate-y-1/2 max-w-64 px-2.5 py-1.5 bg-popover border border-border rounded-md shadow-md text-xs text-popover-foreground whitespace-nowrap overflow-hidden text-ellipsis pointer-events-none">
              {marker.preview}
              <div className="absolute top-1/2 -translate-y-1/2 -right-1 w-2 h-2 bg-popover border-r border-t border-border rotate-45" />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
