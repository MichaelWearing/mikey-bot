import { cappedDeathsForTally, ORB_CARRY_BOSS_NAME, FEAST_SOAK_BOSS_NAME } from "./analyze.js";
import { classifyCast, OUTDATED_HEALTH_POTION_NAME, UPGRADED_HEALTH_POTION_NAME } from "./defensives.js";

function getPlayer(players, name, classHint) {
  if (!players.has(name)) {
    players.set(name, {
      name,
      class: classHint ?? null,
      role: null, // "tank" | "healer" | "dps" — only known once we've seen a kill-pull ranking entry
      totalDeaths: 0,
      wipeTriggerCount: 0,
      wipeTriggerAbilities: [],
      defensiveUsedCount: 0,
      noDefensiveCount: 0,
      judgeableDeaths: 0,
      digInAlignmentCount: 0,
      orbCarryCount: 0,
      feastSoakCount: 0,
      parsePercents: [],
      interruptCount: 0,
      interruptViaPetCount: 0,
      dpsPotionCount: 0,
      oldHealthPotionCount: 0,
      newHealthPotionCount: 0,
      defensiveCastCount: 0,
      externalsGivenCount: 0,
      attendedPulls: 0,
      firstPrepCheck: null,
      lastPrepCheck: null,
      missingFlaskPulls: [],
      missingFoodPulls: [],
      missingWeaponEnchantPulls: [],
      missedClassBuffPulls: new Map(), // buffName -> pull numbers this player (as provider) let lapse
    });
  }
  const p = players.get(name);
  if (!p.class && classHint) p.class = classHint;
  return p;
}

const MIN_DEATHS_FOR_DEFENSIVE_STATS = 2; // need a real sample before judging defensive habits
// Gated on attended pulls (kills + wipes), not kill pulls alone — a heavy-wipe night
// can have very few (or zero) kills, and these stats matter just as much on wipes.
const MIN_ATTENDED_PULLS_FOR_STAT = 3;
const TOP_N = 5;

function topByKey(roster, key, n = TOP_N) {
  return [...roster]
    .filter((p) => p[key] > 0)
    .sort((a, b) => b[key] - a[key])
    .slice(0, n);
}

export function buildNightSummary(analysis) {
  const players = new Map();
  // key: bossName -> { bossName, killed, wiped, firstPullNumber } — dungeon/M+ pulls
  // are already excluded upstream in analyzeReport, so this is raid content only.
  const bossStats = new Map();

  for (const pull of analysis.pulls) {
    const bossEntry = bossStats.get(pull.bossName) ?? {
      bossName: pull.bossName,
      killed: false,
      wiped: false,
      firstPullNumber: pull.pullNumber,
    };
    if (pull.kill) bossEntry.killed = true;
    else bossEntry.wiped = true;
    bossStats.set(pull.bossName, bossEntry);

    for (const d of cappedDeathsForTally(pull)) {
      const p = getPlayer(players, d.playerName, d.playerClass);
      p.totalDeaths += 1;
      if (d.isTrigger) {
        p.wipeTriggerCount += 1;
        p.wipeTriggerAbilities.push(d.killedBy);
      }
      if (d.defensivePreventable) {
        p.judgeableDeaths += 1;
        if (d.defensiveUsed) p.defensiveUsedCount += 1;
        else p.noDefensiveCount += 1;
      }
    }
    if (pull.digInBloodlust) {
      const p = getPlayer(players, pull.digInBloodlust.playerName, pull.digInBloodlust.playerClass);
      p.digInAlignmentCount += 1;
    }
    for (const o of pull.orbCarries ?? []) {
      const p = getPlayer(players, o.playerName, o.playerClass);
      p.orbCarryCount += 1;
    }
    for (const f of pull.feastSoaks ?? []) {
      const p = getPlayer(players, f.playerName, f.playerClass);
      p.feastSoakCount += 1;
    }
    for (const parse of pull.allParses ?? []) {
      const p = getPlayer(players, parse.name, parse.class);
      p.parsePercents.push(parse.rankPercent);
      if (parse.role) p.role = parse.role;
    }
    for (const i of pull.interrupts ?? []) {
      if (!i.sourceName) continue;
      const p = getPlayer(players, i.sourceName, i.sourceClass);
      p.interruptCount += 1;
      if (i.viaPet) p.interruptViaPetCount += 1;
    }
    for (const c of pull.casts ?? []) {
      if (!c.sourceName) continue;
      const classified = classifyCast(c);
      if (!classified) continue;
      const p = getPlayer(players, c.sourceName, c.sourceClass);
      if (classified.type === "consumable" && classified.category === "dps") {
        p.dpsPotionCount += 1;
      } else if (classified.type === "consumable" && c.abilityName === OUTDATED_HEALTH_POTION_NAME) {
        p.oldHealthPotionCount += 1;
      } else if (classified.type === "consumable" && c.abilityName === UPGRADED_HEALTH_POTION_NAME) {
        p.newHealthPotionCount += 1;
      } else if (classified.type === "defensive" && classified.countsTowardUsageStats) {
        p.defensiveCastCount += 1;
      } else if (classified.type === "external") {
        p.externalsGivenCount += 1;
      }
    }
    // Enchants checked at first/last appearance only (see missingEnchantSlots below);
    // flask/food/weapon oil checked every pull, since those run out mid-raid.
    for (const prepCheck of pull.prepChecks ?? []) {
      if (!prepCheck.playerName) continue;
      const p = getPlayer(players, prepCheck.playerName, prepCheck.playerClass);
      p.attendedPulls += 1;
      if (!p.firstPrepCheck) p.firstPrepCheck = prepCheck;
      p.lastPrepCheck = prepCheck;
      if (!prepCheck.hasFlask) p.missingFlaskPulls.push(pull.pullNumber);
      if (!prepCheck.hasFood) p.missingFoodPulls.push(pull.pullNumber);
      if (!prepCheck.hasWeaponEnchant) p.missingWeaponEnchantPulls.push(pull.pullNumber);
    }
    // Only the class buff's providers are on the hook when it lapses.
    for (const gap of pull.buffGaps ?? []) {
      for (const providerName of gap.providerPlayerNames) {
        const p = getPlayer(players, providerName, gap.providerClass);
        if (!p.missedClassBuffPulls.has(gap.buffName)) p.missedClassBuffPulls.set(gap.buffName, []);
        p.missedClassBuffPulls.get(gap.buffName).push({
          pullNumber: pull.pullNumber,
          durationClock: gap.durationClock,
          missingCount: gap.missingPlayerNames.length,
          raidSize: gap.raidSize,
        });
      }
    }
  }

  const roster = [...players.values()];
  for (const p of roster) {
    p.avgParse =
      p.parsePercents.length > 0
        ? p.parsePercents.reduce((sum, v) => sum + v, 0) / p.parsePercents.length
        : null;
    // A slot only counts as "still missing" if it's missing at both the first and
    // last checkpoint, so re-enchanting mid-raid doesn't get flagged.
    p.missingEnchantSlots =
      p.firstPrepCheck && p.lastPrepCheck
        ? p.firstPrepCheck.missingEnchantSlots.filter((slot) => p.lastPrepCheck.missingEnchantSlots.includes(slot))
        : [];
    // Same first/last checkpoint logic as enchants — gems don't change mid-raid, but
    // don't flag someone we only saw once (no real "still missing" comparison possible).
    p.missingPrimaryStatGem =
      p.firstPrepCheck && p.lastPrepCheck ? !p.firstPrepCheck.hasPrimaryStatGem && !p.lastPrepCheck.hasPrimaryStatGem : false;
    p.raidBuffLapses = [...p.missedClassBuffPulls.entries()].map(([buffName, pulls]) => ({ buffName, pulls }));
  }

  const totalDeathsSum = roster.reduce((sum, p) => sum + p.totalDeaths, 0);
  const avgDeaths = roster.length > 0 ? totalDeathsSum / roster.length : 0;

  const withParses = roster.filter((p) => p.avgParse !== null);
  const highestAvgParse = [...withParses].sort((a, b) => b.avgParse - a.avgParse).slice(0, TOP_N);
  const lowestAvgParse = [...withParses].sort((a, b) => a.avgParse - b.avgParse).slice(0, TOP_N);

  // Denominator is judgeableDeaths, not totalDeaths — deaths to boss mechanics no
  // defensive could have prevented (see DEFENSIVE_UNPREVENTABLE_DEATHS in analyze.js)
  // are excluded so they don't drag down someone's rate for something out of their hands.
  const withDeathSample = roster.filter((p) => p.judgeableDeaths >= MIN_DEATHS_FOR_DEFENSIVE_STATS);
  const defensiveRate = (p) => p.defensiveUsedCount / p.judgeableDeaths;
  const diedWithNothingUp = [...withDeathSample]
    .filter((p) => defensiveRate(p) < 1)
    // Rate first, but a lot of nights everyone lands on the exact same 0% — break
    // ties by death count so it's not just an arbitrary ordering when that happens.
    .sort((a, b) => defensiveRate(a) - defensiveRate(b) || b.judgeableDeaths - a.judgeableDeaths)
    .slice(0, TOP_N);

  // DPS-role only — a healer or tank correctly never touching a DPS potion isn't
  // "missing" anything, and role is unknown (null) for anyone who never appeared in
  // a kill-pull ranking, so they're safely excluded rather than guessed at.
  const noDpsPotions = roster
    .filter((p) => p.role === "dps" && p.attendedPulls >= MIN_ATTENDED_PULLS_FOR_STAT && p.dpsPotionCount === 0)
    .sort((a, b) => b.attendedPulls - a.attendedPulls)
    .slice(0, TOP_N);

  // Drank the old Silvermoon Health Potion at least once and never touched the
  // upgraded Concentrated version — not a preference, a straight upgrade missed.
  const usingOutdatedHealthPotion = roster
    .filter((p) => p.oldHealthPotionCount > 0 && p.newHealthPotionCount === 0)
    .sort((a, b) => b.oldHealthPotionCount - a.oldHealthPotionCount)
    .slice(0, TOP_N);

  const leastDefensivesUsed = roster
    .filter((p) => p.attendedPulls >= MIN_ATTENDED_PULLS_FOR_STAT && p.defensiveCastCount === 0)
    .sort((a, b) => b.attendedPulls - a.attendedPulls)
    .slice(0, TOP_N);
  const mostExternalsGiven = topByKey(roster, "externalsGivenCount");

  // Sszorak's Dig In burn window — good-play callout, no gate needed (only players
  // who actually landed a raid cooldown in the window ever get a nonzero count).
  const mostDigInAlignments = topByKey(roster, "digInAlignmentCount");

  const bossesSummary = [...bossStats.values()].sort((a, b) => a.firstPullNumber - b.firstPullNumber);

  // Coiled Altar orb-carry good-play callout — only worth showing once the boss is
  // actually down for the night; tallies every pull (wipes included), not just the kill.
  const coiledAltarKilled = bossStats.get(ORB_CARRY_BOSS_NAME)?.killed ?? false;
  const mostOrbCarries = coiledAltarKilled ? topByKey(roster, "orbCarryCount") : [];

  // Same gate for Twin Fangs' Ravenous Feast soak participation.
  const twinFangsKilled = bossStats.get(FEAST_SOAK_BOSS_NAME)?.killed ?? false;
  const mostFeastSoaks = twinFangsKilled ? topByKey(roster, "feastSoakCount") : [];

  const missingPrep = roster
    .map((p) => ({
      ...p,
      prepIssueScore:
        p.missingEnchantSlots.length +
        p.missingFlaskPulls.length +
        p.missingFoodPulls.length +
        p.missingWeaponEnchantPulls.length +
        (p.missingPrimaryStatGem ? 1 : 0),
    }))
    .filter((p) => p.prepIssueScore > 0)
    .sort((a, b) => b.prepIssueScore - a.prepIssueScore)
    .slice(0, TOP_N);

  const raidBuffLapses = roster
    .map((p) => ({ ...p, buffLapseScore: p.raidBuffLapses.reduce((sum, b) => sum + b.pulls.length, 0) }))
    .filter((p) => p.buffLapseScore > 0)
    .sort((a, b) => b.buffLapseScore - a.buffLapseScore)
    .slice(0, TOP_N);

  return {
    title: analysis.title,
    reportCode: analysis.reportCode,
    reportCodes: analysis.reportCodes,
    duplicatesDropped: analysis.duplicatesDropped,
    totalPulls: analysis.pulls.length,
    totalKills: analysis.pulls.filter((p) => p.kill).length,
    avgDeaths,
    bossesSummary,
    mostDeaths: topByKey(roster, "totalDeaths"),
    mostWipesTriggered: topByKey(roster, "wipeTriggerCount"),
    highestAvgParse,
    lowestAvgParse,
    diedWithNothingUp,
    mostInterrupts: topByKey(roster, "interruptCount"),
    noDpsPotions,
    usingOutdatedHealthPotion,
    leastDefensivesUsed,
    mostExternalsGiven,
    mostDigInAlignments,
    mostOrbCarries,
    mostFeastSoaks,
    missingPrep,
    raidBuffLapses,
  };
}
