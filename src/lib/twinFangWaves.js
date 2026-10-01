// /twin-fang-waves — full list of Eternal Venom stacks taken from Twin Fangs waves, not
// just the /summary top 5. Each wave touch is one stack (re-touching the same wave
// keeps stacking), so stacks is the headline number; waves is how many separate waves.
// Wave touches come from analyze.js (Stir the Depths debuff applications, already cut
// off after the 3rd death on a wipe, same as every other mechanic count).
import { analyzeReport, FEAST_SOAK_BOSS_NAME } from "./analyze.js";

export async function analyzeWaveHits(codeOrCodes) {
  const analysis = await analyzeReport(codeOrCodes);
  const pulls = analysis.pulls.filter((p) => p.bossName === FEAST_SOAK_BOSS_NAME);

  const byPlayer = new Map(); // name -> { name, class, stacks, waves, pullsPresent }
  function entryFor(name, className) {
    const entry = byPlayer.get(name) ?? { name, class: className, stacks: 0, waves: 0, pullsPresent: 0 };
    entry.class ??= className;
    byPlayer.set(name, entry);
    return entry;
  }

  for (const pull of pulls) {
    // Presence from combatant info, so clean players still show up as clean.
    for (const p of pull.prepChecks ?? []) {
      if (p.playerName) entryFor(p.playerName, p.playerClass).pullsPresent++;
    }
    for (const w of pull.waveTouches ?? []) {
      const entry = entryFor(w.playerName, w.playerClass);
      entry.stacks++;
      if (w.newWave) entry.waves++;
    }
  }

  const players = [...byPlayer.values()]
    .map((p) => ({
      name: p.name,
      class: p.class,
      stacks: p.stacks,
      waves: p.waves,
      pullsPresent: p.pullsPresent,
    }))
    .sort((a, b) => b.stacks - a.stacks || b.waves - a.waves || a.name.localeCompare(b.name));

  return {
    title: analysis.title,
    reportCode: analysis.reportCode,
    reportCodes: analysis.reportCodes,
    duplicatesDropped: analysis.duplicatesDropped,
    pullCount: pulls.length,
    totalStacks: players.reduce((sum, p) => sum + p.stacks, 0),
    totalWaves: players.reduce((sum, p) => sum + p.waves, 0),
    hit: players.filter((p) => p.stacks > 0),
    clean: players.filter((p) => p.stacks === 0),
  };
}
