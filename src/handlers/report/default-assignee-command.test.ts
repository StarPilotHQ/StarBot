import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GuildMember, PermissionFlagsBits, PermissionsBitField, type CommandInteraction, type User } from 'discord.js';

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
vi.mock('../../config.js', () => ({ loadConfig: () => ({ guildId: 'g', staffRole: 'staff' }) }));

import { DefaultAssigneeCommands } from './default-assignee-command.js';
import { getDefaultAssigneeId, setDefaultAssigneeId } from './default-assignee.js';

const commands = new DefaultAssigneeCommands();
const USER = { id: '42' } as User;

function invocation({ admin = true, targetIsStaff = true } = {}) {
  const member = Object.create(GuildMember.prototype);
  Object.defineProperty(member, 'permissions', {
    value: new PermissionsBitField(admin ? PermissionFlagsBits.ManageGuild : 0n),
  });
  const replies: string[] = [];
  const say = async (o: { content: string }) => { replies.push(o.content); };
  const interaction = {
    member,
    user: { id: 'admin' },
    guild: { members: { fetch: async () => ({ user: { username: 'alex' }, roles: { cache: new Map(targetIsStaff ? [['staff', 1]] : []) } }) } },
    reply: say, editReply: say, deferReply: async () => {},
  } as unknown as CommandInteraction;
  return { interaction, replies };
}

beforeEach(() => backing.clear());

describe('/report-actions default-assignee', () => {
  it('refuses non-admins without writing', async () => {
    await setDefaultAssigneeId('7');
    const t = invocation({ admin: false });
    await commands.set(USER, t.interaction);
    await commands.clear(t.interaction);
    await commands.show(t.interaction);
    expect(t.replies).toEqual(Array(3).fill('Only admins can manage the default assignee.'));
    expect(await getDefaultAssigneeId()).toBe('7');
  });

  it('refuses a target without the staff role', async () => {
    const t = invocation({ targetIsStaff: false });
    await commands.set(USER, t.interaction);
    expect(t.replies[0]).toContain("doesn't have the staff role");
    expect(await getDefaultAssigneeId()).toBeNull();
  });

  it('stores a staff target', async () => {
    const t = invocation();
    await commands.set(USER, t.interaction);
    expect(await getDefaultAssigneeId()).toBe('42');
    expect(t.replies[0]).toContain('<@42>');
  });

  it('clears the default, and says so when there is none', async () => {
    const t = invocation();
    await commands.clear(t.interaction);
    expect(t.replies[0]).toBe('No default assignee is set.');
    await setDefaultAssigneeId('42');
    await commands.clear(t.interaction);
    expect(await getDefaultAssigneeId()).toBeNull();
  });

  it('shows the current default and flags one that no longer resolves', async () => {
    const ok = invocation();
    await commands.show(ok.interaction);
    expect(ok.replies[0]).toBe('No default assignee is set.');
    await setDefaultAssigneeId('42');
    await commands.show(ok.interaction);
    expect(ok.replies[1]).toContain('<@42>');
    expect(ok.replies[1]).not.toContain('unassigned');
    const stale = invocation({ targetIsStaff: false });
    await commands.show(stale.interaction);
    expect(stale.replies[0]).toContain('unassigned');
  });

  it.each(['set', 'delete'] as const)('reports a failed %s instead of claiming success', async op => {
    if (op === 'delete') await setDefaultAssigneeId('42');
    const broken = vi.spyOn(backing, op).mockImplementation(() => { throw new Error('disk full'); });
    const t = invocation();
    if (op === 'set') await commands.set(USER, t.interaction);
    else await commands.clear(t.interaction);
    broken.mockRestore();
    expect(t.replies).toEqual(['Could not save the default assignee. Try again.']);
  });

  it.each(['clear', 'show'] as const)('does not call the default unset when %s cannot read it', async command => {
    await setDefaultAssigneeId('42');
    const broken = vi.spyOn(backing, 'get').mockImplementation(() => { throw new Error('down'); });
    const t = invocation();
    await commands[command](t.interaction);
    broken.mockRestore();
    expect(t.replies).toEqual([command === 'clear'
      ? 'Could not save the default assignee. Try again.'
      : 'Could not read the default assignee. Try again.']);
    expect(await getDefaultAssigneeId()).toBe('42');
  });
});
