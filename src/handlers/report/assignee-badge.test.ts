import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client, ThreadChannel } from 'discord.js';

const h = vi.hoisted(() => {
  const namespaces = new Map<string, Map<string, string>>();
  const ns = (name: string) => {
    if (!namespaces.has(name)) namespaces.set(name, new Map());
    return namespaces.get(name)!;
  };
  return { ns, namespaces };
});
vi.mock('../../store.js', () => ({
  createStore: (name: string) => ({
    get: async (k: string) => { const v = h.ns(name).get(k); return v === undefined ? undefined : JSON.parse(v); },
    set: async (k: string, v: unknown) => { h.ns(name).set(k, JSON.stringify(v)); },
    delete: async (k: string) => h.ns(name).delete(k),
  }),
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }),
}));

import { assigneeField, assigneeIdFromFields, badgeForAssignee, claimAssigneeEmoji, clearAssigneeEmoji, parseAssigneeEmoji, reportsNeedingBadgeSync, resolveBadge } from './assignee-badge.js';
import { StoredReport, type StoredReportData } from './report-store.js';
import { splitBadge, statusFromTitle, stripLeadingEmoji } from './report-title.js';
import { priorityFromTitle, setPriorityInTitle, stripPriorityEmoji } from './priority.js';
import {
  applyBadge, composeReportTitle, computeStatusTitle, fitTitle, initTitleSync, scheduleBadgeBackfill, scheduleBadgeSync,
  setReportCloseHandler, withThreadLock, setThreadStatusAndClose, setThreadStatusEmoji, splitReportTitle,
} from './title-sync.js';

const ASSIGNED = [{ name: '👤 Assigned to', value: '<@42>' }];

function fakeThread(id: string, name: string, fields: { name: string; value: string }[] = []) {
  const thread = {
    id, name, archived: false, isThread: () => true,
    fetchStarterMessage: vi.fn(async () => ({ embeds: [{ fields }] })),
    setName: vi.fn(async (next: string) => { thread.name = next; }),
  };
  return thread;
}
const asThread = (t: ReturnType<typeof fakeThread>) => t as unknown as ThreadChannel;

function clientFor(threads: ReturnType<typeof fakeThread>[], fails: (id: string) => boolean = () => false): Client {
  return { channels: { fetch: async (id: string) => {
    if (fails(id)) throw new Error('down');
    return threads.find(t => t.id === id) ?? null;
  } } } as unknown as Client;
}

function report(threadId: string, overrides: Partial<StoredReportData> = {}): StoredReportData {
  return {
    threadId, ticketId: '1', reporterId: 'u', label: 'Bug Report', threadName: '', url: '',
    tagNames: ['OPEN'], createdTimestamp: 1, lastActivityAt: 1, ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  for (const m of h.namespaces.values()) m.clear();
});
afterEach(async () => {
  await vi.advanceTimersByTimeAsync(20 * 60_000);
  vi.useRealTimers();
});

describe('title grammar', () => {
  const name = '🦊 🟠 3️⃣ Bug Report - Crash (12)';

  it('reads each part behind a badge', () => {
    expect(splitBadge(name)).toEqual({ badge: '🦊', body: '🟠 3️⃣ Bug Report - Crash (12)' });
    expect(statusFromTitle(name)).toBe('new');
    expect(priorityFromTitle(name)).toBe(3);
    expect(stripLeadingEmoji(name)).toBe(' 3️⃣ Bug Report - Crash (12)');
  });

  it('only treats a non-reserved emoji ahead of a status as a badge', () => {
    for (const n of ['🟠 Crash', '✂️ 🟠 Crash', '🦊 Crash', '🦊', 'Hi 🟠 Crash', '🟠 🔴 Crash']) {
      expect(splitBadge(n).badge).toBeNull();
    }
  });

  it('keeps the badge through priority and human-title edits', () => {
    expect(setPriorityInTitle(name, 1)).toBe('🦊 🟠 1️⃣ Bug Report - Crash (12)');
    expect(stripPriorityEmoji(name)).toBe('🦊 🟠 Bug Report - Crash (12)');
    expect(composeReportTitle(splitReportTitle(name, '12'), 'Boom')).toBe('🦊 🟠 3️⃣ Bug Report - Boom (12)');
    expect(splitReportTitle('🦊 🟠 3️⃣ Old title (12)', '12').title).toBe('Old title');
  });

  it('strips the badge for terminal statuses and keeps it otherwise', () => {
    expect(computeStatusTitle(name, 'closed', '12')).toBe('🔵 3️⃣ Bug Report - Crash (12)');
    expect(computeStatusTitle(name, 'resolved', '12', '🦊')).toBe('🟢 3️⃣ Bug Report - Crash (12)');
    expect(computeStatusTitle(name, 'snoozed', '12')).toBe('🦊 💤 3️⃣ Bug Report - Crash (12)');
  });

  it('fits the badge in 100 chars without losing the ticket id', () => {
    const out = applyBadge(`🟠 Bug Report - ${'x'.repeat(79)} (1234)`, '1234', '🏴󠁧󠁢󠁥󠁮󠁧󠁿');
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith('… (1234)')).toBe(true);
  });

  it('keeps the ticket id when a priority pushes the title past the cap', () => {
    const out = fitTitle(setPriorityInTitle(`🦊 🟠 Bug Report - ${'x'.repeat(75)} (1234)`, 3));
    expect(out.length).toBeLessThanOrEqual(100);
    expect(out.endsWith('… (1234)')).toBe(true);
  });

  it('leaves titles with no status, or an unknown badge, alone', () => {
    expect(applyBadge('✂️ Split - 🟠 Crash', '1', '🦊')).toBe('✂️ Split - 🟠 Crash');
    expect(applyBadge(name, '12', undefined)).toBe(name);
  });
});

describe('emoji registry', () => {
  it('accepts exactly one unreserved emoji', () => {
    expect(parseAssigneeEmoji(' 🦊 ')).toEqual({ ok: true, emoji: '🦊' });
    expect(parseAssigneeEmoji('👩‍🚀')).toEqual({ ok: true, emoji: '👩‍🚀' });
    expect(parseAssigneeEmoji('❤')).toEqual({ ok: true, emoji: '❤️' });
    for (const bad of ['', 'x', '3', '🦊🐻', '<:a:123>', ':fox:']) {
      expect(parseAssigneeEmoji(bad)).toEqual({ ok: false, reason: 'invalid' });
    }
    for (const reserved of ['🟠', '💤', '3️⃣', '🐛', '✂️', '✂', '⚪']) {
      expect(parseAssigneeEmoji(reserved)).toEqual({ ok: false, reason: 'reserved' });
    }
  });

  it('keeps emojis unique and releases them when changed or cleared', async () => {
    expect(await Promise.all([claimAssigneeEmoji('1', '🦊'), claimAssigneeEmoji('2', '🦊')])).toEqual([null, '1']);
    expect(await claimAssigneeEmoji('1', '🐻')).toBeNull();
    expect(await claimAssigneeEmoji('2', '🦊')).toBeNull();
    expect(await clearAssigneeEmoji('2')).toBe(true);
    expect(await clearAssigneeEmoji('2')).toBe(false);
  });
});

describe('resolveBadge', () => {
  it('seeds the assignee from the starter embed once', async () => {
    await claimAssigneeEmoji('42', '🦊');
    await StoredReport.record(report('1'));
    const t = fakeThread('1', '🟠 Crash', ASSIGNED);
    expect(await resolveBadge(asThread(t))).toBe('🦊');
    expect(await resolveBadge(asThread(t))).toBe('🦊');
    expect(t.fetchStarterMessage).toHaveBeenCalledTimes(1);
  });

  it('never overwrites an assignment stored while the embed was loading', async () => {
    await claimAssigneeEmoji('7', '🐻');
    await StoredReport.record(report('1'));
    const t = fakeThread('1', '🟠 Crash', ASSIGNED);
    t.fetchStarterMessage.mockImplementation(async () => {
      await StoredReport.update('1', { assigneeId: '7' });
      return { embeds: [{ fields: ASSIGNED }] };
    });
    expect(await resolveBadge(asThread(t))).toBe('🐻');
  });

  it('is undefined when the starter cannot be fetched', async () => {
    const t = fakeThread('1', '🟠 Crash');
    t.fetchStarterMessage.mockRejectedValue(new Error('down'));
    expect(await resolveBadge(asThread(t))).toBeUndefined();
  });

  it('survives a report re-record', async () => {
    await StoredReport.record(report('1', { assigneeId: '42' }));
    await StoredReport.record(report('1'));
    expect((await StoredReport.get('1'))?.data.assigneeId).toBe('42');
    await StoredReport.record(report('2', { assigneeId: null }));
    await StoredReport.record(report('2'));
    expect((await StoredReport.get('2'))?.data.assigneeId).toBeNull();
  });
});

it('selects only open reports that are or may be assigned to the user', async () => {
  await StoredReport.record(report('1', { assigneeId: '42' }));
  await StoredReport.record(report('2'));
  await StoredReport.record(report('3', { assigneeId: '7' }));
  await StoredReport.record(report('4', { assigneeId: null }));
  await StoredReport.record(report('5', { assigneeId: '42', tagNames: ['CLOSED'] }));
  await StoredReport.record(report('6', { assigneeId: '42', tagNames: ['SNOOZED'] }));
  expect(await reportsNeedingBadgeSync('42')).toEqual(['1', '2']);
});

describe('badge sync', () => {
  const pending = () => JSON.parse(h.ns('title-sync').get('pending') ?? '{}');
  beforeEach(() => claimAssigneeEmoji('42', '🦊'));

  it('renames once after the debounce, restarting it on reassignment', async () => {
    const t = fakeThread('101', '🟠 Crash (9)', ASSIGNED);
    await scheduleBadgeSync(asThread(t));
    await vi.advanceTimersByTimeAsync(40_000);
    await scheduleBadgeSync(asThread(t));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(t.setName).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(21_000);
    expect(t.setName.mock.calls).toEqual([['🦊 🟠 Crash (9)']]);
    expect(pending()).toEqual({});
  });

  it('is absorbed by a status change', async () => {
    const t = fakeThread('102', '🟠 Crash (9)', ASSIGNED);
    await scheduleBadgeSync(asThread(t));
    await setThreadStatusEmoji(asThread(t), 'waiting-for-dev');
    expect(pending()).toEqual({});
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.setName.mock.calls).toEqual([['🦊 🔴 Crash (9)']]);
  });

  it('keeps a request that lands mid-rename', async () => {
    const t = fakeThread('103', '🟠 Crash (9)', []);
    t.setName.mockImplementationOnce(async (next: string) => {
      t.name = next;
      await StoredReport.record(report('103', { assigneeId: '42' }));
      await scheduleBadgeSync(asThread(t));
    });
    await setThreadStatusEmoji(asThread(t), 'waiting-for-dev');
    expect(t.name).toBe('🔴 Crash (9)');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.name).toBe('🦊 🔴 Crash (9)');
  });

  it('retries after a rate limit', async () => {
    const t = fakeThread('104', '🟠 Crash (9)', ASSIGNED);
    t.setName.mockRejectedValueOnce({ timeToReset: 15_000, retryAfter: 300_000 });
    await scheduleBadgeSync(asThread(t));
    await vi.advanceTimersByTimeAsync(62_000);
    expect(t.name).toBe('🟠 Crash (9)');
    await vi.advanceTimersByTimeAsync(302_000);
    expect(t.name).toBe('🦊 🟠 Crash (9)');
  });

  it.each(['CLOSED', 'SNOOZED'])('drops the refresh for a %s thread archived during the debounce', async tag => {
    const t = fakeThread(`105-${tag}`, '🟠 Crash (9)', ASSIGNED);
    await StoredReport.record(report(t.id, { assigneeId: '42', tagNames: [tag] }));
    await scheduleBadgeSync(asThread(t));
    t.archived = true;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.setName).not.toHaveBeenCalled();
    expect(pending()).toEqual({});
  });

  it('does not revive a superseded status when a badge request lands mid-change', async () => {
    const t = fakeThread('111', '🟠 Crash (9)', ASSIGNED);
    t.setName.mockRejectedValueOnce({ timeToReset: 60_000 });
    await setThreadStatusEmoji(asThread(t), 'waiting-for-user');
    t.setName.mockImplementationOnce(async (next: string) => {
      t.name = next;
      await scheduleBadgeSync(asThread(t));
    });
    await setThreadStatusEmoji(asThread(t), 'waiting-for-dev');
    await vi.advanceTimersByTimeAsync(300_000);
    expect(t.name).toBe('🦊 🔴 Crash (9)');
    expect(pending()).toEqual({});
  });

  it('parks an auto-archived open report until it is unarchived', async () => {
    const t = fakeThread('112', '🐻 🟠 Crash (9)');
    await StoredReport.record(report('112', { assigneeId: '42' }));
    initTitleSync(clientFor([t]));
    t.archived = true;
    await scheduleBadgeSync(asThread(t));
    await vi.advanceTimersByTimeAsync(40 * 60_000);
    expect(t.setName).not.toHaveBeenCalled();
    t.archived = false;
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(t.name).toBe('🦊 🟠 Crash (9)');
  });

  it('does not park an archived report whose badge already matches', async () => {
    const t = fakeThread('123', '🟠 Crash (9)');
    await StoredReport.record(report('123'));
    t.archived = true;
    await scheduleBadgeSync(asThread(t));
    await vi.advanceTimersByTimeAsync(10);
    expect(pending()).toEqual({});
    expect((await StoredReport.get('123'))?.data.assigneeId).toBeNull();
  });

  it('retries on a later sweep when the assignee could not be read', async () => {
    const t = fakeThread('113', '🟠 Crash (9)', ASSIGNED);
    initTitleSync(clientFor([t]));
    t.fetchStarterMessage.mockRejectedValueOnce(new Error('down'));
    await scheduleBadgeSync(asThread(t));
    await vi.advanceTimersByTimeAsync(61_000);
    expect(t.name).toBe('🟠 Crash (9)');
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(t.name).toBe('🦊 🟠 Crash (9)');
  });

  it('keeps the refresh when a foreground rename fails', async () => {
    const t = fakeThread('115', '🟠 Crash (9)', ASSIGNED);
    await scheduleBadgeSync(asThread(t));
    t.setName.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 503 }));
    await setThreadStatusEmoji(asThread(t), 'waiting-for-dev');
    await vi.advanceTimersByTimeAsync(61_000);
    expect(t.name).toBe('🦊 🟠 Crash (9)');
  });

  it('retries a transient worker rename failure but gives up on a permanent one', async () => {
    const a = fakeThread('116', '🟠 A (9)', ASSIGNED);
    const b = fakeThread('117', '🟠 B (9)', ASSIGNED);
    initTitleSync(clientFor([a, b]));
    a.setName.mockRejectedValueOnce(Object.assign(new Error('503'), { status: 503 }));
    b.setName.mockRejectedValueOnce(Object.assign(new Error('perms'), { status: 403, code: 50013 }));
    await scheduleBadgeSync(asThread(a));
    await scheduleBadgeSync(asThread(b));
    await vi.advanceTimersByTimeAsync(61_000);
    expect(Object.keys(pending())).toEqual(['116']);
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(a.name).toBe('🦊 🟠 A (9)');
    expect(b.setName).toHaveBeenCalledTimes(1);
  });

  it('queues a refresh when a status change could not resolve the badge', async () => {
    const t = fakeThread('118', '🔵 Crash (9)', ASSIGNED);
    t.fetchStarterMessage.mockRejectedValueOnce(new Error('down'));
    await setThreadStatusEmoji(asThread(t), 'waiting-for-dev');
    expect(t.name).toBe('🔴 Crash (9)');
    await vi.advanceTimersByTimeAsync(61_000);
    expect(t.name).toBe('🦊 🔴 Crash (9)');
  });

  it('rechecks revision and archive state after waiting for the lock', async () => {
    const t = fakeThread('119', '🟠 Crash (9)', ASSIGNED);
    const u = fakeThread('120', '🟠 Crash (9)', ASSIGNED);
    await StoredReport.record(report('120', { tagNames: ['CLOSED'] }));
    await scheduleBadgeSync(asThread(t));
    await scheduleBadgeSync(asThread(u));
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const held = [withThreadLock('119', () => gate), withThreadLock('120', () => gate)];
    await vi.advanceTimersByTimeAsync(61_000);
    await scheduleBadgeSync(asThread(t));
    u.archived = true;
    release();
    await Promise.all(held);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(t.setName).not.toHaveBeenCalled();
    expect(u.setName).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(t.name).toBe('🦊 🟠 Crash (9)');
  });

  it('keeps a newer status persisted while the worker applies an older one', async () => {
    const t = fakeThread('121', '🟠 Crash (9)');
    t.setName.mockRejectedValueOnce({ timeToReset: 5_000 });
    await setThreadStatusEmoji(asThread(t), 'waiting-for-user');
    let finish!: () => void;
    t.setName.mockImplementationOnce(next => new Promise<void>(r => { finish = () => { t.name = next; r(); }; }));
    await vi.advanceTimersByTimeAsync(7_000);
    t.setName.mockRejectedValueOnce({ timeToReset: 5_000 });
    const newer = setThreadStatusEmoji(asThread(t), 'waiting-for-dev');
    finish();
    await newer;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(t.name).toBe('🔴 Crash (9)');
    expect(pending()).toEqual({});
  });

  it('forgets pending work for deleted threads', async () => {
    h.ns('title-sync').set('pending', JSON.stringify({ 122: { badge: { dueAt: 0, rev: 'r' } } }));
    initTitleSync({ channels: { fetch: async () => { throw Object.assign(new Error('gone'), { code: 10003 }); } } } as unknown as Client);
    await vi.advanceTimersByTimeAsync(10);
    expect(pending()).toEqual({});
  });

  it('spends no rename when the badge already matches', async () => {
    const t = fakeThread('114', '🟠 Crash without suffix');
    await scheduleBadgeSync(asThread(t));
    await vi.advanceTimersByTimeAsync(61_000);
    expect(t.setName).not.toHaveBeenCalled();
  });

  it('does not displace a rate-limited close', async () => {
    const close = vi.fn(async (t: ThreadChannel) => { (t as { archived: boolean }).archived = true; });
    setReportCloseHandler(close);
    const t = fakeThread('106', '🦊 🟠 Crash (9)', ASSIGNED);
    t.setName.mockRejectedValueOnce({ timeToReset: 15_000 });
    expect(await setThreadStatusAndClose(asThread(t), 'closed')).toBe(true);
    await scheduleBadgeSync(asThread(t));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.name).toBe('🔵 Crash (9)');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('staggers a backfill and tolerates an unreachable thread', async () => {
    const a = fakeThread('107', '🟠 A (9)', ASSIGNED);
    const b = fakeThread('108', '🟠 B (9)', ASSIGNED);
    let down = true;
    const z = fakeThread('0', '🟠 Z (9)', ASSIGNED);
    initTitleSync(clientFor([a, b, z], id => id === '0' && down));
    await scheduleBadgeBackfill(['107', '0', '108']);
    await vi.advanceTimersByTimeAsync(500);
    expect([a.name, b.name]).toEqual(['🦊 🟠 A (9)', '🟠 B (9)']);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(b.name).toBe('🦊 🟠 B (9)');
    expect(Object.keys(pending())).toEqual(['0']);
    down = false;
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(z.name).toBe('🦊 🟠 Z (9)');
  });

  it('resumes persisted work, including pre-upgrade entries, after a restart', async () => {
    h.ns('title-sync').set('pending', JSON.stringify({ 109: { badge: { dueAt: Date.now() + 30_000, rev: 'r' } }, 110: { status: 'waiting-for-dev' } }));
    const a = fakeThread('109', '🟠 A (9)', ASSIGNED);
    const b = fakeThread('110', '🟠 B (9)', ASSIGNED);
    initTitleSync(clientFor([a, b]));
    await vi.advanceTimersByTimeAsync(1_000);
    expect([a.name, b.name]).toEqual(['🟠 A (9)', '🦊 🔴 B (9)']);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(a.name).toBe('🦊 🟠 A (9)');
    expect(pending()).toEqual({});
  });
});

describe('assignee helpers', () => {
  it('writes a field that parses back to the same user', () => {
    expect(assigneeIdFromFields([assigneeField('42')])).toBe('42');
  });

  it('looks up a claimed emoji by user', async () => {
    expect(await badgeForAssignee('42')).toBeNull();
    await claimAssigneeEmoji('42', '🦊');
    expect(await badgeForAssignee('42')).toBe('🦊');
  });
});
