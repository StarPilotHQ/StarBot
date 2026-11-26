import { EmbedBuilder, type ButtonInteraction } from 'discord.js';
import { submitReport } from './report-service.js';
import { withThreadLock } from './title-sync.js';
import type { ForumChannel, ThreadChannel } from 'discord.js';

const routeRequest = 'This report was moved from Companion Support. Please use **Send Route** to share the drive where the issue happened.';

export async function sendReferralRouteRequest(thread: ThreadChannel, forum: ForumChannel, reporterId: string, ticketId: string) {
  const messages = await thread.messages.fetch({ limit: 50 });
  if (messages.some(message => message.author.id === thread.client.user?.id &&
    message.embeds.some(embed => embed.description?.startsWith(routeRequest)))) return;
  // If the starter is out of view, absence of the prompt is inconclusive.
  if (!messages.has(thread.id)) throw new Error('Check the driving thread before repeating its route request.');
  const { finalizeWaitUser } = await import('./report-actions.js');
  await finalizeWaitUser(thread, forum, {
    mode: 'route', audience: 'sub', message: routeRequest, submitterId: reporterId, ticketId,
  });
}

export interface CompanionSource {
  guildId: string;
  forumId: string;
  threadId: string;
  reporterId: string;
  title: string;
  publicDescription: string;
}

export interface ReferralPorts {
  guildId: string;
  reviewThreadId: string;
  companionForumId: string;
  // Load the public report and reporter from Companion's own record.
  loadSource(threadId: string): Promise<CompanionSource>;
  isStaff(userId: string): Promise<boolean>;
  getAttempt(threadId: string): Promise<boolean>;
  markAttempt(threadId: string): Promise<void>;
  // Verify StarBot ownership, original source, stored ticket and live staff controls.
  findReadyTicket(source: CompanionSource): Promise<string | undefined>;
  requestRouteOnce(source: CompanionSource, destination: string): Promise<void>;
  // Must be idempotent for the source/destination pair.
  finishMove(source: CompanionSource, destination: string): Promise<void>;
}

// Local integration candidate. Wire only to a StarBot-owned staff interaction.
export async function moveCompanionReport(interaction: ButtonInteraction, threadId: string, ports: ReferralPorts) {
  if (!interaction.guildId || interaction.guildId !== ports.guildId ||
      interaction.channelId !== ports.reviewThreadId || !(await ports.isStaff(interaction.user.id))) {
    throw new Error('This action requires staff access in the review thread.');
  }
  return withThreadLock('companion-referral:' + threadId, async () => {
    const source = await ports.loadSource(threadId);
    if (source.guildId !== ports.guildId || source.forumId !== ports.companionForumId || source.threadId !== threadId)
      throw new Error('Invalid Companion report.');
    let destination = await ports.findReadyTicket(source);
    if (!destination) {
      if (await ports.getAttempt(threadId)) throw new Error('Previous move needs reconciliation.');
      await ports.markAttempt(threadId);
      const link = 'https://discord.com/channels/' + source.guildId + '/' + threadId;
      await submitReport(interaction, {
        reporterId: source.reporterId, label: 'Bug Report',
        title: Promise.resolve(source.title), wikiQuery: source.publicDescription,
        additionalRoutes: [], tagNames: ['OPEN', 'BUG', 'WAITING FOR DEV'],
        embed: new EmbedBuilder().setDescription(source.publicDescription.slice(0, 4096))
          .addFields({ name: 'By', value: '<@' + source.reporterId + '>' },
                     { name: 'Companion report', value: link }, { name: 'Route', value: 'Not provided' }),
      });
      destination = await ports.findReadyTicket(source);
    }
    if (!destination) throw new Error('Driving ticket and controls could not be confirmed.');
    await ports.requestRouteOnce(source, destination);
    await ports.finishMove(source, destination);
    return destination;
  });
}
