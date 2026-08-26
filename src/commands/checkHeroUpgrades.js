import { SlashCommandBuilder } from "discord.js";
import { analyzeReport } from "../lib/analyze.js";
import { buildHeroUpgradeCheckEmbed } from "../lib/embeds.js";
import { extractReportCode } from "../lib/reportCode.js";
import { getRoster } from "../lib/roster.js";

export const data = new SlashCommandBuilder()
  .setName("check-hero-upgrades")
  .setDescription("List every roster member who hasn't upgraded 3 items to Hero 6/6 yet")
  .addStringOption((opt) =>
    opt
      .setName("report")
      .setDescription("Report ID or WCL URL — any pull with combatant info works, even one trash pull")
      .setRequired(true)
  );

const HERO_UPGRADE_GOAL = 3;

// Latest CombatantInfo snapshot for this name across the whole report — gear is a
// one-time pre-raid check, not something that changes pull to pull, so the most
// recent sighting is as good as any.
function latestHeroTrackMaxCount(analysis, nameSet) {
  let count = 0;
  for (const pull of analysis.pulls) {
    const prepCheck = (pull.prepChecks ?? []).find((p) => nameSet.has(p.playerName));
    if (prepCheck) count = prepCheck.heroTrackMaxCount;
  }
  return count;
}

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

  // Whole roster, not just people who happened to log data — anyone who hasn't
  // shown up in the report yet defaults to 0/3, which is the correct "still short" read.
  const lacking = roster
    .map((entry) => ({
      class: entry.characters?.[0]?.class ?? null,
      name: entry.names.join(" & "),
      heroTrackMaxCount: latestHeroTrackMaxCount(analysis, new Set(entry.names)),
    }))
    .filter((p) => p.heroTrackMaxCount < HERO_UPGRADE_GOAL)
    .sort((a, b) => a.heroTrackMaxCount - b.heroTrackMaxCount);

  const embed = buildHeroUpgradeCheckEmbed(lacking, analysis.title);
  await interaction.editReply({ embeds: [embed] });
}
