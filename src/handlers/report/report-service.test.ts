import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EmbedBuilder, type ButtonInteraction, type ModalSubmitInteraction } from 'discord.js';
import { moveCompanionReport, type CompanionSource } from './companion-referral.js';

const h = vi.hoisted(() => ({
  stores: new Map<string, Map<string, unknown>>(),
  failing: new Set<string>(),
}));
vi.mock('../../store.js', () => ({
  createStore: (name: string) => {
    if (!h.stores.has(name)) h.stores.set(name, new Map());
    const m = h.stores.get(name)!;
    return {
      get: async (k: string) => {
        if (h.failing.has(name)) throw new Error('down');
        return m.get(k);
      },
      set: async (k: string, v: unknown) => { m.set(k, v); },
      delete: async (k: string) => m.delete(k),
    };
  },
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: () => {}, error: () => {}, info: () => {}, debug: () => {} }),
}));
vi.mock('../../config.js', () => ({
  loadConfig: () => ({ forumChannelId: 'forum', staffRole: 'staff', maxActiveReports: 0 }),
}));
vi.mock('../../wiki/links.js', () => ({ logHelpUrl: () => '' }));
vi.mock('../../wiki/wiki.js', () => ({ getIndex: () => null }));
vi.mock('../../wiki/searcher.js', () => ({ searchWiki: vi.fn(), formatWikiResults: vi.fn() }));
vi.mock('../../integrations/vikunja/sync.js', () => ({ queueVikunjaSync: vi.fn() }));
vi.mock('./route-tracker.js', () => ({
  getForum: async (guild: { forum: unknown }) => guild.forum,
  TRACKER_FIELD_PREFIX: 'tracker',
}));

import { submitReport, swapForumTags } from './report-service.js';
import { StoredReport } from './report-store.js';
import { ASSIGNEE_FIELD, assigneeField, claimAssigneeEmoji } from './assignee-badge.js';
import { withThreadLock } from './title-sync.js';
import { setDefaultAssigneeId } from './default-assignee.js';

const THREAD_ID = '1000000000000000042';
const TAGS = ['OPEN', 'BUG', 'WAITING FOR DEV', 'Priority 3', 'ASSIGNED', 'Assignee alex'];

function setup(staff = true) {
  let starterEmbed = new EmbedBuilder();
  let raced: string | null = null;
  let suppressed = false;
  const starter = {
    get embeds() { return suppressed ? [] : [starterEmbed.toJSON()]; },
    edit: vi.fn(async (_: { embeds: EmbedBuilder[] }) => {}),
    pin: vi.fn(async () => {}),
  };
  const thread = {
    id: THREAD_ID, name: '', url: 'https://thread', createdTimestamp: 1,
    fetchStarterMessage: vi.fn(async (_?: { force: boolean }) => starter),
    send: vi.fn(async () => {}),
    setName: vi.fn(),
    setAppliedTags: vi.fn(),
    members: { add: vi.fn(async (_: string) => {}) },
  };
  const create = vi.fn(async (opts: { name: string; message: { embeds: EmbedBuilder[] }; appliedTags: string[] }) => {
    thread.name = opts.name;
    starterEmbed = EmbedBuilder.from(opts.message.embeds[0].toJSON());
    if (raced) starterEmbed.setFields([assigneeField(raced)]);
    return thread;
  });
  const forum = {
    availableTags: TAGS.map(name => ({ id: `id:${name}`, name, moderated: false, emoji: null })),
    threads: { create },
  };
  const editReply = vi.fn(async (_: { content: string }) => {});
  const interaction = {
    guild: {
      forum,
      members: { fetch: async () => ({ user: { username: 'alex' }, roles: { cache: new Map(staff ? [['staff', 1]] : []) } }) },
      commands: { fetch: async () => ({ find: () => undefined }) },
    },
    user: { id: 'reporter' },
    editReply,
  } as unknown as ModalSubmitInteraction;
  const submit = (title: string | null = 'Crash', label = 'Bug Report', tagNames = ['OPEN', 'BUG', 'WAITING FOR DEV']) => submitReport(interaction, {
    embed: new EmbedBuilder().setDescription('x'),
    title: Promise.resolve(title),
    wikiQuery: '',
    additionalRoutes: [],
    label,
    tagNames,
    reporterId: 'reporter',
  });
  const reassignTo = (id: string | null) => {
    starterEmbed.setFields(id ? [assigneeField(id)] : []);
  };
  const assignAtCreation = (id: string) => { raced = id; };
  const suppressEmbeds = () => { suppressed = true; };
  const created = () => create.mock.calls[0][0];
  const finalFields = () => starter.edit.mock.calls.at(-1)![0].embeds[0].toJSON().fields ?? [];
  return { thread, starter, submit, reassignTo, assignAtCreation, suppressEmbeds, created, finalFields, editReply, create, interaction };
}

const assigneeFields = (fields: { name: string; value: string }[]) => fields.filter(f => f.name === ASSIGNEE_FIELD);

describe('staff referrals from Companion', () => {
  function fixture() {
    const t = setup();
    const guildId = '1000000000000000001';
    const source = { guildId, forumId: 'companion', threadId: 'source', reporterId: 'original-reporter',
      title: 'Brakes late', publicDescription: 'Brakes late at a turn' };
    const interaction = { ...t.interaction, guildId, channelId: 'review', user: { id: 'staff' } } as ButtonInteraction;
    let attempted = false;
    const finishMove = vi.fn(async (_source: CompanionSource, _url: string) => {});
    const ports = {
      guildId, reviewThreadId: 'review', companionForumId: 'companion',
      loadSource: async () => source, isStaff: async (id: string) => id === 'staff',
      getAttempt: async () => attempted, markAttempt: async () => { attempted = true; },
      findReadyTicket: async () => {
        const stored = await StoredReport.get(THREAD_ID);
        const payload = t.starter.edit.mock.lastCall?.[0] as
          { components?: { toJSON(): { components: { custom_id?: string }[] } }[] } | undefined;
        const buttons = payload?.components?.[0]?.toJSON().components;
        return stored?.reporterId === source.reporterId && buttons?.some(b => b.custom_id === 'staff_actions_' + stored.data.ticketId)
          ? stored.url : undefined;
      }, requestRouteOnce: vi.fn(async (_source: CompanionSource, _url: string) => {}), finishMove,
    };
    const move = () => moveCompanionReport(interaction, source.threadId, ports);
    return { t, ports, finishMove, move };
  }

  it('keeps the reporter and native staff controls on a route-less ticket across simultaneous clicks', async () => {
    const { t, move, finishMove } = fixture();
    expect(await Promise.all([move(), move()])).toEqual(['https://thread', 'https://thread']);
    expect(t.create).toHaveBeenCalledTimes(1);
    expect(t.created().message.embeds[0].data.fields).toContainEqual({ name: 'Route', value: 'Not provided' });
    expect(finishMove).toHaveBeenCalledWith(expect.objectContaining({ reporterId: 'original-reporter' }), 'https://thread');
  });

  it('recovers an interrupted source close using the existing ticket', async () => {
    const { t, move, finishMove } = fixture();
    finishMove.mockRejectedValueOnce(new Error('temporary failure'));
    await expect(move()).rejects.toThrow('temporary failure');
    expect(await move()).toBe('https://thread');
    expect(t.create).toHaveBeenCalledTimes(1);
  });

  it('retries a failed route request in the existing driving ticket before closing the source', async () => {
    const { t, ports, move, finishMove } = fixture();
    ports.requestRouteOnce.mockRejectedValueOnce(new Error('send failed'));
    await expect(move()).rejects.toThrow('send failed');
    expect(finishMove).not.toHaveBeenCalled();
    await move();
    expect(t.create).toHaveBeenCalledTimes(1);
    expect(finishMove).toHaveBeenCalledOnce();
  });

  it('leaves the source open if native staff controls never arrive, including on retry', async () => {
    const { t, move, finishMove } = fixture();
    t.thread.fetchStarterMessage.mockRejectedValue(new Error('unavailable'));
    await expect(move()).rejects.toThrow();
    await expect(move()).rejects.toThrow('reconciliation');
    expect(t.create).toHaveBeenCalledTimes(1);
    expect(finishMove).not.toHaveBeenCalled();
  });

  it('rejects unauthorized users and wrong review channels before creating a ticket', async () => {
    const { t, ports, move } = fixture();
    ports.reviewThreadId = 'wrong';
    await expect(move()).rejects.toThrow('staff access');
    ports.reviewThreadId = 'review';
    ports.isStaff = async () => false;
    await expect(move()).rejects.toThrow('staff access');
    expect(t.create).not.toHaveBeenCalled();
  });
});

beforeEach(() => {
  for (const m of h.stores.values()) m.clear();
  h.failing.clear();
});

describe('submitReport with a default assignee', () => {
  it('creates the thread already assigned, without renames or tag edits', async () => {
    await setDefaultAssigneeId('42');
    await claimAssigneeEmoji('42', '🦊');
    const t = setup();
    await t.submit();

    expect(t.created().name).toBe('🦊 🟠 3️⃣ Bug Report - Crash');
    expect(t.created().appliedTags).toEqual(['id:OPEN', 'id:BUG', 'id:WAITING FOR DEV', 'id:Priority 3', 'id:Assignee alex']);
    expect(assigneeFields(t.finalFields())).toEqual([assigneeField('42')]);
    const stored = (await StoredReport.get(THREAD_ID))!.data;
    expect(stored.assigneeId).toBe('42');
    expect(stored.tagNames).toEqual(['OPEN', 'BUG', 'WAITING FOR DEV', 'Priority 3', 'Assignee alex']);
    expect(t.thread.members.add).toHaveBeenCalledWith('42');
    expect(t.thread.setName).not.toHaveBeenCalled();
    expect(JSON.stringify([...h.stores].filter(([n]) => n.includes('title')).map(([, m]) => [...m.values()]))).not.toContain(THREAD_ID);
    expect(t.thread.setAppliedTags).not.toHaveBeenCalled();
  });

  it('carries the assignee field in the creation message', async () => {
    await setDefaultAssigneeId('42');
    const t = setup();
    t.thread.fetchStarterMessage.mockImplementation(async () => null as never);
    await t.submit();
    expect(assigneeFields(t.created().message.embeds[0].toJSON().fields ?? [])).toEqual([assigneeField('42')]);
  });

  it('leaves reports unassigned when no default is set', async () => {
    const t = setup();
    await t.submit();
    expect(t.created().name).toBe('🟠 3️⃣ Bug Report - Crash');
    expect(assigneeFields(t.finalFields())).toEqual([]);
    expect((await StoredReport.get(THREAD_ID))!.data.assigneeId).toBeNull();
    expect(t.thread.members.add).not.toHaveBeenCalled();
  });

  it('still assigns when the badge store fails', async () => {
    await setDefaultAssigneeId('42');
    h.failing.add('assignee-emojis');
    const t = setup();
    await t.submit();
    expect(t.created().name).toBe('🟠 3️⃣ Bug Report - Crash');
    expect((await StoredReport.get(THREAD_ID))!.data.assigneeId).toBe('42');
  });

  it('keeps a badged title within 100 characters', async () => {
    await setDefaultAssigneeId('42');
    await claimAssigneeEmoji('42', '🦊');
    const t = setup();
    await t.submit('x'.repeat(100));
    expect(t.created().name.startsWith('🦊 🟠 3️⃣ Bug Report - xxx')).toBe(true);
    expect(t.created().name.length).toBeLessThanOrEqual(100);
  });

  it.each([['99', [assigneeField('99')]], [null, []]])('keeps a mid-submission reassignment to %s', async (id, expected) => {
    await setDefaultAssigneeId('42');
    const t = setup();
    t.thread.members.add.mockImplementation(async () => { t.reassignTo(id); });
    await t.submit();
    expect(assigneeFields(t.finalFields())).toEqual(expected);
  });

  it('succeeds when the assignee cannot be added to the thread', async () => {
    await setDefaultAssigneeId('42');
    const t = setup();
    t.thread.members.add.mockRejectedValue(new Error('nope'));
    await t.submit();
    expect(t.editReply.mock.calls.at(-1)![0].content).toContain('submitted!');
  });

  it('reads the starter fresh before rewriting it, falling back to the cached one', async () => {
    await setDefaultAssigneeId('42');
    const t = setup();
    t.thread.fetchStarterMessage.mockRejectedValueOnce(new Error('down'));
    await t.submit();
    expect(t.thread.fetchStarterMessage).toHaveBeenNthCalledWith(1, { force: true });
    expect(assigneeFields(t.finalFields())).toEqual([assigneeField('42')]);
  });

  it('stores an assignment that landed before the report was recorded', async () => {
    await setDefaultAssigneeId('42');
    const t = setup();
    t.assignAtCreation('99');
    await t.submit();
    expect((await StoredReport.get(THREAD_ID))!.data.assigneeId).toBe('99');
  });

  it('waits for an in-flight assignment before rewriting the starter', async () => {
    await setDefaultAssigneeId('42');
    const t = setup();
    let release!: () => void;
    const held = withThreadLock(`assignee:${THREAD_ID}`, () => new Promise<void>(r => { release = r; }));
    const submitted = t.submit();
    await new Promise(r => setTimeout(r, 20));
    expect(t.starter.edit).not.toHaveBeenCalled();
    t.reassignTo('99');
    release();
    await Promise.all([held, submitted]);
    expect(assigneeFields(t.finalFields())).toEqual([assigneeField('99')]);
  });

  it('keeps the assignee when the live starter has no embeds', async () => {
    await setDefaultAssigneeId('42');
    const t = setup();
    t.suppressEmbeds();
    await t.submit();
    expect(assigneeFields(t.finalFields())).toEqual([assigneeField('42')]);
  });

  it('fits both assignee tags on feedback', async () => {
    await setDefaultAssigneeId('42');
    const t = setup();
    await t.submit('Nice', 'Feedback', ['OPEN', 'WAITING FOR DEV']);
    expect(t.created().appliedTags).toEqual(['id:OPEN', 'id:WAITING FOR DEV', 'id:Assignee alex', 'id:ASSIGNED']);
  });

  it('creates an unassigned report when the default lost the staff role', async () => {
    await setDefaultAssigneeId('42');
    const t = setup(false);
    await t.submit();
    expect(t.editReply.mock.calls.at(-1)![0].content).toContain('submitted!');
    expect((await StoredReport.get(THREAD_ID))!.data.assigneeId).toBeNull();
    expect(assigneeFields(t.finalFields())).toEqual([]);
  });
});

describe('swapForumTags', () => {
  it('drops ASSIGNED when adding a tag would exceed the limit', async () => {
    const names = ['OPEN', 'FEEDBACK', 'WAITING FOR DEV', 'Assignee alex', 'ASSIGNED'];
    const thread = { appliedTags: names, setAppliedTags: vi.fn(async () => {}) };
    const forum = { availableTags: [...names, 'Priority 1'].map(name => ({ id: name, name })) };
    await swapForumTags(thread as never, forum as never, { add: ['Priority 1'] });
    expect(thread.setAppliedTags).toHaveBeenCalledWith(['OPEN', 'FEEDBACK', 'WAITING FOR DEV', 'Assignee alex', 'Priority 1']);
  });
});
