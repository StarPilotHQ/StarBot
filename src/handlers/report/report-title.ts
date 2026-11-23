export type ReportStatus = 'new' | 'fix-incoming' | 'waiting-for-dev' | 'waiting-for-user' | 'resolved' | 'closed' | 'snoozed';

export const STATUS_EMOJI: Record<ReportStatus, string> = {
  'new': '🟠',
  'fix-incoming': '⚪',
  'waiting-for-dev': '🔴',
  'waiting-for-user': '🟣',
  'resolved': '🟢',
  'closed': '🔵',
  'snoozed': '💤',
};

const LEGACY_TYPE_EMOJIS = ['🐛', '💬', '✨'];
const KNOWN_TITLE_EMOJIS = [...Object.values(STATUS_EMOJI), ...LEGACY_TYPE_EMOJIS];
export const RESERVED_TITLE_EMOJIS = [...KNOWN_TITLE_EMOJIS, '✂️'];

const SINGLE_EMOJI_RE = new RegExp('^\\p{RGI_Emoji}$', 'v');

export function isSingleEmoji(text: string): boolean {
  return SINGLE_EMOJI_RE.test(text);
}

export interface BadgedTitle {
  badge: string | null;
  body: string;
}

export function splitBadge(name: string): BadgedTitle {
  const space = name.indexOf(' ');
  if (space < 0) return { badge: null, body: name };
  const badge = name.slice(0, space);
  const body = name.slice(space + 1);
  if (RESERVED_TITLE_EMOJIS.includes(badge) || !isSingleEmoji(badge) || !statusOfBody(body)) {
    return { badge: null, body: name };
  }
  return { badge, body };
}

export function joinBadge(badge: string | null, body: string): string {
  return badge ? `${badge} ${body}` : body;
}

function statusOfBody(body: string): ReportStatus | null {
  const entry = Object.entries(STATUS_EMOJI).find(([, emoji]) => body.startsWith(emoji));
  return entry ? entry[0] as ReportStatus : null;
}

export function statusFromTitle(name: string): ReportStatus | null {
  return statusOfBody(splitBadge(name).body);
}

export function stripLeadingEmoji(name: string): string {
  const { body } = splitBadge(name);
  for (const e of KNOWN_TITLE_EMOJIS) {
    if (body.startsWith(e)) return body.slice(e.length);
  }
  return body;
}

export function statusShowsBadge(status: ReportStatus): boolean {
  return status !== 'resolved' && status !== 'closed';
}
