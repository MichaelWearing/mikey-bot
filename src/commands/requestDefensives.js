import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { getRoster } from "../lib/roster.js";
import { CLASS_SPECS } from "../lib/classRegistry.js";
import { CLASS_EMOJI } from "../lib/embeds.js";
import { EXTERNAL_ABILITY_NAMES } from "../lib/defensives.js";

export const data = new SlashCommandBuilder()
  .setName("request-defensives")
  .setDescription("Post a defensives/self-heals audit prompt to roster channels, using each player's roster class/spec")
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

// One embed per character — an entry with alts (e.g. a main + an off-class alt)
// gets one section per character, all posted together in the same message.
function buildCharacterEmbed(character) {
  const emoji = CLASS_EMOJI[character.class] ?? "🛡️";
  const embed = new EmbedBuilder().setColor(0x1abc9c).setTitle(`🛡️ Defensives & Self-Heals Audit — ${character.name}`);

  if (!character.class || !character.spec) {
    embed.setDescription("We don't have a class/spec on file for this character — reply here and we'll get it added!");
    return embed;
  }

  const abilities = CLASS_SPECS[character.class]?.[character.spec];
  if (!abilities) {
    embed.setDescription(
      `We have you down as ${emoji} **${character.class} - ${character.spec}**, but don't have a tracked defensives list for that ` +
        `spec yet — reply here with what defensives/self-heals (like Lay on Hands) you'd want tracked!`
    );
    return embed;
  }

  const lines = abilities.map((a) => (EXTERNAL_ABILITY_NAMES.has(a) ? `• ${a} *(also usable as an external on others)*` : `• ${a}`));

  embed.setDescription(
    `${emoji} **${character.class} - ${character.spec}**\n\n` +
      `Here's what's currently tracked for you — defensives *and* self-heals (things like Hunter's Exhilaration or ` +
      `Priest's Prayer of Healing count too, not just damage-reduction cooldowns). A few of these can also be cast ` +
      `on someone else instead of yourself — we track those as "externals given" separately, and they're marked below.\n\n` +
      lines.join("\n") +
      `\n\nIs anything missing, does anything need adding, or does something look odd? Let us know!`
  );
  return embed;
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
      const embeds = entry.characters.map(buildCharacterEmbed);
      await channel.send({ content: entry.names.join(" & "), embeds });
      posted.push({ entry, channel });
    } catch (err) {
      console.error(`Failed to post defensives audit for ${entry.names.join("/")}:`, err);
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
