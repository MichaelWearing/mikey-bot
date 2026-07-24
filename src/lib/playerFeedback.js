import { cappedDeathsForTally } from "./analyze.js";
import {
  DEFENSIVE_ABILITY_NAMES,
  EXTERNAL_ABILITY_NAMES,
  isConsumableAbility,
  consumableCategory,
} from "./defensives.js";

// Rule-based read of the night, built from the same stats shown in the report —
// not a magic judgment, just thresholds on deaths/parse/defensive habits.
function buildVerdict({ deaths, avgParse }) {
  const totalDeaths = deaths.length;
  const noDefensiveDeaths = deaths.filter((d) => !d.defensiveUsed && !d.externalAbility).length;
  const parseText = avgParse !== null ? `${avgParse.toFixed(0)}% average parse` : null;

  if (totalDeaths === 0 && avgParse !== null && avgParse >= 85) {
    return `🌟 Fantastic night — zero deaths and a ${avgParse.toFixed(0)}% average parse. Keep it up!`;
  }
  if (totalDeaths === 0) {
    return `✅ No deaths tonight — great survival instincts.` + (parseText ? ` ${parseText}.` : "");
  }
  if (totalDeaths >= 3 && noDefensiveDeaths === totalDeaths) {
    return (
      `🚩 Died ${totalDeaths} times and never had a defensive or self-heal up beforehand. ` +
      `That's the clearest thing to work on — cooldown usage, not the fights themselves.`
    );
  }
  if (totalDeaths >= 3 && noDefensiveDeaths === 0) {
    return (
      `Died ${totalDeaths} times, but had a defensive up every time — this reads more like a ` +
      `mechanics/positioning issue than a cooldown-usage one.`
    );
  }
  if (avgParse !== null && avgParse >= 85 && totalDeaths <= 1) {
    return `Strong night overall — ${parseText} with minimal deaths.`;
  }
  if (noDefensiveDeaths > 0) {
    return (
      `A fairly average night — ${totalDeaths} death${totalDeaths === 1 ? "" : "s"}` +
      (parseText ? `, ${parseText}` : "") +
      `. ${noDefensiveDeaths} of those death${noDefensiveDeaths === 1 ? "" : "s"} had no defensive up — worth a look.`
    );
  }
  return `A pretty average night — ${totalDeaths} death${totalDeaths === 1 ? "" : "s"}` + (parseText ? `, ${parseText}.` : ".");
}

// playerNames: array of character names — lets one report cover a person's main + alts.
export function buildPlayerFeedback(analysis, playerNames) {
  const nameSet = new Set(playerNames);

  const deaths = [];
  const kills = [];
  const interrupts = [];
  const consumableCounts = new Map(); // key: `${characterName}::${abilityName}`
  const defensiveCounts = new Map(); // key: `${characterName}::${abilityName}`
  const externalsGiven = [];

  for (const pull of analysis.pulls) {
    // Same "pull was already lost" cutoff as /summary — never show a death that
    // happened after 5 others were already down on a wipe.
    for (const d of cappedDeathsForTally(pull)) {
      if (!nameSet.has(d.playerName)) continue;
      deaths.push({
        characterName: d.playerName,
        characterClass: d.playerClass,
        pullNumber: pull.pullNumber,
        bossName: pull.bossName,
        kill: pull.kill,
        killedBy: d.killedBy,
        defensiveUsed: d.defensiveUsed,
        externalHealer: d.externalHealer,
        externalAbility: d.externalAbility,
        deathNumber: d.deathNumber,
      });
    }

    for (const parse of pull.allParses ?? []) {
      if (!nameSet.has(parse.name)) continue;
      kills.push({
        characterName: parse.name,
        characterClass: parse.class,
        pullNumber: pull.pullNumber,
        bossName: pull.bossName,
        durationClock: pull.durationClock,
        spec: parse.spec,
        rankPercent: parse.rankPercent,
      });
    }

    for (const i of pull.interrupts ?? []) {
      if (!nameSet.has(i.sourceName)) continue;
      interrupts.push({
        characterName: i.sourceName,
        characterClass: i.sourceClass,
        pullNumber: pull.pullNumber,
        bossName: pull.bossName,
        interruptedAbility: i.interruptedAbility,
      });
    }

    for (const c of pull.casts ?? []) {
      if (!nameSet.has(c.sourceName)) continue;

      if (isConsumableAbility(c.abilityName)) {
        // Consumables are always self-used — no target check needed (and WCL's
        // targetID on untargeted item uses is unreliable anyway, see below).
        const key = `${c.sourceName}::${c.abilityName}`;
        const entry = consumableCounts.get(key) ?? {
          characterName: c.sourceName,
          characterClass: c.sourceClass,
          name: c.abilityName,
          category: consumableCategory(c.abilityName),
          count: 0,
        };
        entry.count += 1;
        consumableCounts.set(key, entry);
      } else if (DEFENSIVE_ABILITY_NAMES.has(c.abilityName)) {
        // A handful of these can also be cast on someone else (Blessing of
        // Protection, Lay on Hands, etc.). If it was genuinely given to someone
        // else, track it separately as a support action rather than a personal
        // defensive. Everything else is purely self-only, so we skip the target
        // check entirely: WCL logs untargeted self-buffs (Divine Protection,
        // Divine Shield, ...) with whatever enemy is currently targeted, not
        // "self", so requiring targetID === sourceID would wrongly drop real usages.
        const isDualPurpose = EXTERNAL_ABILITY_NAMES.has(c.abilityName);
        const isSelfCast = c.targetID == null || c.targetID === c.sourceID;

        if (isDualPurpose && !isSelfCast) {
          externalsGiven.push({
            characterName: c.sourceName,
            characterClass: c.sourceClass,
            ability: c.abilityName,
            targetName: c.targetName ?? "someone",
            pullNumber: pull.pullNumber,
            bossName: pull.bossName,
          });
          continue;
        }

        const key = `${c.sourceName}::${c.abilityName}`;
        const entry = defensiveCounts.get(key) ?? {
          characterName: c.sourceName,
          characterClass: c.sourceClass,
          name: c.abilityName,
          count: 0,
        };
        entry.count += 1;
        defensiveCounts.set(key, entry);
      }
    }
  }

  const avgParse =
    kills.length > 0 ? kills.reduce((sum, k) => sum + k.rankPercent, 0) / kills.length : null;

  return {
    title: analysis.title,
    reportCode: analysis.reportCode,
    playerNames,
    deaths,
    kills,
    avgParse,
    interrupts,
    consumables: [...consumableCounts.values()],
    defensivesUsed: [...defensiveCounts.values()],
    externalsGiven,
    verdict: buildVerdict({ deaths, avgParse }),
  };
}
