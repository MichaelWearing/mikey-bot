import { SlashCommandBuilder } from "discord.js";
import { analyzeReport } from "../lib/analyze.js";
import { buildReportEmbeds, chunkEmbeds } from "../lib/embeds.js";
import { extractReportCode } from "../lib/reportCode.js";

export const data = new SlashCommandBuilder()
  .setName("analyze")
  .setDescription("Analyze a Warcraft Logs report")
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

  let analysis;
  try {
    analysis = await analyzeReport(code);
  } catch (err) {
    console.error(err);
    await interaction.editReply(`Couldn't analyze that report: ${err.message}`);
    return;
  }

  const embeds = buildReportEmbeds(analysis);
  const chunks = chunkEmbeds(embeds);

  await interaction.editReply({ embeds: chunks[0] });
  for (const chunk of chunks.slice(1)) {
    await interaction.followUp({ embeds: chunk });
  }
}
