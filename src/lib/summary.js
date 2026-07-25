import { cappedDeathsForTally } from "./analyze.js";
import { isConsumableAbility, consumableCategory } from "./defensives.js";

function getPlayer(players, name, classHint) {
  if (!players.has(name)) {
    players.set(name, {
      name,
      class: classHint ?? null,
      totalDeaths: 0,
      wipeTriggerCount: 0,
      wipeTriggerAbilities: [],
      defensiveUsedCount: 0,
      noDefensiveCount: 0,
      parsePercents: [],
      interruptCount: 0,
      interruptViaPetCount: 0,
      dpsPotionCount: 0,
    });
  }
  const p = players.get(name);
  if (!p.class && classHint) p.class = classHint;
  return p;
}

const MIN_DEATHS_FOR_DEFENSIVE_STATS = 2; // need a real sample before judging defensive habits
const MIN_KILLS_FOR_DPS_POTION_STAT = 3; // need a few kill pulls before "no pots" is meaningful
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
      if (d.defensiveUsed) p.defensiveUsedCount += 1;
      else p.noDefensiveCount += 1;
    }
    for (const parse of pull.allParses ?? []) {
      const p = getPlayer(players, parse.name, parse.class);
      p.parsePercents.push(parse.rankPercent);
    }
    for (const i of pull.interrupts ?? []) {
      if (!i.sourceName) continue;
      const p = getPlayer(players, i.sourceName, i.sourceClass);
      p.interruptCount += 1;
      if (i.viaPet) p.interruptViaPetCount += 1;
    }
    for (const c of pull.casts ?? []) {
      if (!c.sourceName) continue;
      if (isConsumableAbility(c.abilityName) && consumableCategory(c.abilityName) === "dps") {
        const p = getPlayer(players, c.sourceName, c.sourceClass);
        p.dpsPotionCount += 1;
      }
    }
  }

  const roster = [...players.values()];
  for (const p of roster) {
    p.avgParse =
      p.parsePercents.length > 0
        ? p.parsePercents.reduce((sum, v) => sum + v, 0) / p.parsePercents.length
        : null;
  }

  const totalDeathsSum = roster.reduce((sum, p) => sum + p.totalDeaths, 0);
  const avgDeaths = roster.length > 0 ? totalDeathsSum / roster.length : 0;

  const withParses = roster.filter((p) => p.avgParse !== null);
  const highestAvgParse = [...withParses].sort((a, b) => b.avgParse - a.avgParse).slice(0, TOP_N);
  const lowestAvgParse = [...withParses].sort((a, b) => a.avgParse - b.avgParse).slice(0, TOP_N);

  const withDeathSample = roster.filter((p) => p.totalDeaths >= MIN_DEATHS_FOR_DEFENSIVE_STATS);
  const defensiveRate = (p) => p.defensiveUsedCount / p.totalDeaths;
  const diedWithNothingUp = [...withDeathSample]
    .filter((p) => defensiveRate(p) < 1)
    .sort((a, b) => defensiveRate(a) - defensiveRate(b))
    .slice(0, TOP_N);

  const noDpsPotions = roster
    .filter((p) => p.parsePercents.length >= MIN_KILLS_FOR_DPS_POTION_STAT && p.dpsPotionCount === 0)
    .sort((a, b) => b.parsePercents.length - a.parsePercents.length)
    .slice(0, TOP_N);

  const bossesSummary = [...bossStats.values()].sort((a, b) => a.firstPullNumber - b.firstPullNumber);

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
  };
}
