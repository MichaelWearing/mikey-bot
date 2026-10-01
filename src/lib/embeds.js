import { EmbedBuilder } from "discord.js";
import { randomPraise } from "./praise.js";

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
function ordinal(n) {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

// " — 4th worst of 16, 112% above raid avg" for a lower-is-better count. "16th of 20"
// reads as a placing, not a warning — the raid lead had to stop and work out which
// end was good — so this names the end the player is actually near instead: top half
// is "3rd cleanest", bottom half is "4th worst", the very worst is "most in the raid".
function lowerIsBetterSuffix(count, standing) {
  if (!standing) return "";
  const { rank, worstRank, raidCount, raidAvg } = standing;
  const clauses = [];
  if (rank * 2 <= raidCount) clauses.push(`${ordinal(rank)} cleanest of ${raidCount}`);
  else if (worstRank === 1) clauses.push(`most in the raid (of ${raidCount})`);
  else clauses.push(`${ordinal(worstRank)} worst of ${raidCount}`);
  // Skipped when the whole raid is on 0 — "n% below an average of 0" means nothing.
  if (raidAvg > 0) {
    const pct = Math.round((Math.abs(count - raidAvg) / raidAvg) * 100);
    clauses.push(count <= raidAvg ? `${pct}% below raid avg` : `${pct}% above raid avg`);
  }
  return ` — ${clauses.join(", ")}`;
}

function deathPositionNote(deathNumber) {
  const others = deathNumber - 1;
  if (others === 0) return "first to die";
  return `${others} other${others === 1 ? "" : "s"} already dead`;
}

const MAX_WIPE_DEATHS_SHOWN = 3;
const MAX_KILL_DEATHS_SHOWN = 10; // safety ceiling only — kills rarely have many deaths
const FIELD_VALUE_LIMIT = 1024;
// Roughly 40 chars a line once ANSI colour codes are counted, so 18 names plus the
// caveat still clears FIELD_VALUE_LIMIT with room to spare.
const DEATHLESS_NAMES_SHOWN = 18;

// Shared "did they have a defensive" line for a death with nothing used. Cooldown-
// aware: names what was actually available, or greys the whole thing out when every
// real emergency defensive was genuinely down.
function noDefensiveStatusLine(d) {
  if (!d.defensivePreventable) {
    return `  ${ANSI.gray}(unavoidable — no defensive prevents this)${ANSI.reset}`;
  }
  const potNote = d.healthConsumableAvailable ? " (health pot/stone still up)" : "";
  if (d.hadDefensiveAvailable === false) {
    return d.healthConsumableAvailable
      ? `  ${ANSI.red}✗ every cooldown was down — but you still had a health pot/stone${ANSI.reset}`
      : `  ${ANSI.gray}✗ used nothing — every defensive was on cooldown${ANSI.reset}`;
  }
  if (d.availableDefensives && d.availableDefensives.length > 0) {
    return `  ${ANSI.red}✗ used nothing — had ${d.availableDefensives.join(", ")} available${potNote}${ANSI.reset}`;
  }
  return `  ${ANSI.red}✗ no defensive used${potNote}${ANSI.reset}`;
}

function deathBlock(d) {
  if (d.isCalledWipe) {
    return [
      `🏳️ ${ANSI.gray}${classEmoji(d.playerClass)} ${d.playerName}${ANSI.reset} — died to ${d.killedBy} at ${d.timeIntoPull} (${deathPositionNote(d.deathNumber)})`,
      `  ${ANSI.gray}(5+ people died to this together — likely a called wipe, not counted against anyone)${ANSI.reset}`,
    ].join("\n");
  }

  if (d.raidEffectivelyWiped) {
    return [
      `🏳️ ${ANSI.gray}${classEmoji(d.playerClass)} ${d.playerName}${ANSI.reset} — died to ${d.killedBy} at ${d.timeIntoPull} (${deathPositionNote(d.deathNumber)})`,
      `  ${ANSI.gray}(half the raid was already down — pull was over, not counted against anyone)${ANSI.reset}`,
    ].join("\n");
  }

  const nameColor = d.isTrigger ? ANSI.yellow : d.isChained ? ANSI.gray : ANSI.bold;
  const tag = d.isTrigger ? "🎯 " : d.isChained ? "↳ " : "";
  const lines = [
    `${tag}${nameColor}${classEmoji(d.playerClass)} ${d.playerName}${ANSI.reset} — died to ${d.killedBy} at ${d.timeIntoPull} (${deathPositionNote(d.deathNumber)})`,
  ];

  if (d.isTrigger) {
    lines.push(`  ${ANSI.yellow}⚠ likely wipe trigger${ANSI.reset}`);
  } else if (d.isChained) {
    lines.push(`  ${ANSI.gray}(+${Math.round(d.gapMs / 1000)}s — part of the same cascade)${ANSI.reset}`);
  } else if (d.isNearbyUnrelated) {
    lines.push(`  ${ANSI.gray}(+${Math.round(d.gapMs / 1000)}s after previous death — different cause)${ANSI.reset}`);
  }

  if (d.sharedMomentCount > 0) {
    lines.push(
      `  ${ANSI.gray}(${d.sharedMomentCount} other${d.sharedMomentCount === 1 ? "" : "s"} also died to ${d.killedBy} within the same second — may be a shared mechanic)${ANSI.reset}`
    );
  }

  if (d.defensiveUsed) {
    lines.push(`  ${ANSI.green}✓ used ${d.defensiveUsed}${ANSI.reset}`);
  }
  if (d.externalAbility) {
    lines.push(`  ${ANSI.cyan}💙 ${d.externalHealer} tried to save them with ${d.externalAbility}${ANSI.reset}`);
  }
  if (!d.defensiveUsed && !d.externalAbility) {
    lines.push(noDefensiveStatusLine(d));
  }

  return lines.join("\n");
}

function buildDeathsField(pull) {
  const totalDeaths = pull.deaths.length;

  if (totalDeaths === 0) {
    return { name: "Deaths", value: "None 🎉" };
  }

  const hardCap = pull.kill ? MAX_KILL_DEATHS_SHOWN : MAX_WIPE_DEATHS_SHOWN;
  // Individual mistakes first, then called-wipe pile-ons, then deaths into an
  // already-lost pull — a mass "wipe called" moment shouldn't eat the only few
  // visible slots and bury what actually mattered.
  const isBackground = (d) => d.isCalledWipe || d.raidEffectivelyWiped;
  const prioritized = pull.kill
    ? pull.deaths
    : [...pull.deaths.filter((d) => !isBackground(d)), ...pull.deaths.filter(isBackground)];
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

function formatPrepIssues({ missingEnchantSlots, missingPrimaryStatGem, missingFlaskPulls, missingFoodPulls, missingWeaponEnchantPulls }) {
  const parts = [];
  if (missingEnchantSlots.length > 0) parts.push(`missing enchant: ${missingEnchantSlots.join(", ")}`);
  if (missingPrimaryStatGem) parts.push(`no primary stat gem (Eversong Diamond)`);
  if (missingFlaskPulls.length > 0) parts.push(`no flask (Pull ${formatPullList(missingFlaskPulls)})`);
  if (missingFoodPulls.length > 0) parts.push(`no food (Pull ${formatPullList(missingFoodPulls)})`);
  if (missingWeaponEnchantPulls.length > 0) parts.push(`no weapon oil (Pull ${formatPullList(missingWeaponEnchantPulls)})`);
  return parts.join(", ");
}

// Pull numbers are capped so a rough night can't blow past Discord's 1024-char field.
const BUFF_LAPSE_PULLS_SHOWN = 6;

function clockFromMs(ms) {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// This field exists to catch two specific failures and nothing else: starting a pull
// without buffing, and not re-buffing someone who lost it mid-fight (almost always a
// rez). Earlier versions reported uptime percentages and total downtime summed across
// raiders — "down 60:37" on a night that wasn't 60 minutes long — which was noise the
// raid lead couldn't act on. Counts of actual misses, plain language, nothing else.
function buffMissClauses(b) {
  const clauses = [];
  // Counts are raider-per-pull, not distinct people — the same raider starting three
  // pulls unbuffed is three misses, which is the number that matters here.
  if (b.startMissCount > 0) {
    clauses.push(`${b.startMissCount}x someone started a pull without it`);
  }
  if (b.rebuffMissCount > 0) {
    clauses.push(`${b.rebuffMissCount}x someone lost it mid-pull and never got it back`);
  }
  return clauses;
}

function formatRaidBuffLapsesShort(raidBuffLapses) {
  return raidBuffLapses.map((b) => `${b.buffName}: ${buffMissClauses(b).join(", ")}`).join("; ");
}

function formatRaidBuffLapses(raidBuffLapses) {
  return raidBuffLapses
    .map((b) => {
      const shown = b.lapsePulls.slice(0, BUFF_LAPSE_PULLS_SHOWN);
      const extra = b.lapsePulls.length - shown.length;
      const pulls = `Pull${shown.length === 1 ? "" : "s"} ${shown.map((n) => `#${n}`).join(", ")}${extra > 0 ? ` +${extra} more` : ""}`;
      const worst = b.worstPlayerName ? ` Longest: ${b.worstPlayerName} went ${clockFromMs(b.worstGapMs)} without it.` : "";
      return `${b.buffName} — ${buffMissClauses(b).join(", ")} (${pulls}).${worst}`;
    })
    .join("\n");
}

function addSummaryField(embed, name, list, formatter, { inline = true, caveat = null } = {}) {
  if (list.length === 0) return;
  let value = "```ansi\n" + list.map(formatter).join("\n") + "\n```";
  if (caveat) value += `\n*${caveat}*`;
  embed.addFields({ name, value, inline });
}

const HERO_UPGRADE_GOAL = 3;

// lacking: [{ class, name, heroTrackMaxCount }] — everyone under the goal, already
// filtered/sorted by the caller (checkHeroUpgrades.js). Empty means everyone's clear.
export function buildHeroUpgradeCheckEmbed(lacking, reportTitle) {
  const embed = new EmbedBuilder()
    .setColor(lacking.length > 0 ? WIPE_COLOR : KILL_COLOR)
    .setTitle(`💎 Hero 6/6 Upgrade Check — ${reportTitle}`)
    .setDescription(`Goal: ${HERO_UPGRADE_GOAL} items at Hero 6/6 (ilvl 321).`);

  if (lacking.length === 0) {
    embed.addFields({ name: "Status", value: "✅ Everyone on the roster has hit the goal." });
    return embed;
  }

  const lines = lacking.map((p) => summaryLine(p, `${p.heroTrackMaxCount}/${HERO_UPGRADE_GOAL}`, ANSI.red));
  embed.addFields({
    name: `Still short (${lacking.length})`,
    value: "```ansi\n" + lines.join("\n") + "\n```",
  });
  embed.setFooter({ text: "Item-level proxy — can't confirm upgrades came from 3/6 specifically, see /summary caveats" });
  return embed;
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
  // Deliberately uncapped-ish: this is praise, so everyone who earned it should see
  // their name. The slice is only a guard against Discord's 1024-char field limit on
  // a farm night where most of the raid goes clean — the header still shows the real
  // total, and the caveat names how many didn't fit.
  const deathless = summary.deathlessRaiders ?? [];
  const deathlessShown = deathless.slice(0, DEATHLESS_NAMES_SHOWN);
  const deathlessExtra = deathless.length - deathlessShown.length;
  addSummaryField(
    embed,
    `🌟 No Deaths (${deathless.length}) — ${randomPraise("group")}`,
    deathlessShown,
    (p) => summaryLine(p, `${p.attendedPulls} pull${p.attendedPulls === 1 ? "" : "s"} clean`, ANSI.green),
    {
      caveat:
        (deathlessExtra > 0 ? `+${deathlessExtra} more not shown — ` : "") +
        "survived every pull they were in; deaths after the pull was already lost (3+ deaths in) don't count against anyone",
    }
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
    (p) => {
      const nothing = p.noDefensiveCount;
      const pct = Math.round((nothing / p.judgeableDeaths) * 100);
      return summaryLine(
        p,
        `nothing up for ${nothing}/${p.judgeableDeaths} avoidable death${p.judgeableDeaths === 1 ? "" : "s"} (${pct}%)`,
        ANSI.red
      );
    },
    { caveat: "only counts deaths a cooldown could have helped, and only what was off CD at the time" }
  );
  addSummaryField(
    embed,
    "🎯 Most Interrupts",
    summary.mostInterrupts,
    (p) =>
      summaryLine(p, `${p.interruptCount} kick${p.interruptCount === 1 ? "" : "s"}` + (p.interruptViaPetCount > 0 ? ` (${p.interruptViaPetCount} via pet)` : ""), ANSI.cyan),
    { caveat: "healers other than Resto Shaman aren't ranked here" }
  );
  addSummaryField(embed, "💧 Most Dispels", summary.mostDispels, (p) =>
    summaryLine(p, `${p.dispelCount} dispel${p.dispelCount === 1 ? "" : "s"}`, ANSI.cyan)
  );
  addSummaryField(
    embed,
    "❤️‍🩹 Most Combat Resurrections",
    summary.mostCombatRes,
    (p) => summaryLine(p, `${p.combatResCount}x`, ANSI.green),
    {
      caveat:
        "counts whoever actually brought someone back — Rebirth, Raise Ally, Intercession or Soulstone. Ignores self-resurrects and rezzes thrown after the pull was already lost (3+ deaths in)",
    }
  );
  addSummaryField(
    embed,
    "🪦 Never Used Their Battle Rez",
    summary.neverCombatRessed ?? [],
    (p) => summaryLine(p, `0x in ${p.attendedPulls} pull${p.attendedPulls === 1 ? "" : "s"}`, ANSI.red),
    {
      caveat:
        "Druids, Death Knights and Warlocks — the classes where every spec has a rez. Paladins aren't listed, since Intercession is a talent they may not have taken (their rezzes still count above). Only shown when someone else did land a rez",
    }
  );
  addSummaryField(
    embed,
    "🧪 No DPS Potions",
    summary.noDpsPotions,
    (p) => summaryLine(p, `0 across ${p.attendedPulls} pull${p.attendedPulls === 1 ? "" : "s"}`, ANSI.yellow),
    { caveat: "free parse left on the table" }
  );
  addSummaryField(
    embed,
    "🧴 Still Using Old Silvermoon Potion",
    summary.usingOutdatedHealthPotion,
    (p) => summaryLine(p, `${p.oldHealthPotionCount}x old, 0x new`, ANSI.yellow),
    { caveat: "Concentrated Silvermoon Health Potion is a straight upgrade" }
  );
  addSummaryField(
    embed,
    "🚫 Least Defensives Used",
    summary.leastDefensivesUsed,
    (p) => summaryLine(p, `0 across ${p.attendedPulls} pull${p.attendedPulls === 1 ? "" : "s"}`, ANSI.red),
    { caveat: "personal defensives/self-heals only, not externals given to others" }
  );
  addSummaryField(embed, "💙 Most Support Given", summary.mostSupportGiven, (p) => {
    const bits = [];
    if (p.externalsGivenCount > 0) bits.push(`${p.externalsGivenCount} external${p.externalsGivenCount === 1 ? "" : "s"}`);
    if (p.innervatesCast > 0) bits.push(`${p.innervatesCast} Innervate${p.innervatesCast === 1 ? "" : "s"}`);
    return summaryLine(p, bits.join(", "), ANSI.cyan);
  });
  addSummaryField(
    embed,
    "🔥 Most Damage During Dig In (Sszorak)",
    summary.mostDigInWindowDamage,
    (p) => summaryLine(p, `${Math.round(p.digInWindowDamageTotal).toLocaleString()}`, ANSI.green),
    { caveat: "total damage dealt during the +30%-damage-taken window, summed across every pull" }
  );
  addSummaryField(
    embed,
    "🌪️ Most Caught by Tornadoes (Sszorak)",
    summary.mostTornadoHits,
    (p) => summaryLine(p, `${p.tornadoHitCount}x`, ANSI.red),
    { caveat: "tanks excluded — Tempest's upfront hit only, not the poison DoT it leaves behind, so dispelling the DoT doesn't erase the count. Provisional (cross-pull skew not yet fully verified) — ignores hits after the pull was already lost (3+ deaths in)" }
  );
  addSummaryField(
    embed,
    "🟢 Most Orb Carries (Coiled Altar)",
    summary.mostOrbCarries,
    (p) => summaryLine(p, `${p.orbCarryCount}x carried`, ANSI.green)
  );
  addSummaryField(
    embed,
    "🍖 Most Feast Soaks (Twin Fangs)",
    summary.mostFeastSoaks,
    (p) => summaryLine(p, `${p.feastSoakCount}x soaked`, ANSI.green)
  );
  addSummaryField(
    embed,
    "🟢 Most Caustic Globule Soaks (Twin Fangs)",
    summary.mostCausticGlobuleSoaks,
    (p) => summaryLine(p, `${p.causticGlobuleSoakCount}x`, ANSI.green)
  );
  addSummaryField(
    embed,
    "🔴 Least Caustic Globule Soaks (Twin Fangs)",
    summary.leastCausticGlobuleSoaks,
    (p) => summaryLine(p, `${p.causticGlobuleSoakCount}x`, ANSI.red),
    { caveat: "counts times the boss targeted them, not damage taken — an immunity can zero the hit but still counts as a soak" }
  );
  addSummaryField(
    embed,
    "🌊 Most Wave Stacks (Twin Fangs)",
    summary.mostWaveTouches,
    (p) => summaryLine(p, `${p.waveTouchCount} stack${p.waveTouchCount === 1 ? "" : "s"}`, ANSI.red),
    { caveat: "every touch adds an Eternal Venom stack, even the brief ones that deal no damage — ignores touches after the pull was already lost (3+ deaths in)" }
  );
  addSummaryField(
    embed,
    "🟢 Most Toxic Droplets Soaks (Entombed Sentinels)",
    summary.mostToxicDropletSoaks,
    (p) => summaryLine(p, `${p.toxicDropletSoakCount}x`, ANSI.green)
  );
  addSummaryField(
    embed,
    "🔴 Least Toxic Droplets Soaks (Entombed Sentinels)",
    summary.leastToxicDropletSoaks,
    (p) => summaryLine(p, `${p.toxicDropletSoakCount}x`, ANSI.red)
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
    (p) => summaryLine(p, formatRaidBuffLapsesShort(p.raidBuffLapses), ANSI.yellow),
    {
      inline: false,
      caveat:
        "counts raiders who went without the buff, from real apply/remove events. Time spent dead isn't counted, nor gaps under 10s (a rez re-buff a few seconds late is fine), nor pulls under a minute",
    }
  );

  if (embed.data.fields === undefined || embed.data.fields.length === 0) {
    embed.addFields({ name: "Not enough data", value: "Nobody stood out this session — nicely balanced night." });
  }

  return embed;
}

// Discord caps a single embed at 6000 characters AND one message at 6000 across all
// its embeds, so an oversized summary has to become several MESSAGES, not several
// embeds in one. The summary quietly grew past 6000 as stats were added — every field
// was individually under the 1024 limit, so nothing caught it until Discord rejected
// the whole thing and the command died with a blank "Something went wrong".
// Splitting here means the next stat added can't resurrect that failure.
const EMBED_TOTAL_LIMIT = 6000;
const EMBED_SPLIT_BUDGET = 5500; // headroom for the continuation title

export function buildSummaryEmbeds(summary) {
  const full = buildSummaryEmbed(summary);
  if (embedLength(full) <= EMBED_TOTAL_LIMIT) return [full];

  const { fields = [], ...base } = full.data;
  const embeds = [];
  let current = null;
  let currentLength = 0;

  for (const field of fields) {
    const fieldLength = (field.name?.length ?? 0) + (field.value?.length ?? 0);
    if (current === null || currentLength + fieldLength > EMBED_SPLIT_BUDGET) {
      current = embeds.length === 0
        ? new EmbedBuilder({ ...base, fields: [] })
        : new EmbedBuilder({ color: base.color, title: `${base.title} (cont.)` });
      embeds.push(current);
      currentLength = embedLength(current);
    }
    current.addFields(field);
    currentLength += fieldLength;
  }

  return embeds;
}

function characterTag(name, className) {
  return `${classEmoji(className)} ${ANSI.bold}${name}${ANSI.reset}`;
}

function feedbackDeathLine(d) {
  const status = d.defensiveUsed
    ? `  ${ANSI.green}✓ used ${d.defensiveUsed}${ANSI.reset}`
    : d.externalAbility
    ? `  ${ANSI.cyan}💙 ${d.externalHealer} tried to save them with ${d.externalAbility}${ANSI.reset}`
    : noDefensiveStatusLine(d);
  const pullTag = d.kill ? "Kill" : "Wipe";
  const sharedMomentNote =
    d.sharedMomentCount > 0
      ? `\n  ${ANSI.gray}(${d.sharedMomentCount} other${d.sharedMomentCount === 1 ? "" : "s"} also died to ${d.killedBy} within the same second — may be a shared mechanic)${ANSI.reset}`
      : "";
  return (
    `${characterTag(d.characterName, d.characterClass)} — Pull #${d.pullNumber} — ${d.bossName} (${pullTag}) — died to ${d.killedBy} at ${d.timeIntoPull} (${deathPositionNote(d.deathNumber)})` +
    sharedMomentNote +
    `\n${status}`
  );
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

  // Parses were removed from personal feedback on raider request — too noisy a
  // personal signal and it read as judgy. The raid-wide leaderboard in /summary
  // keeps them.

  if (feedback.interruptExemptHealer) {
    // Healer (non–Resto Shaman) — no kick standard, so the stat is hidden entirely.
  } else if (feedback.interrupts.length > 0) {
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

  if (feedback.dispels && feedback.dispels.length > 0) {
    const total = feedback.dispels.reduce((sum, d) => sum + d.count, 0);
    const lines = [...feedback.dispels]
      .sort((a, b) => b.count - a.count)
      .slice(0, 10)
      .map((d) => `${ANSI.cyan}${d.ability}${ANSI.reset} x${d.count}`);
    embed.addFields({
      name: `💧 Dispels (${total})`,
      value: "```ansi\n" + lines.join("\n") + "\n```",
      inline: true,
    });
  }

  {
    const ivLines = [];
    if (feedback.innervatesGiven && feedback.innervatesGiven.length > 0) {
      const byTarget = new Map();
      for (const iv of feedback.innervatesGiven) {
        const key = iv.selfCast ? "(self)" : iv.targetName ?? "someone";
        byTarget.set(key, (byTarget.get(key) ?? 0) + 1);
      }
      ivLines.push(
        `${ANSI.green}Given:${ANSI.reset} ` +
          [...byTarget.entries()].map(([name, n]) => `${name} x${n}`).join(", ")
      );
    }
    if (feedback.innervatesReceived && feedback.innervatesReceived.length > 0) {
      const bySource = new Map();
      for (const iv of feedback.innervatesReceived) {
        bySource.set(iv.sourceName ?? "someone", (bySource.get(iv.sourceName ?? "someone") ?? 0) + 1);
      }
      ivLines.push(
        `${ANSI.cyan}Received:${ANSI.reset} ` +
          [...bySource.entries()].map(([name, n]) => `${name} x${n}`).join(", ")
      );
    }
    if (ivLines.length > 0) {
      embed.addFields({ name: "🌿 Innervate", value: "```ansi\n" + ivLines.join("\n") + "\n```", inline: true });
    }
  }

  if (feedback.combatResGiven && feedback.combatResGiven.length > 0) {
    const lines = feedback.combatResGiven.map(
      (r) =>
        `${ANSI.green}${r.ability}${ANSI.reset} → ${r.targetName ?? "someone"} ${ANSI.gray}(Pull #${r.pullNumber}, ${r.bossName})${ANSI.reset}`
    );
    embed.addFields({
      name: `❤️‍🩹 Combat Resurrections (${feedback.combatResGiven.length})`,
      value: "```ansi\n" + lines.join("\n") + "\n```",
      inline: true,
    });
  }

  {
    const usedLines =
      feedback.defensivesUsed.length > 0
        ? feedback.defensivesUsed.map(
            (d) => `${classEmoji(d.characterClass)} ${d.characterName}${ANSI.reset}: ${ANSI.green}${d.name}${ANSI.reset} x${d.count}`
          )
        : ["None used all night"];
    if (feedback.unusedDefensives?.length > 0) {
      usedLines.push(`${ANSI.red}Never used: ${feedback.unusedDefensives.join(", ")}${ANSI.reset}`);
    }
    embed.addFields({ name: "🛡️ Defensives Used", value: "```ansi\n" + usedLines.join("\n\n") + "\n```", inline: true });
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
    // Breakdown by ability — "26x Blessing of Sacrifice, 20x Lay on Hands" reads
    // better than a line per target, especially for a healer who does it every pull.
    const byAbility = new Map();
    for (const e of feedback.externalsGiven) byAbility.set(e.ability, (byAbility.get(e.ability) ?? 0) + 1);
    const lines = [...byAbility.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([ability, count]) => `${ANSI.cyan}${count}x ${ability}${ANSI.reset}`);
    embed.addFields({
      name: `💙 Externals Given (${feedback.externalsGiven.length})`,
      value: "```ansi\n" + lines.join("\n") + "\n```",
    });
  } else {
    embed.addFields({ name: "💙 Externals Given", value: "None used all night" });
  }

  // Trash standing — only present when they're top-5 or bottom-5 of the trash ranking.
  if (feedback.trashStanding) {
    const t = feedback.trashStanding;
    const metric = t.isHealer ? "healing" : "damage";
    const color = t.top ? ANSI.green : ANSI.red;
    const place = t.top ? `#${t.rank} of ${t.size}` : `#${t.rank} of ${t.size} (bottom ${t.size - t.rank + 1})`;
    embed.addFields({
      name: "🗑️ Trash",
      value:
        "```ansi\n" +
        `${color}${place} on trash ${metric}${ANSI.reset} — ${Math.round(t.total).toLocaleString()}\n` +
        "```",
      inline: true,
    });
  }

  // Only shown when a mechanic count is a genuine outlier (well above or below the
  // rest of the raid) — if everyone carried 3-4 orbs, that's the mechanic working as
  // designed, not something worth calling out for any one person. Dig In and tornado
  // hits don't need that outlier gate — a raw damage total or hit count (plus its
  // raid-rank comparison) is worth showing on its own, including a clean 0x tornado
  // night, which is the best possible outcome and worth surfacing as "1st."
  const bossMechanicLines = [];
  if (feedback.orbCarryStandout === "high") bossMechanicLines.push(`🟢 Orb Carries (Coiled Altar): ${feedback.orbCarryCount}x — above raid average`);
  else if (feedback.orbCarryStandout === "low") bossMechanicLines.push(`🔴 Orb Carries (Coiled Altar): ${feedback.orbCarryCount}x — below raid average`);
  if (feedback.feastSoakStandout === "high") bossMechanicLines.push(`🍖 Feast Soaks (Twin Fangs): ${feedback.feastSoakCount}x — above raid average`);
  else if (feedback.feastSoakStandout === "low") bossMechanicLines.push(`🔴 Feast Soaks (Twin Fangs): ${feedback.feastSoakCount}x — below raid average`);
  if (feedback.toxicDropletSoakStandout === "high") bossMechanicLines.push(`🟢 Toxic Droplets Soaks (Entombed Sentinels): ${feedback.toxicDropletSoakCount}x — above raid average`);
  else if (feedback.toxicDropletSoakStandout === "low") bossMechanicLines.push(`🔴 Toxic Droplets Soaks (Entombed Sentinels): ${feedback.toxicDropletSoakCount}x — below raid average`);
  if (feedback.digInWindowDamageTotal > 0) {
    const total = Math.round(feedback.digInWindowDamageTotal).toLocaleString();
    const clauses = [];
    if (feedback.digInWindowDamageRank && feedback.digInWindowDamageRaidCount) {
      clauses.push(`${ordinal(feedback.digInWindowDamageRank)} of ${feedback.digInWindowDamageRaidCount}`);
    }
    if (feedback.digInWindowDamageRaidAvg) {
      const avg = feedback.digInWindowDamageRaidAvg;
      const pct = Math.round((Math.abs(feedback.digInWindowDamageTotal - avg) / avg) * 100);
      clauses.push(feedback.digInWindowDamageTotal >= avg ? `${pct}% above raid avg` : `${pct}% below raid avg`);
    }
    const suffix = clauses.length > 0 ? ` — ${clauses.join(", ")}` : "";
    bossMechanicLines.push(`🔥 Damage During Dig In (Sszorak): ${total}${suffix}`);
  }
  if (feedback.tornadoHitCount > 0 || feedback.tornadoHitStanding) {
    bossMechanicLines.push(
      `🌪️ Caught by Tornadoes (Sszorak): ${feedback.tornadoHitCount}x${lowerIsBetterSuffix(feedback.tornadoHitCount, feedback.tornadoHitStanding)}`
    );
  }
  if (feedback.waveTouchCount > 0 || feedback.waveTouchStanding) {
    bossMechanicLines.push(
      `🌊 Wave Stacks (Twin Fangs): ${feedback.waveTouchCount}x${lowerIsBetterSuffix(feedback.waveTouchCount, feedback.waveTouchStanding)}`
    );
  }
  if (bossMechanicLines.length > 0) {
    embed.addFields({ name: "⚙️ Boss Mechanic Engagement", value: bossMechanicLines.join("\n") });
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
        ? formatRaidBuffLapses(feedback.raidBuffLapses) +
          "\n*Counts raiders who went without your buff — either they started the pull without it, or they lost it mid-fight (usually a rez) and never got it back. Time spent dead isn't counted against you, nor gaps under 10s. Only pulls over a minute are checked.*"
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

function trashDurationText(ms) {
  const totalMinutes = Math.round(ms / 60000);
  return `${totalMinutes} min${totalMinutes === 1 ? "" : "s"}`;
}

function trashRosterLine(p) {
  const color = p.isHealer ? ANSI.cyan : ANSI.green;
  const unit = p.isHealer ? "healing" : "damage";
  // Alts are merged into one row, but named, so the total is never a mystery.
  const alts = p.alts?.length ? ` ${ANSI.gray}(+${p.alts.join(", ")})${ANSI.reset}` : "";
  return `${classEmoji(p.class)} ${p.name}${ANSI.reset}${alts}: ${color}${Math.round(p.total).toLocaleString()} ${unit}${ANSI.reset}`;
}

// Splits a full roster into as many fields as it takes to show everyone, each
// staying under Discord's per-field character limit — this list is deliberately
// uncapped (no top-N cut), so it needs real chunking rather than a "+N more" note.
function chunkRosterFields(embed, baseName, lines) {
  const fenceOverhead = "```ansi\n".length + "\n```".length;
  const chunks = [[]];
  let chunkLength = 0;
  for (const line of lines) {
    const addLength = line.length + 1;
    if (chunks[chunks.length - 1].length > 0 && fenceOverhead + chunkLength + addLength > FIELD_VALUE_LIMIT) {
      chunks.push([]);
      chunkLength = 0;
    }
    chunks[chunks.length - 1].push(line);
    chunkLength += addLength;
  }
  chunks.forEach((chunk, i) => {
    const name = chunks.length > 1 ? `${baseName} (${i + 1}/${chunks.length})` : baseName;
    embed.addFields({ name, value: "```ansi\n" + chunk.join("\n") + "\n```", inline: true });
  });
}

export function buildTrashDamageEmbed(trash) {
  const embed = new EmbedBuilder()
    .setColor(0x8e7cc3)
    .setTitle(`🗑️ Trash Damage — ${trash.title}`)
    .setURL(`https://www.warcraftlogs.com/reports/${trash.reportCode}`)
    .setDescription(
      `${trash.trashPullCount} trash pull${trash.trashPullCount === 1 ? "" : "s"}, ${trashDurationText(trash.totalTrashDurationMs)} total` +
        combinedReportsNote(trash.reportCodes, 0) +
        `\n*Sorted by total damage/healing across all trash this report — healers on healing, everyone else on damage, ` +
        `role from the report's own boss-kill rankings. ` +
        `No loot data — WCL's API has no event type for loot/chests, so that's not something this can show.*`
    );

  if (trash.roster.length > 0) {
    chunkRosterFields(embed, "⚔️ Trash Damage/Healing", trash.roster.map(trashRosterLine));
  } else {
    embed.addFields({ name: "Trash", value: "No real trash pulls found in this report." });
  }

  return embed;
}

export function buildPadEmbed(pad) {
  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle(`🎯 Padding Check — ${pad.title}`)
    .setURL(`https://www.warcraftlogs.com/reports/${pad.reportCode}`)
    .setDescription(
      `Tracked fights: ${pad.targets.map((t) => t.bossName).join(", ")}` +
        combinedReportsNote(pad.reportCodes, 0) +
        `\n*Two signals below: confirmed hits are a known AoE-only ability landing on the add at all (see /request-pad-check) ` +
        `— that alone is deliberate. Volume outliers are total damage from any ability, well above the rest of the raid — ` +
        `check the top ability shown before assuming it's deliberate, since that one isn't ability-gated.*`
    );

  for (const target of pad.targets) {
    if (target.confirmedPadders.length > 0) {
      const lines = target.confirmedPadders.map(
        (p) =>
          `${classEmoji(p.class)} ${p.name}${ANSI.reset}: ${ANSI.red}${p.confirmedDamage.toLocaleString()}${ANSI.reset} — ${p.topConfirmedAbility}`
      );
      embed.addFields({
        name: `${target.bossName} — ${target.targetName}: Confirmed Hits (${target.confirmedPadders.length})`,
        value: "```ansi\n" + lines.join("\n") + "\n```",
      });
    }

    if (target.volumeOutliers.length > 0) {
      const lines = target.volumeOutliers.map(
        (p) => `${classEmoji(p.class)} ${p.name}${ANSI.reset}: ${ANSI.yellow}${p.damage.toLocaleString()}${ANSI.reset} — mostly ${p.topAbility}`
      );
      embed.addFields({
        name: `${target.bossName} — ${target.targetName}: Volume Outliers (${target.volumeOutliers.length})`,
        value: "```ansi\n" + lines.join("\n") + "\n```",
      });
    }

    if (target.confirmedPadders.length === 0 && target.volumeOutliers.length === 0) {
      embed.addFields({ name: `${target.bossName} — ${target.targetName}`, value: "No padding found." });
    }
  }

  return embed;
}

export function buildTwinFangKicksEmbed(result) {
  const embed = new EmbedBuilder()
    .setColor(0x1abc9c)
    .setTitle(`🐍 Twin Fangs Kicks — ${result.title}`)
    .setURL(`https://www.warcraftlogs.com/reports/${result.reportCode}`);

  if (result.pullCount === 0) {
    embed.setDescription(`No Twin Fangs pulls found in this report.` + combinedReportsNote(result.reportCodes, result.duplicatesDropped));
    return embed;
  }

  embed.setDescription(
    `${result.pullCount} pull${result.pullCount === 1 ? "" : "s"}${result.killed ? " (killed)" : ""}` +
      combinedReportsNote(result.reportCodes, result.duplicatesDropped) +
      `\n*Assigned kickers should be roughly equal — judged on kicks per pull present (group avg ${result.avgRate.toFixed(1)}/pull, ` +
      `even share ${result.fairSharePct.toFixed(0)}% each). 🔴 under ${Math.round(result.behindRatio * 100)}% of avg, 🟡 over ${Math.round(result.aheadRatio * 100)}%.*`
  );

  const standingStyle = {
    behind: { icon: "🔴", color: ANSI.red },
    ahead: { icon: "🟡", color: ANSI.yellow },
    even: { icon: "🟢", color: ANSI.green },
    absent: { icon: "⚪", color: ANSI.gray },
  };
  const lines = result.kickers.map((k) => {
    const { icon, color } = standingStyle[k.standing];
    if (k.standing === "absent") return `${icon} ${color}${k.name}${ANSI.reset} — not in any Twin Fangs pull`;
    return (
      `${icon} ${classEmoji(k.class)} ${color}${k.name}${ANSI.reset} — ${k.kicks} kick${k.kicks === 1 ? "" : "s"} ` +
      `(${k.rate.toFixed(1)}/pull over ${k.pullsPresent}, ${k.sharePct.toFixed(0)}% of group)`
    );
  });
  embed.addFields({ name: "🎯 Kick Group", value: "```ansi\n" + lines.join("\n") + "\n```" });

  const pullLines = result.perPull.map(
    (p) =>
      `#${p.pullNumber}${p.kill ? " ✅" : ""}: ` +
      (p.counts.length > 0 ? p.counts.map((c) => `${c.name} ${c.kicks}`).join(" · ") : "no kick group present")
  );
  chunkRosterFields(embed, "📋 Per Pull", pullLines);

  if (result.otherKickers.length > 0) {
    const otherLines = result.otherKickers
      .slice(0, 5)
      .map((o) => `${classEmoji(o.class)} ${o.name}${ANSI.reset} — ${o.kicks} kick${o.kicks === 1 ? "" : "s"}`);
    embed.addFields({ name: "🛡️ Everyone Else (tanks etc., context only)", value: "```ansi\n" + otherLines.join("\n") + "\n```" });
  }

  return embed;
}

export function buildOrbCarryEmbed(result) {
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`🟢 Coiled Altar Orb Carries — ${result.title}`)
    .setURL(`https://www.warcraftlogs.com/reports/${result.reportCode}`);

  if (result.pullCount === 0) {
    embed.setDescription(
      `No Coiled Altar pulls found in this report.` + combinedReportsNote(result.reportCodes, result.duplicatesDropped)
    );
    return embed;
  }

  // Purple only exists on Mythic, so the split is only worth explaining once it shows up.
  const split = result.totalPurple > 0 ? ` (${result.totalGreen} green, ${result.totalPurple} purple)` : "";
  embed.setDescription(
    `${result.totalOrbs} orbs carried${split} across ${result.pullCount} pull${result.pullCount === 1 ? "" : "s"}` +
      combinedReportsNote(result.reportCodes, result.duplicatesDropped) +
      `\n*Carrying is the job — more is better, so the people to look at are at the bottom. ` +
      `Even split would be ~${result.fairShare.toFixed(0)} each. Wipes stop counting after the 3rd death.*`
  );

  if (result.carriers.length > 0) {
    const lines = result.carriers.map((p) => {
      const detail = result.totalPurple > 0 ? ` ${ANSI.gray}(${p.green} green, ${p.purple} purple)${ANSI.reset}` : "";
      return `${classEmoji(p.class)} ${p.name} — ${ANSI.green}${p.orbs}x${ANSI.reset}${detail}`;
    });
    chunkRosterFields(embed, "🟢 Orbs Carried", lines);
  }

  if (result.neverCarried.length > 0) {
    const text = result.neverCarried.map((p) => p.name).join(", ");
    embed.addFields({
      name: `⚠️ Never Carried One (${result.neverCarried.length})`,
      value: text.length <= FIELD_VALUE_LIMIT ? text : text.slice(0, FIELD_VALUE_LIMIT - 1) + "…",
    });
  }

  return embed;
}

export function buildOrbSoakEmbed(result) {
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`🫧 Twin Fangs Orb Pickups — ${result.title}`)
    .setURL(`https://www.warcraftlogs.com/reports/${result.reportCode}`);

  if (result.pullCount === 0) {
    embed.setDescription(`No Twin Fangs pulls found in this report.` + combinedReportsNote(result.reportCodes, result.duplicatesDropped));
    return embed;
  }

  embed.setDescription(
    `${result.totalOrbs} Caustic Globule orbs picked up across ${result.pullCount} pull${result.pullCount === 1 ? "" : "s"}` +
      combinedReportsNote(result.reportCodes, result.duplicatesDropped) +
      `\n*Picking orbs up is the job — more is better. Even split would be ~${result.fairShare.toFixed(0)} each. ` +
      `Wipes stop counting after the 3rd death.*`
  );

  if (result.pickers.length > 0) {
    const lines = result.pickers.map((p) => `${classEmoji(p.class)} ${p.name} — ${ANSI.green}${p.orbs}x${ANSI.reset}`);
    chunkRosterFields(embed, "🫧 Orbs Picked Up", lines);
  }

  if (result.neverPickedUp.length > 0) {
    const text = result.neverPickedUp.map((p) => p.name).join(", ");
    embed.addFields({
      name: `⚠️ Never Picked One Up (${result.neverPickedUp.length})`,
      value: text.length <= FIELD_VALUE_LIMIT ? text : text.slice(0, FIELD_VALUE_LIMIT - 1) + "…",
    });
  }

  return embed;
}

export function buildWaveHitsEmbed(result) {
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`🌊 Twin Fangs Wave Stacks — ${result.title}`)
    .setURL(`https://www.warcraftlogs.com/reports/${result.reportCode}`);

  if (result.pullCount === 0) {
    embed.setDescription(`No Twin Fangs pulls found in this report.` + combinedReportsNote(result.reportCodes, result.duplicatesDropped));
    return embed;
  }

  embed.setDescription(
    `${result.totalStacks} extra Eternal Venom stacks from ${result.totalWaves} wave hits across ${result.pullCount} pull${result.pullCount === 1 ? "" : "s"}` +
      combinedReportsNote(result.reportCodes, result.duplicatesDropped) +
      `\n*Every wave touch is +1 stack, and staying in a wave keeps stacking — more stacks than waves means wading through them. ` +
      `Wipes stop counting after the 3rd death.*`
  );

  if (result.hit.length > 0) {
    const lines = result.hit.map(
      (p) =>
        `${classEmoji(p.class)} ${p.name} — ${ANSI.red}${p.stacks}x${ANSI.reset}  ` +
        `${ANSI.gray}(${p.waves} wave${p.waves === 1 ? "" : "s"})${ANSI.reset}`
    );
    chunkRosterFields(embed, "🌊 Stacks From Waves", lines);
  }

  const cleanText = result.clean.length > 0 ? result.clean.map((p) => p.name).join(", ") : "Nobody — everyone got hit at least once.";
  embed.addFields({
    name: `✅ Never Hit (${result.clean.length})`,
    value: cleanText.length <= FIELD_VALUE_LIMIT ? cleanText : cleanText.slice(0, FIELD_VALUE_LIMIT - 1) + "…",
  });

  return embed;
}
