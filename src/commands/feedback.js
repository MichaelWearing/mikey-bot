import { SlashCommandBuilder } from "discord.js";
import { analyzeReport } from "../lib/analyze.js";
import { analyzeTrash } from "../lib/trash.js";
import { buildPlayerFeedback } from "../lib/playerFeedback.js";
import { buildPlayerFeedbackEmbed } from "../lib/embeds.js";
import { extractReportCode } from "../lib/reportCode.js";
import { getRoster, buildSpecLookup } from "../lib/roster.js";

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

  // Best-effort — if the roster fails to load for some reason, fall back to WCL's
  // own spec detection rather than failing the whole report.
  let specLookup = null;
  try {
    specLookup = buildSpecLookup(await getRoster());
  } catch (err) {
    console.error("Couldn't load roster for spec lookup:", err);
  }

  // Trash standing is a nice-to-have — if it fails or times out, the report still goes out.
  let trashRoster = null;
  try {
    trashRoster = (await analyzeTrash(code)).roster;
  } catch (err) {
    console.error("Couldn't analyze trash for feedback:", err);
  }

  const feedback = buildPlayerFeedback(analysis, playerNames, specLookup, trashRoster);

  if (feedback.deaths.length === 0 && feedback.kills.length === 0) {
    await interaction.editReply(
      `Couldn't find "${playerNames.join(", ")}" in that report. Double-check the exact character name spelling.`
    );
    return;
  }

  const embed = buildPlayerFeedbackEmbed(feedback);
  await interaction.editReply({ embeds: [embed] });
}
