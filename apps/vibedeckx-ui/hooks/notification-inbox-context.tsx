"use client";

import { createContext, useContext } from "react";

export interface NotificationInboxActions {
  /**
   * Mark every inbox milestone belonging to one workflow run read.
   *
   * The bell's normal clearing rule is "the user opened the session the
   * milestone points at", and `review_ready` points at the *reviewer* session
   * (that is where the feedback text lives). But the feedback is also surfaced
   * in the source session's Main Chat, where the user can send it back or end
   * the run outright — having done either, they have plainly seen it, and
   * making them detour into the reviewer session just to silence the badge is
   * busywork. This is the escape hatch for that: a surface that consumes a
   * run's attention says so, without knowing which rows exist.
   *
   * `runEnded` marks the run terminal (approve → completed, cancel →
   * cancelled). Milestones and run-state updates travel on separate channels —
   * the panel is pushed `emitRunUpdated` synchronously while the inbox row
   * waits on the outbox drain — so a `review_ready` can land AFTER the click
   * that consumed it. For an ended run that straggler is answered too, since
   * nothing legitimate can follow. `finalize` passes false: it keeps the run
   * alive and the next round's milestone must still raise the bell.
   */
  markReviewRunRead: (runId: string, opts?: { runEnded?: boolean }) => void;
}

// No-op default so a panel rendered outside the app shell (unit tests) still
// works — clearing the bell is an enhancement on top of the gate actions,
// never a precondition for them.
const NotificationInboxContext = createContext<NotificationInboxActions>({
  markReviewRunRead: () => {},
});

export const NotificationInboxProvider = NotificationInboxContext.Provider;

export function useNotificationInbox(): NotificationInboxActions {
  return useContext(NotificationInboxContext);
}
