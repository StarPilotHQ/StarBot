import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { PermissionFlagsBits } from 'discord.js';
import { MetadataStorage } from 'discordx';

vi.mock('../../store.js', () => ({ createStore: () => ({ get: async () => undefined, set: async () => {}, delete: async () => true }) }));
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

import './report-actions.js';
import './default-assignee-command.js';

it('registers default-assignee as a group inside report-actions', async () => {
  await MetadataStorage.instance.build();
  const commands = MetadataStorage.instance.applicationCommandSlashes;
  const root = commands.filter(c => c.name === 'report-actions');
  expect(root).toHaveLength(1);
  expect(commands.some(c => c.name === 'default-assignee')).toBe(false);
  const json = await root[0].toJSON() as { defaultMemberPermissions?: unknown; options?: { name: string; options?: { name: string }[] }[] };
  expect(json.options?.map(o => o.name)).toEqual(expect.arrayContaining(['update-thread', 'staff-actions', 'assignee-emoji', 'default-assignee']));
  expect(json.options?.find(o => o.name === 'default-assignee')?.options?.map(o => o.name).sort()).toEqual(['clear', 'set', 'show']);
  expect(json.defaultMemberPermissions).toBe(PermissionFlagsBits.ManageThreads);

  const routed = MetadataStorage.instance.applicationCommandSlashesFlat
    .filter(c => c.group === 'report-actions' && c.subgroup === 'default-assignee');
  expect(Object.fromEntries(routed.map(c => [c.name, c.key]))).toEqual({ set: 'set', clear: 'clear', show: 'show' });
  expect(root[0].guilds).toEqual(['g']);
});

it('is loaded by the entrypoint', () => {
  const entrypoint = readFileSync(new URL('../../index.ts', import.meta.url), 'utf8');
  expect(entrypoint).toMatch(/^import '\.\/handlers\/report\/default-assignee-command\.js';$/m);
});
