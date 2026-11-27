import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client, ForumChannel, ThreadChannel } from 'discord.js';

const backing: Record<string, Record<string, unknown>> = {};

vi.mock('../../config.js', () => ({
  loadConfig: vi.fn(() => ({ forumChannelId: 'forum-1' })),
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }),
}));
vi.mock('../../store.js', () => ({
  createStore: () => ({
    get: async (key: string) => backing[key],
    set: async (key: string, value: unknown) => { backing[key] = value as Record<string, unknown>; },
    delete: async (key: string) => { delete backing[key]; return true; },
  }),
}));
vi.mock('./route-tracker.js', () => ({
  getForum: vi.fn(),
}));
vi.mock('./freeze-state.js', () => ({
  isFrozen: vi.fn(),
}));
let pollTip: (commit: CommitTip) => Promise<void>;
vi.mock('./commit-watcher.js', () => ({
  onBranchTip: (fn: typeof pollTip) => { pollTip = fn; },
}));

import { getForum } from './route-tracker.js';
import { isFrozen } from './freeze-state.js';
import {
  initCommitWatches,
  watchCommit,
  cancelCommitWatch,
  readCommitWaits,
  shouldFireWait,
  setCommitWaitFinalizer,
  firePendingCommitWaits,
  type CommitWaitEntry,
} from './uat-wait.js';
import type { CommitTip } from './commit-watcher.js';

const mockForum = vi.mocked(getForum);
const mockFrozen = vi.mocked(isFrozen);
let finalizerFn: ReturnType<typeof vi.fn>;

const COMMIT: CommitTip = { sha: 'a'.repeat(40), short: 'aaaaaaa', date: '2026-08-26T12:00:00Z', branch: 'testing', repo: 'owner/main' };
const BASELINE = 'b'.repeat(40);

function entry(overrides: Partial<CommitWaitEntry> = {}): CommitWaitEntry {
  return {
    msgId: 'msg-1',
    ticketId: '42',
    baselineSha: BASELINE,
    thresholdDate: '2026-08-25T09:47:00Z',
    submitterId: 'user-1',
    audience: 'sub',
    staffMessage: '',
    ...overrides,
  };
}

function threadMock(overrides: { archived?: boolean; locked?: boolean } = {}) {
  return {
    id: 'thread-1',
    isThread: () => true,
    guild: {},
    archived: false,
    locked: false,
    ...overrides,
    messages: {
      fetch: vi.fn(async () => ({ delete: vi.fn(async () => {}) })),
    },
  } as unknown as ThreadChannel;
}

function clientMock(thread: ThreadChannel | null): Client {
  return {
    channels: { fetch: vi.fn(async () => thread) },
  } as unknown as Client;
}

const DELAY_MS = 15 * 60 * 1000;

async function pollAfterDelay(commit: CommitTip): Promise<void> {
  await pollTip(commit);
  vi.setSystemTime(Date.now() + DELAY_MS);
  await pollTip(commit);
}

beforeEach(() => {
  for (const key of Object.keys(backing)) delete backing[key];
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.clearAllMocks();
  mockForum.mockResolvedValue({ id: 'forum-1' } as unknown as ForumChannel);
  mockFrozen.mockResolvedValue(false);
  finalizerFn = vi.fn(async () => {});
  setCommitWaitFinalizer(finalizerFn);
});

afterEach(() => vi.useRealTimers());

describe('shouldFireWait', () => {
  it('fires when the tip moves off the baseline sha, regardless of date', () => {
    // A rebased/cherry-picked fix carries an older date but is a new push.
    expect(shouldFireWait(entry(), { ...COMMIT, date: '2026-08-20T00:00:00Z' })).toBe(true);
  });

  it('does not fire while the tip is still the baseline sha, regardless of date', () => {
    expect(shouldFireWait(entry(), { ...COMMIT, sha: BASELINE, short: 'bbbbbbb', date: '2026-08-27T00:00:00Z' })).toBe(false);
  });

  it('falls back to the threshold date when no baseline was observed', () => {
    const noBaseline = entry({ baselineSha: undefined });
    expect(shouldFireWait(noBaseline, COMMIT)).toBe(true);
    expect(shouldFireWait(noBaseline, { ...COMMIT, date: '2026-08-25T09:47:00Z' })).toBe(false);
  });
});

describe('branch tip activation', () => {
  it('waits 15 minutes across a restart, then activates with the current tip', async () => {
    const thread = threadMock();
    initCommitWatches(clientMock(thread));
    await watchCommit('thread-1', entry());

    await pollTip(COMMIT);
    const due = Date.now() + DELAY_MS;
    expect((await readCommitWaits())['thread-1'].notifyAfter).toBe(due);
    expect(finalizerFn).not.toHaveBeenCalled();

    const laterCommit = { ...COMMIT, sha: 'c'.repeat(40), short: 'ccccccc' };
    vi.setSystemTime(due - 1);
    initCommitWatches(clientMock(thread));
    await pollTip(laterCommit);
    expect(finalizerFn).not.toHaveBeenCalled();
    expect(thread.messages.fetch).not.toHaveBeenCalled();

    vi.setSystemTime(due);
    await pollTip(laterCommit);

    expect(finalizerFn).toHaveBeenCalledTimes(1);
    const [activatedThread, forum, e, commit] = finalizerFn.mock.calls[0];
    expect(activatedThread.id).toBe('thread-1');
    expect(forum).toEqual({ id: 'forum-1' });
    expect(e.ticketId).toBe('42');
    expect(commit).toEqual(laterCommit);
    expect(thread.messages.fetch).toHaveBeenCalledWith('msg-1');
    expect(Object.keys(await readCommitWaits())).toHaveLength(0);
  });

  it('leaves entries whose fire condition is not met', async () => {
    initCommitWatches(clientMock(threadMock()));
    await watchCommit('thread-1', entry({ baselineSha: COMMIT.sha }));

    await pollAfterDelay(COMMIT);

    expect(finalizerFn).not.toHaveBeenCalled();
    expect(Object.keys(await readCommitWaits())).toEqual(['thread-1']);
  });

  it('drops the watch when the thread is gone', async () => {
    initCommitWatches(clientMock(null));
    await watchCommit('thread-1', entry());

    await pollAfterDelay(COMMIT);

    expect(Object.keys(await readCommitWaits())).toHaveLength(0);
  });

  it('drops the watch instead of resurrecting an archived thread', async () => {
    initCommitWatches(clientMock(threadMock({ archived: true })));
    await watchCommit('thread-1', entry());

    await pollAfterDelay(COMMIT);

    expect(finalizerFn).not.toHaveBeenCalled();
    expect(Object.keys(await readCommitWaits())).toHaveLength(0);
  });

  it('drops the watch instead of posting into a locked thread', async () => {
    initCommitWatches(clientMock(threadMock({ locked: true })));
    await watchCommit('thread-1', entry());

    await pollAfterDelay(COMMIT);

    expect(finalizerFn).not.toHaveBeenCalled();
    expect(Object.keys(await readCommitWaits())).toHaveLength(0);
  });

  it('does not activate an entry cancelled by a superseding staff action', async () => {
    initCommitWatches(clientMock(threadMock()));
    await watchCommit('thread-1', entry());
    await pollTip(COMMIT);
    await cancelCommitWatch('thread-1');

    vi.setSystemTime(Date.now() + DELAY_MS);
    await pollTip(COMMIT);

    expect(finalizerFn).not.toHaveBeenCalled();
    expect(Object.keys(await readCommitWaits())).toHaveLength(0);
  });

  it('restores the entry for retry when activation fails', async () => {
    initCommitWatches(clientMock(threadMock()));
    finalizerFn.mockRejectedValue(new Error('discord blew up'));
    await watchCommit('thread-1', entry());

    await pollAfterDelay(COMMIT);

    expect(Object.keys(await readCommitWaits())).toEqual(['thread-1']);
  });
});

describe('freeze deferral', () => {
  it('stores the commit on the entry and fires it on thaw', async () => {
    mockFrozen.mockResolvedValue(true);
    initCommitWatches(clientMock(threadMock()));
    await watchCommit('thread-1', entry());

    await pollAfterDelay(COMMIT);

    const stored = (await readCommitWaits())['thread-1'];
    expect(stored?.pendingCommit).toMatchObject({ sha: COMMIT.sha });

    mockFrozen.mockResolvedValue(false);
    await firePendingCommitWaits();

    expect(finalizerFn).toHaveBeenCalledTimes(1);
    expect(Object.keys(await readCommitWaits())).toHaveLength(0);
  });

  it('keeps pendingCommit on a failed post-thaw retry so it is not stranded', async () => {
    // seed the store directly, bypassing the module's mutate chain
    backing['pending'] = { 'thread-1': entry({ pendingCommit: COMMIT }) };
    finalizerFn.mockRejectedValue(new Error('discord blew up'));
    // initCommitWatches' boot recovery replays deferred entries (same code
    // path thaw uses); the failure must restore the entry with its marker.
    initCommitWatches(clientMock(threadMock()));
    await new Promise(resolve => setImmediate(resolve));

    expect(finalizerFn).toHaveBeenCalledTimes(1);
    const restored = (await readCommitWaits())['thread-1'];
    expect(restored?.pendingCommit).toMatchObject({ sha: COMMIT.sha });
  });
});
