import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, EmbedBuilder, Events, MessageFlags,
  PermissionFlagsBits, type ButtonInteraction, type CommandInteraction, type Guild, type ThreadChannel } from 'discord.js';
import { ArgsOf, ButtonComponent, Discord, Guild as DiscordGuild, On, Slash } from 'discordx';
import { createStore } from '../../store.js';
import { createLogger } from '../../logger.js';
import { loadConfig } from '../../config.js';
import { StoredReport } from './report-store.js';
import { withThreadLock } from './title-sync.js';
import { moveCompanionReport, sendReferralRouteRequest, type CompanionSource } from './companion-referral.js';
import { isFrozen } from './freeze-state.js';

const log = createLogger('companion-handoff');
const publicForum = '1565235002734809168';
const reviewRoom = '1575000066366644244';
const companion = '1574857862872703088';
const guildId = () => loadConfig().guildId;
const enabled = () => guildId() === '1387432184121393333' && process.env.COMPANION_DRIVING_TRANSFERS !== 'off';
interface State { card?: string; attempted?: boolean; destination?: string; requested?: boolean; notice?: string; done?: boolean; left?: boolean }
const records = createStore<State>('companion-driving-transfer-v1', { throwOnErrors: true });
const read = async (id: string) => (await records.get(id)) ?? {};
const save = async (id: string, patch: Partial<State>) => records.set(id, { ...await read(id), ...patch });

export function parseOpener(text: string) {
  const m = /^Report from <@!?(\d{17,20})>[^\n]*\n(?:For <@!?\d{17,20}>\n)?Reference: [\w-]+\r?\n\r?\n([\s\S]+)/.exec(text);
  if (!m) return;
  const description = m[2].split(/\n\s*(?:Private diagnostics:|Staff diagnostics:)/i)[0].trim();
  if (description) return { reporterId: m[1], publicDescription: description };
}
export function suggestsDriving(text: string) {
  return /\b(?:phantom brak(?:ing|es)|steering wobble|lane centering|ping[- ]pong(?:ing)?|brak(?:es|ing|ed) (?:hard|late|early)|steer(?:s|ing|ed) (?:hard|left|right)|longitudinal control)\b/i.test(text);
}
async function staff(guild: Guild, id: string) {
  return (await guild.members.fetch({ user: id, force: true })).roles.cache.has(loadConfig().staffRole);
}
async function room(guild: Guild) {
  const channel = await guild.channels.fetch(reviewRoom);
  if (!channel?.isSendable() || (channel.type !== ChannelType.PrivateThread &&
    channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel) !== false))
    throw Error('The configured review channel must be staff-only.');
  return channel;
}
async function sourceOf(thread: ThreadChannel): Promise<CompanionSource> {
  if (thread.parentId !== publicForum || thread.guildId !== guildId()) throw Error('Use a public Companion report.');
  const msg = await thread.fetchStarterMessage({ force: true });
  if (msg?.author.id !== companion) throw Error('The original Companion report could not be verified.');
  const cards = msg.components.flatMap(c => {
    const obj = c.toJSON();
    if (!('components' in obj)) return [];
    return obj.components.flatMap(v => 'content' in v && typeof v.content === 'string' ? [v.content] : []);
  });
  const data = [msg.content,...cards].map(parseOpener).find(Boolean);
  if (!data) throw Error('The original reporter could not be verified.');
  return { guildId: thread.guildId, forumId: publicForum, threadId: thread.id, title: thread.name, ...data };
}
async function offer(thread: ThreadChannel, manual: boolean) {
  const source = await sourceOf(thread);
  if (thread.archived || thread.locked || (!manual && !suggestsDriving(source.publicDescription))) return;
  await withThreadLock('review:'+thread.id, async () => {
    const state = await read(thread.id);
    if (state.card || state.done || state.left) return;
    const review = await room(thread.guild);
    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('driveleave_'+thread.id).setStyle(ButtonStyle.Secondary).setLabel('Leave as is'),
      new ButtonBuilder().setCustomId('drivemove_'+thread.id).setStyle(ButtonStyle.Primary).setLabel('Move to Driving Reports'));
    const card = await review.send({ embeds: [new EmbedBuilder().setTitle('Possible driving report').setURL(thread.url)
      .setDescription(source.publicDescription.slice(0,1500)).setColor(0xe3a534)], components:[buttons], allowedMentions:{parse:[]},
      nonce:thread.id, enforceNonce:true });
    await save(thread.id,{card:card.id});
  });
}
async function readyDestination(thread: ThreadChannel, source: CompanionSource) {
  const state = await read(thread.id);
  if (!state.attempted) return;
  const reports = state.destination ? [await StoredReport.get(state.destination)] : await StoredReport.forUser(source.reporterId);
  for (const r of reports) {
    if (!r || r.reporterId !== source.reporterId || (!state.destination && r.data.createdTimestamp < thread.createdTimestamp!)) continue;
    const channel = await thread.guild.channels.fetch(r.threadId);
    if (!channel?.isThread() || channel.parentId !== loadConfig().forumChannelId) continue;
    const msg = await channel.fetchStarterMessage({force:true});
    if (!msg || msg.author.id !== thread.client.user.id || !msg.embeds.some(e => e.fields.some(f => f.name === 'Companion report' && f.value === thread.url))) continue;
    if (!msg.components.some(c => { const row=c.toJSON(); return 'components' in row && row.components.some(b => 'custom_id' in b && b.custom_id === 'staff_actions_'+r.data.ticketId); })) continue;
    await save(thread.id,{destination:channel.id});
    return channel.url;
  }
}
async function finish(thread: ThreadChannel, destination: string) {
  const state = await read(thread.id);
  if (!state.notice) {
    const notice = new EmbedBuilder().setTitle('Your report moved to driving support').setURL(destination)
      .setDescription('Your report is already in the driving forum. Open the driving ticket and use **Send Route** to share the drive.');
    const previous = await thread.messages.fetch({limit:100});
    const existing = previous.find(m=>m.author.id===thread.client.user.id && m.embeds.some(e=>e.url===destination && e.title===notice.data.title));
    const sent = existing ?? await thread.send({embeds:[notice],allowedMentions:{parse:[]},nonce:thread.id,enforceNonce:true});
    await save(thread.id,{notice:sent.id});
  }
  if (!thread.archived) {
    const forum=thread.parent;
    if (forum?.type!==ChannelType.GuildForum) throw Error('Companion forum unavailable.');
    const closed=forum.availableTags.find(t=>t.name.toLowerCase()==='closed');
    if (!closed) throw Error('Companion Closed tag unavailable.');
    const statuses=forum.availableTags.filter(t=>/^(open|in progress|waiting for user|waiting for dev|awaiting deploy|closed)$/i.test(t.name)).map(t=>t.id);
    const tags=thread.appliedTags.filter(t=>!statuses.includes(t));
    await thread.edit({archived:true,appliedTags:[...tags,closed.id]});
  }
  await save(thread.id,{done:true});
}
@Discord()
export class DrivingTransfers {
  @On({event:Events.ThreadCreate})
  async newThread([thread]:ArgsOf<Events.ThreadCreate>) {
    if (enabled() && thread.guildId===guildId() && thread.parentId===publicForum)
      await offer(thread,false).catch(err=>log.warn({err,threadId:thread.id},'Driving referral review unavailable'));
  }
  @On({event:Events.MessageCreate})
  async opener([msg]:ArgsOf<Events.MessageCreate>) {
    if(enabled() && msg.author.id===companion && msg.id===msg.channelId && msg.channel.isThread() && msg.channel.parentId===publicForum)
      await offer(msg.channel,false).catch(err=>log.warn({err},'Companion opener unavailable'));
  }
  @Slash({name:'refer-driving',description:'Review this Companion report for transfer to driving support',defaultMemberPermissions:PermissionFlagsBits.ManageThreads})
  @DiscordGuild(guildId)
  async manual(i:CommandInteraction) {
    await i.deferReply({flags:MessageFlags.Ephemeral});
    if(!enabled() || !i.guild || !i.channel?.isThread() || i.channel.parentId!==publicForum || !(await staff(i.guild,i.user.id))) {
      await i.editReply('This command requires staff access in a Companion report.'); return;
    }
    try { await offer(i.channel,true); await i.editReply('Review this report in the staff channel.'); }
    catch { await i.editReply('Could not verify an eligible Companion report and its review channel.'); }
  }
  @ButtonComponent({id:/^drive(move|leave)_\d{17,20}$/})
  async decision(i:ButtonInteraction) {
    await i.deferReply({flags:MessageFlags.Ephemeral});
    const id=i.customId.split('_')[1], guild=i.guild;
    try {
      if(!enabled() || !guild || i.channelId!==reviewRoom || i.guildId!==guildId() || !(await staff(guild,i.user.id))) throw Error('Staff access required.');
      await room(guild);
      await withThreadLock('review:'+id,async()=>{
        const state=await read(id);
        if (state.card!==i.message.id || i.message.author.id!==i.client.user.id) throw Error('Invalid review card.');
        if (state.done || state.left) {
          const description=state.done && state.destination
            ? '[Open driving ticket](https://discord.com/channels/'+guild.id+'/'+state.destination+').'
            : 'Original Companion report kept open.';
          await i.message.edit({embeds:[new EmbedBuilder().setTitle('Review complete').setDescription(description)],components:[]});
          await i.editReply('This review is complete.');return;
        }
        let result='Original Companion report kept open.';
        if(i.customId.startsWith('driveleave')) {
          if(state.attempted) throw Error('A move is already pending. Check its driving ticket.');
          await save(id,{left:true});
        } else {
          const thread=await guild.channels.fetch(id);
          if (!thread?.isThread() || thread.parentId!==publicForum || ((thread.archived || thread.locked) && !state.attempted)) throw Error('Source is closed or unavailable.');
          if(await isFrozen()) throw Error('Driving submissions are currently paused.');
          const destination=await moveCompanionReport(i,id,{
            guildId:guild.id,reviewThreadId:reviewRoom,companionForumId:publicForum,loadSource:()=>sourceOf(thread),isStaff:actor=>staff(guild,actor),
            markAttempt:async()=>{await save(id,{attempted:true});},getAttempt:async()=>!!(await read(id)).attempted,
            findReadyTicket:src=>readyDestination(thread,src),
            requestRouteOnce:async(src)=>{
              const s=await read(id); if(s.requested) return;
              const report=s.destination ? await StoredReport.get(s.destination) : null;
              const dest=report && await guild.channels.fetch(report.threadId);
              if(!report || !dest?.isThread() || dest.parent?.type!==ChannelType.GuildForum || dest.parentId!==loadConfig().forumChannelId) throw Error('Driving ticket unavailable.');
              await sendReferralRouteRequest(dest,dest.parent,src.reporterId,report.data.ticketId); await save(id,{requested:true});
            },finishMove:(_src,url)=>finish(thread,url)
          });
          result='[Open driving ticket]('+destination+'). The reporter was asked for their route.';
        }
        await i.message.edit({embeds:[new EmbedBuilder().setTitle('Review complete').setDescription(result)],components:[]});
        await i.editReply('Review complete.');
      });
    } catch(err) {log.warn({err,source:id},'Driving transfer incomplete'); await i.editReply('Transfer incomplete. Check the review card and driving forum before retrying.');}
  }
}
