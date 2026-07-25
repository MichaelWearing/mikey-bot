import { SlashCommandBuilder } from "discord.js";
import { analyzeReport } from "../lib/analyze.js";
import { buildPlayerFeedback } from "../lib/playerFeedback.js";
import { buildPlayerFeedbackEmbed } from "../lib/embeds.js";
import { extractReportCode } from "../lib/reportCode.js";
import { getRoster } from "../lib/roster.js";

export const data = new SlashCommandBuilder()
  .setName("give-personal-feedback-to-all")
  .setDescription("Post personal feedback for the whole roster (data/roster.json), each to their own channel")
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

  let roster;
  try {
    roster = await getRoster();
  } catch (err) {
    console.error(err);
    await interaction.editReply(`Couldn't load the roster (data/roster.json): ${err.message}`);
    return;
  }

  const posted = [];
  const skipped = [];
  const failed = [];

  for (const entry of roster) {
    const feedback = buildPlayerFeedback(analysis, entry.names);
    const hasData =
      feedback.deaths.length > 0 ||
      feedback.kills.length > 0 ||
      feedback.interrupts.length > 0 ||
      feedback.defensivesUsed.length > 0 ||
      feedback.consumables.length > 0 ||
      feedback.externalsGiven.length > 0;

    if (!hasData) {
      skipped.push({ entry });
      continue;
    }

    const channel = interaction.guild.channels.cache.find(
      (c) => c.name.toLowerCase() === entry.channelName.toLowerCase()
    );

    if (!channel) {
      failed.push({ entry, reason: `#${entry.channelName} not found` });
      continue;
    }

    try {
      const embed = buildPlayerFeedbackEmbed(feedback);
      await channel.send({ embeds: [embed] });
      posted.push({ entry, channel });
    } catch (err) {
      console.error(`Failed to post feedback for ${entry.names.join("/")}:`, err);
      failed.push({ entry, reason: err.message });
    }
  }

  const lines = [];
  if (posted.length > 0) {
    lines.push(
      `✅ Posted: ${posted.map((p) => `${p.entry.names.join(" & ")} (<#${p.channel.id}>)`).join(", ")}`
    );
  }
  if (skipped.length > 0) {
    lines.push(`⏭️ Not in this report: ${skipped.map((s) => s.entry.names.join(" & ")).join(", ")}`);
  }
  if (failed.length > 0) {
    lines.push(`⚠️ Failed: ${failed.map((f) => `${f.entry.names.join(" & ")} (${f.reason})`).join(", ")}`);
  }

  await interaction.editReply(lines.join("\n") || "Nobody on the roster had data in this report.");
}
