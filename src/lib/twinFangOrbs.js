// /twin-fang-orbs — how many Caustic Globule orbs each player picked up. The orbs
// spawn from a boss cast, get CC'd, and then someone chooses to run over one and eat
// the big initial hit. So this is a GOOD stat: picking them up is the job, and the
// people to look at are the ones at the bottom of the list.
//
// What counts as a pickup (Environment-sourced damage only, and why the boss-sourced
// hits of the same name don't count) lives in analyze.js next to the other Twin Fangs
// mechanics — see ENVIRONMENT_SOURCE_ID there.
import { analyzeReport, FEAST_SOAK_BOSS_NAME } from "./analyze.js";

export async function analyzeOrbSoaks(codeOrCodes) {
  const analysis = await analyzeReport(codeOrCodes);
  const pulls = analysis.pulls.filter((p) => p.bossName === FEAST_SOAK_BOSS_NAME);

  const byPlayer = new Map(); // name -> { name, class, orbs, damage, pullsPresent }
  function entryFor(name, className) {
    const entry = byPlayer.get(name) ?? { name, class: className, orbs: 0, damage: 0, pullsPresent: 0 };
    entry.class ??= className;
    byPlayer.set(name, entry);
    return entry;
  }

  for (const pull of pulls) {
    // Presence from combatant info, so someone who picked up nothing still shows up
    // rather than silently vanishing from the list.
    for (const p of pull.prepChecks ?? []) {
      if (p.playerName) entryFor(p.playerName, p.playerClass).pullsPresent++;
    }
    for (const o of pull.orbPickups ?? []) {
      const entry = entryFor(o.playerName, o.playerClass);
      entry.orbs++;
      entry.damage += o.amount;
    }
  }

  const players = [...byPlayer.values()]
    .map((p) => ({
      name: p.name,
      class: p.class,
      orbs: p.orbs,
      pullsPresent: p.pullsPresent,
      // Per-pull rate is the fair comparison — someone who missed half the night
      // shouldn't read as slacking next to someone who was there for every pull.
      rate: p.pullsPresent > 0 ? p.orbs / p.pullsPresent : 0,
      avgHit: p.orbs > 0 ? Math.round(p.damage / p.orbs) : 0,
    }))
    .sort((a, b) => b.orbs - a.orbs || b.rate - a.rate || a.name.localeCompare(b.name));

  const totalOrbs = players.reduce((sum, p) => sum + p.orbs, 0);
  const pickers = players.filter((p) => p.orbs > 0);

  return {
    title: analysis.title,
    reportCode: analysis.reportCode,
    reportCodes: analysis.reportCodes,
    duplicatesDropped: analysis.duplicatesDropped,
    pullCount: pulls.length,
    totalOrbs,
    // Even split across everyone who was actually there — the "you should be around
    // here" line for a mechanic the whole raid is meant to share.
    fairShare: pickers.length > 0 ? totalOrbs / pickers.length : 0,
    pickers,
    neverPickedUp: players.filter((p) => p.orbs === 0),
  };
}
