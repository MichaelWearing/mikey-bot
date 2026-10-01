import { SlashCommandBuilder } from "discord.js";
import { analyzeOrbCarries } from "../lib/coiledAltarOrbs.js";
import { buildOrbCarryEmbed } from "../lib/embeds.js";
import { extractReportCode } from "../lib/reportCode.js";

export const data = new SlashCommandBuilder()
  .setName("coiled-altar-orbs")
  .setDescription("How many green/purple orbs each player carried on The Coiled Altar")
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
    result = await analyzeOrbCarries(code);
  } catch (err) {
    console.error(err);
    await interaction.editReply(`Couldn't analyze that report: ${err.message}`);
    return;
  }

  const embed = buildOrbCarryEmbed(result);
  await interaction.editReply({ embeds: [embed] });
}
