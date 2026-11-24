import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GuildMember, type ButtonInteraction, type EmbedBuilder } from 'discord.js';

const backing = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../../store.js', () => ({
  createStore: (name: string) => ({
    get: async (k: string) => backing.get(`${name}:${k}`),
    set: async (k: string, v: unknown) => { backing.set(`${name}:${k}`, v); },
    delete: async (k: string) => backing.delete(`${name}:${k}`),
  }),
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }),
}));
vi.mock('../../config.js', () => ({ loadConfig: () => ({ guildId: 'g', forumChannelId: 'forum', staffRole: 'staff' }) }));
vi.mock('../../wiki/links.js', () => ({ logHelpUrl: () => '', galaxyUpdateUrl: () => '' }));
vi.mock('../../wiki/wiki.js', () => ({ getIndex: () => null }));
vi.mock('../../wiki/searcher.js', () => ({ searchWiki: vi.fn(), formatWikiResults: vi.fn() }));
vi.mock('../../integrations/vikunja/sync.js', () => ({
  queueVikunjaSync: vi.fn(), queueVikunjaRelation: vi.fn(), queueVikunjaEmbedComment: vi.fn(),
}));

vi.mock('./route-tracker.js', async original => ({
  ...await original<typeof import('./route-tracker.js')>(),
  getForum: async (guild: { forum: unknown }) => guild.forum,
}));

import * as actions from './report-actions.js';
import { StoredReport } from './report-store.js';
import { TRACKER_FIELD_PREFIX } from './route-tracker.js';
import { ASSIGNEE_FIELD, assigneeField } from './assignee-badge.js';

const PARENT_ID = '1000000000000000001';
const SPLIT_ID = '1000000000000000002';
const { splitToThread } = Object.values(actions)
  .map(v => (v as { prototype?: { splitToThread?: (i: ButtonInteraction) => Promise<void> } }).prototype)
  .find(p => p?.splitToThread) as { splitToThread: (i: ButtonInteraction) => Promise<void> };

async function split(assigneeId: string | null, reassignedTo?: string) {
  await StoredReport.record({
    threadId: PARENT_ID, ticketId: '1', reporterId: '7', label: 'Bug Report', threadName: 'x', url: '',
    tagNames: ['OPEN'], createdTimestamp: 1, lastActivityAt: 1, assigneeId,
  });
  const starter = {
    url: 'https://parent', content: '<@7>', mentions: { users: new Map() }, edit: vi.fn(async (_: { embeds: EmbedBuilder[] }) => {}),
    embeds: [{ title: 'Bug', fields: [
      { name: 'x', value: `${TRACKER_FIELD_PREFIX}(https://tracker)` },
      ...(assigneeId ? [assigneeField(assigneeId)] : []),
    ] }],
  };
  const newThread = {
    id: SPLIT_ID, name: 'split', url: '', appliedTags: [], createdTimestamp: 1,
    fetchStarterMessage: async () => null,
    members: { add: vi.fn(async (_: string) => {}) },
  };
  const create = vi.fn(async (_: { message: { embeds: EmbedBuilder[] }; appliedTags: string[] }) => {
    if (reassignedTo) starter.embeds = [{ title: 'Bug', fields: [starter.embeds[0].fields[0], assigneeField(reassignedTo)] }];
    return newThread;
  });
  const forum = { availableTags: [], threads: { create } };
  const interaction = {
    member: Object.assign(Object.create(GuildMember.prototype), {}),
    channel: { id: PARENT_ID, name: '🟠 Bug', appliedTags: ['OPEN', 'Assignee alex'], isThread: () => true, fetchStarterMessage: async () => starter },
    guild: { id: 'g', forum },
    message: { embeds: [{ description: 'more' }], edit: async () => {} },
    deferUpdate: async () => {},
    reply: vi.fn(),
  };
  Object.defineProperty(interaction.member, 'roles', { value: { cache: new Map([['staff', 1]]) } });
  await splitToThread.call({}, interaction as unknown as ButtonInteraction);
  const fields = create.mock.calls[0][0].message.embeds[0].toJSON().fields ?? [];
  const parentFields = starter.edit.mock.calls[0][0].embeds[0].toJSON().fields ?? [];
  return { newThread, parentFields, tags: create.mock.calls[0][0].appliedTags, assignee: fields.filter(f => f.name === ASSIGNEE_FIELD), stored: (await StoredReport.get(SPLIT_ID))!.data.assigneeId };
}

beforeEach(() => backing.clear());

describe('splitting a report', () => {
  it('inherits the parent assignee', async () => {
    const r = await split('42');
    expect(r.assignee).toEqual([assigneeField('42')]);
    expect(r.stored).toBe('42');
    expect(r.tags).toEqual(['OPEN', 'Assignee alex']);
    expect(r.newThread.members.add).toHaveBeenCalledWith('42');
  });

  it('does not revert a parent reassigned during the split', async () => {
    const r = await split('42', '99');
    expect(r.parentFields.filter(f => f.name === ASSIGNEE_FIELD)).toEqual([assigneeField('99')]);
    expect(r.parentFields.some(f => f.name === '✂️ Split')).toBe(true);
  });

  it('stays unassigned when the parent is, even with a default set', async () => {
    backing.set('runtime-config:default-assignee', '99');
    const r = await split(null);
    expect(r.assignee).toEqual([]);
    expect(r.stored).toBeNull();
    expect(r.newThread.members.add).not.toHaveBeenCalled();
  });
});

describe('reassigning', () => {
  it('replaces the named tag on a bug within the 5 tag limit, from a fresh starter', async () => {
    const tag = (name: string) => ({ id: name, name, moderated: false, emoji: null });
    const base = ['OPEN', 'BUG', 'WAITING FOR DEV', 'Priority 3'];
    const forum = { availableTags: [...base, 'ASSIGNED', 'Assignee alex', 'Assignee sam'].map(tag) };
    const starter = { embeds: [{ fields: [assigneeField('42')] }], edit: vi.fn(async () => {}) };
    const thread = {
      id: PARENT_ID, name: '🟠 Bug', appliedTags: [...base, 'Assignee alex'],
      fetchStarterMessage: vi.fn(async () => starter),
      members: { add: async () => {} },
      setAppliedTags: vi.fn(async () => {}),
    };
    await actions.setReportAssignee(thread as never, { forum } as never, { userId: '43', username: 'sam' });
    expect(thread.setAppliedTags).toHaveBeenCalledWith([...base, 'Assignee sam']);
    expect(thread.fetchStarterMessage).toHaveBeenCalledWith({ force: true });
  });
});

describe('assign modal', () => {
  it('tells staff when the report cannot be read instead of throwing', async () => {
    const { handleAssignSubmit } = Object.values(actions)
      .map(v => (v as { prototype?: { handleAssignSubmit?: (i: unknown) => Promise<void> } }).prototype)
      .find(p => p?.handleAssignSubmit) as { handleAssignSubmit: (i: unknown) => Promise<void> };
    const member = Object.create(GuildMember.prototype);
    Object.defineProperty(member, 'roles', { value: { cache: new Map([['staff', 1]]) } });
    const editReply = vi.fn(async (_: { content: string }) => {});
    await handleAssignSubmit.call({}, {
      member, customId: 'assign_modal_1',
      channel: { id: PARENT_ID, isThread: () => true, fetchStarterMessage: async () => { throw new Error('503'); } },
      guild: { members: { fetch: async () => member } },
      fields: { getSelectedUsers: () => ({ first: () => ({ id: '43', username: 'sam' }) }) },
      isFromMessage: () => false, deferReply: async () => {}, reply: async () => {}, editReply,
    });
    expect(editReply.mock.calls.at(-1)![0].content).toContain('Could not update this report');
  });
});

describe('assigning while tags change', () => {
  it('keeps a tag swap that lands while the assignee tag is being created', async () => {
    const tag = (name: string) => ({ id: name, name, moderated: false, emoji: null });
    const thread = {
      id: PARENT_ID, name: '🟠 Bug', appliedTags: ['OPEN', 'WAITING FOR DEV'],
      fetchStarterMessage: async () => ({ embeds: [{ fields: [] }], edit: async () => {} }),
      members: { add: async () => {} },
      setAppliedTags: vi.fn(async () => {}),
    };
    const forum = {
      availableTags: ['OPEN', 'WAITING FOR DEV', 'WAITING FOR USER'].map(tag),
      setAvailableTags: async () => {
        thread.appliedTags = ['OPEN', 'WAITING FOR USER'];
        forum.availableTags.push(tag('Assignee sam'));
        return forum;
      },
    };
    await actions.setReportAssignee(thread as never, { forum } as never, { userId: '43', username: 'sam' });
    expect(thread.setAppliedTags).toHaveBeenCalledWith(['OPEN', 'WAITING FOR USER', 'Assignee sam']);
  });
});
