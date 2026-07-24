import { EmbedBuilder } from "discord.js";

const WIPE_COLOR = 0xe74c3c;
const KILL_COLOR = 0x2ecc71;

// Discord renders these inside ```ansi code blocks as real colored/bold text.
const ESC = String.fromCharCode(27);
const ANSI = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1;37m`,
  green: `${ESC}[1;32m`,
  red: `${ESC}[1;31m`,
  cyan: `${ESC}[1;36m`,
  yellow: `${ESC}[1;33m`,
  gray: `${ESC}[2;37m`,
};

const CLASS_EMOJI = {
  Warrior: "⚔️",
  Paladin: "🛡️",
  Hunter: "🏹",
  Rogue: "🗡️",
  Priest: "🙏",
  DeathKnight: "💀",
  Shaman: "🌩️",
  Mage: "❄️",
  Warlock: "👹",
  Monk: "🥋",
  Druid: "🐻",
  DemonHunter: "😈",
  Evoker: "🐲",
};

function classEmoji(className) {
  return CLASS_EMOJI[className] ?? "❔";
}

// "3rd to die" -> "2 others already dead", so every death line makes clear how
// far into the pull's chaos this particular death landed.
function deathPositionNote(deathNumber) {
  const others = deathNumber - 1;
  if (others === 0) return "first to die";
  return `${others} other${others === 1 ? "" : "s"} already dead`;
}

const MAX_WIPE_DEATHS_SHOWN = 3;
const MAX_KILL_DEATHS_SHOWN = 10; // safety ceiling only — kills rarely have many deaths
const FIELD_VALUE_LIMIT = 1024;

function deathBlock(d) {
  const nameColor = d.isTrigger ? ANSI.yellow : d.isChained ? ANSI.gray : ANSI.bold;
  const tag = d.isTrigger ? "🎯 " : d.isChained ? "↳ " : "";
  const lines = [
    `${tag}${nameColor}${classEmoji(d.playerClass)} ${d.playerName}${ANSI.reset} — died to ${d.killedBy} (${deathPositionNote(d.deathNumber)})`,
  ];

  if (d.isTrigger) {
    lines.push(`  ${ANSI.yellow}⚠ likely wipe trigger${ANSI.reset}`);
  } else if (d.isChained) {
    lines.push(`  ${ANSI.gray}(+${Math.round(d.gapMs / 1000)}s — part of the same cascade)${ANSI.reset}`);
  } else if (d.isNearbyUnrelated) {
    lines.push(`  ${ANSI.gray}(+${Math.round(d.gapMs / 1000)}s after previous death — different cause)${ANSI.reset}`);
  }

  if (d.defensiveUsed) {
    lines.push(`  ${ANSI.green}✓ used ${d.defensiveUsed}${ANSI.reset}`);
  }
  if (d.externalAbility) {
    lines.push(`  ${ANSI.cyan}💙 ${d.externalHealer} tried to save them with ${d.externalAbility}${ANSI.reset}`);
  }
  if (!d.defensiveUsed && !d.externalAbility) {
    lines.push(`  ${ANSI.red}✗ no defensive used${ANSI.reset}`);
  }

  return lines.join("\n");
}

function buildDeathsField(pull) {
  const totalDeaths = pull.deaths.length;

  if (totalDeaths === 0) {
    return { name: "Deaths", value: "None 🎉" };
  }

  const hardCap = pull.kill ? MAX_KILL_DEATHS_SHOWN : MAX_WIPE_DEATHS_SHOWN;
  const candidates = pull.deaths.slice(0, hardCap);
  const fenceOverhead = "```ansi\n".length + "\n```".length;
  const footerBudget = 40; // room for the "+N more deaths" line

  const blocks = [];
  let bodyLength = 0;
  for (const block of candidates.map(deathBlock)) {
    const addLength = (blocks.length > 0 ? 2 : 0) + block.length;
    if (fenceOverhead + bodyLength + addLength > FIELD_VALUE_LIMIT - footerBudget) break;
    blocks.push(block);
    bodyLength += addLength;
  }

  const remaining = totalDeaths - blocks.length;
  let value = "```ansi\n" + blocks.join("\n\n") + "\n```";
  if (remaining > 0) {
    const reason = pull.kill ? "" : " — pull was already over by then";
    value += `\n*+${remaining} more death${remaining === 1 ? "" : "s"}${reason}*`;
  }

  return { name: `Deaths (${totalDeaths})`, value };
}

function parseBlock(p, color) {
  return `${color}${classEmoji(p.class)} ${p.name}${ANSI.reset} (${p.spec}) — ${p.rankPercent}%`;
}

function buildParseFields(pull) {
  const fields = [];
  if (pull.topParses.length > 0) {
    fields.push({
      name: "📈 Top parses",
      value: "```ansi\n" + pull.topParses.map((p) => parseBlock(p, ANSI.green)).join("\n") + "\n```",
      inline: true,
    });
  }
  if (pull.bottomParses.length > 0) {
    fields.push({
      name: "📉 Needs work",
      value: "```ansi\n" + pull.bottomParses.map((p) => parseBlock(p, ANSI.red)).join("\n") + "\n```",
      inline: true,
    });
  }
  return fields;
}

function summaryLine(p, valueText, color) {
  return `${color}${classEmoji(p.class)} ${p.name}${ANSI.reset} — ${valueText}`;
}

function addSummaryField(embed, name, list, formatter, { inline = true, caveat = null } = {}) {
  if (list.length === 0) return;
  let value = "```ansi\n" + list.map(formatter).join("\n") + "\n```";
  if (caveat) value += `\n*${caveat}*`;
  embed.addFields({ name, value, inline });
}

export function buildSummaryEmbed(summary) {
  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle(`🌙 Night Summary — ${summary.title}`)
    .setURL(`https://www.warcraftlogs.com/reports/${summary.reportCode}`)
    .setDescription(
      `${summary.totalPulls} pulls, ${summary.totalKills} kills — avg ${summary.avgDeaths.toFixed(1)} deaths/player`
    );

  addSummaryField(embed, "💀 Most Deaths", summary.mostDeaths, (p) =>
    summaryLine(p, `${p.totalDeaths} death${p.totalDeaths === 1 ? "" : "s"}`, ANSI.red)
  );
  addSummaryField(
    embed,
    "🎯 Most Wipes Triggered",
    summary.mostWipesTriggered,
    (p) => {
      const abilities = [...new Set(p.wipeTriggerAbilities)].join(", ");
      return summaryLine(p, `${p.wipeTriggerCount}x — ${abilities}`, ANSI.yellow);
    },
    { caveat: "first death of the wipe; not always the actual cause" }
  );
  addSummaryField(embed, "📈 Highest Avg Parse", summary.highestAvgParse, (p) =>
    summaryLine(p, `${p.avgParse.toFixed(0)}%`, ANSI.green)
  );
  addSummaryField(embed, "📉 Lowest Avg Parse", summary.lowestAvgParse, (p) =>
    summaryLine(p, `${p.avgParse.toFixed(0)}%`, ANSI.red)
  );
  addSummaryField(
    embed,
    "🛡️ Died With Defensive Up",
    summary.diedWithDefensiveUp,
    (p) => summaryLine(p, `${Math.round((p.defensiveUsedCount / p.totalDeaths) * 100)}% of deaths`, ANSI.green),
    { caveat: "only counts what was up at the moment they died" }
  );
  addSummaryField(
    embed,
    "⚠️ Died With Nothing Up",
    summary.diedWithNothingUp,
    (p) => summaryLine(p, `${Math.round((p.defensiveUsedCount / p.totalDeaths) * 100)}% of deaths`, ANSI.red),
    { caveat: "only counts what was up at the moment they died" }
  );

  if (embed.data.fields === undefined || embed.data.fields.length === 0) {
    embed.addFields({ name: "Not enough data", value: "Nobody stood out this session — nicely balanced night." });
  }

  return embed;
}

function characterTag(name, className) {
  return `${classEmoji(className)} ${ANSI.bold}${name}${ANSI.reset}`;
}

function feedbackDeathLine(d) {
  const status = d.defensiveUsed
    ? `  ${ANSI.green}✓ used ${d.defensiveUsed}${ANSI.reset}`
    : d.externalAbility
    ? `  ${ANSI.cyan}💙 ${d.externalHealer} tried to save them with ${d.externalAbility}${ANSI.reset}`
    : `  ${ANSI.red}✗ no defensive used${ANSI.reset}`;
  const pullTag = d.kill ? "Kill" : "Wipe";
  return (
    `${characterTag(d.characterName, d.characterClass)} — Pull #${d.pullNumber} — ${d.bossName} (${pullTag}) — died to ${d.killedBy} (${deathPositionNote(d.deathNumber)})\n` +
    status
  );
}

function parseColor(rankPercent) {
  if (rankPercent >= 75) return ANSI.green;
  if (rankPercent >= 40) return ANSI.yellow;
  return ANSI.red;
}

const CONSUMABLE_CATEGORY_LABELS = {
  health: "🔴 Health Potions & Stones",
  dps: "⚔️ DPS Potions",
  mana: "💧 Mana Potions",
  other: "🧪 Other Consumables",
};
const CONSUMABLE_CATEGORY_ORDER = ["health", "dps", "mana", "other"];

export function buildPlayerFeedbackEmbed(feedback) {
  const embed = new EmbedBuilder()
    .setColor(0x1abc9c)
    .setTitle(`📋 Personal Report — ${feedback.playerNames.join(" & ")}`)
    .setURL(`https://www.warcraftlogs.com/reports/${feedback.reportCode}`)
    .setDescription(
      `${feedback.title}\n${feedback.totalKillPulls} kills, ${feedback.totalWipePulls} wipes, ${feedback.deaths.length} death${feedback.deaths.length === 1 ? "" : "s"}` +
        (feedback.avgParse !== null ? ` — avg parse ${feedback.avgParse.toFixed(0)}%` : "")
    );

  embed.addFields({ name: "📝 Night Verdict", value: feedback.verdict });

  if (feedback.deaths.length > 0) {
    const shown = feedback.deaths.slice(0, 10);
    let value = "```ansi\n" + shown.map(feedbackDeathLine).join("\n\n") + "\n```";
    if (feedback.deaths.length > shown.length) {
      value += `\n*+${feedback.deaths.length - shown.length} more*`;
    }
    embed.addFields({ name: `💀 Deaths (${feedback.deaths.length})`, value });
  } else {
    embed.addFields({ name: "💀 Deaths", value: "No deaths tonight — great job! 🎉" });
  }

  if (feedback.kills.length > 0) {
    const lines = feedback.kills.map(
      (k) =>
        `${classEmoji(k.characterClass)} ${ANSI.bold}${k.characterName}${ANSI.reset} — ${parseColor(k.rankPercent)}Pull #${k.pullNumber} — ${k.bossName} (${k.spec}) — ${k.rankPercent}%${ANSI.reset}`
    );
    embed.addFields({ name: "📊 Parse on Kills", value: "```ansi\n" + lines.join("\n") + "\n```" });
  }

  if (feedback.interrupts.length > 0) {
    const byCharacterAbility = new Map();
    for (const i of feedback.interrupts) {
      const key = `${i.characterName}::${i.interruptedAbility}`;
      const entry = byCharacterAbility.get(key) ?? {
        characterName: i.characterName,
        characterClass: i.characterClass,
        ability: i.interruptedAbility,
        count: 0,
      };
      entry.count += 1;
      byCharacterAbility.set(key, entry);
    }
    const lines = [...byCharacterAbility.values()].map(
      (e) => `${classEmoji(e.characterClass)} ${e.characterName}${ANSI.reset}: ${ANSI.cyan}${e.ability}${ANSI.reset} x${e.count}`
    );
    embed.addFields({
      name: `🎯 Interrupts (${feedback.interrupts.length})`,
      value: "```ansi\n" + lines.join("\n\n") + "\n```",
      inline: true,
    });
  } else {
    embed.addFields({ name: "🎯 Interrupts", value: "None all night", inline: true });
  }

  if (feedback.defensivesUsed.length > 0) {
    const lines = feedback.defensivesUsed.map(
      (d) => `${classEmoji(d.characterClass)} ${d.characterName}${ANSI.reset}: ${ANSI.green}${d.name}${ANSI.reset} x${d.count}`
    );
    embed.addFields({ name: "🛡️ Defensives Used", value: "```ansi\n" + lines.join("\n\n") + "\n```", inline: true });
  } else {
    embed.addFields({ name: "🛡️ Defensives Used", value: "None used all night", inline: true });
  }

  if (feedback.consumables.length > 0) {
    const byCategory = new Map();
    for (const c of feedback.consumables) {
      if (!byCategory.has(c.category)) byCategory.set(c.category, []);
      byCategory.get(c.category).push(c);
    }
    for (const category of CONSUMABLE_CATEGORY_ORDER) {
      const entries = byCategory.get(category);
      if (!entries || entries.length === 0) continue;
      const lines = entries.map(
        (c) => `${classEmoji(c.characterClass)} ${c.characterName}${ANSI.reset}: ${ANSI.green}${c.name}${ANSI.reset} x${c.count}`
      );
      embed.addFields({
        name: CONSUMABLE_CATEGORY_LABELS[category],
        value: "```ansi\n" + lines.join("\n\n") + "\n```",
        inline: true,
      });
    }
  } else {
    embed.addFields({ name: "🧪 Consumables Used", value: "None used all night", inline: true });
  }

  if (feedback.externalsGiven.length > 0) {
    const shown = feedback.externalsGiven.slice(0, 8);
    const lines = shown.map(
      (e) =>
        `${classEmoji(e.characterClass)} ${e.characterName}${ANSI.reset}: ${ANSI.cyan}${e.ability}${ANSI.reset} → ${e.targetName} (Pull #${e.pullNumber})`
    );
    let value = "```ansi\n" + lines.join("\n\n") + "\n```";
    if (feedback.externalsGiven.length > shown.length) {
      value += `\n*+${feedback.externalsGiven.length - shown.length} more*`;
    }
    embed.addFields({ name: `💙 Externals Given (${feedback.externalsGiven.length})`, value });
  } else {
    embed.addFields({ name: "💙 Externals Given", value: "None used all night" });
  }

  return embed;
}

export function buildPullEmbed(pull) {
  const embed = new EmbedBuilder();

  if (pull.kill) {
    embed
      .setColor(KILL_COLOR)
      .setTitle(`✅ ${pull.bossName} — Pull #${pull.pullNumber} (Kill! ${pull.durationClock})`);
  } else {
    embed
      .setColor(WIPE_COLOR)
      .setTitle(
        `💀 ${pull.bossName} — Pull #${pull.pullNumber} (Wipe, boss at ${pull.bossPercentRemaining}%)`
      );
  }

  embed.addFields(buildDeathsField(pull));

  if (pull.kill) {
    embed.addFields(buildParseFields(pull));
  }

  return embed;
}

export function buildReportEmbeds(analysis) {
  const header = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`Raid Log Analysis — ${analysis.title}`)
    .setURL(`https://www.warcraftlogs.com/reports/${analysis.reportCode}`)
    .setDescription(`${analysis.pulls.length} pulls analyzed`);

  const pullEmbeds = analysis.pulls.map(buildPullEmbed);
  return [header, ...pullEmbeds];
}

function embedLength(embed) {
  const data = embed.data ?? embed;
  let len = 0;
  len += data.title?.length ?? 0;
  len += data.description?.length ?? 0;
  len += data.footer?.text?.length ?? 0;
  len += data.author?.name?.length ?? 0;
  for (const field of data.fields ?? []) {
    len += (field.name?.length ?? 0) + (field.value?.length ?? 0);
  }
  return len;
}

// Discord caps messages at 10 embeds and 6000 total embed characters;
// split into chunks that respect both limits.
export function chunkEmbeds(embeds, maxCount = 10, maxTotalLength = 6000) {
  const chunks = [];
  let current = [];
  let currentLength = 0;

  for (const embed of embeds) {
    const length = embedLength(embed);
    const wouldOverflow =
      current.length >= maxCount || (current.length > 0 && currentLength + length > maxTotalLength);

    if (wouldOverflow) {
      chunks.push(current);
      current = [];
      currentLength = 0;
    }

    current.push(embed);
    currentLength += length;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}
