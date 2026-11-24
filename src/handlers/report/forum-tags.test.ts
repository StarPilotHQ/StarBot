import { describe, expect, it, vi } from 'vitest';
import type { ForumChannel } from 'discord.js';

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }),
}));

import { ensureForumTag } from './forum-tags.js';

type Tag = { id?: string; name: string; moderated?: boolean; emoji?: unknown };

function fakeForum() {
  const forum = {
    id: 'f',
    availableTags: [] as Tag[],
    setAvailableTags: vi.fn(async (tags: Tag[]) => {
      await Promise.resolve();
      forum.availableTags = tags.map(t => ({ ...t, id: t.id ?? `id:${t.name}` }));
      return forum;
    }),
  };
  return forum;
}

describe('ensureForumTag', () => {
  it('keeps both tags when two are created at once', async () => {
    const forum = fakeForum();
    await Promise.all([
      ensureForumTag(forum as unknown as ForumChannel, 'A'),
      ensureForumTag(forum as unknown as ForumChannel, 'B'),
    ]);
    expect(forum.availableTags.map(t => t.name)).toEqual(['A', 'B']);
  });

  it('creates a tag once when requested twice at once', async () => {
    const forum = fakeForum();
    await Promise.all(['A', 'A'].map(n => ensureForumTag(forum as unknown as ForumChannel, n)));
    expect(forum.setAvailableTags).toHaveBeenCalledTimes(1);
  });

  it('returns the forum unchanged, and keeps working, after a failure', async () => {
    const forum = fakeForum();
    forum.setAvailableTags.mockRejectedValueOnce(new Error('limit'));
    expect(await ensureForumTag(forum as unknown as ForumChannel, 'A')).toBe(forum);
    expect(forum.availableTags).toEqual([]);
    await ensureForumTag(forum as unknown as ForumChannel, 'B');
    expect(forum.availableTags.map(t => t.name)).toEqual(['B']);
  });

  it('does not wait behind another tag creation when the tag exists', async () => {
    const forum = fakeForum();
    forum.availableTags = [{ id: 'id:A', name: 'A' }];
    let release!: () => void;
    forum.setAvailableTags.mockImplementationOnce(() => new Promise(r => { release = () => r(forum); }));
    const slow = ensureForumTag(forum as unknown as ForumChannel, 'B');
    const result = await Promise.race([
      ensureForumTag(forum as unknown as ForumChannel, 'A'),
      new Promise(r => setTimeout(() => r('waited'), 20)),
    ]);
    release();
    await slow;
    expect(result).toBe(forum);
  });

  it('falls back to the given forum when the edit returns no channel', async () => {
    const forum = fakeForum();
    forum.setAvailableTags.mockResolvedValueOnce(undefined as never);
    expect(await ensureForumTag(forum as unknown as ForumChannel, 'A')).toBe(forum);
  });
});
