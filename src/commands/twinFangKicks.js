import { SlashCommandBuilder } from "discord.js";
import { analyzeTwinFangKicks } from "../lib/twinFangKicks.js";
import { buildTwinFangKicksEmbed } from "../lib/embeds.js";
import { extractReportCode } from "../lib/reportCode.js";

export const data = new SlashCommandBuilder()
  .setName("twin-fang-kicks")
  .setDescription("Check the assigned Twin Fangs kick group is sharing interrupts evenly")
  .addStringOption((opt) =>
    opt
      .setName("report")
      .setDescription("Report ID or WCL URL (comma-separate multiple if the night spans several logs)")
      .setRequired(true)
  );

export async function execute(interaction) {
  const input = interaction.options.getString("report", true);
  const code = extractReportCode(input);

  await interaction.deferReply();

  let result;
  try {
    result = await analyzeTwinFangKicks(code);
  } catch (err) {
    console.error(err);
    await interaction.editReply(`Couldn't analyze that report: ${err.message}`);
    return;
  }

  const embed = buildTwinFangKicksEmbed(result);
  await interaction.editReply({ embeds: [embed] });
}
