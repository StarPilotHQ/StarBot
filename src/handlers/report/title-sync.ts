import { randomUUID } from 'node:crypto';
import type { Client, ThreadChannel } from 'discord.js';
import { RESTJSONErrorCodes } from 'discord.js';
import { createStore } from '../../store.js';
import { createLogger } from '../../logger.js';
import { stripPriorityEmoji } from './priority.js';
import { STATUS_EMOJI, joinBadge, splitBadge, statusFromTitle, statusShowsBadge, stripLeadingEmoji, type ReportStatus } from './report-title.js';
import { resolveBadge } from './assignee-badge.js';
import { StoredReport } from './report-store.js';

export { STATUS_EMOJI, stripLeadingEmoji, type ReportStatus };

const log = createLogger('title-sync');

const FALLBACK_RETRY_MS = 10 * 60 * 1000;
const NON_RATE_LIMIT_RETRY_MS = 60 * 1000;
const MAX_RATE_LIMIT_RETRIES = 10;
const BADGE_DEBOUNCE_MS = 60 * 1000;
const BADGE_BACKFILL_STAGGER_MS = 1_000;
const SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const TITLE_INDEX_KEY = 'pending';

// Stores the desired status, not a frozen title, so the worker recomputes against the
// thread's current name at fire time. `close` persists so a restart still closes in order.
interface PendingEntry {
  status?: ReportStatus;
  close?: boolean;
  rev?: string;
  badge?: { dueAt: number; rev: string };
}

const titleStore = createStore<Record<string, PendingEntry>>('title-sync');

const syncing = new Set<string>();
const rekick = new Set<string>();
let client: Client | null = null;
let sweepTimer: ReturnType<typeof setInterval> | null = null;

// Shared by applyTitle, syncWorker, and close-scheduler's timer so they can't race
// each other's thread renames against the 2-per-10-min sublimit. Hold it per REST
// attempt only, never across a retry sleep, or a rate-limit wait would stall closes.
const threadOps = new Map<string, Promise<unknown>>();

export function withThreadLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
  const prev = threadOps.get(threadId) ?? Promise.resolve();
  const run = prev.then(() => fn(), () => fn());
  const tail = run.then(() => undefined, () => undefined);
  threadOps.set(threadId, tail);
  void tail.then(() => { if (threadOps.get(threadId) === tail) threadOps.delete(threadId); });
  return run;
}

// Report close is owned by report-actions; it's injected here so the deferred
// worker (and restart recovery) can finalize a close without an import cycle.
let closeHandler: ((thread: ThreadChannel) => Promise<void>) | null = null;

export function setReportCloseHandler(fn: (thread: ThreadChannel) => Promise<void>): void {
  closeHandler = fn;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const MAX_TITLE_LEN = 100;

/** Surrogate-safe truncation with a trailing ellipsis (thread titles cap at 100 chars). */
export function truncateTitle(name: string, max: number): string {
  if (name.length <= max) return name;
  let cut = name.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + '…';
}

const REPORT_LABELS = ['Bug Report', 'Feedback', 'Feature Request'];
const FIRST_LABEL_SPLIT_RE = new RegExp(`^(.*?(?:${REPORT_LABELS.join('|')}) - )(.*)$`);
const TRAILING_TICKET_ID_RE = /\s*\((\d+)\)\s*$/;

export interface ReportTitleParts {
  prefix: string;
  title: string;
  suffix: string;
}

export function splitReportTitle(currentName: string, ticketId: string): ReportTitleParts {
  const suffix = ` (${ticketId})`;
  const trailingId = currentName.match(TRAILING_TICKET_ID_RE);
  const body = trailingId?.[1] === ticketId ? currentName.slice(0, trailingId.index) : currentName;

  const labelled = body.match(FIRST_LABEL_SPLIT_RE);
  if (labelled) return { prefix: labelled[1], title: labelled[2], suffix };

  const { badge, body: unbadged } = splitBadge(body);
  const stripped = stripLeadingEmoji(unbadged);
  const emoji = joinBadge(badge, unbadged.slice(0, unbadged.length - stripped.length));
  // Keep any priority emoji in the prefix so renames never treat it as title text.
  const noPriority = stripPriorityEmoji(stripped);
  const priorityPart = stripped.slice(0, stripped.length - noPriority.length);
  return { prefix: emoji + priorityPart + (noPriority.startsWith(' ') ? ' ' : ''), title: noPriority.trimStart(), suffix };
}

export function maxRenameLength(parts: ReportTitleParts): number {
  return Math.max(1, MAX_TITLE_LEN - parts.prefix.length - parts.suffix.length);
}

export function composeReportTitle(parts: ReportTitleParts, newTitle: string): string {
  const title = truncateTitle(newTitle.trim(), maxRenameLength(parts));
  return `${parts.prefix}${title}${parts.suffix}`;
}

function ticketIdFor(thread: ThreadChannel): string {
  return String(parseInt(thread.id.slice(-7), 10));
}

export function computeStatusTitle(
  currentName: string,
  status: ReportStatus,
  ticketId: string,
  badge: string | null | undefined = splitBadge(currentName).badge,
): string {
  let base = stripLeadingEmoji(currentName);
  if (base.startsWith(' ')) base = base.slice(1);
  const title = joinBadge(statusShowsBadge(status) ? badge : null, `${STATUS_EMOJI[status]} ${base}`);
  // Creation omits the (id) suffix to save a rename; add it on the first status change.
  return fitTitle(TICKET_SUFFIX_RE.test(title) ? title : `${title} (${ticketId})`);
}

const TICKET_SUFFIX_RE = /\s*\(\d+\)\s*$/;

export function fitTitle(title: string): string {
  const suffix = title.match(TICKET_SUFFIX_RE)?.[0] ?? '';
  const head = title.slice(0, title.length - suffix.length);
  return `${truncateTitle(head, MAX_TITLE_LEN - suffix.length)}${suffix}`;
}

export function applyBadge(name: string, ticketId: string, badge: string | null | undefined): string {
  const status = statusFromTitle(name);
  if (!status || badge === undefined) return name;
  const shown = statusShowsBadge(status) ? badge : null;
  if (splitBadge(name).badge === shown) return name;
  return computeStatusTitle(name, status, ticketId, badge);
}

export async function withCurrentBadge(thread: ThreadChannel, name: string): Promise<string> {
  return applyBadge(name, ticketIdFor(thread), await resolveBadge(thread));
}

async function desiredTitle(thread: ThreadChannel, status: ReportStatus | undefined): Promise<{ name: string; badgeKnown: boolean }> {
  const effective = status ?? statusFromTitle(thread.name);
  const badge = effective && !statusShowsBadge(effective) ? null : await resolveBadge(thread);
  const name = status
    ? computeStatusTitle(thread.name, status, ticketIdFor(thread), badge)
    : applyBadge(thread.name, ticketIdFor(thread), badge);
  return { name, badgeKnown: badge !== undefined };
}

// A rate-limit rejection (discord.js RateLimitError) carries `timeToReset` and
// no Discord error `code`; that's the only failure we retry. Everything else
// (missing perms, invalid name, unknown channel, network) is non-retryable.
export function isRateLimit(err: unknown): boolean {
  return err != null && typeof err === 'object'
    && 'timeToReset' in err && typeof (err as { timeToReset?: unknown }).timeToReset === 'number';
}

function isTransientRenameError(err: unknown): boolean {
  const { code, status } = (err ?? {}) as { code?: unknown; status?: unknown };
  if (typeof status === 'number' && status >= 500) return true;
  return typeof code !== 'number' || code === RESTJSONErrorCodes.InvalidActionOnArchivedThread;
}

// Thread-name edits hit a 2-per-10-min sublimit whose true wait is in `retryAfter`
// / `sublimitTimeout`, NOT `timeToReset` (the ~15s general-bucket reset). Honoring
// only timeToReset retries every ~20s and burns MAX_RATE_LIMIT_RETRIES before the
// sublimit clears, abandoning the rename - so take the largest wait Discord gives.
export function retryDelay(err: unknown): number {
  if (err != null && typeof err === 'object') {
    const e = err as { timeToReset?: number; retryAfter?: number; sublimitTimeout?: number };
    const wait = Math.max(e.retryAfter ?? 0, e.sublimitTimeout ?? 0, e.timeToReset ?? 0);
    if (wait > 0) return wait + 1_000;
  }
  return FALLBACK_RETRY_MS;
}

// Serialize read-modify-write on the shared index so concurrent status changes
// on different threads can't lose each other's entry (last-write-wins).
let indexChain: Promise<unknown> = Promise.resolve();

async function readIndex(): Promise<Record<string, PendingEntry>> {
  return (await titleStore.get(TITLE_INDEX_KEY)) ?? {};
}

function mutateIndex<T>(fn: (index: Record<string, PendingEntry>) => T): Promise<T> {
  const run = indexChain.then(async () => {
    const index = await readIndex();
    const result = fn(index);
    await titleStore.set(TITLE_INDEX_KEY, index);
    return result;
  });
  indexChain = run.then(() => undefined, () => undefined);
  return run;
}

function persistStatus(threadId: string, status: ReportStatus, close: boolean): Promise<void> {
  return mutateIndex(index => {
    index[threadId] = { ...index[threadId], status, close, rev: randomUUID() };
  });
}

function settleEntry(threadId: string, seen: PendingEntry | undefined, done: { status?: boolean; badge?: boolean; retryBadge?: boolean }): Promise<void> {
  return mutateIndex(index => {
    const entry = index[threadId];
    if (!entry) {
      if (done.retryBadge) requestBadgeRefresh(index, threadId, Date.now() + BADGE_DEBOUNCE_MS);
      return;
    }
    if (done.status && entry.rev === seen?.rev) {
      delete entry.status;
      delete entry.close;
      delete entry.rev;
    }
    if (done.badge && entry.badge?.rev === seen?.badge?.rev) delete entry.badge;
    if (done.retryBadge && !entry.badge) requestBadgeRefresh(index, threadId, Date.now() + BADGE_DEBOUNCE_MS);
    if (!entry.status && !index[threadId].badge) delete index[threadId];
  });
}

async function readEntry(threadId: string): Promise<PendingEntry | undefined> {
  return (await readIndex())[threadId];
}

async function runClose(thread: ThreadChannel): Promise<void> {
  if (!closeHandler) {
    log.error({ threadId: thread.id }, 'no close handler registered; cannot finalize close');
    return;
  }
  await closeHandler(thread);
}

// Rename before close so a rename never fires on an already-archived thread.
// Returns true when deferred to the background worker (rate-limited).
async function applyTitle(thread: ThreadChannel, status: ReportStatus, close: boolean): Promise<boolean> {
  return withThreadLock(thread.id, async () => {
    const pending = await readEntry(thread.id);
    const { name: desired, badgeKnown } = await desiredTitle(thread, status);
    let renamed = true;

    if (thread.name !== desired) {
      try {
        await thread.setName(desired);
      } catch (err) {
        if (isRateLimit(err)) {
          await persistStatus(thread.id, status, close);
          kickWorker(thread);
          return true;
        }
        renamed = false;
        log.warn({ err, threadId: thread.id }, 'title rename failed (non-rate-limit); leaving title unchanged');
      }
    }

    if (close) {
      try {
        await runClose(thread);
      } catch (err) {
        if (isRateLimit(err)) {
          await persistStatus(thread.id, status, true);
          kickWorker(thread);
          return true;
        }
        log.warn({ err, threadId: thread.id }, 'close failed (non-rate-limit); abandoning');
      }
    }

    await settleEntry(thread.id, pending, { status: true, badge: badgeKnown && renamed, retryBadge: !badgeKnown });
    if (!badgeKnown) kickWorker(thread);
    return false;
  });
}

// Fire-and-forget the worker without ever rejecting: an unhandled rejection
// crashes the whole bot (see process.on('unhandledRejection') in index.ts).
function kickWorker(thread: ThreadChannel): void {
  void syncWorker(thread).catch(err => log.warn({ err, threadId: thread.id }, 'title sync worker crashed'));
}

// On non-rate-limit errors, logs and gives up - once past the first attempt
// there's nothing actionable to surface to the user.
async function syncWorker(thread: ThreadChannel): Promise<void> {
  if (syncing.has(thread.id)) {
    rekick.add(thread.id);
    return;
  }
  syncing.add(thread.id);
  try {
    let rateLimitRetries = 0;
    for (;;) {
      const entry = await readEntry(thread.id);
      if (!entry) break;

      // If a pending close already landed (thread archived) but we crashed before
      // clearing it, treat it as done - re-editing would unarchive a closed report.
      if (entry.close && thread.archived) {
        await settleEntry(thread.id, entry, { status: true, badge: true });
        continue;
      }

      if (!entry.status && thread.archived) {
        const report = await StoredReport.get(thread.id);
        if (report?.isActive && report.category !== 'Snoozed') {
          const { name, badgeKnown } = await desiredTitle(thread, undefined);
          if (!badgeKnown || name !== thread.name) break;
        }
        await settleEntry(thread.id, entry, { badge: true });
        continue;
      }

      const wait = entry.status ? 0 : (entry.badge?.dueAt ?? 0) - Date.now();
      if (wait > 0) {
        await sleep(wait);
        continue;
      }

      let badgeKnown = true;
      let retryRename = false;
      let ran = false;
      try {
        await withThreadLock(thread.id, async () => {
          const current = await readEntry(thread.id);
          if (current?.rev !== entry.rev || current?.badge?.rev !== entry.badge?.rev) return;
          if (!entry.status && thread.archived) return;
          ran = true;
          const desired = await desiredTitle(thread, entry.status);
          badgeKnown = desired.badgeKnown;
          if (thread.name !== desired.name) {
            try {
              await thread.setName(desired.name);
            } catch (err) {
              if (isRateLimit(err)) throw err;
              retryRename = isTransientRenameError(err);
              log.warn({ err, threadId: thread.id }, 'deferred rename failed (non-rate-limit); leaving title unchanged');
            }
          }
          if (entry.close) await runClose(thread);
        });
        if (!ran) continue;
        rateLimitRetries = 0;
      } catch (err) {
        if (isRateLimit(err)) {
          if (++rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
            log.warn({ threadId: thread.id, rateLimitRetries }, 'title sync exhausted rate-limit retries; abandoning');
            await settleEntry(thread.id, entry, { status: true, badge: true });
            break;
          }
          const retryIn = retryDelay(err);
          log.warn({ err, threadId: thread.id, waitMs: retryIn, rateLimitRetries }, 'title sync deferred (rate limit); will retry');
          await sleep(retryIn);
          continue;
        }
        log.warn({ err, threadId: thread.id }, 'deferred title sync failed (non-rate-limit); abandoning');
      }

      const badgeDone = badgeKnown && !(retryRename && entry.badge);
      await settleEntry(thread.id, entry, { status: true, badge: badgeDone, retryBadge: !badgeKnown });
      if (!badgeDone) break;
    }
  } finally {
    syncing.delete(thread.id);
    if (rekick.delete(thread.id)) kickWorker(thread);
  }
}

export async function setThreadStatusEmoji(thread: ThreadChannel, status: ReportStatus): Promise<void> {
  await applyTitle(thread, status, false);
}

// Returns true if deferred (rate limited) - caller should tell the user it may take a moment.
export function setThreadStatusAndClose(thread: ThreadChannel, status: ReportStatus): Promise<boolean> {
  return applyTitle(thread, status, true);
}

export async function tryStatusClose(
  thread: ThreadChannel,
  status: ReportStatus,
): Promise<{ done: true } | { done: false; retryMs: number; rateLimited: boolean }> {
  try {
    const { name: desired } = await desiredTitle(thread, status);
    if (thread.name !== desired) {
      try {
        await thread.setName(desired);
      } catch (err) {
        if (isRateLimit(err)) throw err;
        log.warn({ err, threadId: thread.id }, 'scheduled close rename failed (non-rate-limit); closing without it');
      }
    }
    await runClose(thread);
    return { done: true };
  } catch (err) {
    if (isRateLimit(err)) return { done: false, retryMs: retryDelay(err), rateLimited: true };
    log.warn({ err, threadId: thread.id }, 'scheduled close failed (non-rate-limit); will retry');
    return { done: false, retryMs: NON_RATE_LIMIT_RETRY_MS, rateLimited: false };
  }
}

function requestBadgeRefresh(index: Record<string, PendingEntry>, threadId: string, dueAt: number): void {
  index[threadId] = { ...index[threadId], badge: { dueAt, rev: randomUUID() } };
}

export async function scheduleBadgeSync(thread: ThreadChannel): Promise<void> {
  const notBefore = Date.now() + BADGE_DEBOUNCE_MS;
  await mutateIndex(index => requestBadgeRefresh(index, thread.id, notBefore));
  kickWorker(thread);
}

export async function scheduleBadgeBackfill(threadIds: string[]): Promise<void> {
  const start = Date.now();
  await mutateIndex(index => {
    threadIds.forEach((id, i) => requestBadgeRefresh(index, id, start + i * BADGE_BACKFILL_STAGGER_MS));
  });
  void sweepPending();
}

export function initTitleSync(c: Client): void {
  client = c;
  void sweepPending();
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = setInterval(() => { void sweepPending(); }, SWEEP_INTERVAL_MS).unref();
}

async function sweepPending(): Promise<void> {
  if (!client) return;
  try {
    const index = await readIndex();
    for (const threadId of Object.keys(index)) {
      if (syncing.has(threadId)) continue;
      try {
        const ch = await client.channels.fetch(threadId);
        if (ch?.isThread()) kickWorker(ch);
        else await settleEntry(threadId, index[threadId], { status: true, badge: true });
      } catch (err) {
        if ((err as { code?: unknown } | null)?.code === RESTJSONErrorCodes.UnknownChannel) {
          await settleEntry(threadId, index[threadId], { status: true, badge: true });
        } else {
          log.warn({ err, threadId }, 'could not fetch thread for pending title; will retry');
        }
      }
    }
  } catch (err) {
    log.warn({ err }, 'pending title sweep failed');
  }
}
