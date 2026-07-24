import { cappedDeathsForTally } from "./analyze.js";

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
    });
  }
  const p = players.get(name);
  if (!p.class && classHint) p.class = classHint;
  return p;
}

const MIN_DEATHS_FOR_DEFENSIVE_STATS = 2; // need a real sample before judging defensive habits
const TOP_N = 5;

function topByKey(roster, key, n = TOP_N) {
  return [...roster]
    .filter((p) => p[key] > 0)
    .sort((a, b) => b[key] - a[key])
    .slice(0, n);
}

export function buildNightSummary(analysis) {
  const players = new Map();

  for (const pull of analysis.pulls) {
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
  const diedWithDefensiveUp = [...withDeathSample]
    .filter((p) => defensiveRate(p) > 0)
    .sort((a, b) => defensiveRate(b) - defensiveRate(a))
    .slice(0, TOP_N);
  const diedWithNothingUp = [...withDeathSample]
    .filter((p) => defensiveRate(p) < 1)
    .sort((a, b) => defensiveRate(a) - defensiveRate(b))
    .slice(0, TOP_N);

  return {
    title: analysis.title,
    reportCode: analysis.reportCode,
    totalPulls: analysis.pulls.length,
    totalKills: analysis.pulls.filter((p) => p.kill).length,
    avgDeaths,
    mostDeaths: topByKey(roster, "totalDeaths"),
    mostWipesTriggered: topByKey(roster, "wipeTriggerCount"),
    highestAvgParse,
    lowestAvgParse,
    diedWithDefensiveUp,
    diedWithNothingUp,
  };
}
