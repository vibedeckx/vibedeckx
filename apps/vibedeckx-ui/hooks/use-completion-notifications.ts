'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useGlobalEventStream } from '@/hooks/global-event-stream';
import {
  getNotifications,
  markAllNotificationsRead as markAllReadApi,
  markNotificationRead as markReadApi,
  type NotificationKind,
  type ServerNotification,
} from '@/lib/api';

export type { NotificationKind, ServerNotification } from '@/lib/api';

/**
 * Notification center backed by the server inbox.
 *
 * The server database is the source of truth for both the list and the read
 * state, so a closed browser, an SSE drop, or a front-server restart can no
 * longer lose a completion. `notification:created` is consumed purely for
 * latency; refreshing the page rebuilds the same state from
 * `GET /api/notifications`.
 *
 * Deliberately does NOT consume `branch:activity`. That event describes the
 * aggregate state of a `projectId + branch`, which cannot express "two sessions
 * on this branch both finished" or "this reviewer's result deserves attention
 * but that helper turn does not". See
 * docs/plans/2026-07-25-persistent-notification-milestones-design.md.
 */

/**
 * Per-kind cue. Exported as a pure map so tests can assert the three distinct
 * paths without playing audio.
 *
 * Success and review-ready keep their established sounds; both failure kinds
 * share one distinct, non-startling failure cue — success vs. review vs.
 * something-went-wrong is the distinction that carries information.
 */
export const SOUND_FOR_KIND: Record<NotificationKind, string> = {
  session_result_ready: '/sounds/sound1.mp3',
  review_ready: '/sounds/sound2.mp3',
  session_failed: '/sounds/failure.mp3',
  workflow_failed: '/sounds/failure.mp3',
};

/**
 * The pre-milestone, browser-only store: branch-keyed entries with no stable
 * milestone identity and no user identity. Not uploaded — it cannot be mapped
 * onto server rows — just discarded after the first successful hydration.
 */
export const LEGACY_STORAGE_KEY = 'vibedeckx:completion-notifications';

/**
 * Insert or replace by notification id, newest first.
 *
 * Keying on the full milestone id (not `projectId:branch`) is the whole point:
 * two sessions completing on one branch produce two ids and therefore two
 * entries, where the old branch-keyed store collapsed them into one.
 */
export function upsertNotification(
  list: ServerNotification[],
  incoming: ServerNotification,
): ServerNotification[] {
  const rest = list.filter((n) => n.id !== incoming.id);
  const merged = [...rest, incoming];
  merged.sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1));
  return merged;
}

// Module-level so warmed <audio> elements outlive any mount/unmount of the
// hook's host and are shared app-wide.
const audioCache = new Map<string, HTMLAudioElement>();
const warming = new Set<string>();

// Preload by fetching the bytes ourselves and holding them as in-memory object
// URLs, so the first play is purely local.
//
// Why not `new Audio(src)` + preload="auto" + load(): browsers treat preload as
// a *hint* and deliberately defer media downloads for detached <audio> elements
// before a user gesture (observed `suspend` and readyState 0 at play time even
// after load()). A plain fetch() runs immediately and is exempt from those
// heuristics; the object URL then makes play() read from RAM.
function warmCompletionSounds(): void {
  if (typeof window === 'undefined') return;
  for (const src of new Set(Object.values(SOUND_FOR_KIND))) {
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
      } catch {
        // Network hiccup at startup — playSound's lazy fallback covers it.
      } finally {
        warming.delete(src);
      }
    })();
  }
}

export interface CompletionNotificationsResult {
  notifications: ServerNotification[];
  unreadCount: number;
  markRead: (id: string) => void;
  markAllRead: () => void;
  /** Hide locally and mark read on the server (there is no delete endpoint). */
  remove: (id: string) => void;
  /** Hide all locally and mark all read on the server. */
  clear: () => void;
}

/**
 * `activeSessionId` is the session the user is currently looking at. A
 * notification targeting exactly that session is auto-read — being on screen is
 * the user having seen it. A notification for a *different* session stays
 * unread even when it shares a branch with the one on screen.
 */
export function useCompletionNotifications(
  activeSessionId: string | null,
): CompletionNotificationsResult {
  const [notifications, setNotifications] = useState<ServerNotification[]>([]);
  /**
   * Ids already surfaced to this browser. Guards the *sound* only: an SSE frame
   * for a row we hydrated (or already heard) must be silent, while the row
   * itself is still upserted so read-state changes land.
   */
  const heard = useRef<Set<string>>(new Set());
  /** Ids whose read call is in flight, so navigation churn can't re-fire it. */
  const readInFlight = useRef<Set<string>>(new Set());

  useEffect(() => {
    warmCompletionSounds();
  }, []);

  // The SSE handler reads the *current* active session through a ref so it
  // never has to re-subscribe on navigation.
  const activeSessionIdRef = useRef(activeSessionId);
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  /**
   * Optimistic read: flip locally, then persist. On failure the local flip is
   * rolled back, leaving the row unread on both sides — the next hydration
   * reconciles rather than silently swallowing the milestone.
   */
  const persistRead = useCallback((id: string) => {
    if (readInFlight.current.has(id)) return;
    readInFlight.current.add(id);
    const readAt = Date.now();
    setNotifications((prev) =>
      prev.map((n) => (n.id === id && n.read_at === null ? { ...n, read_at: readAt } : n)),
    );
    void markReadApi(id)
      .catch(() => {
        setNotifications((prev) =>
          prev.map((n) => (n.id === id && n.read_at === readAt ? { ...n, read_at: null } : n)),
        );
      })
      .finally(() => {
        readInFlight.current.delete(id);
      });
  }, []);

  // Hydrate from the server. This — not localStorage — is what restores unread
  // state across a reload.
  useEffect(() => {
    let cancelled = false;
    void getNotifications({ limit: 100 })
      .then((rows) => {
        if (cancelled) return;
        for (const row of rows) heard.current.add(row.id);
        setNotifications((prev) => {
          // Merge rather than replace: a frame that arrived before hydration
          // resolved must not be dropped. Everything goes through
          // upsertNotification so display order is ours, not a dependency on the
          // server's ORDER BY.
          let merged: ServerNotification[] = [];
          for (const row of rows) merged = upsertNotification(merged, row);
          for (const pending of prev) {
            if (!rows.some((r) => r.id === pending.id)) merged = upsertNotification(merged, pending);
          }
          return merged;
        });
        if (typeof window !== 'undefined') {
          // Legacy entries are branch-keyed and carry no user identity, so they
          // cannot be mapped onto server rows. Discard rather than upload.
          try {
            window.localStorage.removeItem(LEGACY_STORAGE_KEY);
          } catch {
            /* private mode — nothing to clean up */
          }
        }
      })
      .catch((err) => {
        console.warn('[notifications] hydration failed:', err);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useGlobalEventStream((data) => {
    if (data.type !== 'notification:created') return;
    const notification = (data as { notification?: ServerNotification }).notification;
    if (!notification?.id) return;

    const isNew = !heard.current.has(notification.id);
    heard.current.add(notification.id);

    const active = activeSessionIdRef.current;
    const onScreen = notification.session_id !== null && notification.session_id === active;

    // Sound fires for every first-time milestone, including the session on
    // screen: `onScreen` suppresses the bell entry (the user can see the
    // result), but not the cue that tells them to look. Only `isNew` gates it,
    // so a hydrated or replayed row stays silent.
    if (isNew) playSound(SOUND_FOR_KIND[notification.kind]);

    setNotifications((prev) =>
      upsertNotification(prev, onScreen ? { ...notification, read_at: notification.read_at ?? Date.now() } : notification),
    );
    if (onScreen && notification.read_at === null) {
      void markReadApi(notification.id).catch(() => {
        // Leave it read locally but unread on the server; the next hydration
        // will show it unread again rather than losing it.
      });
    }
  });

  // Navigating *into* a session clears its pending notifications — covers the
  // sidebar/deep-link case where the row was already unread before arrival.
  //
  // Unlike the user-initiated `markRead` below, this deliberately updates state
  // only in the network callback rather than optimistically: a synchronous
  // setState here would cascade renders (this effect depends on `notifications`,
  // which it also writes). Navigation is not a click waiting on feedback, so
  // clearing the badge one round-trip later is the better trade.
  useEffect(() => {
    if (!activeSessionId) return;
    for (const notification of notifications) {
      if (notification.session_id !== activeSessionId || notification.read_at !== null) continue;
      if (readInFlight.current.has(notification.id)) continue;
      const { id } = notification;
      readInFlight.current.add(id);
      void markReadApi(id)
        .then(() => {
          setNotifications((prev) =>
            prev.map((n) => (n.id === id && n.read_at === null ? { ...n, read_at: Date.now() } : n)),
          );
        })
        .catch(() => {
          // Stays unread on both sides; the next hydration reconciles.
        })
        .finally(() => {
          readInFlight.current.delete(id);
        });
    }
  }, [activeSessionId, notifications]);

  const markRead = useCallback((id: string) => persistRead(id), [persistRead]);

  const markAllRead = useCallback(() => {
    const readAt = Date.now();
    const previous = notifications;
    setNotifications((prev) =>
      prev.some((n) => n.read_at === null)
        ? prev.map((n) => (n.read_at === null ? { ...n, read_at: readAt } : n))
        : prev,
    );
    void markAllReadApi().catch(() => setNotifications(previous));
  }, [notifications]);

  // No delete endpoint by design (see the API surface in the design doc):
  // dismissing hides the row for this view and marks it read, so it can never
  // come back as unread. Server-side retention prunes read history.
  const remove = useCallback((id: string) => {
    persistRead(id);
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, [persistRead]);

  const clear = useCallback(() => {
    void markAllReadApi().catch((err) => console.warn('[notifications] read-all failed:', err));
    setNotifications((prev) => (prev.length ? [] : prev));
  }, []);

  const unreadCount = notifications.reduce((acc, n) => acc + (n.read_at === null ? 1 : 0), 0);

  return { notifications, unreadCount, markRead, markAllRead, remove, clear };
}

function playSound(src: string) {
  let audio = audioCache.get(src);
  if (!audio) {
    // Normally already warmed; this is the fallback if a milestone beats the preload.
    audio = new Audio(src);
    audio.preload = 'auto';
    audioCache.set(src, audio);
  }
  audio.currentTime = 0;
  // Browser autoplay policy rejects play() until the user has interacted with
  // the page. By the time a milestone fires the user has invariably clicked
  // into the workspace; swallow the rejection regardless.
  void audio.play().catch(() => {});
}
