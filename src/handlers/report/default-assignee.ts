import type { Guild } from 'discord.js';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { strictConfigStore } from '../../runtime-config.js';
import type { Assignee } from './assignee-tags.js';

const log = createLogger('default-assignee');

const CONFIG_KEY = 'default-assignee';

export async function getDefaultAssigneeId(): Promise<string | null> {
  return ((await strictConfigStore.get(CONFIG_KEY)) as string | undefined) ?? null;
}

export async function setDefaultAssigneeId(userId: string): Promise<void> {
  await strictConfigStore.set(CONFIG_KEY, userId);
}

export async function clearDefaultAssignee(): Promise<boolean> {
  const wasSet = (await getDefaultAssigneeId()) !== null;
  await strictConfigStore.delete(CONFIG_KEY);
  return wasSet;
}

export async function resolveDefaultAssignee(guild: Guild): Promise<Assignee | null> {
  try {
    const userId = await getDefaultAssigneeId();
    if (!userId) return null;
    const member = await guild.members.fetch(userId);
    if (!member.roles.cache.has(loadConfig().staffRole)) {
      log.warn({ userId }, 'Default assignee no longer has the staff role');
      return null;
    }
    return { userId, username: member.user.username };
  } catch (err) {
    log.warn({ err }, 'Could not resolve default assignee');
    return null;
  }
}
