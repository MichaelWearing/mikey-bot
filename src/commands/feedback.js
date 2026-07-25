import { SlashCommandBuilder } from "discord.js";
import { analyzeReport } from "../lib/analyze.js";
import { buildPlayerFeedback } from "../lib/playerFeedback.js";
import { buildPlayerFeedbackEmbed } from "../lib/embeds.js";
import { extractReportCode } from "../lib/reportCode.js";

export const data = new SlashCommandBuilder()
  .setName("feedback")
  .setDescription("Post a personal raid feedback report for one player (run this in their feedback channel)")
  .addStringOption((opt) =>
    opt
      .setName("report")
      .setDescription("Report ID or WCL URL (comma-separate multiple if the night spans several logs)")
      .setRequired(true)
  )
  .addStringOption((opt) =>
    opt
      .setName("player")
      .setDescription("Character name(s) as they appear in the log — comma-separate alts, e.g. Mikey, Rambomikey")
      .setRequired(true)
  );

export async function execute(interaction) {
  const input = interaction.options.getString("report", true);
  const playerInput = interaction.options.getString("player", true);
  const code = extractReportCode(input);
  const playerNames = playerInput
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  await interaction.deferReply();

  let analysis;
  try {
    analysis = await analyzeReport(code);
  } catch (err) {
    console.error(err);
    await interaction.editReply(`Couldn't analyze that report: ${err.message}`);
    return;
  }

  const feedback = buildPlayerFeedback(analysis, playerNames);

  if (feedback.deaths.length === 0 && feedback.kills.length === 0) {
    await interaction.editReply(
      `Couldn't find "${playerNames.join(", ")}" in that report. Double-check the exact character name spelling.`
    );
    return;
  }

  const embed = buildPlayerFeedbackEmbed(feedback);
  await interaction.editReply({ embeds: [embed] });
}
