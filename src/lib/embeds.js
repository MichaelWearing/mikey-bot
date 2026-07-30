import { EmbedBuilder } from "discord.js";

const WIPE_COLOR = 0xe74c3c;
const KILL_COLOR = 0x2ecc71;

// Appended to a description when multiple WCL reports were combined for one night —
// e.g. two people both ran a logging addon, or a crash split the night in two.
function combinedReportsNote(reportCodes, duplicatesDropped) {
  if (!reportCodes || reportCodes.length <= 1) return "";
  let note = `\nCombined ${reportCodes.length} logs`;
  if (duplicatesDropped > 0) {
    note += ` — merged ${duplicatesDropped} duplicate pull${duplicatesDropped === 1 ? "" : "s"}`;
  }
  return note + ".";
}

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

export const CLASS_EMOJI = {
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
  if (d.isCalledWipe) {
    return [
      `🏳️ ${ANSI.gray}${classEmoji(d.playerClass)} ${d.playerName}${ANSI.reset} — died to ${d.killedBy} (${deathPositionNote(d.deathNumber)})`,
      `  ${ANSI.gray}(5+ people died to this together — likely a called wipe, not counted against anyone)${ANSI.reset}`,
    ].join("\n");
  }

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
  // Individual mistakes first, called-wipe pile-ons last — a mass "wipe called"
  // moment shouldn't eat the only few visible slots and bury what actually mattered.
  const prioritized = pull.kill
    ? pull.deaths
    : [...pull.deaths.filter((d) => !d.isCalledWipe), ...pull.deaths.filter((d) => d.isCalledWipe)];
  const candidates = prioritized.slice(0, hardCap);
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

// Shared by /feedback's own prep field and /summary's raid-wide leaderboard.
function formatPullList(pullNumbers) {
  return pullNumbers.map((n) => `#${n}`).join(", ");
}

function formatPrepIssues({ missingEnchantSlots, missingFlaskPulls, missingFoodPulls, missingWeaponEnchantPulls }) {
  const parts = [];
  if (missingEnchantSlots.length > 0) parts.push(`missing enchant: ${missingEnchantSlots.join(", ")}`);
  if (missingFlaskPulls.length > 0) parts.push(`no flask (Pull ${formatPullList(missingFlaskPulls)})`);
  if (missingFoodPulls.length > 0) parts.push(`no food (Pull ${formatPullList(missingFoodPulls)})`);
  if (missingWeaponEnchantPulls.length > 0) parts.push(`no weapon oil (Pull ${formatPullList(missingWeaponEnchantPulls)})`);
  return parts.join(", ");
}

// Each entry: { pullNumber, durationClock, missingCount, raidSize }
function formatBuffLapsePulls(pulls) {
  return pulls.map((p) => `#${p.pullNumber} (${p.durationClock}, ${p.missingCount}/${p.raidSize} missing)`).join(", ");
}

function formatRaidBuffLapses(raidBuffLapses) {
  return raidBuffLapses.map(({ buffName, pulls }) => `let ${buffName} lapse — Pull ${formatBuffLapsePulls(pulls)}`).join("; ");
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
      `${summary.totalPulls} pulls, ${summary.totalKills} kills — avg ${summary.avgDeaths.toFixed(1)} deaths/player` +
        combinedReportsNote(summary.reportCodes, summary.duplicatesDropped)
    );

  if (summary.bossesSummary.length > 0) {
    const lines = summary.bossesSummary.map((b) => (b.killed ? `✅ ${b.bossName}` : `💀 ${b.bossName} (not killed)`));
    embed.addFields({ name: "🐲 Bosses", value: lines.join("\n") });
  }

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
    "⚠️ Died With Nothing Up",
    summary.diedWithNothingUp,
    (p) => summaryLine(p, `${Math.round((p.defensiveUsedCount / p.totalDeaths) * 100)}% of deaths`, ANSI.red),
    { caveat: "only counts what was up at the moment they died" }
  );
  addSummaryField(embed, "🎯 Most Interrupts", summary.mostInterrupts, (p) =>
    summaryLine(p, `${p.interruptCount} kick${p.interruptCount === 1 ? "" : "s"}` + (p.interruptViaPetCount > 0 ? ` (${p.interruptViaPetCount} via pet)` : ""), ANSI.cyan)
  );
  addSummaryField(
    embed,
    "🧪 No DPS Potions",
    summary.noDpsPotions,
    (p) => summaryLine(p, `0 across ${p.parsePercents.length} kill${p.parsePercents.length === 1 ? "" : "s"}`, ANSI.yellow),
    { caveat: "free parse left on the table" }
  );
  addSummaryField(
    embed,
    "⚠️ Missing Prep",
    summary.missingPrep,
    (p) => summaryLine(p, formatPrepIssues(p), ANSI.yellow),
    { inline: false, caveat: "enchants checked at first/last pull; flask/food/weapon oil checked every pull" }
  );
  addSummaryField(
    embed,
    "🎺 Raid Buff Lapses",
    summary.raidBuffLapses,
    (p) => summaryLine(p, formatRaidBuffLapses(p.raidBuffLapses), ANSI.yellow),
    { inline: false, caveat: "only checked on pulls 30s+; only flags the class(es) that provide that buff" }
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
        (feedback.avgParse !== null ? ` — avg parse ${feedback.avgParse.toFixed(0)}%` : "") +
        combinedReportsNote(feedback.reportCodes, feedback.duplicatesDropped)
    );

  if (feedback.bossesSummary.length > 0) {
    const lines = feedback.bossesSummary.map((b) => {
      if (!b.attended) return `⬜ ${b.bossName} (missed — raid ${b.killed ? "killed it" : "didn't kill it"})`;
      return b.killed ? `✅ ${b.bossName}` : `💀 ${b.bossName} (wiped)`;
    });
    embed.addFields({ name: "🐲 Bosses", value: lines.join("\n") });
  }

  embed.addFields({ name: "📝 Night Verdict", value: feedback.verdict });

  if (feedback.deaths.length > 0) {
    // Personal report — highlight every death for this player, not just the first
    // few. No arbitrary head-count cap; only Discord's actual field size limits it.
    const fenceOverhead = "```ansi\n".length + "\n```".length;
    const footerBudget = 40; // room for the "+N more" line
    const blocks = [];
    let bodyLength = 0;
    for (const block of feedback.deaths.map(feedbackDeathLine)) {
      const addLength = (blocks.length > 0 ? 2 : 0) + block.length;
      if (fenceOverhead + bodyLength + addLength > FIELD_VALUE_LIMIT - footerBudget) break;
      blocks.push(block);
      bodyLength += addLength;
    }
    let value = "```ansi\n" + blocks.join("\n\n") + "\n```";
    const remaining = feedback.deaths.length - blocks.length;
    if (remaining > 0) {
      value += `\n*+${remaining} more*`;
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
      const key = `${i.characterName}::${i.interruptedAbility}::${i.viaPet}`;
      const entry = byCharacterAbility.get(key) ?? {
        characterName: i.characterName,
        characterClass: i.characterClass,
        ability: i.interruptedAbility,
        viaPet: i.viaPet,
        count: 0,
      };
      entry.count += 1;
      byCharacterAbility.set(key, entry);
    }
    const lines = [...byCharacterAbility.values()].map(
      (e) =>
        `${classEmoji(e.characterClass)} ${e.characterName}${ANSI.reset}: ${ANSI.cyan}${e.ability}${ANSI.reset} x${e.count}` +
        (e.viaPet ? `${ANSI.gray} (via pet)${ANSI.reset}` : "")
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
    // Ground-targeted raid CDs (Darkness, etc.) log their target as "Environment" —
    // there's no one to credit, so collapse those into a plain count instead of a
    // repeated line per cast. Externals with a real target keep the who/when detail.
    const grouped = new Map();
    for (const e of feedback.externalsGiven) {
      const isGroundTargeted = e.targetName === "Environment";
      const key = isGroundTargeted ? `${e.characterName}::${e.ability}` : `${e.characterName}::${e.ability}::${e.targetName}`;
      const entry = grouped.get(key) ?? {
        characterName: e.characterName,
        characterClass: e.characterClass,
        ability: e.ability,
        targetName: isGroundTargeted ? null : e.targetName,
        count: 0,
        pullNumbers: [],
      };
      entry.count += 1;
      if (!isGroundTargeted) entry.pullNumbers.push(e.pullNumber);
      grouped.set(key, entry);
    }

    const groupedEntries = [...grouped.values()];
    const shown = groupedEntries.slice(0, 8);
    const lines = shown.map((e) => {
      const base = `${classEmoji(e.characterClass)} ${e.characterName}${ANSI.reset}: ${ANSI.cyan}${e.ability}${ANSI.reset}`;
      if (!e.targetName) return `${base} x${e.count}`;
      return `${base} → ${e.targetName} (Pull ${e.pullNumbers.map((p) => `#${p}`).join(", ")})`;
    });
    let value = "```ansi\n" + lines.join("\n\n") + "\n```";
    if (groupedEntries.length > shown.length) {
      value += `\n*+${groupedEntries.length - shown.length} more*`;
    }
    embed.addFields({ name: `💙 Externals Given (${feedback.externalsGiven.length})`, value });
  } else {
    embed.addFields({ name: "💙 Externals Given", value: "None used all night" });
  }

  const prepIssues = formatPrepIssues(feedback.prepCheck);
  embed.addFields({
    name: "🧵 Missing Prep",
    value: prepIssues || "Fully prepped all night! 🎉",
  });

  // Only shown for classes that actually provide one of the tracked raid buffs —
  // no point telling a Rogue they "kept up" a buff they never had to maintain.
  if (feedback.raidBuffProvided) {
    const value =
      feedback.raidBuffLapses.length > 0
        ? formatRaidBuffLapses(feedback.raidBuffLapses)
        : `Kept **${feedback.raidBuffProvided}** up all night! 🎉`;
    embed.addFields({ name: "🎺 Raid Buff Uptime", value });
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
    .setDescription(`${analysis.pulls.length} pulls analyzed` + combinedReportsNote(analysis.reportCodes, analysis.duplicatesDropped));

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
