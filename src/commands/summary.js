import { SlashCommandBuilder } from "discord.js";
import { analyzeReport } from "../lib/analyze.js";
import { buildNightSummary } from "../lib/summary.js";
import { buildSummaryEmbed } from "../lib/embeds.js";
import { extractReportCode } from "../lib/reportCode.js";

export const data = new SlashCommandBuilder()
  .setName("summary")
  .setDescription("Get an overall night summary for a Warcraft Logs report")
  .addStringOption((opt) =>
    opt
      .setName("report")
      .setDescription("Report ID or Warcraft Logs URL")
      .setRequired(true)
  );

export async function execute(interaction) {
  const input = interaction.options.getString("report", true);
  const code = extractReportCode(input);

  await interaction.deferReply();

  let analysis;
  try {
    analysis = await analyzeReport(code);
  } catch (err) {
    console.error(err);
    await interaction.editReply(`Couldn't analyze that report: ${err.message}`);
    return;
  }

  const summary = buildNightSummary(analysis);
  const embed = buildSummaryEmbed(summary);

  await interaction.editReply({ embeds: [embed] });
}
