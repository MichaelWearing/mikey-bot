import {
  cappedDeathsForTally,
  ORB_CARRY_BOSS_NAME,
  FEAST_SOAK_BOSS_NAME,
  TOXIC_DROPLETS_BOSS_NAME,
  SSZORAK_BOSS_NAME,
  COMBAT_RES_CLASSES,
} from "./analyze.js";
import {
  classifyCast,
  consumableCategory,
  isConsumableAbility,
  OUTDATED_HEALTH_POTION_NAME,
  UPGRADED_HEALTH_POTION_NAME,
  ROTATIONAL_DEFENSIVE_NAMES,
  DEFENSIVE_ALIAS_GROUPS,
  RAID_DEFENSIVE_COOLDOWN_NAMES,
  MAINTENANCE_EXTERNAL_NAMES,
  realDefensivesAvailableAt,
  DEFENSIVE_COOLDOWNS,
} from "./defensives.js";
import { CLASS_BUFFS } from "./prep.js";
import { CLASS_SPECS, TANK_SPEC_NAMES } from "./classRegistry.js";
import { randomPraise } from "./praise.js";

// Healers other than Resto Shaman don't have an interrupt anyone expects them to
// use (Wind Shear is the exception — it's off the GCD and spammable), so their kick
// count is noise. Used to hide the interrupt stat entirely for those specs.
function isInterruptExemptHealer(role, className) {
  return role === "healer" && className !== "Shaman";
}

// Resolves the single class/spec this player was on for the night and returns their
// tracked defensive kit. specLookup (roster.json, hand-maintained) wins over WCL's
// own per-report spec detection — see neverUsedDefensives for why. Returns null if
// the class is ambiguous (alt-swapped mid-raid) or no spec is known.
function resolvePlayerKit(deaths, kills, specLookup) {
  const classesSeen = new Set([...deaths, ...kills].map((d) => d.characterClass).filter(Boolean));
  if (classesSeen.size !== 1) return null;
  const [className] = classesSeen;
  const activeCharacterName = [...deaths, ...kills].find((d) => d.characterClass === className)?.characterName;
  const spec = specLookup?.get(activeCharacterName)?.spec ?? kills.find((k) => k.spec)?.spec;
  if (!spec) return null;
  const kit = CLASS_SPECS[className]?.[spec];
  if (!kit) return null;
  return { className, spec, kit };
}

function mmss(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function stdDev(nums) {
  if (nums.length < 2) return 0;
  const mean = nums.reduce((sum, n) => sum + n, 0) / nums.length;
  return Math.sqrt(nums.reduce((sum, n) => sum + (n - mean) ** 2, 0) / nums.length);
}

const RHYTHM_MIN_PULLS = 3; // need this many pulls of a boss where they used the CD
const RHYTHM_CONSISTENT_MS = 12000; // first-cast timing within ~12s across pulls = planned
const RHYTHM_SCATTERED_MS = 45000; // spread over ~45s+ = reactive / no plan

// For each (boss, real defensive) the player used on RHYTHM_MIN_PULLS+ pulls of that
// boss, is the FIRST use each pull at a consistent point (planned) or all over the
// place (reactive panic)? gallain's ask: reward pressing defensives in the same spot
// every pull, not yolo-ing them after already dropping low.
function computeDefensiveRhythm(timingsByKey) {
  const out = [];
  for (const [key, entries] of timingsByKey) {
    const firstPerPull = new Map();
    for (const e of entries) {
      if (!firstPerPull.has(e.pullNumber) || e.t < firstPerPull.get(e.pullNumber)) firstPerPull.set(e.pullNumber, e.t);
    }
    const times = [...firstPerPull.values()];
    if (times.length < RHYTHM_MIN_PULLS) continue;
    const sd = stdDev(times);
    let verdict = null;
    if (sd <= RHYTHM_CONSISTENT_MS) verdict = "consistent";
    else if (sd >= RHYTHM_SCATTERED_MS) verdict = "scattered";
    if (!verdict) continue;
    const [boss, ability] = key.split("::");
    out.push({
      boss,
      ability,
      samples: times.length,
      stdevMs: sd,
      meanClock: mmss(times.reduce((sum, n) => sum + n, 0) / times.length),
      minClock: mmss(Math.min(...times)),
      maxClock: mmss(Math.max(...times)),
      verdict,
    });
  }
  return out;
}

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

// A player's count vs. the rest of the raid on a shared/rotational mechanic (orb
// carries, Feast soaks) — only worth calling out when they're a genuine outlier.
// "Everyone carried 3-4 orbs" isn't a standout in either direction, it's just the
// mechanic working as designed, so returns null unless there's real separation.
function standoutVsOthers(count, othersTotals, minGap) {
  if (othersTotals.length === 0) return null; // no baseline in the raid to compare against
  const avg = othersTotals.reduce((sum, n) => sum + n, 0) / othersTotals.length;
  if (avg === 0) return null; // nobody else did this either — not a meaningful signal
  if (count >= avg * 1.5 && count - avg >= minGap) return "high";
  if (count <= avg * 0.5 && avg - count >= minGap) return "low";
  return null;
}

// Defensives this player's own kit has but never cast all night. specLookup (roster
// class/spec, hand-maintained by raid leadership) is preferred over WCL's own
// per-report spec detection, which is unreliable — confirmed directly: WCL reported
// a Warrior as "Arms" in one report despite him visibly casting Impending Victory, a
// Fury-only ability, that same night. If neither source has a spec, or this name/alt
// group shows more than one class this session (alt-swapped mid-raid), there's no
// single safe kit to check against, so this is skipped rather than guessed at.
function neverUsedDefensives({ deaths, kills, defensivesUsed, externalsGiven, role, specLookup }) {
  // Healers aren't judged on personal-defensive usage — that check is for DPS/tanks
  // sitting on a survival CD. Repeated false-looking output (Mammy "never used Power
  // Word: Shield") was eroding trust in the whole report.
  if (role === "healer") return [];
  const resolved = resolvePlayerKit(deaths, kills, specLookup);
  if (!resolved) return [];
  const { kit } = resolved;
  // Dual-purpose abilities (Blessing of Sacrifice, Lay on Hands, Ironbark, ...) get
  // classified as an "external" when cast on someone else, so they never land in
  // defensivesUsed — count them as used if they were thrown to anyone, otherwise a
  // Holy Paladin who Sacrifices a tank every pull gets flagged for "never using" it.
  const usedNames = new Set([...defensivesUsed.map((d) => d.name), ...(externalsGiven ?? []).map((e) => e.ability)]);
  const missing = kit.filter(
    (name) => !usedNames.has(name) && !ROTATIONAL_DEFENSIVE_NAMES.has(name) && !RAID_DEFENSIVE_COOLDOWN_NAMES.has(name)
  );
  // Drop anything whose alias-group sibling was used — same ability slot, different
  // name depending on talent choice (e.g. Ice Block/Ice Cold), so using either covers
  // both. If none of the group was used, list it once as "A / B" rather than as two
  // separate misses for what's really one button.
  const result = [];
  for (const name of missing) {
    const group = DEFENSIVE_ALIAS_GROUPS.find((g) => g.includes(name));
    if (!group) {
      result.push(name);
      continue;
    }
    if (group.some((sibling) => usedNames.has(sibling))) continue;
    const combined = group.filter((sibling) => kit.includes(sibling)).join(" / ");
    if (!result.includes(combined)) result.push(combined);
  }
  return result;
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Where a player lands on a lower-is-better count (hits taken, waves touched) among
// everyone who was at the fight. `attendeeNames` must be everyone present, NOT the
// keys of `totals` — a clean 0-hit night leaves a player absent from `totals`, and
// dropping them would silently remove the raid's best performers from the pool.
// `worstRank` is counted from the other end rather than derived as (count - rank + 1)
// so ties stay honest — two people on the same count aren't "worse" than each other.
function lowerIsBetterStanding(myCount, attendeeNames, nameSet, totals) {
  if (attendeeNames.length < 4) return null;
  const others = attendeeNames.filter((name) => !nameSet.has(name)).map((name) => totals.get(name) ?? 0);
  const raidCount = others.length + 1;
  return {
    rank: 1 + others.filter((v) => v < myCount).length,
    worstRank: 1 + others.filter((v) => v > myCount).length,
    raidCount,
    raidAvg: [...others, myCount].reduce((sum, v) => sum + v, 0) / raidCount,
  };
}

// The lead clause of the verdict — death count framed against the rest of the raid,
// so "5 deaths" reads very differently on a farm night vs. a wipe-fest. Falls back to
// a bare count when there's no raid baseline (single-player-only analysis, tiny raid).
function deathCountClause(totalDeaths, deathRank, raidCount, raidAvg) {
  const s = totalDeaths === 1 ? "" : "s";
  if (totalDeaths === 0) return "No deaths tonight";
  if (raidAvg == null || !deathRank || !raidCount) return `${totalDeaths} death${s} tonight`;
  if (deathRank === 1 && totalDeaths >= raidAvg * 1.4) return `${totalDeaths} death${s} — most in the raid tonight`;
  if (deathRank <= 3 && totalDeaths >= raidAvg * 1.25) return `${totalDeaths} death${s} — ${ordinal(deathRank)} most in the raid tonight`;
  if (totalDeaths <= Math.max(1, raidAvg * 0.55)) return `${totalDeaths} death${s} — among the cleanest in the raid tonight`;
  return `${totalDeaths} death${s} — about average for the raid tonight`;
}

// Every specific finding worth surfacing, pulled from the same data shown elsewhere
// in the report. `weight` = how much it should drive the verdict; `polarity` decides
// which section it lands in (negative/neutral → "Also", positive → "Did well").
function buildObservations({
  deaths,
  className,
  interrupts,
  consumables,
  totalKillPulls,
  externalsGiven,
  othersInterruptTotals,
  role,
  dispelsByAbility,
  innervatesCast,
  combatResCount,
  combatResStandout,
  combatResNeverUsed,
  combatResTop,
  combatResJointTop,
  soulstonePlacementCount,
  othersCombatResTotals,
  defensiveRhythm,
  prepCheck,
  raidBuffLapses,
  raidBuffProvided,
  orbCarryCount,
  orbCarryStandout,
  feastSoakCount,
  feastSoakStandout,
  toxicDropletSoakCount,
  toxicDropletSoakStandout,
  digInWindowDamageTotal,
  digInWindowDamageStandout,
  tornadoHitCount,
  tornadoHitStandout,
  waveTouchCount,
  waveTouchStandout,
  unusedDefensives,
}) {
  const notes = [];
  // Deaths to boss mechanics no defensive could have prevented (DEFENSIVE_UNPREVENTABLE_DEATHS
  // in analyze.js), and deaths where every real cooldown was genuinely down
  // (hadDefensiveAvailable === false), are both excluded from cooldown-usage judgment —
  // raiders (rightly) hated being called out for a cooldown they didn't have.
  const preventableDeaths = deaths.filter((d) => d.defensivePreventable);
  const noDef = preventableDeaths.filter(
    (d) => !d.defensiveUsed && !d.externalAbility && d.hadDefensiveAvailable !== false
  );
  const everythingDown = preventableDeaths.filter(
    (d) => !d.defensiveUsed && !d.externalAbility && d.hadDefensiveAvailable === false
  );
  const usedDefBeforeDeath = preventableDeaths.filter((d) => d.defensiveUsed).length;
  const judgeable = preventableDeaths.length - everythingDown.length;

  // --- death patterns ---
  const repeatBoss = topRepeatGroup(groupBy(deaths, (d) => d.bossName));
  if (repeatBoss) {
    const [boss, list] = repeatBoss;
    notes.push({
      weight: 86 + list.length,
      polarity: "negative",
      text: `${list.length} of your ${deaths.length} deaths were on ${boss} — the fight to review first.`,
    });
  }
  // "Melee" is the boss auto-attacking a tank — not a mechanic to dodge, so it's not
  // a "drill it" pattern; exclude it (and unattributed deaths) from ability grouping.
  const repeatAbility = topRepeatGroup(
    groupBy(
      deaths.filter((d) => d.killedBy && d.killedBy !== "Melee" && d.killedBy !== "Unknown ability"),
      (d) => d.killedBy
    )
  );
  if (repeatAbility) {
    const [ability, list] = repeatAbility;
    const sameBossAsRepeat =
      repeatBoss && new Set(list.map((d) => d.bossName)).size === 1 && list[0].bossName === repeatBoss[0];
    if (sameBossAsRepeat && list.length >= repeatBoss[1].length) {
      // Exactly the same set of deaths as the repeat-boss note — no new information.
    } else if (sameBossAsRepeat) {
      notes.push({
        weight: 60,
        polarity: "negative",
        text: `${list.length} of those ${repeatBoss[0]} deaths were specifically ${ability}.`,
      });
    } else {
      notes.push({
        weight: 82 + list.length,
        polarity: "negative",
        text: `${list.length} deaths to ${ability} across the night — one mechanic, drill it.`,
      });
    }
  }

  // --- defensive habits, scaled to how many deaths we're actually judging ---
  const availableNames = [...new Set(noDef.flatMap((d) => d.availableDefensives ?? []))];
  const availClause =
    availableNames.length > 0
      ? ` — ${availableNames.join(", ")} ${availableNames.length === 1 ? "was" : "were"} up`
      : "";
  if (noDef.length > 0 && noDef.length === judgeable && judgeable >= 3) {
    notes.push({
      weight: 92,
      polarity: "negative",
      text: `Zero defensives before any of your ${judgeable} avoidable deaths${availClause} — the clearest thing to fix.`,
    });
  } else if (noDef.length >= 2) {
    notes.push({
      weight: 64,
      polarity: "negative",
      text: `${noDef.length} deaths with nothing pressed beforehand${availClause}.`,
    });
  } else if (noDef.length === 1) {
    notes.push({
      weight: 32,
      polarity: "neutral",
      text: `One death with nothing pressed${availClause} — worth the reflex, but not a pattern yet.`,
    });
  }
  if (judgeable >= 2 && usedDefBeforeDeath / judgeable >= 0.7) {
    notes.push({
      weight: 46,
      polarity: "positive",
      text: `Pressed a cooldown before ${usedDefBeforeDeath} of ${judgeable} avoidable deaths — good instinct.`,
    });
  }

  // Defensive rhythm — do they press it in the same spot every pull (planned) or
  // all over the place (reactive)?  Surface the clearest of each at most.
  const rConsistent = (defensiveRhythm ?? [])
    .filter((r) => r.verdict === "consistent")
    .sort((a, b) => b.samples - a.samples)[0];
  const rScattered = (defensiveRhythm ?? [])
    .filter((r) => r.verdict === "scattered")
    .sort((a, b) => b.stdevMs - a.stdevMs)[0];
  if (rConsistent) {
    notes.push({
      weight: 54,
      polarity: "positive",
      text: `${rConsistent.ability} goes out around ${rConsistent.meanClock} into every ${rConsistent.boss} pull (${rConsistent.samples} pulls) — planned, not reactive.`,
    });
  }
  if (rScattered) {
    notes.push({
      weight: 56,
      polarity: "negative",
      text: `${rScattered.ability} on ${rScattered.boss} lands anywhere from ${rScattered.minClock} to ${rScattered.maxClock} pull to pull — reads reactive, not planned.`,
    });
  }
  if (everythingDown.length > 0) {
    notes.push({
      weight: 28,
      polarity: "neutral",
      text: `${everythingDown.length} death${everythingDown.length === 1 ? "" : "s"} with every cooldown already down — unlucky, not on you.`,
    });
  }
  if (unusedDefensives?.length > 0) {
    notes.push({
      weight: 52,
      polarity: "negative",
      text: `Never touched ${unusedDefensives.join(", ")} all night.`,
    });
  }

  const killPullDeaths = deaths.filter((d) => d.kill).length;
  if (killPullDeaths > 0 && killPullDeaths === deaths.length) {
    notes.push({
      weight: 30,
      polarity: "neutral",
      text: `Every death was on a pull the raid still closed out — never fight-ending.`,
    });
  }

  // --- consumables / prep ---
  const dpsPotCount = consumables.filter((c) => c.category === "dps").reduce((sum, c) => sum + c.count, 0);
  if (role === "dps" && totalKillPulls >= 3 && dpsPotCount === 0) {
    notes.push({
      weight: 44,
      polarity: "negative",
      text: `No DPS potions across ${totalKillPulls} kills — free damage left behind.`,
    });
  }
  const oldHP = consumables.filter((c) => c.name === OUTDATED_HEALTH_POTION_NAME).reduce((sum, c) => sum + c.count, 0);
  const newHP = consumables.filter((c) => c.name === UPGRADED_HEALTH_POTION_NAME).reduce((sum, c) => sum + c.count, 0);
  if (oldHP > 0 && newHP === 0) {
    notes.push({
      weight: 38,
      polarity: "negative",
      text: `Still on the old Silvermoon Health Potion (${oldHP}x) — Concentrated is a straight upgrade.`,
    });
  }
  const prepBits = [];
  if (prepCheck?.missingEnchantSlots?.length)
    prepBits.push(`${prepCheck.missingEnchantSlots.length} unenchanted slot${prepCheck.missingEnchantSlots.length === 1 ? "" : "s"}`);
  if (prepCheck?.missingWeaponEnchantPulls?.length) prepBits.push("no weapon oil");
  if (prepCheck?.missingFlaskPulls?.length) prepBits.push("flask gaps");
  if (prepCheck?.missingFoodPulls?.length) prepBits.push("food gaps");
  if (prepCheck?.missingPrimaryStatGem) prepBits.push("no primary-stat gem");
  if (prepBits.length >= 2) {
    notes.push({ weight: 50, polarity: "negative", text: `Prep gaps: ${prepBits.join(", ")}.` });
  } else if (prepBits.length === 1) {
    notes.push({ weight: 36, polarity: "negative", text: `Prep gap: ${prepBits[0]}.` });
  }
  // A one-pull lapse is usually just someone getting rezzed into a brief gap — only
  // worth a note once it's a repeated thing.
  const totalBuffLapses = (raidBuffLapses ?? []).reduce((sum, b) => sum + b.lapsePulls.length, 0);
  if (raidBuffProvided && totalBuffLapses >= 2) {
    notes.push({
      weight: 54,
      polarity: "negative",
      text: `Let ${raidBuffLapses.map((b) => b.buffName).join(", ")} drop on ${totalBuffLapses} pulls — longest gap ${mmss(Math.max(...raidBuffLapses.map((b) => b.worstGapMs)))}.`,
    });
  } else if (raidBuffProvided && totalBuffLapses === 0) {
    notes.push({ weight: 30, polarity: "positive", text: `Kept ${raidBuffProvided} up all night.` });
  }

  // --- positives ---
  if (interrupts.length >= 3 && !isInterruptExemptHealer(role, className)) {
    const avgOthers =
      othersInterruptTotals.length > 0
        ? othersInterruptTotals.reduce((sum, n) => sum + n, 0) / othersInterruptTotals.length
        : 0;
    const standsOut =
      othersInterruptTotals.length === 0 || (interrupts.length >= avgOthers * 1.5 && interrupts.length - avgOthers >= 2);
    if (standsOut) {
      const viaPet = interrupts.filter((i) => i.viaPet).length;
      notes.push({
        weight: 58,
        polarity: "positive",
        text:
          `${interrupts.length} interrupts${viaPet > 0 ? ` (${viaPet} via pet)` : ""}` +
          (avgOthers > 0 ? `, vs a raid average of ${avgOthers.toFixed(0)}` : "") +
          ` — carried the kick rotation.`,
      });
    }
  }
  // Clutch externals only — routine raid-shield spam (Power Word: Shield) shouldn't
  // read as "250 externals thrown to save teammates".
  const clutchExternals = externalsGiven.filter((e) => !MAINTENANCE_EXTERNAL_NAMES.has(e.ability)).length;
  if (clutchExternals >= 1) {
    notes.push({
      weight: 50,
      polarity: "positive",
      text: `${clutchExternals === 1 ? "One external" : `${clutchExternals} externals`} thrown to save teammates.`,
    });
  }
  const totalDispels = [...dispelsByAbility.values()].reduce((sum, n) => sum + n, 0);
  if (role === "healer" && totalDispels >= 5) {
    const top = [...dispelsByAbility.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n);
    notes.push({
      weight: 48,
      polarity: "positive",
      text: `${totalDispels} dispels${top.length ? ` (mostly ${top.join(", ")})` : ""} — on top of raid debuffs.`,
    });
  }
  if (innervatesCast >= 1) {
    notes.push({
      weight: 42,
      polarity: "positive",
      text: `${innervatesCast} Innervate${innervatesCast === 1 ? "" : "s"} handed to the healers.`,
    });
  }
  // Rare and always worth a shout — landed a battle rez instead of eating the wipe.
  // Weighted up when they're clearly ahead of the raid's other rezzers.
  if (combatResCount >= 1) {
    const ahead = combatResTop
      ? " — more than anyone else in the raid"
      : combatResJointTop
        ? " — joint-most in the raid"
        : combatResStandout === "high"
          ? " — well above the raid's other rezzers"
          : "";
    notes.push({
      weight: combatResStandout === "high" || combatResTop ? 62 : 52,
      polarity: "positive",
      text: `${combatResCount === 1 ? "Landed a combat resurrection" : `Landed ${combatResCount} combat resurrections`}${ahead} — kept the pull alive instead of eating a wipe.`,
    });
  } else if (combatResNeverUsed) {
    // Heaviest negative in the list: a battle rez sat unused all night while other
    // people were bringing raiders back. Only fires when someone else actually landed
    // one, so it can't go off on a night with no rezzable moments.
    notes.push({
      weight: 70,
      polarity: "negative",
      text:
        className === "Warlock"
          ? `Never put a Soulstone out all night, while the raid's other rezzers brought back ${othersCombatResTotals.reduce((sum, v) => sum + v, 0)} people.`
          : `Never used your battle rez all night, while the raid's other rezzers landed ${othersCombatResTotals.reduce((sum, v) => sum + v, 0)} between them.`,
    });
  } else if (combatResStandout === "low") {
    notes.push({
      weight: 48,
      polarity: "negative",
      text: `Only ${combatResCount} battle rez${combatResCount === 1 ? "" : "es"} — well below the others who have one.`,
    });
  }
  const mech = (label, cnt, standout) => {
    if (standout === "high") notes.push({ weight: 45, polarity: "positive", text: `${label}: ${cnt}x — well above raid average.` });
    else if (standout === "low") notes.push({ weight: 45, polarity: "negative", text: `${label}: only ${cnt}x — well below raid average.` });
  };
  mech("Coiled Altar orb carries", orbCarryCount, orbCarryStandout);
  mech("Twin Fangs Feast soaks", feastSoakCount, feastSoakStandout);
  mech("Entombed Sentinels Toxic Droplets soaks", toxicDropletSoakCount, toxicDropletSoakStandout);
  // Dig In: only the "high" side is worth a note — dealing less than average during
  // the window isn't necessarily a problem (could be a healer, could be an add
  // tunneled instead of boss), so it's not flagged as a negative.
  if (digInWindowDamageStandout === "high") {
    notes.push({
      weight: 44,
      polarity: "positive",
      text: `Led damage during Sszorak's Dig In window (${Math.round(digInWindowDamageTotal).toLocaleString()} total) — well above raid average.`,
    });
  }
  // Tornado: only "high" (got caught more than average) is worth a note — being
  // caught less than average is just normal, not praiseworthy.
  if (tornadoHitStandout === "high") {
    notes.push({
      weight: 44,
      polarity: "negative",
      text: `Caught by Sszorak's tornado (Tempest) ${tornadoHitCount}x — well above raid average, worth tightening up positioning.`,
    });
  }
  if (waveTouchStandout === "high") {
    notes.push({
      weight: 44,
      polarity: "negative",
      text: `Took ${waveTouchCount} extra Eternal Venom stacks from Twin Fangs waves — well above raid average. Every touch is a stack, even the brief ones that deal no damage, and staying in a wave keeps stacking.`,
    });
  }

  return notes;
}

// The rich verdict: a headline that IS the biggest finding (not a template), an
// "Also" list of everything else worth a glance, a "Did well" list of earned
// positives (not forced), and a by-the-numbers line. Budgeted to stay under
// Discord's 1024-char field limit — the "Did well" block and then "Also" bullets
// get trimmed if it runs long.
const VERDICT_CHAR_BUDGET = 1000;


function buildVerdict({
  deaths,
  kills,
  className,
  interrupts,
  consumables,
  totalKillPulls,
  totalWipePulls,
  externalsGiven,
  othersInterruptTotals,
  dispelsByAbility,
  innervatesCast,
  combatResCount,
  combatResStandout,
  combatResNeverUsed,
  combatResTop,
  combatResJointTop,
  soulstonePlacementCount,
  othersCombatResTotals,
  defensiveRhythm,
  prepCheck,
  raidBuffLapses,
  raidBuffProvided,
  deathRank,
  raidDeathCount,
  raidDeathAvg,
  otherDeathlessCount,
  orbCarryCount,
  orbCarryStandout,
  feastSoakCount,
  feastSoakStandout,
  toxicDropletSoakCount,
  toxicDropletSoakStandout,
  digInWindowDamageTotal,
  digInWindowDamageStandout,
  tornadoHitCount,
  tornadoHitStandout,
  waveTouchCount,
  waveTouchStandout,
  unusedDefensives,
}) {
  const totalDeaths = deaths.length;
  const role = kills.find((k) => k.role)?.role ?? null;
  const notes = buildObservations({
    deaths,
    className,
    interrupts,
    consumables,
    totalKillPulls,
    externalsGiven,
    othersInterruptTotals,
    role,
    dispelsByAbility,
    innervatesCast,
    combatResCount,
    combatResStandout,
    combatResNeverUsed,
    combatResTop,
    combatResJointTop,
    soulstonePlacementCount,
    othersCombatResTotals,
    defensiveRhythm,
    prepCheck,
    raidBuffLapses,
    raidBuffProvided,
    orbCarryCount,
    orbCarryStandout,
    feastSoakCount,
    feastSoakStandout,
    toxicDropletSoakCount,
    toxicDropletSoakStandout,
    digInWindowDamageTotal,
    digInWindowDamageStandout,
    tornadoHitCount,
    tornadoHitStandout,
    waveTouchCount,
    waveTouchStandout,
    unusedDefensives,
  });
  const negatives = notes.filter((n) => n.polarity !== "positive").sort((a, b) => b.weight - a.weight);
  const positives = notes.filter((n) => n.polarity === "positive").sort((a, b) => b.weight - a.weight);

  // --- headline ---
  const countClause = deathCountClause(totalDeaths, deathRank, raidDeathCount, raidDeathAvg);
  const flag =
    totalDeaths >= 4 || (deathRank === 1 && raidDeathAvg != null && totalDeaths >= raidDeathAvg * 1.4) ? "🚩 " : "";
  const lead = negatives[0];
  const totalPulls = totalKillPulls + totalWipePulls;
  let headline;
  if (totalDeaths === 0 && totalPulls >= 3) {
    // A deathless night is the single most useful thing a raider can do for the
    // raid (raider feedback: Pynky went 0 deaths over 40 pulls vs. a 2.6 raid average
    // and only got "nothing major" + a nitpick). Lead with it, keep it fun — no need
    // to explain the wipe-cutoff logic behind "no deaths". Any nitpick comes after.
    const praise = randomPraise("personal");
    const rarity =
      otherDeathlessCount === 0
        ? " — the only raider to manage that"
        : otherDeathlessCount <= 2
          ? ` — one of only ${otherDeathlessCount + 1} raiders to manage that`
          : "";
    headline = `🌟 No deaths tonight, ${praise}${rarity}.` + (lead ? `\n\nOne thing to tidy: ${lead.text}` : "");
  } else if (totalDeaths === 0 && !lead) {
    headline = "✅ Clean night — no deaths, nothing to flag.";
  } else if (lead && lead.weight >= 60) {
    headline = `${flag}${countClause}. ${lead.text}`;
  } else if (lead) {
    headline = `${flag}${countClause} — nothing major. ${lead.text}`;
  } else {
    headline = `${flag}${countClause} — nothing that needs attention.`;
  }

  // --- also / did well ---
  const alsoNotes = negatives.slice(lead ? 1 : 0, (lead ? 1 : 0) + 4);
  let also = alsoNotes.map((n) => `• ${n.text}`);
  let didWell = positives.filter((n) => n.weight >= 40).slice(0, 3).map((n) => `• ${n.text}`);

  // --- by the numbers ---
  const preventable = deaths.filter((d) => d.defensivePreventable);
  const unavoidable = preventable.filter((d) => d.hadDefensiveAvailable === false).length;
  const judged = preventable.length - unavoidable;
  const usedBefore = preventable.filter((d) => d.defensiveUsed).length;
  const dS = totalDeaths === 1 ? "" : "s";
  const statBits = [];
  statBits.push(
    raidDeathAvg != null
      ? `${totalDeaths} death${dS} (raid averaged ${raidDeathAvg.toFixed(1)})`
      : `${totalDeaths} death${dS}`
  );
  if (judged > 0) {
    statBits.push(`defensive up before ${usedBefore} of ${judged} avoidable death${judged === 1 ? "" : "s"}`);
  }
  if (unavoidable > 0) {
    statBits.push(
      unavoidable === totalDeaths
        ? `every cooldown was already down for ${unavoidable === 1 ? "it" : "them"}`
        : `${unavoidable} where every cooldown was already down`
    );
  }
  statBits.push(
    `in ${totalKillPulls} kill${totalKillPulls === 1 ? "" : "s"} + ${totalWipePulls} wipe${totalWipePulls === 1 ? "" : "s"}`
  );

  // --- assemble, trimming to budget ---
  const assemble = () => {
    const parts = [headline];
    if (also.length) parts.push("🔍 Also:\n" + also.join("\n"));
    if (didWell.length) parts.push("✅ Did well:\n" + didWell.join("\n"));
    parts.push("📊 " + statBits.join(" · "));
    return parts.join("\n\n");
  };
  let out = assemble();
  while (out.length > VERDICT_CHAR_BUDGET && didWell.length > 0) {
    didWell = didWell.slice(0, -1);
    out = assemble();
  }
  while (out.length > VERDICT_CHAR_BUDGET && also.length > 1) {
    also = also.slice(0, -1);
    out = assemble();
  }
  return out;
}

// playerNames: array of character names — lets one report cover a person's main + alts.
// specLookup: optional Map<characterName, {class, spec}> built from roster.json —
// see neverUsedDefensives for why this takes priority over WCL's own spec detection.
// trashRoster: optional array from analyzeTrash().roster — [{ name, class, isHealer,
// total, perSecond }] sorted by total desc. Used to show this player's trash standing
// ONLY if they're top-5 or bottom-5; mid-pack is omitted (raider request).
export function buildPlayerFeedback(analysis, playerNames, specLookup = null, trashRoster = null) {
  const nameSet = new Set(playerNames);

  const deaths = [];
  const kills = [];
  const interrupts = [];
  const consumableCounts = new Map(); // key: `${characterName}::${abilityName}`
  const defensiveCounts = new Map(); // key: `${characterName}::${abilityName}`
  const externalsGiven = [];
  const dispelsByAbility = new Map(); // removed-debuff name -> count (this player as the dispeller)
  const innervatesGiven = []; // { targetName, selfCast } — this player casting Innervate
  const innervatesReceived = []; // { sourceName } — this player getting an Innervate
  const combatResGiven = []; // { targetName, ability, pullNumber, bossName } — this player landed a combat rez
  const combatResReceived = []; // { sourceName, ability, pullNumber, bossName } — this player got combat rezzed
  // key: bossName -> { bossName, killed, wiped, firstPullNumber } — tracked for the
  // whole raid (every pull) so bosses the player sat out still show up as "missed"
  // rather than silently disappearing from their report.
  const raidBossStats = new Map();
  const playerBossStats = new Map();
  const raidInterrupterTotals = new Map(); // characterName -> total interrupts, whole raid
  const raidOrbCarryTotals = new Map(); // characterName -> total orb carries, whole raid
  const raidFeastSoakTotals = new Map(); // characterName -> total Feast soaks, whole raid
  const raidToxicDropletSoakTotals = new Map(); // characterName -> total Toxic Droplets soaks, whole raid
  const raidDigInWindowDamageTotals = new Map(); // characterName -> total Dig In window damage, whole raid
  const raidTornadoHitTotals = new Map(); // characterName -> total tornado hits, whole raid
  const raidSszorakAttendees = new Set(); // every character present for at least one Sszorak pull, whole raid
  const raidWaveTouchTotals = new Map(); // characterName -> total Twin Fangs wave touches, whole raid
  const raidTwinFangsAttendees = new Set(); // every character present for at least one Twin Fangs pull, whole raid
  const raidCombatResTotals = new Map(); // characterName -> battle rezzes landed, whole raid
  let soulstonePlacementCount = 0; // this player putting Soulstones out (Warlocks only)
  const raidCombatResCapable = new Set(); // every character in the raid who HAS a battle rez
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
  const raidDeathTotals = new Map(); // characterName -> capped death count, whole raid (for the "vs the raid" line)
  const raidAttendees = new Set(); // every character seen in the raid this night
  const defCastTimings = new Map(); // `${boss}::${ability}` -> [{ pullNumber, t }] for defensive-rhythm
  let orbCarryCount = 0;
  let digInWindowDamageTotal = 0;
  let tornadoHitCount = 0;
  let waveTouchCount = 0;
  let feastSoakCount = 0;
  let toxicDropletSoakCount = 0;

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
      raidOrbCarryTotals.set(o.playerName, (raidOrbCarryTotals.get(o.playerName) ?? 0) + 1);
    }
    for (const f of pull.feastSoaks ?? []) {
      raidFeastSoakTotals.set(f.playerName, (raidFeastSoakTotals.get(f.playerName) ?? 0) + 1);
    }
    for (const t of pull.toxicDropletSoaks ?? []) {
      raidToxicDropletSoakTotals.set(t.playerName, (raidToxicDropletSoakTotals.get(t.playerName) ?? 0) + 1);
    }
    for (const d of pull.digInWindowDamage ?? []) {
      raidDigInWindowDamageTotals.set(d.playerName, (raidDigInWindowDamageTotals.get(d.playerName) ?? 0) + d.damage);
    }
    for (const t of pull.tornadoHits ?? []) {
      raidTornadoHitTotals.set(t.playerName, (raidTornadoHitTotals.get(t.playerName) ?? 0) + 1);
    }
    for (const pc of pull.prepChecks ?? []) {
      if (pc.playerName) raidAttendees.add(pc.playerName);
      // Tornado hits are 0 for most of the raid most nights — that's the good outcome,
      // not an absence of data — so ranking needs everyone who was AT the fight, not
      // just the (much smaller) set of names that happen to appear in
      // raidTornadoHitTotals (which only has players hit at least once).
      if (pc.playerName && pull.bossName === SSZORAK_BOSS_NAME) raidSszorakAttendees.add(pc.playerName);
      if (pc.playerName && pull.bossName === FEAST_SOAK_BOSS_NAME) raidTwinFangsAttendees.add(pc.playerName);
      // Everyone in the raid who owns a battle rez — the only fair comparison group
      // for "should you have used one". Seeded from attendance (not from who actually
      // rezzed) so a Druid who never pressed it still counts in the pool.
      if (pc.playerName && COMBAT_RES_CLASSES.has(pc.playerClass)) raidCombatResCapable.add(pc.playerName);
    }
    for (const w of pull.waveTouches ?? []) {
      raidWaveTouchTotals.set(w.playerName, (raidWaveTouchTotals.get(w.playerName) ?? 0) + 1);
      if (nameSet.has(w.playerName)) waveTouchCount += 1;
    }

    for (const o of pull.orbCarries ?? []) {
      if (nameSet.has(o.playerName)) orbCarryCount += 1;
    }
    for (const f of pull.feastSoaks ?? []) {
      if (nameSet.has(f.playerName)) feastSoakCount += 1;
    }
    for (const t of pull.toxicDropletSoaks ?? []) {
      if (nameSet.has(t.playerName)) toxicDropletSoakCount += 1;
    }
    for (const d of pull.digInWindowDamage ?? []) {
      if (nameSet.has(d.playerName)) digInWindowDamageTotal += d.damage;
    }
    for (const t of pull.tornadoHits ?? []) {
      if (nameSet.has(t.playerName)) tornadoHitCount += 1;
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
      // analyze.js only emits an entry when the buff actually dropped on someone.
      for (const gap of pull.buffGaps ?? []) {
        if (!gap.providerPlayerNames.some((n) => nameSet.has(n))) continue;
        const entry = missedClassBuffPulls.get(gap.buffName) ?? {
          buffName: gap.buffName,
          startMissCount: 0,
          rebuffMissCount: 0,
          worstGapMs: 0,
          lapsePulls: [],
          worstPlayerName: null,
        };
        entry.startMissCount += gap.startMissCount;
        entry.rebuffMissCount += gap.rebuffMissCount;
        if (gap.worstGapMs > entry.worstGapMs) {
          entry.worstGapMs = gap.worstGapMs;
          entry.worstPlayerName = gap.missingPlayers[0]?.playerName ?? null;
        }
        entry.lapsePulls.push(pull.pullNumber);
        missedClassBuffPulls.set(gap.buffName, entry);
      }
    }

    // Same "pull was already lost" cutoff as /summary — called-wipe pile-ons and
    // deaths after the raid was effectively wiped are already dropped by
    // cappedDeathsForTally, so nothing past that point is shown or judged here.
    for (const d of cappedDeathsForTally(pull)) {
      raidDeathTotals.set(d.playerName, (raidDeathTotals.get(d.playerName) ?? 0) + 1);
      raidAttendees.add(d.playerName);
      if (!nameSet.has(d.playerName)) continue;
      deaths.push({
        characterName: d.playerName,
        characterClass: d.playerClass,
        pullNumber: pull.pullNumber,
        bossName: pull.bossName,
        kill: pull.kill,
        killedBy: d.killedBy,
        timestamp: d.timestamp,
        timeIntoPull: d.timeIntoPull,
        sharedMomentCount: d.sharedMomentCount,
        defensiveUsed: d.defensiveUsed,
        defensivePreventable: d.defensivePreventable,
        externalHealer: d.externalHealer,
        externalAbility: d.externalAbility,
        deathNumber: d.deathNumber,
        // Filled in after the loop once the player's class/spec kit is resolved.
        availableDefensives: null,
        hadDefensiveAvailable: undefined,
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

    for (const e of pull.dispels ?? []) {
      if (!nameSet.has(e.sourceName)) continue;
      dispelsByAbility.set(e.removedAbility, (dispelsByAbility.get(e.removedAbility) ?? 0) + 1);
    }

    for (const iv of pull.innervates ?? []) {
      if (nameSet.has(iv.sourceName)) innervatesGiven.push({ targetName: iv.targetName, selfCast: iv.selfCast });
      else if (nameSet.has(iv.targetName)) innervatesReceived.push({ sourceName: iv.sourceName });
    }

    for (const s of pull.soulstonePlacements ?? []) {
      if (nameSet.has(s.sourceName)) soulstonePlacementCount += 1;
    }
    for (const r of pull.combatRes ?? []) {
      raidCombatResTotals.set(r.sourceName, (raidCombatResTotals.get(r.sourceName) ?? 0) + 1);
      if (nameSet.has(r.sourceName)) {
        combatResGiven.push({ targetName: r.targetName, ability: r.ability, pullNumber: pull.pullNumber, bossName: pull.bossName });
      } else if (r.targetName && nameSet.has(r.targetName)) {
        combatResReceived.push({ sourceName: r.sourceName, ability: r.ability, pullNumber: pull.pullNumber, bossName: pull.bossName });
      }
    }

    for (const c of pull.casts ?? []) {
      if (!nameSet.has(c.sourceName)) continue;

      // Defensive-rhythm sample: when in the pull did each real CD first go out.
      if (DEFENSIVE_COOLDOWNS[c.abilityName] && c.timeIntoPullMs != null) {
        const rk = `${pull.bossName}::${c.abilityName}`;
        if (!defCastTimings.has(rk)) defCastTimings.set(rk, []);
        defCastTimings.get(rk).push({ pullNumber: pull.pullNumber, t: c.timeIntoPullMs });
      }

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

  const othersOrbCarryTotals = [...raidOrbCarryTotals.entries()].filter(([name]) => !nameSet.has(name)).map(([, c]) => c);
  const othersFeastSoakTotals = [...raidFeastSoakTotals.entries()].filter(([name]) => !nameSet.has(name)).map(([, c]) => c);
  const othersToxicDropletSoakTotals = [...raidToxicDropletSoakTotals.entries()]
    .filter(([name]) => !nameSet.has(name))
    .map(([, c]) => c);
  const othersDigInWindowDamageTotals = [...raidDigInWindowDamageTotals.entries()]
    .filter(([name]) => !nameSet.has(name))
    .map(([, c]) => c);
  const othersTornadoHitTotals = [...raidTornadoHitTotals.entries()]
    .filter(([name]) => !nameSet.has(name))
    .map(([, c]) => c);
  const othersWaveTouchTotals = [...raidWaveTouchTotals.entries()]
    .filter(([name]) => !nameSet.has(name))
    .map(([, c]) => c);
  // Don't flag someone "below raid average" on a rotational mechanic most of the raid
  // also skipped — 0 orb carries isn't a failing if only 5 people ever carry one
  // (raider feedback: "a lot of peeps got 'below raid average', is it really below
  // average if a lot of people didn't do it?"). Gate "low" on the mechanic being
  // widely done — at least half of everyone who was in the raid.
  const raidHeadcount = Math.max(raidAttendees.size, 1);
  const widelyDone = (othersWhoDidIt) => othersWhoDidIt.length >= (raidHeadcount - 1) * 0.5;

  let orbCarryStandout = standoutVsOthers(orbCarryCount, othersOrbCarryTotals, 3);
  // "Low" only means something if they were actually there for the mechanic —
  // otherwise 0 orb carries just means they sat that boss out, not that they slacked.
  if (orbCarryStandout === "low" && (!playerBossStats.has(ORB_CARRY_BOSS_NAME) || !widelyDone(othersOrbCarryTotals)))
    orbCarryStandout = null;
  let feastSoakStandout = standoutVsOthers(feastSoakCount, othersFeastSoakTotals, 2);
  if (feastSoakStandout === "low" && (!playerBossStats.has(FEAST_SOAK_BOSS_NAME) || !widelyDone(othersFeastSoakTotals)))
    feastSoakStandout = null;
  // Toxic Droplets soak counts run much higher than orb carries/Feast soaks (tens,
  // not single digits), so the minimum gap to call out is scaled up to match.
  let toxicDropletSoakStandout = standoutVsOthers(toxicDropletSoakCount, othersToxicDropletSoakTotals, 15);
  if (
    toxicDropletSoakStandout === "low" &&
    (!playerBossStats.has(TOXIC_DROPLETS_BOSS_NAME) || !widelyDone(othersToxicDropletSoakTotals))
  )
    toxicDropletSoakStandout = null;

  // Dig In damage — only the "high" side is meaningful (see buildObservations).
  // Gated on having actually attended Sszorak; a fresh Infinity-average edge case
  // (nobody else has a nonzero total yet) is handled by standoutVsOthers itself.
  let digInWindowDamageStandout = standoutVsOthers(digInWindowDamageTotal, othersDigInWindowDamageTotals, 1);
  if (digInWindowDamageStandout !== "high" || !playerBossStats.has(SSZORAK_BOSS_NAME)) digInWindowDamageStandout = null;
  // Raid average + rank for Dig In damage, for the personal "how did I compare" line
  // — same "min 4 in the raid" gate as raidDeathAvg below. Rank is 1-indexed among
  // everyone (self + others) who dealt any Dig In damage this night.
  let digInWindowDamageRaidAvg = null;
  let digInWindowDamageRank = null;
  let digInWindowDamageRaidCount = null;
  if (raidDigInWindowDamageTotals.size >= 4) {
    const values = [...raidDigInWindowDamageTotals.values()];
    digInWindowDamageRaidAvg = values.reduce((sum, v) => sum + v, 0) / values.length;
    if (digInWindowDamageTotal > 0) {
      digInWindowDamageRaidCount = othersDigInWindowDamageTotals.length + 1;
      digInWindowDamageRank = 1 + othersDigInWindowDamageTotals.filter((v) => v > digInWindowDamageTotal).length;
    }
  }
  // Tornado hits — only the "high" (caught more than average) side is meaningful.
  let tornadoHitStandout = standoutVsOthers(tornadoHitCount, othersTornadoHitTotals, 2);
  if (tornadoHitStandout !== "high" || !playerBossStats.has(SSZORAK_BOSS_NAME)) tornadoHitStandout = null;
  // Rank for tornado hits, for the personal "how did I compare" line. Tanks are left
  // out of the comparison entirely (same call the raid lead made for the /summary
  // leaderboard): they're parked in the boss's face by design and eat far more hits
  // than anyone else, which dragged the raid average up so hard that a player could
  // sit 16th of 20 while reading as only "11% above raid avg" — the two halves of the
  // line contradicted each other and neither looked trustworthy.
  const isTankName = (name) => TANK_SPEC_NAMES.has(specLookup?.get(name)?.spec);
  // A tank reading this is measured against a pool they were deliberately left out
  // of, so they get the raw count with no rank — ranking them against non-tanks
  // would just tell every tank they're the worst in the raid every single week.
  const playerIsTank = [...raidSszorakAttendees].some((name) => nameSet.has(name) && isTankName(name));
  const tornadoHitStanding =
    playerBossStats.has(SSZORAK_BOSS_NAME) && !playerIsTank
      ? lowerIsBetterStanding(
          tornadoHitCount,
          [...raidSszorakAttendees].filter((name) => !isTankName(name)),
          nameSet,
          raidTornadoHitTotals
        )
      : null;

  // Twin Fangs wave touches — same lower-is-better ranking, but tanks stay in the pool
  // (touching a wave isn't part of the tank's job, unlike standing in a tornado).
  let waveTouchStandout = standoutVsOthers(waveTouchCount, othersWaveTouchTotals, 2);
  if (waveTouchStandout !== "high" || !playerBossStats.has(FEAST_SOAK_BOSS_NAME)) waveTouchStandout = null;
  const waveTouchStanding = playerBossStats.has(FEAST_SOAK_BOSS_NAME)
    ? lowerIsBetterStanding(waveTouchCount, [...raidTwinFangsAttendees], nameSet, raidWaveTouchTotals)
    : null;

  const role = kills.find((k) => k.role)?.role ?? null;
  const defensivesUsed = [...defensiveCounts.values()];
  // Only worth checking with a real sample of the night to draw from.
  const unusedDefensives =
    totalKillPulls + totalWipePulls >= 3
      ? neverUsedDefensives({ deaths, kills, defensivesUsed, externalsGiven, role, specLookup })
      : [];

  // Cooldown-aware death eval: for each "no defensive" death, work out which of the
  // player's real emergency cooldowns were actually off CD at that moment (from their
  // own casts earlier in that same pull). Deaths where everything was down get greyed
  // out and don't count against them (raider request). Needs a resolved class/spec —
  // if that's ambiguous, leave hadDefensiveAvailable undefined and fall back to the
  // old "no defensive used" wording.
  const resolvedKit = resolvePlayerKit(deaths, kills, specLookup);
  const className =
    resolvedKit?.className ??
    kills.find((k) => k.characterClass)?.characterClass ??
    deaths.find((d) => d.characterClass)?.characterClass ??
    null;
  {
    const pullsByNumber = new Map(analysis.pulls.map((p) => [p.pullNumber, p]));
    for (const d of deaths) {
      if (d.defensiveUsed || d.externalAbility || !d.defensivePreventable) continue;
      const pull = pullsByNumber.get(d.pullNumber);
      const playerPullCasts = (pull?.casts ?? []).filter((c) => nameSet.has(c.sourceName));
      if (resolvedKit) {
        const available = realDefensivesAvailableAt(resolvedKit.kit, playerPullCasts, d.timestamp);
        d.availableDefensives = available;
        d.hadDefensiveAvailable = available.length > 0;
      }
      // Health potion / healthstone: one use per pull, so "available" = hadn't
      // cracked one yet before this death.
      d.healthConsumableAvailable = !playerPullCasts.some(
        (c) => c.timestamp <= d.timestamp && isConsumableAbility(c.abilityName) && consumableCategory(c.abilityName) === "health"
      );
    }
  }

  const interruptExemptHealer = isInterruptExemptHealer(role, className);
  const innervatesCast = innervatesGiven.length;
  const combatResCount = combatResGiven.length;
  const defensiveRhythm = computeDefensiveRhythm(defCastTimings);

  // Battle rezzes judged only against OTHER raiders who also have one — comparing a
  // Druid to a Mage would be meaningless. Zeros are seeded from the capable pool, so
  // a Druid who never pressed it is in the comparison rather than absent from it.
  // If nobody rezzed all night the average is 0 and standoutVsOthers returns null,
  // which is the fairness gate: no rezzes anywhere usually means there was never a
  // live pull worth saving, not that everyone slacked.
  const combatResCapable = [...raidCombatResCapable].some((name) => nameSet.has(name));
  // The comparison pool is everyone who COULD rez (at 0 if they never did) PLUS anyone
  // who actually landed one, whatever their class. That second half matters: Paladin
  // Intercession is left out of the flag list because it's a talent, and reusing that
  // list for comparisons quietly hid the raid's biggest rezzer — a player on 2 was
  // told he'd done "more than anyone else" on a night a Paladin landed 11.
  const combatResPool = new Set([...raidCombatResCapable, ...raidCombatResTotals.keys()]);
  const othersCombatResTotals = [...combatResPool]
    .filter((name) => !nameSet.has(name))
    .map((name) => raidCombatResTotals.get(name) ?? 0);
  const bestOtherCombatRes = othersCombatResTotals.length > 0 ? Math.max(...othersCombatResTotals) : 0;
  // Only claim a superlative when it's actually true — "high" from standoutVsOthers
  // just means above average, which is not the same as being top of the raid.
  const combatResTop = combatResCount > 0 && combatResCount > bestOtherCombatRes;
  const combatResJointTop = combatResCount > 0 && combatResCount === bestOtherCombatRes;
  let combatResStandout = combatResCapable ? standoutVsOthers(combatResCount, othersCombatResTotals, 1) : null;
  // "Had one and never used it" is the headline case, so it's called out even when the
  // gap to the others is small — as long as somebody else actually managed one.
  //
  // A Warlock who put Soulstones out is exempt: they did their job, and whether a
  // stone ever fires depends on whether that player dies, not on the Warlock. They're
  // only on the hook if no stone went out at all.
  const warlockDidTheirJob = soulstonePlacementCount > 0;
  const combatResNeverUsed =
    combatResCapable &&
    combatResCount === 0 &&
    !warlockDidTheirJob &&
    othersCombatResTotals.some((v) => v > 0);
  if (combatResNeverUsed) combatResStandout = "low";

  // This player's death count vs. the rest of the raid — turns "5 deaths" into
  // "5 deaths, 2nd most in the raid" or "5 deaths, about average tonight". Only when
  // there's a real raid to compare against.
  const myDeathCount = deaths.length;
  let deathRank = null;
  let raidDeathAvg = null;
  let raidDeathCount = null;
  for (const [name] of raidDeathTotals) raidAttendees.add(name);
  if (raidAttendees.size >= 4) {
    raidDeathCount = raidAttendees.size;
    const values = [...raidAttendees].map((n) => raidDeathTotals.get(n) ?? 0);
    raidDeathAvg = values.reduce((sum, v) => sum + v, 0) / values.length;
    deathRank =
      1 + [...raidAttendees].filter((n) => !nameSet.has(n) && (raidDeathTotals.get(n) ?? 0) > myDeathCount).length;
  }
  // Other raiders who also went the night without a (counted) death — makes a
  // deathless night read as rare when it is.
  const otherDeathlessCount = [...raidAttendees].filter((n) => !nameSet.has(n) && !raidDeathTotals.get(n)).length;

  // Trash standing — only surfaced if this player is top-5 or bottom-5 of the trash
  // damage/healing ranking; mid-pack is left off entirely.
  let trashStanding = null;
  if (Array.isArray(trashRoster) && trashRoster.length > 0) {
    const idx = trashRoster.findIndex((r) => nameSet.has(r.name));
    if (idx !== -1) {
      const rank = idx + 1;
      const size = trashRoster.length;
      if (rank <= 5 || rank > size - 5) {
        const row = trashRoster[idx];
        trashStanding = {
          rank,
          size,
          top: rank <= 5,
          total: row.total,
          perSecond: row.perSecond,
          isHealer: row.isHealer,
        };
      }
    }
  }

  const prepCheck = { missingEnchantSlots, missingPrimaryStatGem, missingFlaskPulls, missingFoodPulls, missingWeaponEnchantPulls };
  const raidBuffLapses = [...missedClassBuffPulls.values()];
  const raidBuffProvided =
    Object.entries(CLASS_BUFFS).find(([, cls]) => cls === (firstPrepCheck ?? lastPrepCheck)?.playerClass)?.[0] ?? null;

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
    interruptExemptHealer,
    dispels: [...dispelsByAbility.entries()].map(([ability, count]) => ({ ability, count })),
    innervatesGiven,
    innervatesReceived,
    combatResGiven,
    combatResReceived,
    defensiveRhythm,
    trashStanding,
    consumables: consumablesUsed,
    defensivesUsed,
    unusedDefensives,
    externalsGiven,
    orbCarryCount,
    orbCarryStandout,
    digInWindowDamageTotal,
    digInWindowDamageStandout,
    digInWindowDamageRaidAvg,
    digInWindowDamageRank,
    digInWindowDamageRaidCount,
    tornadoHitCount,
    tornadoHitStandout,
    tornadoHitStanding,
    waveTouchCount,
    waveTouchStandout,
    waveTouchStanding,
    feastSoakCount,
    feastSoakStandout,
    toxicDropletSoakCount,
    toxicDropletSoakStandout,
    prepCheck,
    raidBuffLapses,
    raidBuffProvided,
    deathRank,
    raidDeathAvg,
    verdict: buildVerdict({
      deaths,
      kills,
      className,
      interrupts,
      consumables: consumablesUsed,
      totalKillPulls,
      totalWipePulls,
      externalsGiven,
      othersInterruptTotals: [...raidInterrupterTotals.entries()]
        .filter(([name]) => !nameSet.has(name))
        .map(([, count]) => count),
      dispelsByAbility,
      innervatesCast,
      combatResCount,
      combatResStandout,
      combatResNeverUsed,
      combatResTop,
      combatResJointTop,
      soulstonePlacementCount,
      othersCombatResTotals,
      defensiveRhythm,
      prepCheck,
      raidBuffLapses,
      raidBuffProvided,
      deathRank,
      raidDeathCount,
      raidDeathAvg,
      otherDeathlessCount,
      orbCarryCount,
      orbCarryStandout,
      feastSoakCount,
      feastSoakStandout,
      toxicDropletSoakCount,
      toxicDropletSoakStandout,
      digInWindowDamageTotal,
      digInWindowDamageStandout,
      tornadoHitCount,
      tornadoHitStandout,
      waveTouchCount,
      waveTouchStandout,
      unusedDefensives,
    }),
  };
}
