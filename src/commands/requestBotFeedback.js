import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { getRoster } from "../lib/roster.js";

export const data = new SlashCommandBuilder()
  .setName("request-bot-feedback")
  .setDescription("Ask each player for feedback on the bot itself — not raid stats, the tool")
  .addStringOption((opt) =>
    opt
      .setName("player")
      .setDescription("Only send to one player (leave blank to send to the whole roster)")
      .setRequired(false)
      .setAutocomplete(true)
  );

export async function autocomplete(interaction) {
  const roster = await getRoster();
  const focused = interaction.options.getFocused().toLowerCase();
  const matches = roster
    .filter((entry) => entry.names.some((n) => n.toLowerCase().includes(focused)))
    .slice(0, 25)
    .map((entry) => ({ name: entry.names.join("/"), value: entry.names[0] }));
  await interaction.respond(matches);
}

// One embed per roster entry (not per character — this is about the bot, not a
// spec/kit), same questions for everyone. Free-text reply in-channel, same as
// /request-pad-check and /request-defensives — no structured collection, this is
// meant to just get an honest read, not build a dataset.
function buildFeedbackEmbed(names) {
  return new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle(`📋 Bot Feedback — ${names.join(" & ")}`)
    .setDescription(
      `Just some quick questions in regards to Mikey Bot. I understand not everyone is interested in it, so no stress if you have nothing to say. But any input is appreciated!\n\n` +
        `**1.** Do you actually look at your report/feedback message? *(yes / no / briefly / in detail)*\n` +
        `**2.** Things you like about the feedback\n` +
        `**3.** Things you dislike about the feedback\n` +
        `**4.** Anything you'd want added or removed\n\n` +
        `Doesn't need to be long — even a one-word answer per question is genuinely useful.`
    );
}

export async function execute(interaction) {
  const playerFilter = interaction.options.getString("player");

  let roster;
  try {
    roster = await getRoster();
  } catch (err) {
    console.error(err);
    await interaction.reply({ content: `Couldn't load the roster (data/roster.json): ${err.message}`, ephemeral: true });
    return;
  }

  const targets = playerFilter
    ? roster.filter((entry) => entry.names.some((n) => n.toLowerCase() === playerFilter.toLowerCase()))
    : roster;

  if (targets.length === 0) {
    await interaction.reply({ content: `Couldn't find "${playerFilter}" in the roster.`, ephemeral: true });
    return;
  }

  await interaction.deferReply();

  const posted = [];
  const failed = [];

  for (const entry of targets) {
    const channel = interaction.guild.channels.cache.find((c) => c.name.toLowerCase() === entry.channelName.toLowerCase());
    if (!channel) {
      failed.push({ entry, reason: `#${entry.channelName} not found` });
      continue;
    }

    try {
      await channel.send({ content: entry.names.join(" & "), embeds: [buildFeedbackEmbed(entry.names)] });
      posted.push({ entry, channel });
    } catch (err) {
      console.error(`Failed to post bot feedback request for ${entry.names.join("/")}:`, err);
      failed.push({ entry, reason: err.message });
    }
  }

  const lines = [];
  if (posted.length > 0) {
    lines.push(`✅ Posted: ${posted.map((p) => `${p.entry.names.join(" & ")} (<#${p.channel.id}>)`).join(", ")}`);
  }
  if (failed.length > 0) {
    lines.push(`⚠️ Failed: ${failed.map((f) => `${f.entry.names.join(" & ")} (${f.reason})`).join(", ")}`);
  }

  await interaction.editReply(lines.join("\n") || "Nobody matched.");
}
