import { Collection, type ForumChannel, type ThreadChannel } from 'discord.js';
import { describe, expect, it, vi } from 'vitest';

const { finalize } = vi.hoisted(() => ({ finalize: vi.fn() }));
vi.mock('./report-actions.js', () => ({ finalizeWaitUser: finalize }));
vi.mock('./report-service.js', () => ({ submitReport: vi.fn() }));
vi.mock('./title-sync.js', () => ({ withThreadLock: vi.fn() }));
import { sendReferralRouteRequest } from './companion-referral.js';

describe('route request on handoff', () => {
  it('uses the normal reporter-only route action once, including after a lost acknowledgement', async () => {
    const messages = new Collection<string, {author: {id: string}; embeds: {description: string}[]}>();
    messages.set('123', {author: {id: 'bot'}, embeds: []});
    const thread = {id: '123', client: {user: {id: 'bot'}}, messages: {fetch: async () => messages}} as unknown as ThreadChannel;
    const forum = {} as ForumChannel;
    finalize.mockImplementationOnce(async (_thread, _forum, params) => {
      messages.set('124', {author: {id: 'bot'}, embeds: [{description: params.message + '\n\nClick Send Route.'}]});
      throw Error('receipt lost');
    });
    await expect(sendReferralRouteRequest(thread, forum, 'original', 'ticket')).rejects.toThrow('receipt lost');
    await sendReferralRouteRequest(thread, forum, 'original', 'ticket');
    expect(finalize).toHaveBeenCalledExactlyOnceWith(thread, forum, expect.objectContaining({
      mode: 'route', audience: 'sub', submitterId: 'original', ticketId: 'ticket',
    }));
  });
});
