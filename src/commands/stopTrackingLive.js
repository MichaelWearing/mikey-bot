import { SlashCommandBuilder } from "discord.js";
import { stopPolling } from "../lib/poller.js";

export const data = new SlashCommandBuilder()
  .setName("stop-tracking-live")
  .setDescription("Stop auto-posting new raid reports");

export async function execute(interaction) {
  const result = stopPolling();

  if (!result.wasRunning) {
    await interaction.reply("Tracking isn't currently running.");
    return;
  }

  await interaction.reply(`Stopped tracking. Was posting to <#${result.channelId}>.`);
}
