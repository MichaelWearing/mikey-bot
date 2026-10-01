import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { analyzeOrbSoaks } from "../lib/twinFangOrbs.js";
import { getRoster } from "../lib/roster.js";
import { extractReportCode } from "../lib/reportCode.js";

// Posts each of the top 5 / bottom 5 orb pickers a note in their OWN channel, the
// same per-raider channel the /request-* commands use.
const GROUP_SIZE = 5;

// Someone who only made a handful of pulls will have a low raw count without having
// slacked at all, so they're held out of the BOTTOM group rather than called out for
// attendance. They can still make the top group — a high count on few pulls is real.
const MIN_ATTENDANCE_RATIO = 0.5;

export const data = new SlashCommandBuilder()
  .setName("twin-fang-orbs-post")
  .setDescription("Post orb pickup results to the top 5 and bottom 5 raiders' own channels")
  .addStringOption((opt) =>
    opt
      .setName("report")
      .setDescription("Report ID or WCL URL (comma-separate multiple if the night spans several logs)")
      .setRequired(true)
  )
  .addBooleanOption((opt) =>
    opt
      .setName("confirm")
      .setDescription("Actually post. Leave off to preview who would get a message without sending anything.")
  );

function buildPlayerEmbed({ player, rank, isTop, result }) {
  return new EmbedBuilder()
    .setColor(isTop ? 0x2ecc71 : 0xe67e22)
    .setTitle(isTop ? "🫧 Twin Fangs orbs — top 5 this night" : "🫧 Twin Fangs orbs — bottom 5 this night")
    .setURL(`https://www.warcraftlogs.com/reports/${result.reportCode}`)
    .setDescription(
      (isTop
        ? `You picked up **${player.orbs}** Caustic Globule orbs — **#${rank}** in the raid. Nice.`
        : `You picked up **${player.orbs}** Caustic Globule orbs, which put you in the bottom ${GROUP_SIZE}.`) +
        `\n\nRaid total was ${result.totalOrbs} across ${result.pullCount} pulls — an even split would be ~${result.fairShare.toFixed(0)} each.` +
        `\nYou averaged ${player.rate.toFixed(1)} per pull over ${player.pullsPresent} pulls.` +
        (isTop ? "" : `\n\n*Orbs have to get picked up by someone — every one you leave is one somebody else eats.*`)
    );
}

export async function execute(interaction) {
  const input = interaction.options.getString("report", true);
  const confirm = interaction.options.getBoolean("confirm") ?? false;
  const code = extractReportCode(input);

  await interaction.deferReply();

  let result, roster;
  try {
    [result, roster] = await Promise.all([analyzeOrbSoaks(code), getRoster()]);
  } catch (err) {
    console.error(err);
    await interaction.editReply(`Couldn't analyze that report: ${err.message}`);
    return;
  }

  if (result.pullCount === 0) {
    await interaction.editReply("No Twin Fangs pulls found in that report.");
    return;
  }

  // Character name -> roster entry, so an alt resolves to the same person's channel.
  const entryByCharacter = new Map();
  for (const entry of roster) {
    for (const character of entry.characters) entryByCharacter.set(character.name, entry);
  }

  const maxPulls = Math.max(...result.pickers.map((p) => p.pullsPresent), 0);
  const attendanceFloor = maxPulls * MIN_ATTENDANCE_RATIO;

  const top = result.pickers.slice(0, GROUP_SIZE);
  const bottomEligible = result.pickers.filter((p) => p.pullsPresent >= attendanceFloor);
  const bottom = bottomEligible.slice(-GROUP_SIZE).reverse();
  const heldOut = result.pickers.filter((p) => p.pullsPresent < attendanceFloor);

  const targets = [
    ...top.map((player, i) => ({ player, rank: i + 1, isTop: true })),
    ...bottom.map((player) => ({ player, rank: result.pickers.indexOf(player) + 1, isTop: false })),
  ];

  const planned = [];
  const unresolved = [];
  for (const t of targets) {
    const entry = entryByCharacter.get(t.player.name);
    if (!entry) {
      unresolved.push({ ...t, reason: "not in roster.json" });
      continue;
    }
    const channel = interaction.guild.channels.cache.find((c) => c.name.toLowerCase() === entry.channelName.toLowerCase());
    if (!channel) {
      unresolved.push({ ...t, reason: `#${entry.channelName} not found` });
      continue;
    }
    planned.push({ ...t, entry, channel });
  }

  const summary = (verb) => {
    const lines = [];
    const fmt = (list) => list.map((p) => `${p.player.name} (${p.player.orbs}x)`).join(", ");
    lines.push(`**Top ${GROUP_SIZE}:** ${fmt(planned.filter((p) => p.isTop))}`);
    lines.push(`**Bottom ${GROUP_SIZE}:** ${fmt(planned.filter((p) => !p.isTop))}`);
    lines.push(`${verb} ${planned.length} channel${planned.length === 1 ? "" : "s"}.`);
    if (unresolved.length > 0) {
      lines.push(`⚠️ No channel for: ${unresolved.map((u) => `${u.player.name} (${u.reason})`).join(", ")}`);
    }
    if (heldOut.length > 0) {
      lines.push(
        `ℹ️ Held out of the bottom ${GROUP_SIZE} for low attendance: ` +
          heldOut.map((p) => `${p.name} (${p.pullsPresent}/${maxPulls} pulls)`).join(", ")
      );
    }
    return lines.join("\n");
  };

  if (!confirm) {
    await interaction.editReply(`**Preview — nothing sent.** Re-run with \`confirm: true\` to post.\n\n${summary("Would post to")}`);
    return;
  }

  const failed = [];
  for (const t of planned) {
    try {
      await t.channel.send({
        content: t.entry.names.join(" & "),
        embeds: [buildPlayerEmbed({ player: t.player, rank: t.rank, isTop: t.isTop, result })],
      });
    } catch (err) {
      console.error(`Failed to post orb results for ${t.player.name}:`, err);
      failed.push({ ...t, reason: err.message });
    }
  }

  const posted = planned.length - failed.length;
  let reply = summary(`✅ Posted to ${posted} of`);
  if (failed.length > 0) {
    reply += `\n❌ Failed: ${failed.map((f) => `${f.player.name} (${f.reason})`).join(", ")}`;
  }
  await interaction.editReply(reply);
}
