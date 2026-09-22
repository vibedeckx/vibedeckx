'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { STREAM_RECONNECTED_EVENT, useGlobalEventStream } from '@/hooks/global-event-stream';
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
  loop_done: '/sounds/sound1.mp3',
  // Needs attention but nothing is broken mid-run — the failure cue would
  // overstate it; the review cue's "look at this when you can" register fits.
  cross_remote_token_expired: '/sounds/sound2.mp3',
};

/**
 * How old a milestone may be and still earn its cue when it only surfaces
 * through the reconnect catch-up. The cue means "look now"; a completion
 * missed for longer than this is just a bell entry — replaying it late would
 * tell the user nothing the bell doesn't. Sized to cover the watchdog's
 * detect-and-reopen of a silent stream (~45s) plus a slow reconnect.
 */
export const CATCH_UP_SOUND_WINDOW_MS = 2 * 60 * 1000;

/**
 * Delays before re-trying a failed catch-up read. The stream reopening says the
 * server is reachable, not that the network has settled — the inbox read right
 * behind it can still hit the tail of the same outage, and nothing else would
 * ask again while the stream stays healthy. Bounded well inside the sound
 * window: past it a success only lands bell entries.
 */
export const CATCH_UP_RETRY_DELAYS_MS = [2_000, 5_000, 15_000];

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

export interface NotificationGroup {
  /** Newest member — supplies the copy, timestamp, and navigation target. */
  latest: ServerNotification;
  /** Every member id, newest first — read/dismiss must cover all of them. */
  ids: string[];
  /** All members, including retained read history. Collapsing scope, not a UI number. */
  count: number;
  /**
   * Members not yet seen — "how many happened since you last looked". Read
   * history collapses into the group but must never inflate this: marking read
   * keeps rows in the inbox, so total count grows without bound.
   */
  unreadCount: number;
  /** True when ANY member is unread. */
  unread: boolean;
}

/**
 * Session milestones collapse per session: a newer "result ready" strictly
 * supersedes an older one for the same session — by the time the user looks,
 * the session shows its latest state. Everything else stays one entry per
 * milestone: `review_ready` is already one-per-run by id, and two
 * `workflow_failed` rows are deliberately distinct attention states (see
 * workflowFailedId in notification-milestones.ts).
 */
const SESSION_COLLAPSED_KINDS: ReadonlySet<NotificationKind> = new Set([
  'session_result_ready',
  'session_failed',
]);

function groupKey(n: ServerNotification): string {
  return SESSION_COLLAPSED_KINDS.has(n.kind) && n.session_id
    ? `${n.kind}:${n.session_id}`
    : n.id;
}

/**
 * Collapse a newest-first milestone list into display groups. Milestones are
 * kept per-turn in storage (idempotency and history need them); grouping is
 * purely a presentation concern, shared by the bell badge and the menu list.
 */
export function groupNotifications(list: ServerNotification[]): NotificationGroup[] {
  const groups = new Map<string, NotificationGroup>();
  for (const n of list) {
    const unread = n.read_at === null;
    const existing = groups.get(groupKey(n));
    if (existing) {
      existing.ids.push(n.id);
      existing.count += 1;
      if (unread) {
        existing.unreadCount += 1;
        existing.unread = true;
      }
    } else {
      // First member seen is the newest — input order is newest-first, and Map
      // insertion order keeps groups sorted by their newest member.
      groups.set(groupKey(n), {
        latest: n,
        ids: [n.id],
        count: 1,
        unreadCount: unread ? 1 : 0,
        unread,
      });
    }
  }
  return [...groups.values()];
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
  /**
   * Mark every milestone carrying `workflow_run_id === runId` read, and — when
   * `runEnded` — any that arrive later. Fed to the Main Chat review panel
   * through `NotificationInboxProvider`; see hooks/notification-inbox-context.tsx
   * for why acting there counts as seen.
   */
  markReviewRunRead: (runId: string, opts?: { runEnded?: boolean }) => void;
}

/**
 * `activeSessionId` is the session the user is currently looking at, and
 * `activeResultAt` when the session stream delivered the finished state now on
 * screen (the page passes null for both while the conversation shows the
 * session running, a cache preview, or a transcript frozen by a dropped
 * connection). A notification for that session is auto-read only if it is no
 * newer than `activeResultAt` — being shown the result is the user having seen
 * it; a page that predates it is not. The comparison is strict, with no
 * allowance for clock skew: the milestone is written before its finished
 * status reaches the browser, so in-sync clocks already order them, while a
 * forward allowance would swallow a turn that ended seconds after the shown
 * one. A skewed clock errs toward keeping the milestone unread. A notification for a *different* session
 * stays unread even when it shares a branch with the one on screen.
 */
export function useCompletionNotifications(
  activeSessionId: string | null,
  activeResultAt: number | null = null,
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
  /**
   * Live view of the list for callbacks handed out through context. Reading the
   * state directly would make those callbacks change identity on every incoming
   * milestone, re-rendering every consumer for data they don't display. Synced
   * from an effect (like `activeSessionIdRef` below) rather than during render;
   * the consumers are event handlers, which always run after the commit.
   */
  const notificationsRef = useRef(notifications);
  useEffect(() => {
    notificationsRef.current = notifications;
  }, [notifications]);
  /**
   * Runs whose attention was consumed in Main Chat AND which have since ended.
   * The sweep below can only answer milestones already in hand; a run's inbox
   * row travels on the drain while the panel is pushed its state change
   * directly, so the `review_ready` can arrive after the click. Ended runs mint
   * nothing further, so any straggler for one is answered on arrival.
   */
  const consumedRuns = useRef<Set<string>>(new Set());

  useEffect(() => {
    warmCompletionSounds();
  }, []);

  // The SSE handler reads the *current* active session through a ref so it
  // never has to re-subscribe on navigation.
  const activeSessionIdRef = useRef(activeSessionId);
  const activeResultAtRef = useRef(activeResultAt);
  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
    activeResultAtRef.current = activeResultAt;
  }, [activeSessionId, activeResultAt]);

  /**
   * Per session, the latest `activeResultAt` the user actually looked at
   * (visible tab). A milestone no newer than it is one whose result was shown;
   * the reconnect catch-up reads it and skips the cue. A hidden tab doesn't
   * count — there the cue is the only way to find out.
   */
  const seenResultAt = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    if (!activeSessionId || activeResultAt === null) return;
    const note = () => {
      if (document.visibilityState !== 'visible') return;
      const prev = seenResultAt.current.get(activeSessionId) ?? -Infinity;
      if (activeResultAt > prev) seenResultAt.current.set(activeSessionId, activeResultAt);
    };
    note();
    document.addEventListener('visibilitychange', note);
    return () => document.removeEventListener('visibilitychange', note);
  }, [activeSessionId, activeResultAt]);

  const hasSeenResult = useCallback(
    (n: ServerNotification): boolean =>
      n.session_id !== null &&
      (seenResultAt.current.get(n.session_id) ?? -Infinity) >= n.created_at,
    [],
  );

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

  /**
   * Answer a milestone whose run was already dealt with in Main Chat and has
   * since ended. Must run on BOTH arrival paths, not just the SSE frame: the
   * hydration request is issued at mount but can land after the user has acted,
   * and server rows win over local ones in that merge — so without this, a slow
   * initial response both misses its own row and resurrects one the SSE path had
   * already answered.
   *
   * Called outside the `setNotifications` updater on purpose: the read call is a
   * side effect, and StrictMode double-invokes updaters.
   */
  const answerConsumed = useCallback((n: ServerNotification): ServerNotification => {
    if (n.read_at !== null) return n;
    if (n.workflow_run_id === null || !consumedRuns.current.has(n.workflow_run_id)) return n;
    void markReadApi(n.id).catch(() => {
      // Read locally, unread on the server. The next hydration answers it again
      // (`consumedRuns` outlives it), so nothing is lost.
    });
    return { ...n, read_at: Date.now() };
  }, []);

  // Hydrate from the server. This — not localStorage — is what restores unread
  // state across a reload.
  useEffect(() => {
    let cancelled = false;
    void getNotifications({ limit: 100 })
      .then((rows) => {
        if (cancelled) return;
        for (const row of rows) heard.current.add(row.id);
        const answered = rows.map(answerConsumed);
        setNotifications((prev) => {
          // Merge rather than replace: a frame that arrived before hydration
          // resolved must not be dropped. Everything goes through
          // upsertNotification so display order is ours, not a dependency on the
          // server's ORDER BY.
          let merged: ServerNotification[] = [];
          for (const row of answered) merged = upsertNotification(merged, row);
          for (const pending of prev) {
            if (!answered.some((r) => r.id === pending.id)) merged = upsertNotification(merged, pending);
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
  }, [answerConsumed]);

  /**
   * Take in one milestone from the live stream or the reconnect catch-up.
   * Returns whether it earns a cue; the caller plays it, so a catch-up batch
   * can collapse into a single sound. `alreadySeen` means the user has been
   * looking at the session since the milestone — read it, and no cue.
   */
  const ingest = useCallback((notification: ServerNotification, alreadySeen = false): boolean => {
    const isNew = !heard.current.has(notification.id);
    heard.current.add(notification.id);

    const active = activeSessionIdRef.current;
    const resultAt = activeResultAtRef.current;
    const onScreen =
      notification.session_id !== null &&
      notification.session_id === active &&
      resultAt !== null &&
      resultAt >= notification.created_at;
    // A straggler for a run the user already finished with in Main Chat.
    const consumed =
      notification.workflow_run_id !== null &&
      consumedRuns.current.has(notification.workflow_run_id);

    // Sound fires for every first-time milestone, including the session on
    // screen: `onScreen` suppresses the bell entry (the user can see the
    // result), but not the cue that tells them to look. Only `isNew` gates it,
    // so a hydrated or replayed row stays silent. A consumed run is the one
    // case that earns silence as well as no entry — it is over, so there is
    // nothing left for the cue to send the user to look at.
    const earnsCue = isNew && !consumed && !alreadySeen;

    const autoRead = onScreen || consumed || alreadySeen;
    setNotifications((prev) =>
      upsertNotification(prev, autoRead ? { ...notification, read_at: notification.read_at ?? Date.now() } : notification),
    );
    if (autoRead && notification.read_at === null) {
      void markReadApi(notification.id).catch(() => {
        // Leave it read locally but unread on the server; the next hydration
        // will show it unread again rather than losing it.
      });
    }
    return earnsCue;
  }, []);

  /**
   * The server keeps no per-client backlog, so a milestone emitted while the
   * stream was down (or silently dead — a zombie socket swallows frames until
   * the watchdog notices) never arrives as a frame. Re-read the inbox and take
   * in whatever this browser hasn't seen. Only milestones still fresh get a
   * cue, and a batch gets one cue (the newest's) rather than a burst. A
   * milestone whose result the user has already been shown (see
   * `seenResultAt`) is read on arrival and stays silent.
   *
   * A failed read is retried on `CATCH_UP_RETRY_DELAYS_MS`. A newer reconnect
   * supersedes a pending retry — it starts its own catch-up.
   */
  const catchUpRetry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const unmounted = useRef(false);
  useEffect(() => {
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      if (catchUpRetry.current) clearTimeout(catchUpRetry.current);
    };
  }, []);

  const catchUp = useCallback(() => {
    if (catchUpRetry.current) {
      clearTimeout(catchUpRetry.current);
      catchUpRetry.current = null;
    }
    const run = (attempt: number) => {
      void getNotifications({ limit: 100 })
        .then((rows) => {
          const now = Date.now();
          let cue: ServerNotification | null = null;
          for (const row of rows) {
            if (heard.current.has(row.id)) continue;
            const earnsCue = ingest(row, hasSeenResult(row));
            const fresh = row.read_at === null && now - row.created_at <= CATCH_UP_SOUND_WINDOW_MS;
            if (earnsCue && fresh && (!cue || row.created_at > cue.created_at)) cue = row;
          }
          if (cue) playSound(SOUND_FOR_KIND[cue.kind]);
        })
        .catch((err) => {
          const delay = CATCH_UP_RETRY_DELAYS_MS[attempt];
          console.warn(
            `[notifications] reconnect catch-up failed${delay === undefined ? ', giving up' : `, retrying in ${delay}ms`}:`,
            err,
          );
          if (delay === undefined || unmounted.current) return;
          catchUpRetry.current = setTimeout(() => {
            catchUpRetry.current = null;
            run(attempt + 1);
          }, delay);
        });
    };
    run(0);
  }, [ingest, hasSeenResult]);

  useGlobalEventStream((data) => {
    if (data.type === STREAM_RECONNECTED_EVENT) {
      catchUp();
      return;
    }
    if (data.type !== 'notification:created') return;
    const notification = (data as { notification?: ServerNotification }).notification;
    if (!notification?.id) return;
    if (ingest(notification)) playSound(SOUND_FOR_KIND[notification.kind]);
  });

  // Navigating *into* a session clears its pending notifications — covers the
  // sidebar/deep-link case where the row was already unread before arrival.
  //
  // Unlike the user-initiated `markRead` below, this deliberately updates state
  // only in the network callback rather than optimistically: a synchronous
  // setState here would cascade renders (this effect depends on `notifications`,
  // which it also writes). Navigation is not a click waiting on feedback, so
  // clearing the badge one round-trip later is the better trade.
  //
  // Only milestones the page on screen already covers: one newer than the
  // shown result (a page that predates it) stays unread.
  useEffect(() => {
    if (!activeSessionId || activeResultAt === null) return;
    for (const notification of notifications) {
      if (notification.session_id !== activeSessionId || notification.read_at !== null) continue;
      if (notification.created_at > activeResultAt) continue;
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
  }, [activeSessionId, activeResultAt, notifications]);

  const markRead = useCallback((id: string) => persistRead(id), [persistRead]);

  // A run can hold more than one unread `review_ready`: every discussion round
  // mints a fresh one (`reviewReadyId(runId, boundary)`), and unlike session
  // milestones they do NOT collapse in the bell — each round is its own entry.
  // Consuming the run therefore has to sweep all of them, not just the newest.
  const markReviewRunRead = useCallback(
    (runId: string, opts?: { runEnded?: boolean }) => {
      if (opts?.runEnded) consumedRuns.current.add(runId);
      for (const n of notificationsRef.current) {
        if (n.workflow_run_id === runId && n.read_at === null) persistRead(n.id);
      }
    },
    [persistRead],
  );

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

  // The badge answers "how many places need my attention", so it counts unread
  // GROUPS — three completions of one session are one place to look, not three.
  const unreadCount = groupNotifications(notifications).reduce(
    (acc, g) => acc + (g.unread ? 1 : 0),
    0,
  );

  return { notifications, unreadCount, markRead, markAllRead, remove, clear, markReviewRunRead };
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
