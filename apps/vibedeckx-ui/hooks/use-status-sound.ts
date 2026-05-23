'use client';
import { useEffect, useRef } from 'react';
import { getAuthToken } from '@/lib/api';

type BranchActivity =
  | 'idle'
  | 'working'
  | 'completed'
  | 'stopped'
  | 'main-running'
  | 'main-completed';

// Notification sound played when a workspace enters a terminal "completed"
// state. The two completion states get distinct cues, mirroring the two dot
// colors in the sidebar (see `StatusDot` in app-sidebar.tsx):
//   - `completed`      — Agent session done  (浅绿 / lime dot)   → sound1
//   - `main-completed` — chat session done   (绿色 / emerald dot) → sound2
const SOUND_FOR_ACTIVITY: Partial<Record<BranchActivity, string>> = {
  completed: '/sounds/sound1.mp3',
  'main-completed': '/sounds/sound2.mp3',
};

interface BranchActivityEvent {
  type: 'branch:activity';
  projectId: string;
  branch: string | null;
  activity: BranchActivity;
  since: number;
}

function getApiBase(): string {
  if (typeof window === 'undefined') return '';
  if (window.location.hostname === 'localhost' && window.location.port === '3000') {
    return 'http://localhost:5173';
  }
  return '';
}

/**
 * App-level notification sounds for workspace completion, across *all* projects
 * — not just the selected one. Subscribes directly to the global `/api/events`
 * SSE stream and plays a sound when any branch transitions into a completed
 * state, regardless of which project is on screen.
 *
 * Why subscribe to SSE directly rather than diff the per-project status map
 * (`computeWorkspaceStatuses`): that map only ever holds the *current*
 * project's branches, so a background project's completion would be missed and
 * a project switch would surface stale completions as if they were fresh. The
 * raw event stream sidesteps both problems by construction:
 *
 *   - The backend broadcasts every project's events to every client with no
 *     project scoping (see routes/event-routes.ts), so a completion in a
 *     background project arrives live and fires its sound the moment it
 *     happens.
 *   - The stream carries only genuine transitions — the server-side
 *     `BranchActivityDedupe` gate emits a `branch:activity` event only when the
 *     state actually changes — and there is no history replay on connect. So a
 *     workspace that was *already* completed (on page load, or when you switch
 *     into its project) sends no event and stays silent.
 *
 * The per-(project, branch) `changed` check is belt-and-suspenders against any
 * redundant re-emit slipping past the backend dedupe.
 */
export function useStatusSound() {
  const lastActivity = useRef<Map<string, BranchActivity>>(new Map());
  const audioCache = useRef<Map<string, HTMLAudioElement>>(new Map());

  useEffect(() => {
    const token = getAuthToken();
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
    const es = new EventSource(`${getApiBase()}/api/events${tokenParam}`);

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { type?: string };
        if (data.type !== 'branch:activity') return;
        const evt = data as BranchActivityEvent;

        const key = `${evt.projectId}:${evt.branch ?? ''}`;
        const changed = lastActivity.current.get(key) !== evt.activity;
        lastActivity.current.set(key, evt.activity);

        const src = SOUND_FOR_ACTIVITY[evt.activity];
        if (src && changed) playSound(src, audioCache.current);
      } catch {
        // Ignore parse errors (e.g. keepalive comments)
      }
    };

    return () => es.close();
  }, []);
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
