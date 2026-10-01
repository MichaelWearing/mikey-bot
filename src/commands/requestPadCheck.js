import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { getRoster } from "../lib/roster.js";
import { PAD_TRACKED_TARGETS } from "../lib/analyze.js";
import { PAD_ABILITIES } from "../lib/padAbilities.js";
import { CLASS_EMOJI } from "../lib/embeds.js";

export const data = new SlashCommandBuilder()
  .setName("request-pad-check")
  .setDescription("Ask each player what abilities in their kit could show up as padding, using their roster class/spec")
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

const trackedFightsText = PAD_TRACKED_TARGETS.map((t) => `${t.bossName} (${t.targetName})`).join(", ");

// /pad runs on two signals: a curated list of confirmed AoE-only-spender abilities
// (padAbilities.js — landing one of these on the add at all is already the signal),
// plus a statistical-outlier check on total damage from anything else. This command
// shows the confirmed list for specs that have one and asks if it's right, or asks
// open-ended for specs that don't have one yet — either way gathering the judgment
// call ("is this ability only ever used with 2+ targets up, or is it part of normal
// single-target rotation too") that decides what belongs on that list.
function buildCharacterEmbed(character) {
  const emoji = CLASS_EMOJI[character.class] ?? "🎯";
  const embed = new EmbedBuilder().setColor(0xe67e22).setTitle(`🎯 Padding Check — ${character.name}`);

  if (!character.class || !character.spec) {
    embed.setDescription("We don't have a class/spec on file for this character — reply here and we'll get it added!");
    return embed;
  }

  const confirmed = PAD_ABILITIES[character.class]?.[character.spec];

  if (confirmed && confirmed.length > 0) {
    embed.setDescription(
      `${emoji} **${character.class} - ${character.spec}**\n\n` +
        `Here's what's currently tracked as a confirmed padding signal for you:\n\n` +
        confirmed.map((a) => `• ${a}`).join("\n") +
        `\n\nCurrently tracked fights: ${trackedFightsText}.\n\n` +
        `Explain to us the abilities your class uses to do AoE damage that are a clear signal of padding — does the list ` +
        `above look right, or is there anything else in your kit that fits (something you'd only ever cast with 2+ targets ` +
        `up, never as part of your normal single-target rotation)? Let us know!`
    );
    return embed;
  }

  embed.setDescription(
    `${emoji} **${character.class} - ${character.spec}**\n\n` +
      `We don't have a confirmed padding ability tracked for you yet.\n\n` +
      `Explain to us the abilities your class uses to do AoE damage that are a clear signal of padding — something you'd ` +
      `only ever cast with 2+ targets up, never as part of your normal single-target rotation. Think Divine Storm for a ` +
      `Ret Paladin, Black Powder for a Sub Rogue, or Mind Sear for a Shadow Priest. If nothing like that exists for you, ` +
      `that's fine too, just let us know either way.\n\n` +
      `Currently tracked fights: ${trackedFightsText}.`
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
      console.error(`Failed to post pad check for ${entry.names.join("/")}:`, err);
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
