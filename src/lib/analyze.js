import { wclQuery } from "./wcl.js";
import { findDefensiveBeforeDeath, findExternalBeforeDeath } from "./defensives.js";

const REPORT_QUERY = `
  query ($code: String!) {
    reportData {
      report(code: $code) {
        title
        startTime
        fights {
          id
          name
          kill
          difficulty
          fightPercentage
          bossPercentage
          startTime
          endTime
        }
        masterData {
          actors { id name type subType }
          abilities { gameID name }
        }
      }
    }
  }
`;

const FIGHT_DETAIL_QUERY = `
  query ($code: String!, $fightId: Int!) {
    reportData {
      report(code: $code) {
        deaths: events(fightIDs: [$fightId], dataType: Deaths) {
          data
        }
        casts: events(fightIDs: [$fightId], dataType: Casts, hostilityType: Friendlies) {
          data
        }
        interrupts: events(fightIDs: [$fightId], dataType: Interrupts) {
          data
        }
        rankings(fightIDs: [$fightId])
      }
    }
  }
`;

function msToClock(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

const CASCADE_WINDOW_MS = 3000; // deaths this close together are likely the same wipe cascade

// Best-effort heuristic: the first death in a wipe is often what tipped the pull over.
// A death that follows within a few seconds AND shares the same killing ability is likely
// genuine fallout from that same mechanic (e.g. a raid-wide hit nobody could react to).
// A death that follows closely but from a *different* ability is probably an unrelated,
// separate mistake that just happened to land in the same window.
function annotateDeaths(deaths, isWipe) {
  const sorted = [...deaths].sort((a, b) => a.timestamp - b.timestamp);
  return sorted.map((d, i) => {
    const isTrigger = isWipe && i === 0;
    const prev = i > 0 ? sorted[i - 1] : null;
    const gapMs = prev ? d.timestamp - prev.timestamp : null;
    const withinWindow = isWipe && i > 0 && gapMs <= CASCADE_WINDOW_MS;
    const isChained = withinWindow && d.killedBy === prev.killedBy;
    const isNearbyUnrelated = withinWindow && d.killedBy !== prev.killedBy;
    // 1-indexed position in the pull's death order, so displays can say
    // "3rd to die" / "2 others already down" for context.
    return { ...d, isTrigger, isChained, isNearbyUnrelated, gapMs, deathNumber: i + 1 };
  });
}

const WIPE_DEATH_TALLY_CAP = 5; // a wipe is already lost past this point — don't count the pile-on

// Shared by /summary and /feedback so both apply the exact same "pull was already
// over" cutoff when tallying per-player stats from a wipe.
export function cappedDeathsForTally(pull, cap = WIPE_DEATH_TALLY_CAP) {
  return pull.kill ? pull.deaths : pull.deaths.slice(0, cap);
}

export async function analyzeReport(code) {
  const base = await wclQuery(REPORT_QUERY, { code });
  const report = base.reportData.report;
  if (!report) {
    throw new Error(`Report not found: ${code}`);
  }

  const actorsById = new Map(report.masterData.actors.map((a) => [a.id, a]));
  const abilitiesById = new Map(report.masterData.abilities.map((a) => [a.gameID, a.name]));

  const pulls = report.fights.filter((f) => f.kill !== null);

  const results = [];
  for (const fight of pulls) {
    const detail = await wclQuery(FIGHT_DETAIL_QUERY, { code, fightId: fight.id });
    const reportDetail = detail.reportData.report;

    const casts = (reportDetail.casts?.data ?? []).map((c) => {
      const source = actorsById.get(c.sourceID);
      const target = actorsById.get(c.targetID);
      return {
        ...c,
        abilityName: abilitiesById.get(c.abilityGameID) ?? "Unknown",
        sourceName: source?.name ?? null,
        sourceClass: source?.subType ?? null,
        targetName: target?.name ?? null,
      };
    });

    const interrupts = (reportDetail.interrupts?.data ?? []).map((i) => {
      const source = actorsById.get(i.sourceID);
      return {
        sourceName: source?.name ?? null,
        sourceClass: source?.subType ?? null,
        interruptAbility: abilitiesById.get(i.abilityGameID) ?? "Unknown",
        interruptedAbility: abilitiesById.get(i.extraAbilityGameID) ?? "Unknown",
        timestamp: i.timestamp,
      };
    });

    const rawDeaths = (reportDetail.deaths?.data ?? []).map((d) => {
      const player = actorsById.get(d.targetID);
      const killedBy = abilitiesById.get(d.killingAbilityGameID) ?? "Unknown ability";
      const defensiveUsed = findDefensiveBeforeDeath(casts, d.targetID, d.timestamp);
      const externalCast = findExternalBeforeDeath(casts, d.targetID, d.timestamp);
      return {
        playerName: player?.name ?? `Unknown (${d.targetID})`,
        playerClass: player?.subType ?? null,
        killedBy,
        timestamp: d.timestamp,
        defensiveUsed,
        externalHealer: externalCast ? actorsById.get(externalCast.sourceID)?.name ?? "Someone" : null,
        externalAbility: externalCast?.abilityName ?? null,
      };
    });
    // This is the FULL death list for the pull. embeds.js applies its own display
    // cutoff for /analyze, and summary.js applies its own cutoff when tallying
    // per-player stats for /summary — each caller decides independently how much
    // of a pile-on wipe is still meaningful.
    const deaths = annotateDeaths(rawDeaths, !fight.kill);

    let topParses = [];
    let bottomParses = [];
    let allParses = [];
    if (fight.kill) {
      const rankingEntry = reportDetail.rankings?.data?.[0];
      const allCharacters = [];
      if (rankingEntry?.roles) {
        for (const role of Object.values(rankingEntry.roles)) {
          for (const c of role.characters ?? []) {
            allCharacters.push({
              name: c.name,
              class: c.class,
              spec: c.spec,
              rankPercent: c.rankPercent,
            });
          }
        }
      }
      const sorted = [...allCharacters].sort((a, b) => b.rankPercent - a.rankPercent);
      allParses = sorted;
      const topCount = Math.min(5, sorted.length);
      const bottomCount = Math.min(5, Math.max(0, sorted.length - topCount));
      topParses = sorted.slice(0, topCount);
      bottomParses = sorted.slice(sorted.length - bottomCount).reverse();
    }

    results.push({
      fightId: fight.id,
      bossName: fight.name,
      kill: fight.kill,
      pullNumber: pulls.indexOf(fight) + 1,
      durationMs: fight.endTime - fight.startTime,
      durationClock: msToClock(fight.endTime - fight.startTime),
      bossPercentRemaining: fight.bossPercentage,
      deaths,
      topParses,
      bottomParses,
      allParses,
      casts,
      interrupts,
    });
  }

  return {
    title: report.title,
    reportCode: code,
    pulls: results,
  };
}
