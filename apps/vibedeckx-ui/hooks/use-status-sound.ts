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
 * completed status. A sound fires once per completion (not on every recompute)
 * and across every workspace, not just the selected one.
 *
 * Two guards keep project switches and page loads silent — neither should
 * announce workspaces that were *already* completed:
 *
 *   1. On mount and on every `projectId` change, the baseline is reset to an
 *      *empty* map. Switching projects swaps the whole branch set, and the
 *      orchestrator dot shares the empty-string branch key across all projects,
 *      so a stale baseline would diff across projects and false-fire. Clearing
 *      it drops those cross-project keys.
 *   2. A sound only fires for an *observed* transition: the branch must have
 *      been seen in a non-completed state first. A branch that appears already
 *      "completed" (prev value undefined) is recorded silently. This covers the
 *      window after a reset/switch while the new project's data streams in.
 *
 * Together: a genuine completion you watched happen (working → completed) plays;
 * a workspace that was already done when you arrived stays quiet.
 */
export function useStatusSound(
  statuses: Map<string, WorkspaceStatus>,
  projectId: string | null,
) {
  const prevRef = useRef<Map<string, WorkspaceStatus>>(new Map());
  const projectRef = useRef<string | null>(null);
  const audioCache = useRef<Map<string, HTMLAudioElement>>(new Map());

  useEffect(() => {
    if (projectRef.current !== projectId) {
      // New project (or first mount): drop the previous project's baseline so
      // its branches — and the shared orchestrator key — can't diff across the
      // switch. The new project's statuses are recorded silently below.
      projectRef.current = projectId;
      prevRef.current = new Map();
    }

    const prev = prevRef.current;
    for (const [branch, status] of statuses) {
      const src = SOUND_FOR_STATUS[status];
      if (!src) continue;
      const prevStatus = prev.get(branch);
      if (prevStatus === undefined) continue; // first sighting — record, don't sound
      if (prevStatus === status) continue; // no transition into completed
      playSound(src, audioCache.current);
    }

    prevRef.current = new Map(statuses);
  }, [statuses, projectId]);
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
