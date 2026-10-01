import { SlashCommandBuilder } from "discord.js";
import { analyzeOrbSoaks } from "../lib/twinFangOrbs.js";
import { buildOrbSoakEmbed } from "../lib/embeds.js";
import { extractReportCode } from "../lib/reportCode.js";

export const data = new SlashCommandBuilder()
  .setName("twin-fang-orbs")
  .setDescription("How many Caustic Globule orbs each player picked up on Twin Fangs")
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
    result = await analyzeOrbSoaks(code);
  } catch (err) {
    console.error(err);
    await interaction.editReply(`Couldn't analyze that report: ${err.message}`);
    return;
  }

  const embed = buildOrbSoakEmbed(result);
  await interaction.editReply({ embeds: [embed] });
}
