// Aggregates PAD_TRACKED_TARGETS damage (see analyze.js) across a whole night, one
// section per tracked boss/add pair — deliberately its own command rather than a
// /summary field, since new tracked fights get added here over time.
import { PAD_TRACKED_TARGETS } from "./analyze.js";
import { standoutHigh } from "./summary.js";

// Real totals here run hundreds of thousands to millions — this floor is just a
// guard against near-zero noise; standoutHigh's 1.5x-average multiplier does the
// actual outlier filtering the same way it does for orb carries/Feast soaks.
const MIN_GAP = 50000;
const MAX_SHOWN = 10;

export function buildPadReport(analysis) {
  const targets = PAD_TRACKED_TARGETS.map(({ bossName, targetName }) => {
    const players = new Map(); // name -> { name, class, damage, confirmedDamage, byAbility, confirmedByAbility }
    for (const pull of analysis.pulls) {
      if (pull.bossName !== bossName) continue;
      for (const hit of pull.padDamage ?? []) {
        const entry = players.get(hit.playerName) ?? {
          name: hit.playerName,
          class: hit.playerClass,
          damage: 0,
          confirmedDamage: 0,
          byAbility: new Map(),
          confirmedByAbility: new Map(),
        };
        entry.damage += hit.damage;
        entry.byAbility.set(hit.ability, (entry.byAbility.get(hit.ability) ?? 0) + hit.damage);
        if (hit.isConfirmedPad) {
          entry.confirmedDamage += hit.damage;
          entry.confirmedByAbility.set(hit.ability, (entry.confirmedByAbility.get(hit.ability) ?? 0) + hit.damage);
        }
        players.set(hit.playerName, entry);
      }
    }

    const roster = [...players.values()].map((p) => ({
      ...p,
      topAbility: [...p.byAbility.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
      topConfirmedAbility: [...p.confirmedByAbility.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
    }));

    // Two independent signals: statistical outliers on total damage (any ability),
    // and anyone who landed a confirmed AoE-only-spender hit at all — the latter
    // doesn't need to clear the outlier bar, a single hit from that list is already
    // the signal (see padAbilities.js).
    const volumeOutliers = standoutHigh(roster, "damage", MIN_GAP, MAX_SHOWN);
    const confirmedPadders = roster
      .filter((p) => p.confirmedDamage > 0)
      .sort((a, b) => b.confirmedDamage - a.confirmedDamage)
      .slice(0, MAX_SHOWN);

    return { bossName, targetName, volumeOutliers, confirmedPadders };
  });

  return {
    title: analysis.title,
    reportCode: analysis.reportCode,
    reportCodes: analysis.reportCodes,
    targets,
  };
}
