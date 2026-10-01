import { SlashCommandBuilder } from "discord.js";
import { analyzeReport } from "../lib/analyze.js";
import { buildNightSummary } from "../lib/summary.js";
import { buildSummaryEmbeds } from "../lib/embeds.js";
import { extractReportCode } from "../lib/reportCode.js";
import { getRoster, buildSpecLookup } from "../lib/roster.js";

export const data = new SlashCommandBuilder()
  .setName("summary")
  .setDescription("Get an overall night summary for a Warcraft Logs report")
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

  // Best-effort — the cooldown-aware death check still works off WCL's own spec
  // detection if the roster can't be loaded, it's just less reliable.
  let specLookup = null;
  try {
    specLookup = buildSpecLookup(await getRoster());
  } catch (err) {
    console.error("Couldn't load roster for spec lookup:", err);
  }

  const summary = buildNightSummary(analysis, specLookup);
  // One embed per message: Discord's 6000-char cap applies to a whole message, so a
  // long night has to be split across follow-ups rather than stacked in one reply.
  const embeds = buildSummaryEmbeds(summary);

  await interaction.editReply({ embeds: [embeds[0]] });
  for (const embed of embeds.slice(1)) {
    await interaction.followUp({ embeds: [embed] });
  }
}
