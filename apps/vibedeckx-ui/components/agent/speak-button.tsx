"use client";

import { useEffect, useMemo, useRef } from "react";
import { Loader2, Volume2, VolumeX } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { hasSpeakableContent } from "@/lib/tts/speakable-text";
import { ttsPlayer, useTtsState } from "@/lib/tts/tts-player";

/**
 * `<sessionId>:<entry index>:<content hash>`. The entry index tells identical
 * replies apart (two "好的。" in one session must not share a control); it is
 * the persisted entry index, not the array position, which shifts when older
 * history loads. Callers without one fall back to content alone.
 */
export function speakOwnerKey(sessionId: string | null, content: string, entryIndex?: number): string {
  let hash = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < content.length; i++) {
    hash ^= content.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${sessionId ?? "none"}:${entryIndex ?? "-"}:${(hash >>> 0).toString(36)}:${content.length}`;
}

/**
 * Read-aloud toggle for one message. Hover-revealed like its neighbours when
 * idle, but pinned visible while this message is loading / playing / failed —
 * otherwise the only way to stop playback would vanish with the pointer.
 */
export function SpeakButton({ ownerKey, text, className }: { ownerKey: string; text: string; className?: string }) {
  const state = useTtsState();
  const mine = state.status !== "idle" && state.ownerKey === ownerKey;
  const loading = mine && state.status === "loading";
  const playing = mine && state.status === "playing";
  const error = mine && state.status === "error" ? state : null;

  // Code-only replies have nothing to say.
  const speakable = useMemo(() => hasSpeakableContent(text), [text]);

  const lastToasted = useRef<typeof error>(null);
  useEffect(() => {
    if (!error || lastToasted.current === error) return;
    lastToasted.current = error;
    if (error.code === "not_configured") {
      toast.error("Text-to-speech is not configured", {
        description: "Add a speech provider key in Settings → Speech.",
      });
    } else {
      toast.error("Could not read this message aloud", { description: error.message });
    }
  }, [error]);

  if (!speakable) return null;

  const active = loading || playing;
  const label = active ? "Stop reading" : "Read aloud";
  const progress = mine && state.status !== "error" && state.total > 1 ? ` (${state.chunk + 1}/${state.total})` : "";

  return (
    <button
      type="button"
      onClick={() => ttsPlayer.toggle(ownerKey, text)}
      title={error ? error.message : label + progress}
      aria-label={label}
      aria-pressed={active}
      className={cn(
        "transition-opacity text-muted-foreground hover:text-foreground",
        mine ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
        playing && "text-primary hover:text-primary/80",
        error && "text-destructive",
        className,
      )}
    >
      {loading ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : error ? (
        <VolumeX className="w-3.5 h-3.5" />
      ) : (
        <Volume2 className={cn("w-3.5 h-3.5", playing && "animate-pulse")} />
      )}
    </button>
  );
}
