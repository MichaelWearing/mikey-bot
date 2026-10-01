import { SlashCommandBuilder } from "discord.js";
import { analyzeTrash } from "../lib/trash.js";
import { buildTrashDamageEmbed } from "../lib/embeds.js";
import { extractReportCode } from "../lib/reportCode.js";

export const data = new SlashCommandBuilder()
  .setName("trash-damage")
  .setDescription("Top/lowest 5 damage on trash pulls (boss pulls excluded) for a Warcraft Logs report")
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

  let trash;
  try {
    trash = await analyzeTrash(code);
  } catch (err) {
    console.error(err);
    await interaction.editReply(`Couldn't analyze that report: ${err.message}`);
    return;
  }

  const embed = buildTrashDamageEmbed(trash);
  await interaction.editReply({ embeds: [embed] });
}
