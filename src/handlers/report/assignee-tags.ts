import type { ForumChannel } from 'discord.js';
import { createLogger } from '../../logger.js';
import { createStore } from '../../store.js';
import { ensureForumTag } from './forum-tags.js';

const log = createLogger('assignee-tags');

const MAX_POST_TAGS = 5;
const MAX_TAG_NAME_LENGTH = 20;

export interface Assignee {
  userId: string;
  username: string;
}

const assigneeTagStore = createStore<string>('assignee-tags');

function assigneeTagName(userId: string, username: string): string {
  const full = `Assignee ${username}`;
  if (full.length <= MAX_TAG_NAME_LENGTH) return full;
  const suffix = `~${userId.slice(-4)}`;
  return full.slice(0, MAX_TAG_NAME_LENGTH - suffix.length) + suffix;
}

async function getOrCreateAssigneeTag(forum: ForumChannel, userId: string, username: string): Promise<string | null> {
  const cached = await assigneeTagStore.get(userId);
  if (cached) {
    if (forum.availableTags.some(t => t.id === cached)) return cached;
    await assigneeTagStore.delete(userId);
  }

  const tagName = assigneeTagName(userId, username);
  const tagged = await ensureForumTag(forum, tagName);
  const tag = tagged.availableTags.find(t => t.name === tagName);
  if (!tag) return null;
  await assigneeTagStore.set(userId, tag.id);
  return tag.id;
}

export function fitPostTags(forum: ForumChannel, tagIds: string[]): string[] {
  const unique = [...new Set(tagIds)];
  if (unique.length <= MAX_POST_TAGS) return unique;
  const assignedTagId = forum.availableTags.find(t => t.name === 'ASSIGNED')?.id;
  return unique.filter(id => id !== assignedTagId);
}

export function resolveAssigneeTagId(forum: ForumChannel, assignee: Assignee): Promise<string | null> {
  return getOrCreateAssigneeTag(forum, assignee.userId, assignee.username).catch(err => {
    log.warn({ err, userId: assignee.userId }, 'Could not resolve assignee tag');
    return null;
  });
}

export function addAssigneeTags(forum: ForumChannel, baseTagIds: string[], assigneeTagId: string | null): string[] {
  const assignedTagId = forum.availableTags.find(t => t.name === 'ASSIGNED')?.id;
  const extra = [assigneeTagId, assignedTagId].filter((id): id is string => id != null);
  return [...new Set([...baseTagIds, ...extra])].slice(0, MAX_POST_TAGS);
}

export async function withAssigneeTags(forum: ForumChannel, baseTagIds: string[], assignee: Assignee): Promise<string[]> {
  if (baseTagIds.length >= MAX_POST_TAGS) return baseTagIds;
  return addAssigneeTags(forum, baseTagIds, await resolveAssigneeTagId(forum, assignee));
}
