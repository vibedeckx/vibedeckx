'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getAuthToken } from '@/lib/api';

type BranchActivity =
  | 'idle'
  | 'working'
  | 'completed'
  | 'stopped'
  | 'main-running'
  | 'main-completed';

// The two terminal "completed" states we surface — both as a sound cue and as
// a notification entry. They mirror the two completion dot colors in the
// sidebar (`StatusDot` in app-sidebar.tsx):
//   - `completed`      — Agent session done  (lime dot)    → sound1
//   - `main-completed` — chat session done   (emerald dot) → sound2
type CompletionActivity = 'completed' | 'main-completed';

const SOUND_FOR_ACTIVITY: Record<CompletionActivity, string> = {
  completed: '/sounds/sound1.mp3',
  'main-completed': '/sounds/sound2.mp3',
};

function isCompletion(activity: BranchActivity): activity is CompletionActivity {
  return activity === 'completed' || activity === 'main-completed';
}

interface BranchActivityEvent {
  type: 'branch:activity';
  projectId: string;
  branch: string | null;
  activity: BranchActivity;
  since: number;
}

export interface CompletionNotification {
  /** `${projectId}:${branch ?? ''}` — one entry per workspace. */
  id: string;
  projectId: string;
  branch: string | null;
  type: CompletionActivity;
  /** Backend emit time (`since`), epoch ms. */
  at: number;
  read: boolean;
}

function getApiBase(): string {
  if (typeof window === 'undefined') return '';
  if (window.location.hostname === 'localhost' && window.location.port === '3000') {
    return 'http://localhost:5173';
  }
  return '';
}

function notificationKey(projectId: string, branch: string | null): string {
  return `${projectId}:${branch ?? ''}`;
}

export interface CompletionNotificationsResult {
  notifications: CompletionNotification[];
  unreadCount: number;
  markRead: (id: string) => void;
  markAllRead: () => void;
  remove: (id: string) => void;
  clear: () => void;
}

/**
 * Completion notification center, fed by the single global `/api/events` SSE
 * stream. Detects every workspace's transition into a completed state (across
 * *all* projects, not just the one on screen), plays the completion sound, and
 * maintains an in-memory, newest-first notification list with per-entry
 * read/unread state.
 *
 * This is the sole owner of the global completion signal — it absorbs what was
 * `useStatusSound`, so the app opens one global SSE connection for both sound
 * and notifications rather than two. (The per-project `useBranchActivity`
 * connection is a separate concern: it drives the live sidebar dots and does
 * REST reconciliation.)
 *
 * Why subscribe to the raw stream rather than diff a status map: the backend
 * broadcasts every project's events to every client with no project scoping
 * and no history replay (see routes/event-routes.ts + the server-side
 * `BranchActivityDedupe` gate). So a background project's completion arrives
 * live, and a workspace that was *already* completed on load/switch stays
 * silent. The per-(project, branch) `changed` guard is belt-and-suspenders
 * against a redundant re-emit slipping past the backend dedupe.
 *
 * `activeKey` is the workspace the user is currently viewing
 * (`${projectId}:${branch ?? ''}`, or null). A completion for the active
 * workspace is still listed but pushed pre-read — the user can already see it,
 * so it shouldn't inflate the unread badge.
 */
export function useCompletionNotifications(
  activeKey: string | null,
): CompletionNotificationsResult {
  const [notifications, setNotifications] = useState<CompletionNotification[]>([]);
  const lastActivity = useRef<Map<string, BranchActivity>>(new Map());
  const audioCache = useRef<Map<string, HTMLAudioElement>>(new Map());

  // The SSE handler closes over this ref so it always reads the *current*
  // active workspace without re-subscribing on every navigation.
  const activeKeyRef = useRef(activeKey);
  useEffect(() => {
    activeKeyRef.current = activeKey;
  }, [activeKey]);

  useEffect(() => {
    const token = getAuthToken();
    const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
    const es = new EventSource(`${getApiBase()}/api/events${tokenParam}`);

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as { type?: string };
        if (data.type !== 'branch:activity') return;
        const evt = data as BranchActivityEvent;

        const key = notificationKey(evt.projectId, evt.branch);
        const changed = lastActivity.current.get(key) !== evt.activity;
        lastActivity.current.set(key, evt.activity);

        if (!changed || !isCompletion(evt.activity)) return;
        // Capture the narrowed type before the closure — TS widens
        // `evt.activity` back to BranchActivity across the callback boundary.
        const type = evt.activity;

        playSound(SOUND_FOR_ACTIVITY[type], audioCache.current);

        const read = activeKeyRef.current === key;
        setNotifications((prev) => {
          const entry: CompletionNotification = {
            id: key,
            projectId: evt.projectId,
            branch: evt.branch,
            type,
            at: evt.since,
            read,
          };
          // De-dup: one entry per workspace. A repeat completion replaces the
          // old entry (updated time/type, re-marked unread unless active) and
          // floats to the top.
          const rest = prev.filter((n) => n.id !== key);
          return [entry, ...rest];
        });
      } catch {
        // Ignore parse errors (e.g. keepalive comments)
      }
    };

    return () => es.close();
  }, []);

  const markRead = useCallback((id: string) => {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read: true } : n)),
    );
  }, []);

  const markAllRead = useCallback(() => {
    setNotifications((prev) =>
      prev.some((n) => !n.read) ? prev.map((n) => ({ ...n, read: true })) : prev,
    );
  }, []);

  const remove = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const clear = useCallback(() => {
    setNotifications((prev) => (prev.length ? [] : prev));
  }, []);

  const unreadCount = notifications.reduce((acc, n) => acc + (n.read ? 0 : 1), 0);

  return { notifications, unreadCount, markRead, markAllRead, remove, clear };
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
