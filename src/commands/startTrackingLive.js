import { SlashCommandBuilder } from "discord.js";
import { startPolling } from "../lib/poller.js";

export const data = new SlashCommandBuilder()
  .setName("start-tracking-live")
  .setDescription("Start auto-posting new raid reports to this channel every 5 minutes");

export async function execute(interaction) {
  let result;
  try {
    result = startPolling(interaction.client, interaction.channelId);
  } catch (err) {
    await interaction.reply(`Couldn't start tracking: ${err.message}`);
    return;
  }

  if (result.alreadyRunning) {
    await interaction.reply(
      `Already tracking — posting new reports to <#${result.channelId}>. Run /stop-tracking-live first if you want to move it here.`
    );
    return;
  }

  await interaction.reply(
    "Started tracking. I'll check for new raid reports every 5 minutes and post them in this channel."
  );
}
