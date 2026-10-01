// /coiled-altar-orbs — the full list of orbs each player carried on The Coiled Altar,
// not just the /summary standouts. Carrying one is the job, so this is a GOOD stat and
// the people worth looking at are at the bottom.
//
// Green and purple are counted together as one total, with the split shown per player:
// green (Volatile Venom) is the Heroic orb everyone shares, purple (Mutagenic Venom)
// only exists on Mythic and sits on a much smaller group. Carries come from analyze.js
// (debuff applications, already cut off after the 3rd death on a wipe).
import { analyzeReport, ORB_CARRY_BOSS_NAME, GREEN_ORB_DEBUFF_NAME, PURPLE_ORB_DEBUFF_NAME } from "./analyze.js";

export async function analyzeOrbCarries(codeOrCodes) {
  const analysis = await analyzeReport(codeOrCodes);
  const pulls = analysis.pulls.filter((p) => p.bossName === ORB_CARRY_BOSS_NAME);

  const byPlayer = new Map();
  function entryFor(name, className) {
    const entry = byPlayer.get(name) ?? { name, class: className, orbs: 0, green: 0, purple: 0, pullsPresent: 0 };
    entry.class ??= className;
    byPlayer.set(name, entry);
    return entry;
  }

  for (const pull of pulls) {
    // Presence from combatant info, so someone who carried nothing still shows up
    // rather than silently vanishing from the list.
    for (const p of pull.prepChecks ?? []) {
      if (p.playerName) entryFor(p.playerName, p.playerClass).pullsPresent++;
    }
    for (const o of pull.orbCarries ?? []) {
      const entry = entryFor(o.playerName, o.playerClass);
      entry.orbs++;
      if (o.ability === PURPLE_ORB_DEBUFF_NAME) entry.purple++;
      else if (o.ability === GREEN_ORB_DEBUFF_NAME) entry.green++;
    }
  }

  const players = [...byPlayer.values()]
    .map((p) => ({
      ...p,
      // Per-pull rate is the fair comparison — someone who missed half the night
      // shouldn't read as slacking next to someone there for every pull.
      rate: p.pullsPresent > 0 ? p.orbs / p.pullsPresent : 0,
    }))
    .sort((a, b) => b.orbs - a.orbs || b.rate - a.rate || a.name.localeCompare(b.name));

  const carriers = players.filter((p) => p.orbs > 0);
  const totalOrbs = players.reduce((sum, p) => sum + p.orbs, 0);

  return {
    title: analysis.title,
    reportCode: analysis.reportCode,
    reportCodes: analysis.reportCodes,
    duplicatesDropped: analysis.duplicatesDropped,
    pullCount: pulls.length,
    totalOrbs,
    totalGreen: players.reduce((sum, p) => sum + p.green, 0),
    totalPurple: players.reduce((sum, p) => sum + p.purple, 0),
    // Even split across everyone who actually carried — the "you should be around
    // here" line for a job the raid is meant to share.
    fairShare: carriers.length > 0 ? totalOrbs / carriers.length : 0,
    carriers,
    neverCarried: players.filter((p) => p.orbs === 0),
  };
}
