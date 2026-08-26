import { cappedDeathsForTally } from "./analyze.js";
import { classifyCast, OUTDATED_HEALTH_POTION_NAME, UPGRADED_HEALTH_POTION_NAME } from "./defensives.js";
import { CLASS_BUFFS } from "./prep.js";

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

// Largest group in a groupBy map, or null if none has 2+ members.
function topRepeatGroup(map) {
  const entries = [...map.entries()].filter(([, list]) => list.length >= 2);
  entries.sort((a, b) => b[1].length - a[1].length);
  return entries[0] ?? null;
}

// Headline sentence — overall tone from the two biggest numbers (deaths, parse).
// Specifics (which boss, which ability, defensive habits) live in the observations below.
function buildHeadline({ totalDeaths, avgParse, parseText }) {
  if (totalDeaths === 0 && avgParse !== null && avgParse >= 85) {
    return `🌟 Fantastic night — zero deaths and a ${avgParse.toFixed(0)}% average parse. Keep it up!`;
  }
  if (totalDeaths === 0) {
    return `✅ No deaths tonight — great survival instincts.` + (parseText ? ` ${parseText}.` : "");
  }
  if (avgParse !== null && avgParse >= 85 && totalDeaths <= 1) {
    return `Strong night overall — ${parseText} with minimal deaths.`;
  }
  if (totalDeaths >= 4) {
    return `🚩 Died ${totalDeaths} times tonight — that's the headline number to bring down.` + (parseText ? ` ${parseText}.` : "");
  }
  return `A fairly average night — ${totalDeaths} death${totalDeaths === 1 ? "" : "s"}` + (parseText ? `, ${parseText}.` : ".");
}

// Specific, personalized observations pulled from the same stats shown in the rest of
// the report. Each is tagged with a weight (importance) and polarity so buildVerdict
// can pick the most relevant ones instead of always leading with the worst news.
function buildObservations({
  deaths,
  kills,
  avgParse,
  interrupts,
  consumables,
  totalKillPulls,
  externalsGiven,
  othersInterruptTotals,
  role,
  orbCarryCount,
  feastSoakCount,
  digInAlignmentCount,
}) {
  const notes = [];
  // Deaths to boss mechanics no defensive could have prevented (see
  // DEFENSIVE_UNPREVENTABLE_DEATHS in analyze.js) are excluded from cooldown-usage
  // judgment entirely — they still count toward the death total and repeat-boss/
  // repeat-ability notes below, just not toward "you had nothing up."
  const preventableDeaths = deaths.filter((d) => d.defensivePreventable);
  const noDef = preventableDeaths.filter((d) => !d.defensiveUsed && !d.externalAbility);

  const repeatBoss = topRepeatGroup(groupBy(deaths, (d) => d.bossName));
  if (repeatBoss) {
    const [boss, list] = repeatBoss;
    notes.push({
      weight: 90 + list.length,
      polarity: "negative",
      text: `${list.length} of those deaths were on ${boss} — that's the fight to review first.`,
    });
  }

  const repeatAbility = topRepeatGroup(groupBy(deaths.filter((d) => d.killedBy), (d) => d.killedBy));
  if (repeatAbility) {
    const [ability, list] = repeatAbility;
    const distinctBosses = new Set(list.map((d) => d.bossName)).size;
    const redundantWithBossNote = repeatBoss && distinctBosses === 1 && list[0].bossName === repeatBoss[0];
    if (!redundantWithBossNote) {
      notes.push({
        weight: 85 + list.length,
        polarity: "negative",
        text: `${list.length} deaths came from ${ability} specifically — same mechanic, worth drilling.`,
      });
    }
  }

  if (preventableDeaths.length > 0 && noDef.length === preventableDeaths.length) {
    notes.push({
      weight: 95,
      polarity: "negative",
      text: `None of your deaths had a defensive or self-heal up beforehand — cooldown usage is the clearest lever to pull.`,
    });
  } else if (noDef.length > 0) {
    const bosses = [...new Set(noDef.map((d) => d.bossName))];
    notes.push({
      weight: 70,
      polarity: "negative",
      text: `${noDef.length} of those death${noDef.length === 1 ? "" : "s"} had nothing defensive up beforehand (on ${bosses.join(", ")}).`,
    });
  } else if (preventableDeaths.length >= 2) {
    notes.push({
      weight: 65,
      polarity: "neutral",
      text: `Had a defensive up every time you died — reads more like positioning/mechanics than cooldown usage.`,
    });
  }

  const killPullDeaths = deaths.filter((d) => d.kill).length;
  if (killPullDeaths > 0) {
    notes.push({
      weight: 40,
      polarity: "neutral",
      text: `${killPullDeaths} of those death${killPullDeaths === 1 ? "" : "s"} happened on a pull the raid still closed out, so it wasn't fight-ending.`,
    });
  }

  if (kills.length >= 2) {
    const parses = kills.map((k) => k.rankPercent);
    const min = Math.min(...parses);
    const max = Math.max(...parses);
    if (max - min >= 30) {
      notes.push({
        weight: 55,
        polarity: "negative",
        text: `Parses swung a lot pull to pull — ${min.toFixed(0)}% to ${max.toFixed(0)}%.`,
      });
    } else if (max - min <= 12 && avgParse !== null && avgParse >= 60) {
      notes.push({
        weight: 50,
        polarity: "positive",
        text: `Consistent parses all night (${min.toFixed(0)}-${max.toFixed(0)}%).`,
      });
    }
  }

  // DPS-role only — a healer or tank correctly never touching a DPS potion isn't a
  // gap to close, and role stays unknown if this player never landed a kill-pull
  // ranking that night, so it's safely skipped rather than guessed at.
  const dpsPotCount = consumables.filter((c) => c.category === "dps").reduce((sum, c) => sum + c.count, 0);
  if (role === "dps" && totalKillPulls >= 3 && dpsPotCount === 0) {
    notes.push({
      weight: 45,
      polarity: "negative",
      text: `No DPS potions used across ${totalKillPulls} kills — easy parse to pick up.`,
    });
  }

  const oldHealthPotCount = consumables.filter((c) => c.name === OUTDATED_HEALTH_POTION_NAME).reduce((sum, c) => sum + c.count, 0);
  const newHealthPotCount = consumables.filter((c) => c.name === UPGRADED_HEALTH_POTION_NAME).reduce((sum, c) => sum + c.count, 0);
  if (oldHealthPotCount > 0 && newHealthPotCount === 0) {
    notes.push({
      weight: 40,
      polarity: "negative",
      text: `Still drinking the old Silvermoon Health Potion (${oldHealthPotCount}x) — Concentrated Silvermoon Health Potion is a straight upgrade.`,
    });
  }

  // Only call out interrupts as a strength when this player is genuinely ahead of
  // everyone else who kicked that night — on fights where everyone shares kicks,
  // most players land in the same range, and singling one out for it is noise.
  if (interrupts.length >= 3) {
    const avgOthers =
      othersInterruptTotals.length > 0
        ? othersInterruptTotals.reduce((sum, n) => sum + n, 0) / othersInterruptTotals.length
        : 0;
    const standsOut =
      othersInterruptTotals.length === 0 || (interrupts.length >= avgOthers * 1.5 && interrupts.length - avgOthers >= 2);
    if (standsOut) {
      const viaPet = interrupts.filter((i) => i.viaPet).length;
      notes.push({
        weight: 60,
        polarity: "positive",
        text:
          `Pulled real weight on interrupts — ${interrupts.length} kick${interrupts.length === 1 ? "" : "s"} tonight` +
          (viaPet > 0 ? ` (${viaPet} via pet)` : "") +
          `.`,
      });
    }
  }

  if (externalsGiven.length >= 1) {
    notes.push({
      weight: 50,
      polarity: "positive",
      text: `Also threw ${externalsGiven.length === 1 ? "an external" : `${externalsGiven.length} externals`} to save teammates — good awareness.`,
    });
  }

  if (orbCarryCount >= 5) {
    notes.push({
      weight: 45,
      polarity: "positive",
      text: `Carried the venom orb ${orbCarryCount}x on Coiled Altar — pulling real weight on that mechanic.`,
    });
  }

  if (feastSoakCount >= 3) {
    notes.push({
      weight: 45,
      polarity: "positive",
      text: `Soaked Ravenous Feast ${feastSoakCount}x on Twin Fangs — good group-mechanic participation.`,
    });
  }

  if (digInAlignmentCount >= 1) {
    notes.push({
      weight: 40,
      polarity: "positive",
      text: `Saved a raid cooldown for Sszorak's Dig In window instead of popping it on pull.`,
    });
  }

  return notes;
}

// Rule-based read of the night: a headline from the two biggest numbers, plus up to two
// of the most relevant specific observations — biased toward including at least one
// positive note when one's been earned, so it doesn't read as pure criticism every time.
function buildVerdict({
  deaths,
  kills,
  avgParse,
  interrupts,
  consumables,
  totalKillPulls,
  externalsGiven,
  othersInterruptTotals,
  orbCarryCount,
  feastSoakCount,
  digInAlignmentCount,
}) {
  const totalDeaths = deaths.length;
  const parseText = avgParse !== null ? `${avgParse.toFixed(0)}% average parse` : null;
  const headline = buildHeadline({ totalDeaths, avgParse, parseText });

  // Role is stable for a character across a night — any kill entry with it will do.
  const role = kills.find((k) => k.role)?.role ?? null;
  const notes = buildObservations({
    deaths,
    kills,
    avgParse,
    interrupts,
    consumables,
    totalKillPulls,
    externalsGiven,
    othersInterruptTotals,
    role,
    orbCarryCount,
    feastSoakCount,
    digInAlignmentCount,
  });
  if (notes.length === 0) return headline;

  const sorted = [...notes].sort((a, b) => b.weight - a.weight);
  const chosen = [sorted[0]];
  const bestPositive = sorted.find((n) => n.polarity === "positive" && n !== sorted[0]);
  if (bestPositive) {
    chosen.push(bestPositive);
  } else if (sorted[1]) {
    chosen.push(sorted[1]);
  }

  return [headline, ...chosen.map((n) => n.text)].join(" ");
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
  // key: bossName -> { bossName, killed, wiped, firstPullNumber } — tracked for the
  // whole raid (every pull) so bosses the player sat out still show up as "missed"
  // rather than silently disappearing from their report.
  const raidBossStats = new Map();
  const playerBossStats = new Map();
  const raidInterrupterTotals = new Map(); // characterName -> total interrupts, whole raid
  let attendedKillPulls = 0;
  let attendedWipePulls = 0;
  // Enchants: checked at first and last attended pull only (they don't change mid-raid
  // often) — a slot only counts as "still missing" if it's missing at both checkpoints,
  // so re-enchanting mid-raid doesn't get flagged. Flask/food/weapon oil: checked every
  // attended pull, since those do run out and need reapplying.
  let firstPrepCheck = null;
  let lastPrepCheck = null;
  const missingFlaskPulls = [];
  const missingFoodPulls = [];
  const missingWeaponEnchantPulls = [];
  const missedClassBuffPulls = new Map(); // buffName -> pull numbers this player (as provider) let lapse
  let orbCarryCount = 0;
  let digInAlignmentCount = 0;
  let feastSoakCount = 0;

  for (const pull of analysis.pulls) {
    const raidBossEntry = raidBossStats.get(pull.bossName) ?? {
      bossName: pull.bossName,
      killed: false,
      wiped: false,
      firstPullNumber: pull.pullNumber,
    };
    if (pull.kill) raidBossEntry.killed = true;
    else raidBossEntry.wiped = true;
    raidBossStats.set(pull.bossName, raidBossEntry);

    for (const i of pull.interrupts ?? []) {
      raidInterrupterTotals.set(i.sourceName, (raidInterrupterTotals.get(i.sourceName) ?? 0) + 1);
    }

    for (const o of pull.orbCarries ?? []) {
      if (nameSet.has(o.playerName)) orbCarryCount += 1;
    }
    for (const f of pull.feastSoaks ?? []) {
      if (nameSet.has(f.playerName)) feastSoakCount += 1;
    }
    if (pull.digInBloodlust && nameSet.has(pull.digInBloodlust.playerName)) {
      digInAlignmentCount += 1;
    }

    // Attendance for this pull: any trace of the player at all (death, ranked parse,
    // interrupt, or a plain cast) — casts cover wipes too, since rankings only exist
    // for kill pulls, so this is the only reliable signal on a wipe.
    const attended =
      pull.deaths.some((d) => nameSet.has(d.playerName)) ||
      (pull.allParses ?? []).some((p) => nameSet.has(p.name)) ||
      (pull.interrupts ?? []).some((i) => nameSet.has(i.sourceName)) ||
      (pull.casts ?? []).some((c) => nameSet.has(c.sourceName));
    if (attended) {
      if (pull.kill) attendedKillPulls += 1;
      else attendedWipePulls += 1;

      const bossEntry = playerBossStats.get(pull.bossName) ?? {
        bossName: pull.bossName,
        killed: false,
        wiped: false,
        firstPullNumber: pull.pullNumber,
      };
      if (pull.kill) bossEntry.killed = true;
      else bossEntry.wiped = true;
      playerBossStats.set(pull.bossName, bossEntry);

      const prepCheck = (pull.prepChecks ?? []).find((p) => nameSet.has(p.playerName));
      if (prepCheck) {
        if (!firstPrepCheck) firstPrepCheck = prepCheck;
        lastPrepCheck = prepCheck;
        if (!prepCheck.hasFlask) missingFlaskPulls.push(pull.pullNumber);
        if (!prepCheck.hasFood) missingFoodPulls.push(pull.pullNumber);
        if (!prepCheck.hasWeaponEnchant) missingWeaponEnchantPulls.push(pull.pullNumber);
      }

      // Only the class buff's providers are on the hook when it lapses — everyone
      // else missing it (e.g. someone just got rezzed) isn't their fault to track.
      for (const gap of pull.buffGaps ?? []) {
        if (!gap.providerPlayerNames.some((n) => nameSet.has(n))) continue;
        if (!missedClassBuffPulls.has(gap.buffName)) missedClassBuffPulls.set(gap.buffName, []);
        missedClassBuffPulls.get(gap.buffName).push({
          pullNumber: pull.pullNumber,
          durationClock: gap.durationClock,
          missingCount: gap.missingPlayerNames.length,
          raidSize: gap.raidSize,
        });
      }
    }

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
        timeIntoPull: d.timeIntoPull,
        sharedMomentCount: d.sharedMomentCount,
        defensiveUsed: d.defensiveUsed,
        defensivePreventable: d.defensivePreventable,
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
        role: parse.role,
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
        viaPet: i.viaPet,
      });
    }

    for (const c of pull.casts ?? []) {
      if (!nameSet.has(c.sourceName)) continue;

      const classified = classifyCast(c);
      if (!classified) continue;

      if (classified.type === "consumable") {
        const key = `${c.sourceName}::${c.abilityName}`;
        const entry = consumableCounts.get(key) ?? {
          characterName: c.sourceName,
          characterClass: c.sourceClass,
          name: c.abilityName,
          category: classified.category,
          count: 0,
        };
        entry.count += 1;
        consumableCounts.set(key, entry);
      } else if (classified.type === "external") {
        externalsGiven.push({
          characterName: c.sourceName,
          characterClass: c.sourceClass,
          ability: c.abilityName,
          targetName: c.targetName ?? "someone",
          pullNumber: pull.pullNumber,
          bossName: pull.bossName,
        });
      } else if (classified.type === "defensive") {
        // Rotational resource spenders (Death Strike) still count toward "did they have
        // something up when they died," just not toward this raw per-ability usage list —
        // otherwise a Blood DK's Death Strike buries every real cooldown pop. See
        // ROTATIONAL_DEFENSIVE_NAMES in defensives.js.
        if (!classified.countsTowardUsageStats) continue;
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
  // Attended pulls only — not every pull in the report, so someone who sat out a
  // fight (or a boss/dungeon they weren't in) doesn't get charged with kills/wipes
  // that weren't theirs.
  const totalKillPulls = attendedKillPulls;
  const totalWipePulls = attendedWipePulls;
  const consumablesUsed = [...consumableCounts.values()];
  const bossesSummary = [...raidBossStats.values()]
    .sort((a, b) => a.firstPullNumber - b.firstPullNumber)
    .map((raidEntry) => {
      const playerEntry = playerBossStats.get(raidEntry.bossName);
      if (!playerEntry) {
        return { bossName: raidEntry.bossName, attended: false, killed: raidEntry.killed };
      }
      return { bossName: raidEntry.bossName, attended: true, killed: playerEntry.killed };
    });

  const missingEnchantSlots =
    firstPrepCheck && lastPrepCheck
      ? firstPrepCheck.missingEnchantSlots.filter((slot) => lastPrepCheck.missingEnchantSlots.includes(slot))
      : [];
  const missingPrimaryStatGem =
    firstPrepCheck && lastPrepCheck ? !firstPrepCheck.hasPrimaryStatGem && !lastPrepCheck.hasPrimaryStatGem : false;

  return {
    title: analysis.title,
    reportCode: analysis.reportCode,
    reportCodes: analysis.reportCodes,
    duplicatesDropped: analysis.duplicatesDropped,
    playerNames,
    totalKillPulls,
    totalWipePulls,
    bossesSummary,
    deaths,
    kills,
    avgParse,
    interrupts,
    consumables: consumablesUsed,
    defensivesUsed: [...defensiveCounts.values()],
    externalsGiven,
    orbCarryCount,
    digInAlignmentCount,
    feastSoakCount,
    prepCheck: {
      missingEnchantSlots,
      missingPrimaryStatGem,
      missingFlaskPulls,
      missingFoodPulls,
      missingWeaponEnchantPulls,
    },
    raidBuffLapses: [...missedClassBuffPulls.entries()].map(([buffName, pulls]) => ({ buffName, pulls })),
    raidBuffProvided: Object.entries(CLASS_BUFFS).find(([, cls]) => cls === (firstPrepCheck ?? lastPrepCheck)?.playerClass)?.[0] ?? null,
    verdict: buildVerdict({
      deaths,
      kills,
      avgParse,
      interrupts,
      consumables: consumablesUsed,
      totalKillPulls,
      externalsGiven,
      othersInterruptTotals: [...raidInterrupterTotals.entries()]
        .filter(([name]) => !nameSet.has(name))
        .map(([, count]) => count),
      orbCarryCount,
      feastSoakCount,
      digInAlignmentCount,
    }),
  };
}
