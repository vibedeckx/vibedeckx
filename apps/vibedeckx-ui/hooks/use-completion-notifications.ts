'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getFreshToken } from '@/lib/api';

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

const STORAGE_KEY = 'vibedeckx:completion-notifications';
// Cap the persisted list. Per-workspace de-dup already bounds it by workspace
// count, but persistence means it accumulates across sessions, so trim the
// oldest beyond this to keep localStorage small.
const MAX_NOTIFICATIONS = 50;

function isStoredNotification(v: unknown): v is CompletionNotification {
  if (typeof v !== 'object' || v === null) return false;
  const n = v as Record<string, unknown>;
  return (
    typeof n.id === 'string' &&
    typeof n.projectId === 'string' &&
    (typeof n.branch === 'string' || n.branch === null) &&
    (n.type === 'completed' || n.type === 'main-completed') &&
    typeof n.at === 'number' &&
    typeof n.read === 'boolean'
  );
}

function loadStored(): CompletionNotification[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredNotification).slice(0, MAX_NOTIFICATIONS);
  } catch {
    return [];
  }
}

function persist(list: CompletionNotification[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    // quota exceeded or private-mode disable — accept loss; the notification
    // list is best-effort UX, not a correctness requirement.
  }
}

// Module-level so the warmed <audio> elements outlive any mount/unmount of the
// hook's host and are shared app-wide. Switching projects keeps page.tsx
// mounted so this already wouldn't reload — but hoisting it out of the
// component guarantees the sounds are fetched+decoded exactly once per page
// load regardless of remounts (HMR, Strict Mode, future refactors).
const audioCache = new Map<string, HTMLAudioElement>();

// Tracks srcs whose warm fetch is in flight so a re-entrant call (or React
// Strict Mode double-invoke) doesn't kick off a duplicate download.
const warming = new Set<string>();

// Preload the completion sounds by fetching the bytes ourselves and holding
// them as in-memory object URLs, so the first play is purely local.
//
// Why not just `new Audio(src)` + preload="auto" + load(): browsers treat
// preload as a *hint* and deliberately defer/suspend media downloads for
// detached <audio> elements before a user gesture (we observed `suspend` and
// readyState 0 at play time even after load()). So that approach never
// buffered the file — the completion play still did a cold, stall-prone fetch.
// A plain fetch() runs immediately and is exempt from those media heuristics;
// the object URL then makes play() read from RAM with no network involved.
function warmCompletionSounds(): void {
  if (typeof window === 'undefined') return;
  for (const src of Object.values(SOUND_FOR_ACTIVITY)) {
    if (audioCache.has(src) || warming.has(src)) continue;
    warming.add(src);
    void (async () => {
      try {
        const res = await fetch(src);
        const blob = await res.blob();
        const audio = new Audio(URL.createObjectURL(blob));
        audio.preload = 'auto';
        audio.load();
        audioCache.set(src, audio);
        // [sound-preload-debug] Confirms the bytes landed in memory ahead of
        // any completion. Remove once verified.
        console.log(`[sound-preload-debug] warmed ${src} bytes=${blob.size}`);
      } catch (err) {
        // Network hiccup at startup — leave it to playSound's lazy fallback.
        console.log(`[sound-preload-debug] warm failed ${src}`, err);
      } finally {
        warming.delete(src);
      }
    })();
  }
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
 * maintains a newest-first notification list with per-entry read/unread state,
 * persisted to localStorage (capped at MAX_NOTIFICATIONS) so the list and its
 * read flags survive page reloads.
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
 * workspace is still listed but kept read — both when it arrives while you're
 * viewing the workspace and when you navigate into a workspace that already has
 * an unread entry (e.g. via the sidebar) — so it never inflates the unread
 * badge for something on screen.
 */
export function useCompletionNotifications(
  activeKey: string | null,
): CompletionNotificationsResult {
  const [notifications, setNotifications] = useState<CompletionNotification[]>([]);
  const lastActivity = useRef<Map<string, BranchActivity>>(new Map());

  // Warm the shared, module-level audio cache once. Switching projects keeps
  // this hook mounted, so no reload happens on navigation; the module-level
  // cache also makes it a no-op should the host ever remount.
  useEffect(() => {
    warmCompletionSounds();
  }, []);

  // The SSE handler closes over this ref so it always reads the *current*
  // active workspace without re-subscribing on every navigation.
  const activeKeyRef = useRef(activeKey);
  useEffect(() => {
    activeKeyRef.current = activeKey;
  }, [activeKey]);

  // Viewing a workspace clears its completion notification's unread state.
  // The SSE handler pre-reads a completion that *arrives* while you're on the
  // workspace, but this also covers navigating *into* a workspace that already
  // has an unread entry (e.g. clicking it in the sidebar) and a stored unread
  // entry for the workspace you're already viewing on reload. `notifications`
  // is a dep so hydration/new arrivals are caught; the same-reference guard
  // (returning `prev` unchanged) prevents a re-render loop.
  useEffect(() => {
    if (!activeKey) return;
    setNotifications((prev) =>
      prev.some((n) => n.id === activeKey && !n.read)
        ? prev.map((n) => (n.id === activeKey ? { ...n, read: true } : n))
        : prev,
    );
  }, [activeKey, notifications]);

  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;

    const handleMessage = (event: MessageEvent) => {
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

        playSound(SOUND_FOR_ACTIVITY[type]);

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
          // floats to the top. Trim to MAX_NOTIFICATIONS now that the list
          // persists across sessions.
          const rest = prev.filter((n) => n.id !== key);
          return [entry, ...rest].slice(0, MAX_NOTIFICATIONS);
        });
      } catch {
        // Ignore parse errors (e.g. keepalive comments)
      }
    };

    // Refresh the token (rides in the SSE query string) before connecting.
    void getFreshToken().then((token) => {
      if (cancelled) return;
      const tokenParam = token ? `?token=${encodeURIComponent(token)}` : '';
      es = new EventSource(`${getApiBase()}/api/events${tokenParam}`);
      es.onmessage = handleMessage;
    });

    return () => {
      cancelled = true;
      es?.close();
    };
  }, []);

  // Hydrate from localStorage after mount (not via a lazy initializer) so the
  // server/build render and the first client render agree — otherwise a stored
  // unread badge would trip a hydration mismatch. Merges rather than replaces
  // so a completion that somehow arrived before this runs isn't clobbered.
  useEffect(() => {
    const stored = loadStored();
    if (stored.length === 0) return;
    setNotifications((prev) => {
      if (prev.length === 0) return stored;
      const seen = new Set(prev.map((n) => n.id));
      return [...prev, ...stored.filter((n) => !seen.has(n.id))].slice(
        0,
        MAX_NOTIFICATIONS,
      );
    });
  }, []);

  // Persist on every change. Skip the initial mount pass so we don't overwrite
  // stored data with the empty initial state before hydration has loaded it.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      return;
    }
    persist(notifications);
  }, [notifications]);

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

function playSound(src: string) {
  let audio = audioCache.get(src);
  if (!audio) {
    // Normally already warmed by warmCompletionSounds(); this is the fallback
    // if a completion somehow beats the preload.
    audio = new Audio(src);
    audio.preload = 'auto';
    audioCache.set(src, audio);
  }
  audio.currentTime = 0;
  // [sound-preload-debug] readyState here tells the story: 4 = warmed (should
  // be instant), 0/1 = still cold (would stall). Remove once verified.
  console.log(`[sound-preload-debug] play ${src} readyState=${audio.readyState}`);
  // Browser autoplay policy rejects play() until the user has interacted with
  // the page. By the time a completion fires the user has invariably clicked
  // into the workspace, so this resolves; swallow the rejection regardless.
  void audio.play().catch(() => {});
}
