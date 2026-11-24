import { Discord, Guild, Slash, SlashGroup, SlashOption } from 'discordx';
import { ApplicationCommandOptionType, GuildMember, MessageFlags, PermissionFlagsBits, type CommandInteraction, type User } from 'discord.js';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { clearDefaultAssignee, getDefaultAssigneeId, resolveDefaultAssignee, setDefaultAssigneeId } from './default-assignee.js';

const log = createLogger('default-assignee-command');

const NONE_SET = 'No default assignee is set.';
const READ_FAILED = 'Could not read the default assignee. Try again.';
const SAVE_FAILED = 'Could not save the default assignee. Try again.';

async function beginAdminReply(interaction: CommandInteraction): Promise<boolean> {
  if (!(interaction.member instanceof GuildMember) || !interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) {
    await interaction.reply({ content: 'Only admins can manage the default assignee.', flags: MessageFlags.Ephemeral });
    return false;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  return true;
}

async function respond(interaction: CommandInteraction, content: string): Promise<void> {
  await interaction.editReply({ content, allowedMentions: { parse: [] } });
}

@Discord()
@Guild(loadConfig().guildId)
@SlashGroup({
  description: 'Manage who new reports are assigned to (admin only)',
  name: 'default-assignee',
  root: 'report-actions',
})
@SlashGroup('default-assignee', 'report-actions')
export class DefaultAssigneeCommands {
  @Slash({ description: 'Assign all new reports to a staff member', name: 'set' })
  async set(
    @SlashOption({
      name: 'user',
      description: 'Staff member to assign new reports to',
      required: true,
      type: ApplicationCommandOptionType.User,
    })
    user: User | GuildMember,
    interaction: CommandInteraction,
  ) {
    if (!(await beginAdminReply(interaction))) return;
    const target = await interaction.guild?.members.fetch(user.id).catch(() => null);
    if (!target?.roles.cache.has(loadConfig().staffRole)) {
      await respond(interaction, `<@${user.id}> doesn't have the staff role and can't be assigned reports.`);
      return;
    }
    try {
      await setDefaultAssigneeId(user.id);
    } catch (err) {
      log.error({ err }, 'Failed to set default assignee');
      await respond(interaction, SAVE_FAILED);
      return;
    }
    log.info({ userId: interaction.user.id, targetId: user.id }, 'Default assignee set');
    await respond(interaction, `New reports will be assigned to <@${user.id}>. Existing reports are unchanged.`);
  }

  @Slash({ description: 'Stop assigning new reports by default', name: 'clear' })
  async clear(interaction: CommandInteraction) {
    if (!(await beginAdminReply(interaction))) return;
    try {
      if (!(await clearDefaultAssignee())) {
        await respond(interaction, NONE_SET);
        return;
      }
    } catch (err) {
      log.error({ err }, 'Failed to clear default assignee');
      await respond(interaction, SAVE_FAILED);
      return;
    }
    log.info({ userId: interaction.user.id }, 'Default assignee cleared');
    await respond(interaction, 'Default assignee cleared. Existing reports are unchanged.');
  }

  @Slash({ description: 'Show who new reports are assigned to', name: 'show' })
  async show(interaction: CommandInteraction) {
    if (!(await beginAdminReply(interaction))) return;
    let userId: string | null;
    try {
      userId = await getDefaultAssigneeId();
    } catch (err) {
      log.error({ err }, 'Failed to read default assignee');
      await respond(interaction, READ_FAILED);
      return;
    }
    if (!userId) {
      await respond(interaction, NONE_SET);
      return;
    }
    const usable = interaction.guild && await resolveDefaultAssignee(interaction.guild);
    await respond(interaction, usable
      ? `New reports are assigned to <@${userId}>.`
      : `The default assignee is <@${userId}>, but they couldn't be found or no longer have the staff role, so new reports will be unassigned.`);
  }
}
