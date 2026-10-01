import { SlashCommandBuilder } from "discord.js";
import { analyzeReport } from "../lib/analyze.js";
import { buildPadReport } from "../lib/pad.js";
import { buildPadEmbed } from "../lib/embeds.js";
import { extractReportCode } from "../lib/reportCode.js";

export const data = new SlashCommandBuilder()
  .setName("pad")
  .setDescription("Check for padding on tracked add fights (currently: Ula'tek's Blightscale Rawling)")
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

  const pad = buildPadReport(analysis);
  const embed = buildPadEmbed(pad);
  await interaction.editReply({ embeds: [embed] });
}
