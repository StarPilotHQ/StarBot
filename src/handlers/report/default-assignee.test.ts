import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Guild } from 'discord.js';

const backing = vi.hoisted(() => new Map<string, unknown>());
const warn = vi.hoisted(() => vi.fn());
vi.mock('../../store.js', () => ({
  createStore: () => ({
    get: async (k: string) => backing.get(k),
    set: async (k: string, v: unknown) => { backing.set(k, v); },
    delete: async (k: string) => backing.delete(k),
  }),
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn, error: () => {}, info: () => {}, debug: () => {} }),
}));
vi.mock('../../config.js', () => ({ loadConfig: () => ({ staffRole: 'staff' }) }));

import { clearDefaultAssignee, getDefaultAssigneeId, resolveDefaultAssignee, setDefaultAssigneeId } from './default-assignee.js';

function guildWith(fetch: (id: string) => Promise<unknown>) {
  const spy = vi.fn(fetch);
  return { guild: { members: { fetch: spy } } as unknown as Guild, spy };
}
const member = (roles: string[]) => ({ id: '42', user: { username: 'alex' }, roles: { cache: new Map(roles.map(r => [r, r])) } });

beforeEach(() => { backing.clear(); warn.mockClear(); });

describe('default assignee', () => {
  it('round-trips and reports whether clear removed anything', async () => {
    expect(await getDefaultAssigneeId()).toBeNull();
    expect(await clearDefaultAssignee()).toBe(false);
    await setDefaultAssigneeId('42');
    expect(await getDefaultAssigneeId()).toBe('42');
    expect(await clearDefaultAssignee()).toBe(true);
    expect(await getDefaultAssigneeId()).toBeNull();
  });

  it('does not fetch members when unset', async () => {
    const { guild, spy } = guildWith(async () => member(['staff']));
    expect(await resolveDefaultAssignee(guild)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('resolves a staff member', async () => {
    await setDefaultAssigneeId('42');
    const { guild } = guildWith(async () => member(['staff']));
    expect(await resolveDefaultAssignee(guild)).toEqual({ userId: '42', username: 'alex' });
  });

  it.each([
    ['left the guild', async () => { throw new Error('Unknown Member'); }],
    ['lost the staff role', async () => member([])],
  ])('is null but keeps the setting when the member %s', async (_, fetch) => {
    await setDefaultAssigneeId('42');
    expect(await resolveDefaultAssignee(guildWith(fetch).guild)).toBeNull();
    expect(await getDefaultAssigneeId()).toBe('42');
  });

  it('is null and warns when the config store fails', async () => {
    const get = vi.spyOn(backing, 'get').mockImplementation(() => { throw new Error('down'); });
    expect(await resolveDefaultAssignee(guildWith(async () => member(['staff'])).guild)).toBeNull();
    get.mockRestore();
    expect(warn).toHaveBeenCalledOnce();
  });
});
