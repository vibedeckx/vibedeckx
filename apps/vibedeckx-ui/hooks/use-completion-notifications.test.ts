// @vitest-environment jsdom
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getNotifications: vi.fn(),
  markNotificationRead: vi.fn(),
  markAllNotificationsRead: vi.fn(),
}));
vi.mock('@/lib/api', () => api);

// The hook subscribes through this context in the real app; here we capture the
// listener so tests can push SSE frames synchronously.
const stream = vi.hoisted(() => ({ listener: null as ((data: unknown) => void) | null }));
vi.mock('@/hooks/global-event-stream', () => ({
  useGlobalEventStream: (listener: (data: unknown) => void) => {
    stream.listener = listener;
  },
}));

const played = vi.hoisted(() => ({ srcs: [] as string[] }));

import {
  LEGACY_STORAGE_KEY,
  SOUND_FOR_KIND,
  groupNotifications,
  upsertNotification,
  useCompletionNotifications,
  type ServerNotification,
} from './use-completion-notifications';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (overrides: Partial<ServerNotification> = {}): ServerNotification => ({
  id: 'n1',
  kind: 'session_result_ready',
  project_id: 'p1',
  branch: 'dev',
  session_id: 's1',
  workflow_run_id: null,
  title: 'Session result is ready',
  body: 'Fix login',
  created_at: 10,
  read_at: null,
  ...overrides,
});

describe('SOUND_FOR_KIND', () => {
  it('gives success, review-ready, and failure three distinct cues', () => {
    expect(SOUND_FOR_KIND.session_result_ready).toBe('/sounds/sound1.mp3');
    expect(SOUND_FOR_KIND.review_ready).toBe('/sounds/sound2.mp3');
    expect(SOUND_FOR_KIND.session_failed).toBe('/sounds/failure.mp3');
    // Both failure kinds share the failure cue — the distinction the user needs
    // is success vs. review vs. something-went-wrong.
    expect(SOUND_FOR_KIND.workflow_failed).toBe('/sounds/failure.mp3');
    expect(new Set(Object.values(SOUND_FOR_KIND)).size).toBe(3);
  });
});

describe('upsertNotification', () => {
  it('inserts newest-first by created_at', () => {
    const older = row({ id: 'a', created_at: 1 });
    const newer = row({ id: 'b', created_at: 9 });
    expect(upsertNotification([older], newer).map((n) => n.id)).toEqual(['b', 'a']);
  });

  it('replaces by notification id rather than appending a duplicate', () => {
    const first = row({ id: 'a', read_at: null });
    const replayed = row({ id: 'a', read_at: 55 });
    const result = upsertNotification([first], replayed);
    expect(result).toHaveLength(1);
    expect(result[0].read_at).toBe(55);
  });

  it('keys on the full notification id, so two sessions on one branch stay separate', () => {
    const a = row({ id: 'session:sA:turn:2:result-ready', session_id: 'sA' });
    const b = row({ id: 'session:sB:turn:2:result-ready', session_id: 'sB' });
    expect(upsertNotification([a], b)).toHaveLength(2);
  });
});

describe('groupNotifications', () => {
  it('collapses repeated completions of one session into one group led by the newest', () => {
    let list: ServerNotification[] = [];
    for (const [id, at] of [['s1:t2', 2], ['s1:t5', 5], ['s1:t9', 9]] as const) {
      list = upsertNotification(list, row({ id, created_at: at }));
    }
    const groups = groupNotifications(list);
    expect(groups).toHaveLength(1);
    expect(groups[0].latest.id).toBe('s1:t9');
    expect(groups[0].count).toBe(3);
    expect(groups[0].unreadCount).toBe(3);
    expect(groups[0].ids).toEqual(['s1:t9', 's1:t5', 's1:t2']);
  });

  it('unreadCount excludes retained read history — it means "new since you last looked"', () => {
    // Two completions already seen (read, but still in the retained inbox) plus
    // one fresh one: the batch the user has yet to look at is 1, not 3.
    const list = [
      row({ id: 's1:t9', created_at: 9, read_at: null }),
      row({ id: 's1:t5', created_at: 5, read_at: 100 }),
      row({ id: 's1:t2', created_at: 2, read_at: 100 }),
    ];
    const [group] = groupNotifications(list);
    expect(group.count).toBe(3);
    expect(group.unreadCount).toBe(1);
    expect(group.unread).toBe(true);
  });

  it('a group is unread if ANY member is unread, even when the newest is read', () => {
    const list = [
      row({ id: 'new', created_at: 9, read_at: 100 }),
      row({ id: 'old', created_at: 2, read_at: null }),
    ];
    expect(groupNotifications(list)[0].unread).toBe(true);
    const allRead = list.map((n) => ({ ...n, read_at: 100 }));
    expect(groupNotifications(allRead)[0].unread).toBe(false);
  });

  it('keeps different sessions on one branch separate', () => {
    const list = [
      row({ id: 'a', session_id: 'sA', created_at: 9 }),
      row({ id: 'b', session_id: 'sB', created_at: 2 }),
    ];
    expect(groupNotifications(list)).toHaveLength(2);
  });

  it('keeps a failure separate from a success of the same session', () => {
    const list = [
      row({ id: 'ok', kind: 'session_result_ready', created_at: 9 }),
      row({ id: 'boom', kind: 'session_failed', created_at: 2 }),
    ];
    expect(groupNotifications(list)).toHaveLength(2);
  });

  it('never collapses workflow_failed milestones — distinct failures are distinct attention states', () => {
    const list = [
      row({ id: 'wf:r1:failed:v2', kind: 'workflow_failed', session_id: null, workflow_run_id: 'r1', created_at: 9 }),
      row({ id: 'wf:r1:failed:v1', kind: 'workflow_failed', session_id: null, workflow_run_id: 'r1', created_at: 2 }),
    ];
    expect(groupNotifications(list)).toHaveLength(2);
  });

  it('preserves newest-first ordering across groups', () => {
    const list = [
      row({ id: 'a2', session_id: 'sA', created_at: 9 }),
      row({ id: 'b1', session_id: 'sB', created_at: 5 }),
      row({ id: 'a1', session_id: 'sA', created_at: 2 }),
    ];
    expect(groupNotifications(list).map((g) => g.latest.id)).toEqual(['a2', 'b1']);
  });
});

/**
 * The hook can only be as correct as what it is handed. The original defect was
 * purely a wiring one — `urlSessionId` (an explicit `?session=` selection) was
 * passed as though it meant "visible" — so it lived entirely outside the hook's
 * own tests. These guard the composition instead.
 */
describe('page wiring: visibility source', () => {
  const read = async (rel: string) => {
    const fs = await import('node:fs');
    return fs.readFileSync(new URL(rel, import.meta.url), 'utf-8');
  };

  it('feeds the notification hook the rendered session, never the URL param', async () => {
    const page = await read('../app/page.tsx');
    expect(page).toMatch(/useCompletionNotifications\(activeNotificationSessionId\)/);
    // Derived from what the conversation reports it is showing...
    expect(page).toMatch(/activeNotificationSessionId\s*=\s*\n?\s*activeView === 'workspace' \? renderedSessionId : null/);
    // ...and explicitly NOT from the URL selection.
    expect(page).not.toMatch(/activeNotificationSessionId\s*=\s*\n?\s*activeView === 'workspace' \? urlSessionId : null/);
  });

  it('subscribes to AgentConversation.onActiveSessionChange', async () => {
    const page = await read('../app/page.tsx');
    expect(page).toMatch(/onActiveSessionChange=\{setRenderedSessionId\}/);

    const conversation = await read('../components/agent/agent-conversation.tsx');
    // Reports the RESOLVED session (auto-restored included), not the prop.
    expect(conversation).toMatch(/const activeSessionId = session\?\.id \?\? null;/);
    expect(conversation).toMatch(/onActiveSessionChange\?\.\(activeSessionId\)/);
  });
});

describe('useCompletionNotifications', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: ReturnType<typeof useCompletionNotifications>;

  // Published from an effect, not during render: assigning to an outer variable
  // mid-render is a side effect React (and eslint) rightly rejects. act() flushes
  // effects, so `latest` is current by the time assertions run.
  function Harness({ activeSessionId }: { activeSessionId: string | null }) {
    const result = useCompletionNotifications(activeSessionId);
    useEffect(() => {
      latest = result;
    });
    return null;
  }

  // createElement rather than JSX so this stays a .ts file alongside the hook.
  async function render(activeSessionId: string | null = null) {
    await act(async () => {
      root.render(createElement(Harness, { activeSessionId }));
    });
  }

  const rerender = render;

  async function pushSse(notification: ServerNotification) {
    await act(async () => {
      stream.listener?.({ type: 'notification:created', projectId: notification.project_id, notification });
    });
  }

  beforeEach(() => {
    played.srcs = [];
    api.getNotifications.mockResolvedValue([]);
    api.markNotificationRead.mockResolvedValue(undefined);
    api.markAllNotificationsRead.mockResolvedValue(undefined);
    window.localStorage.clear();
    // Audio is unimplemented in jsdom; record play() calls instead.
    vi.stubGlobal('Audio', class {
      currentTime = 0;
      preload = '';
      readyState = 4;
      constructor(public src: string) {}
      load() {}
      play() { played.srcs.push(this.src); return Promise.resolve(); }
    });
    // Reject the warm fetch so playSound takes its lazy fallback and constructs
    // Audio with the LOGICAL path — which is what these tests assert. (Warming
    // otherwise replaces the src with an opaque blob: URL.)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline'); }));
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    stream.listener = null;
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('hydrates from the server inbox on mount', async () => {
    api.getNotifications.mockResolvedValue([row({ id: 'a' }), row({ id: 'b', created_at: 20 })]);
    await render();
    expect(api.getNotifications).toHaveBeenCalled();
    expect(latest.notifications.map((n) => n.id)).toEqual(['b', 'a']);
  });

  it('drops the legacy branch-keyed localStorage entry after hydration, without uploading it', async () => {
    window.localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify([{ id: 'p1:dev', read: false }]));
    await render();
    expect(window.localStorage.getItem(LEGACY_STORAGE_KEY)).toBeNull();
    expect(latest.notifications).toEqual([]);
  });

  it('counts unread from the server read state, surviving a refresh', async () => {
    api.getNotifications.mockResolvedValue([row({ id: 'a', read_at: null }), row({ id: 'b', read_at: 5 })]);
    await render();
    expect(latest.unreadCount).toBe(1);
  });

  it('counts sessions needing attention, not individual turn milestones', async () => {
    // Three unread completions of one session + one of another: the badge should
    // say 2 (two sessions to look at), not 4.
    api.getNotifications.mockResolvedValue([
      row({ id: 's1:t9', session_id: 's1', created_at: 9 }),
      row({ id: 's1:t5', session_id: 's1', created_at: 5 }),
      row({ id: 's1:t2', session_id: 's1', created_at: 2 }),
      row({ id: 's2:t3', session_id: 's2', created_at: 3 }),
    ]);
    await render();
    expect(latest.unreadCount).toBe(2);
  });

  it('inserts a notification:created frame and plays its kind sound', async () => {
    await render();
    await pushSse(row({ id: 'a', kind: 'session_result_ready' }));
    expect(latest.notifications.map((n) => n.id)).toEqual(['a']);
    expect(played.srcs).toEqual(['/sounds/sound1.mp3']);
  });

  it.each([
    ['review_ready', '/sounds/sound2.mp3'],
    ['session_failed', '/sounds/failure.mp3'],
    ['workflow_failed', '/sounds/failure.mp3'],
  ] as const)('plays the %s cue', async (kind, src) => {
    await render();
    await pushSse(row({ id: `n-${kind}`, kind }));
    expect(played.srcs).toEqual([src]);
  });

  it('an SSE replay of an existing row neither duplicates nor re-plays the sound', async () => {
    await render();
    await pushSse(row({ id: 'a' }));
    await pushSse(row({ id: 'a' }));
    expect(latest.notifications).toHaveLength(1);
    expect(played.srcs).toHaveLength(1);
  });

  it('a row already present from hydration is not re-sounded by its SSE frame', async () => {
    api.getNotifications.mockResolvedValue([row({ id: 'a' })]);
    await render();
    await pushSse(row({ id: 'a' }));
    expect(played.srcs).toEqual([]);
  });

  it('auto-reads a notification targeting the exact active session', async () => {
    await render('s1');
    await pushSse(row({ id: 'a', session_id: 's1' }));
    expect(latest.notifications[0].read_at).not.toBeNull();
    expect(latest.unreadCount).toBe(0);
    expect(api.markNotificationRead).toHaveBeenCalledWith('a');
  });

  /**
   * Auto-read suppresses the *bell entry*, not the audible cue. The user is
   * looking at the page but not necessarily at the screen — the sound is how a
   * finished turn reaches them while they're elsewhere.
   */
  it('still plays the sound for the session on screen, even though it auto-reads', async () => {
    await render('s1');
    await pushSse(row({ id: 'a', session_id: 's1', kind: 'session_result_ready' }));
    expect(played.srcs).toEqual(['/sounds/sound1.mp3']);
    expect(latest.notifications[0].read_at).not.toBeNull();
    expect(latest.unreadCount).toBe(0);
  });

  it('leaves another session on the SAME BRANCH unread', async () => {
    await render('s1');
    // Same project + branch, different session — the exact bug the milestone
    // redesign exists to fix.
    await pushSse(row({ id: 'b', session_id: 's2', branch: 'dev', project_id: 'p1' }));
    expect(latest.notifications[0].read_at).toBeNull();
    expect(latest.unreadCount).toBe(1);
    expect(api.markNotificationRead).not.toHaveBeenCalled();
  });

  /**
   * Visibility must come from the session the conversation actually RENDERS.
   * Opening a workspace with no `?session=` still shows the branch's
   * auto-restored session; treating that as "nothing visible" would leave its
   * own results stuck unread while the user stares at them.
   */
  it('auto-reads an auto-restored session that was never named in the URL', async () => {
    // Mount with nothing selected (as a bare workspace URL would).
    await render(null);
    await pushSse(row({ id: 'a', session_id: 's-restored' }));
    expect(latest.notifications[0].read_at).toBeNull();

    // AgentConversation resolves and renders the branch's latest session and
    // reports it upward — no URL change involved.
    await rerender('s-restored');
    expect(latest.unreadCount).toBe(0);
    expect(api.markNotificationRead).toHaveBeenCalledWith('a');
  });

  it('stops auto-reading once the conversation reports nothing is rendered', async () => {
    await render('s1');
    // Leaving the workspace: the component unmounts and reports null.
    await rerender(null);
    await pushSse(row({ id: 'a', session_id: 's1' }));
    expect(latest.notifications[0].read_at).toBeNull();
    expect(latest.unreadCount).toBe(1);
  });

  it('navigating into a target session marks its pending notifications read', async () => {
    api.getNotifications.mockResolvedValue([row({ id: 'a', session_id: 's9', read_at: null })]);
    await render(null);
    expect(latest.unreadCount).toBe(1);

    await rerender('s9');
    expect(latest.unreadCount).toBe(0);
    expect(api.markNotificationRead).toHaveBeenCalledWith('a');
  });

  it('markRead updates the server and local state', async () => {
    api.getNotifications.mockResolvedValue([row({ id: 'a' })]);
    await render();
    await act(async () => { latest.markRead('a'); });
    expect(api.markNotificationRead).toHaveBeenCalledWith('a');
    expect(latest.notifications[0].read_at).not.toBeNull();
  });

  it('markAllRead updates the server and local state', async () => {
    api.getNotifications.mockResolvedValue([row({ id: 'a' }), row({ id: 'b', created_at: 2 })]);
    await render();
    await act(async () => { latest.markAllRead(); });
    expect(api.markAllNotificationsRead).toHaveBeenCalled();
    expect(latest.unreadCount).toBe(0);
  });

  it('a failed read mutation leaves the row unread so the next fetch reconciles it', async () => {
    api.getNotifications.mockResolvedValue([row({ id: 'a' })]);
    api.markNotificationRead.mockRejectedValue(new Error('offline'));
    await render();
    await act(async () => { latest.markRead('a'); });
    expect(latest.notifications[0].read_at).toBeNull();
    expect(latest.unreadCount).toBe(1);
  });

  it('ignores branch:activity entirely — no bell entry, no sound', async () => {
    await render();
    await act(async () => {
      stream.listener?.({
        type: 'branch:activity', projectId: 'p1', branch: 'dev',
        activity: 'completed', since: Date.now(), sessionId: 's1',
      });
    });
    expect(latest.notifications).toEqual([]);
    expect(played.srcs).toEqual([]);
  });
});
