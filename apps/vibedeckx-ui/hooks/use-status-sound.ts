'use client';
import { useEffect, useRef } from 'react';
import type { WorkspaceStatus } from '@/lib/workspace-status';

// Notification sound played when a workspace enters a terminal "completed"
// state. The two completion states get distinct cues, mirroring the two dot
// colors in the sidebar (see `StatusDot` in app-sidebar.tsx):
//   - `completed`      — Agent session done  (浅绿 / lime dot)
//   - `main-completed` — chat session done   (绿色 / emerald dot)
const SOUND_FOR_STATUS: Partial<Record<WorkspaceStatus, string>> = {
  completed: '/sounds/sound1.mp3',
  'main-completed': '/sounds/sound2.mp3',
};

/**
 * Plays a notification sound whenever any workspace *transitions into* a
 * completed status. Watches the computed status map and compares each branch
 * against its previous value, so a sound fires once per completion (not on
 * every recompute) and across every workspace, not just the selected one.
 *
 * The first run after mount only seeds the baseline — a workspace that is
 * already "completed" on page load stays silent.
 */
export function useStatusSound(statuses: Map<string, WorkspaceStatus>) {
  const prevRef = useRef<Map<string, WorkspaceStatus> | null>(null);
  const audioCache = useRef<Map<string, HTMLAudioElement>>(new Map());

  useEffect(() => {
    const prev = prevRef.current;
    if (prev === null) {
      prevRef.current = new Map(statuses);
      return;
    }

    for (const [branch, status] of statuses) {
      const src = SOUND_FOR_STATUS[status];
      if (!src) continue;
      if (prev.get(branch) === status) continue; // no transition into completed
      playSound(src, audioCache.current);
    }

    prevRef.current = new Map(statuses);
  }, [statuses]);
}

function playSound(src: string, cache: Map<string, HTMLAudioElement>) {
  let audio = cache.get(src);
  if (!audio) {
    audio = new Audio(src);
    audio.preload = 'auto';
    cache.set(src, audio);
  }
  audio.currentTime = 0;
  // Browser autoplay policy rejects play() until the user has interacted with
  // the page. By the time a completion fires the user has invariably clicked
  // into the workspace, so this resolves; swallow the rejection regardless.
  void audio.play().catch(() => {});
}
