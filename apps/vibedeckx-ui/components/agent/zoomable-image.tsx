"use client";

import { useEffect, useRef, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

// A conversation image that opens in a viewport lightbox on click. The panel
// matches the executor terminal's maximize window (centered, max-w-6xl ×
// 85vh on a dimmed layer), but is a real Radix dialog portaled to <body>, so
// the conversation scroller's will-change:transform can't trap the fixed
// layer. Inside the panel: wheel zooms around the cursor, drag pans, and
// double-click resets. Escape, the ✕, or the dimmed margin closes it.
export function ZoomableImage({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
      <DialogPrimitive.Trigger asChild>
        <button
          type="button"
          title="Click to enlarge"
          aria-label={`Enlarge image: ${alt}`}
          className="block cursor-zoom-in rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={src} alt={alt} className={className} />
        </button>
      </DialogPrimitive.Trigger>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/70" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          // Radix's outside-click never fires here: Content itself spans the
          // viewport. Pressing the margin around the panel is the "outside".
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
          className="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 fixed inset-0 z-50 flex items-center justify-center p-4 outline-none sm:p-10 lg:p-16"
        >
          <DialogPrimitive.Title className="sr-only">{alt}</DialogPrimitive.Title>
          <ImageViewport src={src} alt={alt} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export interface View {
  scale: number;
  x: number;
  y: number;
}

export const MIN_SCALE = 1;
export const MAX_SCALE = 8;
const IDENTITY: View = { scale: 1, x: 0, y: 0 };

// The zoomed layer is panel-sized with transform-origin 0 0, so at scale s its
// left edge may sit anywhere in [w·(1−s), 0] and still cover the panel.
export function clampView(v: View, w: number, h: number): View {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale));
  return {
    scale,
    x: Math.min(0, Math.max(w * (1 - scale), v.x)),
    y: Math.min(0, Math.max(h * (1 - scale), v.y)),
  };
}

// Rescale while keeping the image point under (px, py) fixed on screen.
export function zoomAt(v: View, px: number, py: number, nextScale: number, w: number, h: number): View {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, nextScale));
  const k = scale / v.scale;
  return clampView({ scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k }, w, h);
}

function ImageViewport({ src, alt }: { src: string; alt: string }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View>(IDENTITY);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  // Native non-passive listener: React's onWheel is passive, and without
  // preventDefault the wheel would also try to scroll the page behind.
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      setView((v) =>
        zoomAt(v, e.clientX - r.left, e.clientY - r.top, v.scale * Math.exp(-delta * 0.002), r.width, r.height)
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const zoomed = view.scale > 1.001;

  return (
    <div
      ref={panelRef}
      data-testid="image-lightbox-panel"
      onDoubleClick={() => setView(IDENTITY)}
      onPointerDown={(e) => {
        if (!zoomed || e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d || d.id !== e.pointerId) return;
        const dx = e.clientX - d.x;
        const dy = e.clientY - d.y;
        d.x = e.clientX;
        d.y = e.clientY;
        const r = e.currentTarget.getBoundingClientRect();
        setView((v) => clampView({ ...v, x: v.x + dx, y: v.y + dy }, r.width, r.height));
      }}
      onPointerUp={() => {
        drag.current = null;
        setDragging(false);
      }}
      onPointerCancel={() => {
        drag.current = null;
        setDragging(false);
      }}
      className={cn(
        "relative h-full w-full max-h-[85vh] max-w-6xl touch-none select-none overflow-hidden rounded-md border border-zinc-700 bg-zinc-950 shadow-2xl",
        zoomed && (dragging ? "cursor-grabbing" : "cursor-grab")
      )}
    >
      <div
        data-testid="image-lightbox-layer"
        className="absolute inset-0 origin-top-left"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={src} alt={alt} draggable={false} className="h-full w-full object-contain" />
      </div>
      <div className="pointer-events-none absolute bottom-2 left-1/2 -translate-x-1/2 rounded bg-black/60 px-2 py-0.5 text-xs text-white/80">
        {zoomed
          ? `${Math.round(view.scale * 100)}% · drag to pan · double-click to reset`
          : "Scroll to zoom"}
      </div>
      <DialogPrimitive.Close
        aria-label="Close enlarged image"
        className="absolute top-2 right-2 rounded-md bg-black/50 p-1.5 text-white/80 transition-colors hover:bg-black/70 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
      >
        <X className="h-4 w-4" />
      </DialogPrimitive.Close>
    </div>
  );
}
