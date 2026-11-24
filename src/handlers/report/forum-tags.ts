import type { ForumChannel } from 'discord.js';
import { createLogger } from '../../logger.js';

const log = createLogger('forum-tags');

// setAvailableTags replaces the whole list, so concurrent writers would drop each other's tags.
let chain: Promise<unknown> = Promise.resolve();

function hasTag(forum: ForumChannel, name: string): boolean {
  return forum.availableTags.some(t => t.name === name);
}

/** Returns the forum with the tag present, creating it if missing. Best-effort. */
export function ensureForumTag(forum: ForumChannel, name: string): Promise<ForumChannel> {
  if (hasTag(forum, name)) return Promise.resolve(forum);
  const run = chain.then(async () => {
    if (hasTag(forum, name)) return forum;
    try {
      const updated: ForumChannel | undefined = await forum.setAvailableTags([
        ...forum.availableTags.map(t => ({ name: t.name, id: t.id, moderated: t.moderated, emoji: t.emoji ?? undefined })),
        { name },
      ]);
      return updated ?? forum;
    } catch (err) {
      log.warn({ err, name }, 'Failed to create forum tag');
      return forum;
    }
  });
  chain = run.then(() => undefined, () => undefined);
  return run;
}
