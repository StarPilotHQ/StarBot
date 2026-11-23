import { RESTJSONErrorCodes, type ThreadChannel } from 'discord.js';
import { createStore } from '../../store.js';
import { createLogger } from '../../logger.js';
import { PRIORITY_EMOJIS } from './priority.js';
import { RESERVED_TITLE_EMOJIS, isSingleEmoji } from './report-title.js';
import { StoredReport } from './report-store.js';

const log = createLogger('assignee-badge');

export const ASSIGNEE_FIELD = '👤 Assigned to';

const EMOJI_KEY = 'all';
const emojiStore = createStore<Record<string, string>>('assignee-emojis');

const VARIATION_SELECTOR = '️';

function canonicalEmoji(emoji: string): string {
  return emoji.replaceAll(VARIATION_SELECTOR, '');
}

const RESERVED = new Set([...RESERVED_TITLE_EMOJIS, ...Object.values(PRIORITY_EMOJIS)].map(canonicalEmoji));

export type EmojiParseResult = { ok: true; emoji: string } | { ok: false; reason: 'invalid' | 'reserved' };

export function parseAssigneeEmoji(input: string): EmojiParseResult {
  const text = input.trim();
  const emoji = [text, text + VARIATION_SELECTOR].find(isSingleEmoji);
  if (!emoji) return { ok: false, reason: 'invalid' };
  if (RESERVED.has(canonicalEmoji(emoji))) return { ok: false, reason: 'reserved' };
  return { ok: true, emoji };
}

let chain: Promise<unknown> = Promise.resolve();

function mutate<T>(fn: (emojis: Record<string, string>) => T): Promise<T> {
  const run = chain.then(async () => {
    const emojis = (await emojiStore.get(EMOJI_KEY)) ?? {};
    const result = fn(emojis);
    await emojiStore.set(EMOJI_KEY, emojis);
    return result;
  });
  chain = run.then(() => undefined, () => undefined);
  return run;
}

export function claimAssigneeEmoji(userId: string, emoji: string): Promise<string | null> {
  return mutate(emojis => {
    const holder = Object.keys(emojis).find(id => id !== userId && canonicalEmoji(emojis[id]) === canonicalEmoji(emoji));
    if (holder) return holder;
    emojis[userId] = emoji;
    return null;
  });
}

export function clearAssigneeEmoji(userId: string): Promise<boolean> {
  return mutate(emojis => {
    const had = userId in emojis;
    delete emojis[userId];
    return had;
  });
}

export function assigneeIdFromFields(fields: ReadonlyArray<{ name: string; value: string }> | undefined): string | null {
  return fields?.find(f => f.name === ASSIGNEE_FIELD)?.value.match(/<@!?(\d+)>/)?.[1] ?? null;
}

async function resolveAssigneeId(thread: ThreadChannel): Promise<string | null> {
  const stored = (await StoredReport.get(thread.id))?.data.assigneeId;
  if (stored !== undefined) return stored;
  const starter = await thread.fetchStarterMessage().catch(err => {
    if ((err as { code?: unknown } | null)?.code === RESTJSONErrorCodes.UnknownMessage) return null;
    throw err;
  });
  return StoredReport.seedAssignee(thread.id, assigneeIdFromFields(starter?.embeds[0]?.fields));
}

export async function resolveBadge(thread: ThreadChannel): Promise<string | null | undefined> {
  try {
    const assigneeId = await resolveAssigneeId(thread);
    if (!assigneeId) return null;
    return (await emojiStore.get(EMOJI_KEY))?.[assigneeId] ?? null;
  } catch (err) {
    log.warn({ err, threadId: thread.id }, 'Could not resolve assignee badge');
    return undefined;
  }
}

export async function reportsNeedingBadgeSync(userId: string): Promise<string[]> {
  const reports = await StoredReport.listAll();
  return reports
    .filter(r => r.isActive && r.category !== 'Snoozed')
    .filter(r => r.data.assigneeId === undefined || r.data.assigneeId === userId)
    .map(r => r.threadId);
}
