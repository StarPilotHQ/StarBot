import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForumChannel } from 'discord.js';

const backing = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../../store.js', () => ({
  createStore: () => ({
    get: async (k: string) => backing.get(k),
    set: async (k: string, v: unknown) => { backing.set(k, v); },
    delete: async (k: string) => backing.delete(k),
  }),
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }),
}));

import { withAssigneeTags } from './assignee-tags.js';

const ALEX = { userId: '42', username: 'alex' };

function forumWith(names: string[], setAvailableTags = vi.fn()) {
  return {
    availableTags: names.map(name => ({ id: name, name, moderated: false, emoji: null })),
    setAvailableTags,
  } as unknown as ForumChannel;
}

beforeEach(() => backing.clear());

describe('withAssigneeTags', () => {
  const forum = forumWith(['ASSIGNED', 'Assignee alex']);

  it('keeps the named tag and drops ASSIGNED when only one slot is left', async () => {
    expect(await withAssigneeTags(forum, ['a', 'b', 'c', 'd'], ALEX)).toEqual(['a', 'b', 'c', 'd', 'Assignee alex']);
  });

  it('adds both tags when they fit', async () => {
    expect(await withAssigneeTags(forum, ['a', 'b', 'c'], ALEX)).toEqual(['a', 'b', 'c', 'Assignee alex', 'ASSIGNED']);
  });

  it('leaves a full tag list alone', async () => {
    expect(await withAssigneeTags(forum, ['a', 'b', 'c', 'd', 'e'], ALEX)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('falls back to ASSIGNED when the named tag cannot be created', async () => {
    const rejecting = forumWith(['ASSIGNED'], vi.fn(async () => { throw new Error('20 tag limit'); }));
    expect(await withAssigneeTags(rejecting, ['a', 'b'], ALEX)).toEqual(['a', 'b', 'ASSIGNED']);
  });

  it('survives a tag store failure', async () => {
    const get = vi.spyOn(backing, 'get').mockImplementation(() => { throw new Error('down'); });
    expect(await withAssigneeTags(forum, ['a', 'b'], ALEX)).toEqual(['a', 'b', 'ASSIGNED']);
    get.mockRestore();
  });

  it('does not create a tag that cannot fit', async () => {
    const create = vi.fn();
    await withAssigneeTags(forumWith([], create), ['a', 'b', 'c', 'd', 'e'], ALEX);
    expect(create).not.toHaveBeenCalled();
  });

  it('shortens long usernames to a distinct tag of at most 20 characters', async () => {
    const created: string[] = [];
    const forum = forumWith([], vi.fn(async (tags: { name: string }[]) => {
      const name = tags.at(-1)!.name;
      created.push(name);
      return { availableTags: [{ id: name, name }] };
    }));
    await withAssigneeTags(forum, [], { userId: '100000000000001111', username: 'averylongusername_a' });
    await withAssigneeTags(forum, [], { userId: '100000000000002222', username: 'averylongusername_b' });
    expect(created).toEqual(['Assignee averyl~1111', 'Assignee averyl~2222']);
    expect(created.every(n => n.length <= 20)).toBe(true);
  });
});
