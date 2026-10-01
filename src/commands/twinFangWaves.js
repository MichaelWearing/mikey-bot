import { SlashCommandBuilder } from "discord.js";
import { analyzeWaveHits } from "../lib/twinFangWaves.js";
import { buildWaveHitsEmbed } from "../lib/embeds.js";
import { extractReportCode } from "../lib/reportCode.js";

export const data = new SlashCommandBuilder()
  .setName("twin-fang-waves")
  .setDescription("Eternal Venom stacks everyone took from Twin Fangs waves")
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
    result = await analyzeWaveHits(code);
  } catch (err) {
    console.error(err);
    await interaction.editReply(`Couldn't analyze that report: ${err.message}`);
    return;
  }

  const embed = buildWaveHitsEmbed(result);
  await interaction.editReply({ embeds: [embed] });
}
