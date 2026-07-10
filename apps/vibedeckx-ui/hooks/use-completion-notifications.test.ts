import { describe, expect, it } from 'vitest';
import {
  notificationFromEvent,
  parseStoredNotifications,
  type CompletionNotification,
} from './use-completion-notifications';

describe('notificationFromEvent', () => {
  it('stores the event sessionId so the click can deep-link ?session=<id>', () => {
    const n = notificationFromEvent(
      {
        projectId: 'proj-1',
        branch: 'feat-a',
        activity: 'completed',
        since: 1000,
        sessionId: 'sess-9',
      },
      false,
    );
    expect(n).toEqual({
      id: 'proj-1:feat-a',
      projectId: 'proj-1',
      branch: 'feat-a',
      sessionId: 'sess-9',
      type: 'completed',
      at: 1000,
      read: false,
    });
  });

  it('sessionId is null when the event carries none (main-completed / legacy backend)', () => {
    const n = notificationFromEvent(
      { projectId: 'proj-1', branch: null, activity: 'main-completed', since: 2000 },
      true,
    );
    expect(n.sessionId).toBeNull();
    expect(n.id).toBe('proj-1:');
    expect(n.read).toBe(true);
  });
});

describe('parseStoredNotifications', () => {
  const valid: CompletionNotification = {
    id: 'proj-1:feat-a',
    projectId: 'proj-1',
    branch: 'feat-a',
    sessionId: 'sess-9',
    type: 'completed',
    at: 1000,
    read: false,
  };

  it('round-trips an entry with sessionId', () => {
    expect(parseStoredNotifications(JSON.stringify([valid]))).toEqual([valid]);
  });

  it('normalizes legacy entries without sessionId to null', () => {
    const legacy = { ...valid } as Record<string, unknown>;
    delete legacy.sessionId;
    const parsed = parseStoredNotifications(JSON.stringify([legacy]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].sessionId).toBeNull();
  });

  it('drops malformed entries and non-array payloads', () => {
    expect(parseStoredNotifications(JSON.stringify([{ id: 42 }]))).toEqual([]);
    expect(parseStoredNotifications('{"not":"array"}')).toEqual([]);
    expect(parseStoredNotifications('not json')).toEqual([]);
    expect(parseStoredNotifications(null)).toEqual([]);
  });
});
