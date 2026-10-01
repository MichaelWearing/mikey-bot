import {
  cappedDeathsForTally,
  ORB_CARRY_BOSS_NAME,
  FEAST_SOAK_BOSS_NAME,
  TOXIC_DROPLETS_BOSS_NAME,
  COMBAT_RES_CLASSES,
} from "./analyze.js";
import {
  classifyCast,
  OUTDATED_HEALTH_POTION_NAME,
  UPGRADED_HEALTH_POTION_NAME,
  MAINTENANCE_EXTERNAL_NAMES,
  realDefensivesAvailableAt,
} from "./defensives.js";
import { CLASS_SPECS, TANK_SPEC_NAMES } from "./classRegistry.js";

function getPlayer(players, name, classHint) {
  if (!players.has(name)) {
    players.set(name, {
      name,
      class: classHint ?? null,
      spec: null, // from a kill-pull ranking entry (WCL) or specLookup — used for the cooldown-aware death check
      role: null, // "tank" | "healer" | "dps" — only known once we've seen a kill-pull ranking entry
      totalDeaths: 0,
      wipeTriggerCount: 0,
      wipeTriggerAbilities: [],
      defensiveUsedCount: 0,
      noDefensiveCount: 0,
      judgeableDeaths: 0,
      diedEverythingDownCount: 0,
      dispelCount: 0,
      innervatesCast: 0,
      combatResCount: 0,
      soulstonePlacementCount: 0,
      digInWindowDamageTotal: 0,
      tornadoHitCount: 0,
      waveTouchCount: 0,
      orbCarryCount: 0,
      feastSoakCount: 0,
      causticGlobuleSoakCount: 0,
      attendedTwinFangs: false,
      toxicDropletSoakCount: 0,
      attendedEntombedSentinels: false,
      parsePercents: [],
      interruptCount: 0,
      interruptViaPetCount: 0,
      dpsPotionCount: 0,
      oldHealthPotionCount: 0,
      newHealthPotionCount: 0,
      defensiveCastCount: 0,
      externalsGivenCount: 0,
      attendedPulls: 0,
      firstPrepCheck: null,
      lastPrepCheck: null,
      missingFlaskPulls: [],
      missingFoodPulls: [],
      missingWeaponEnchantPulls: [],
      missedClassBuffPulls: new Map(), // buffName -> pull numbers this player (as provider) let lapse
    });
  }
  const p = players.get(name);
  if (!p.class && classHint) p.class = classHint;
  return p;
}

const MIN_DEATHS_FOR_DEFENSIVE_STATS = 2; // need a real sample before judging defensive habits
// Gated on attended pulls (kills + wipes), not kill pulls alone — a heavy-wipe night
// can have very few (or zero) kills, and these stats matter just as much on wipes.
const MIN_ATTENDED_PULLS_FOR_STAT = 3;
const TOP_N = 5;

function topByKey(roster, key, n = TOP_N) {
  return [...roster]
    .filter((p) => p[key] > 0)
    .sort((a, b) => b[key] - a[key])
    .slice(0, n);
}

// For shared/rotational mechanics (orb carries, Feast soaks) — a plain top-N sort
// still returns a full list when everyone's tied around the same number, which reads
// as a leaderboard but isn't one. Only include people who are genuinely ahead of the
// pack; if nobody clears the bar (e.g. everyone's within a couple of each other),
// this returns empty and the field just doesn't show.
export function standoutHigh(roster, key, minGap, n = TOP_N) {
  const withCount = roster.filter((p) => p[key] > 0);
  if (withCount.length === 0) return [];
  const avg = withCount.reduce((sum, p) => sum + p[key], 0) / withCount.length;
  if (avg === 0) return [];
  return withCount
    .filter((p) => p[key] >= avg * 1.5 && p[key] - avg >= minGap)
    .sort((a, b) => b[key] - a[key])
    .slice(0, n);
}

// Healers other than Resto Shaman aren't held to a kick standard — hide their
// interrupt count entirely rather than ranking them on it (raider request).
function isInterruptExemptHealer(role, className) {
  return role === "healer" && className !== "Shaman";
}

// WCL only reveals role/spec through kill-pull rankings, so on a pure prog night
// (Sszorak: 51 pulls, 0 kills) every player's role is still null — the roster's own
// spec data is the only thing that identifies a tank there, and it has to be the
// fallback or this check silently does nothing on exactly the nights it matters.
function isTank(p, specLookup) {
  if (p.role === "tank") return true;
  const spec = p.spec ?? specLookup?.get(p.name)?.spec;
  return spec != null && TANK_SPEC_NAMES.has(spec);
}

export function buildNightSummary(analysis, specLookup = null) {
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
      if (d.defensivePreventable) {
        // Cooldown-aware: if every real emergency defensive this player has was
        // genuinely on CD at the moment they died, it's not a usage problem — don't
        // count it toward the "died with nothing up" rate (raider request).
        const spec = specLookup?.get(d.playerName)?.spec ?? p.spec;
        const kit = spec ? CLASS_SPECS[d.playerClass]?.[spec] : null;
        let everythingDown = false;
        if (kit && !d.defensiveUsed) {
          const playerPullCasts = (pull.casts ?? []).filter((c) => c.sourceName === d.playerName);
          everythingDown = realDefensivesAvailableAt(kit, playerPullCasts, d.timestamp).length === 0;
        }
        if (everythingDown) {
          p.diedEverythingDownCount += 1;
        } else {
          p.judgeableDeaths += 1;
          if (d.defensiveUsed) p.defensiveUsedCount += 1;
          else p.noDefensiveCount += 1;
        }
      }
    }
    for (const e of pull.dispels ?? []) {
      if (!e.sourceName) continue;
      getPlayer(players, e.sourceName, e.sourceClass).dispelCount += 1;
    }
    for (const iv of pull.innervates ?? []) {
      if (!iv.sourceName || iv.selfCast) continue;
      getPlayer(players, iv.sourceName, iv.sourceClass).innervatesCast += 1;
    }
    for (const s of pull.soulstonePlacements ?? []) {
      getPlayer(players, s.sourceName, s.sourceClass).soulstonePlacementCount += 1;
    }
    for (const r of pull.combatRes ?? []) {
      if (!r.sourceName) continue;
      getPlayer(players, r.sourceName, r.sourceClass).combatResCount += 1;
    }
    for (const d of pull.digInWindowDamage ?? []) {
      const p = getPlayer(players, d.playerName, d.playerClass);
      p.digInWindowDamageTotal += d.damage;
    }
    for (const t of pull.tornadoHits ?? []) {
      const p = getPlayer(players, t.playerName, t.playerClass);
      p.tornadoHitCount += 1;
    }
    for (const w of pull.waveTouches ?? []) {
      const p = getPlayer(players, w.playerName, w.playerClass);
      p.waveTouchCount += 1;
    }
    for (const o of pull.orbCarries ?? []) {
      const p = getPlayer(players, o.playerName, o.playerClass);
      p.orbCarryCount += 1;
    }
    for (const f of pull.feastSoaks ?? []) {
      const p = getPlayer(players, f.playerName, f.playerClass);
      p.feastSoakCount += 1;
    }
    for (const g of pull.causticGlobuleSoaks ?? []) {
      const p = getPlayer(players, g.playerName, g.playerClass);
      p.causticGlobuleSoakCount += 1;
    }
    for (const t of pull.toxicDropletSoaks ?? []) {
      const p = getPlayer(players, t.playerName, t.playerClass);
      p.toxicDropletSoakCount += 1;
    }
    // Attendance specifically for Twin Fangs — "least Caustic Globule soaks" should
    // only ever flag someone who was actually in that fight, not everyone in the raid.
    if (pull.bossName === FEAST_SOAK_BOSS_NAME) {
      for (const prepCheck of pull.prepChecks ?? []) {
        if (!prepCheck.playerName) continue;
        getPlayer(players, prepCheck.playerName, prepCheck.playerClass).attendedTwinFangs = true;
      }
    }
    // Same idea for Entombed Sentinels — "least Toxic Droplets soaks" should only
    // flag someone who was actually in that fight.
    if (pull.bossName === TOXIC_DROPLETS_BOSS_NAME) {
      for (const prepCheck of pull.prepChecks ?? []) {
        if (!prepCheck.playerName) continue;
        getPlayer(players, prepCheck.playerName, prepCheck.playerClass).attendedEntombedSentinels = true;
      }
    }
    for (const parse of pull.allParses ?? []) {
      const p = getPlayer(players, parse.name, parse.class);
      p.parsePercents.push(parse.rankPercent);
      if (parse.role) p.role = parse.role;
      if (parse.spec) p.spec = parse.spec;
    }
    for (const i of pull.interrupts ?? []) {
      if (!i.sourceName) continue;
      const p = getPlayer(players, i.sourceName, i.sourceClass);
      p.interruptCount += 1;
      if (i.viaPet) p.interruptViaPetCount += 1;
    }
    for (const c of pull.casts ?? []) {
      if (!c.sourceName) continue;
      const classified = classifyCast(c);
      if (!classified) continue;
      const p = getPlayer(players, c.sourceName, c.sourceClass);
      if (classified.type === "consumable" && classified.category === "dps") {
        p.dpsPotionCount += 1;
      } else if (classified.type === "consumable" && c.abilityName === OUTDATED_HEALTH_POTION_NAME) {
        p.oldHealthPotionCount += 1;
      } else if (classified.type === "consumable" && c.abilityName === UPGRADED_HEALTH_POTION_NAME) {
        p.newHealthPotionCount += 1;
      } else if (classified.type === "defensive" && classified.countsTowardUsageStats) {
        p.defensiveCastCount += 1;
      } else if (classified.type === "external" && !MAINTENANCE_EXTERNAL_NAMES.has(c.abilityName)) {
        p.externalsGivenCount += 1;
      }
    }
    // Enchants checked at first/last appearance only (see missingEnchantSlots below);
    // flask/food/weapon oil checked every pull, since those run out mid-raid.
    for (const prepCheck of pull.prepChecks ?? []) {
      if (!prepCheck.playerName) continue;
      const p = getPlayer(players, prepCheck.playerName, prepCheck.playerClass);
      p.attendedPulls += 1;
      if (!p.firstPrepCheck) p.firstPrepCheck = prepCheck;
      p.lastPrepCheck = prepCheck;
      if (!prepCheck.hasFlask) p.missingFlaskPulls.push(pull.pullNumber);
      if (!prepCheck.hasFood) p.missingFoodPulls.push(pull.pullNumber);
      if (!prepCheck.hasWeaponEnchant) p.missingWeaponEnchantPulls.push(pull.pullNumber);
    }
    // Only the class buff's providers are on the hook when it drops. Clean pulls are
    // analyze.js only emits an entry when the buff actually dropped on someone.
    for (const gap of pull.buffGaps ?? []) {
      for (const providerName of gap.providerPlayerNames) {
        const p = getPlayer(players, providerName, gap.providerClass);
        const entry = p.missedClassBuffPulls.get(gap.buffName) ?? {
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
        p.missedClassBuffPulls.set(gap.buffName, entry);
      }
    }
  }

  const roster = [...players.values()];
  for (const p of roster) {
    p.avgParse =
      p.parsePercents.length > 0
        ? p.parsePercents.reduce((sum, v) => sum + v, 0) / p.parsePercents.length
        : null;
    // A slot only counts as "still missing" if it's missing at both the first and
    // last checkpoint, so re-enchanting mid-raid doesn't get flagged.
    p.missingEnchantSlots =
      p.firstPrepCheck && p.lastPrepCheck
        ? p.firstPrepCheck.missingEnchantSlots.filter((slot) => p.lastPrepCheck.missingEnchantSlots.includes(slot))
        : [];
    // Same first/last checkpoint logic as enchants — gems don't change mid-raid, but
    // don't flag someone we only saw once (no real "still missing" comparison possible).
    p.missingPrimaryStatGem =
      p.firstPrepCheck && p.lastPrepCheck ? !p.firstPrepCheck.hasPrimaryStatGem && !p.lastPrepCheck.hasPrimaryStatGem : false;
    p.raidBuffLapses = [...p.missedClassBuffPulls.values()];
  }

  const totalDeathsSum = roster.reduce((sum, p) => sum + p.totalDeaths, 0);
  const avgDeaths = roster.length > 0 ? totalDeathsSum / roster.length : 0;

  const withParses = roster.filter((p) => p.avgParse !== null);
  const highestAvgParse = [...withParses].sort((a, b) => b.avgParse - a.avgParse).slice(0, TOP_N);
  const lowestAvgParse = [...withParses].sort((a, b) => a.avgParse - b.avgParse).slice(0, TOP_N);

  // Denominator is judgeableDeaths, not totalDeaths — deaths to boss mechanics no
  // defensive could have prevented (see DEFENSIVE_UNPREVENTABLE_DEATHS in analyze.js)
  // are excluded so they don't drag down someone's rate for something out of their hands.
  const withDeathSample = roster.filter((p) => p.judgeableDeaths >= MIN_DEATHS_FOR_DEFENSIVE_STATS);
  const defensiveRate = (p) => p.defensiveUsedCount / p.judgeableDeaths;
  const diedWithNothingUp = [...withDeathSample]
    .filter((p) => defensiveRate(p) < 1)
    // Rate first, but a lot of nights everyone lands on the exact same 0% — break
    // ties by death count so it's not just an arbitrary ordering when that happens.
    .sort((a, b) => defensiveRate(a) - defensiveRate(b) || b.judgeableDeaths - a.judgeableDeaths)
    .slice(0, TOP_N);

  // DPS-role only — a healer or tank correctly never touching a DPS potion isn't
  // "missing" anything, and role is unknown (null) for anyone who never appeared in
  // a kill-pull ranking, so they're safely excluded rather than guessed at.
  const noDpsPotions = roster
    .filter((p) => p.role === "dps" && p.attendedPulls >= MIN_ATTENDED_PULLS_FOR_STAT && p.dpsPotionCount === 0)
    .sort((a, b) => b.attendedPulls - a.attendedPulls)
    .slice(0, TOP_N);

  // Drank the old Silvermoon Health Potion at least once and never touched the
  // upgraded Concentrated version — not a preference, a straight upgrade missed.
  const usingOutdatedHealthPotion = roster
    .filter((p) => p.oldHealthPotionCount > 0 && p.newHealthPotionCount === 0)
    .sort((a, b) => b.oldHealthPotionCount - a.oldHealthPotionCount)
    .slice(0, TOP_N);

  const leastDefensivesUsed = roster
    .filter((p) => p.attendedPulls >= MIN_ATTENDED_PULLS_FOR_STAT && p.defensiveCastCount === 0)
    .sort((a, b) => b.attendedPulls - a.attendedPulls)
    .slice(0, TOP_N);
  // Externals + Innervate together — both are "gave a cooldown to a teammate", no
  // need for Innervate to have its own field. Ranked by the combined total.
  const supportGiven = (p) => p.externalsGivenCount + p.innervatesCast;
  const mostSupportGiven = [...roster]
    .filter((p) => supportGiven(p) > 0)
    .sort((a, b) => supportGiven(b) - supportGiven(a))
    .slice(0, TOP_N);

  // Sszorak's Dig In burn window — raw total damage dealt during the +30% window,
  // same "total first" convention as trash damage. No cooldown-alignment check
  // (raider feedback: everyone's cooldowns differ, that's not a fair comparison).
  const mostDigInWindowDamage = topByKey(roster, "digInWindowDamageTotal");
  // Tornado (Tempest) — straight top-N, no outlier gate; getting hit at all is the
  // thing worth flagging. (Caustic Residue was also tracked here but the raid lead
  // said he doesn't care about it — removed rather than left dead in the leaderboard.)
  // Tanks are excluded: they're parked in the boss's face by design, so they eat
  // these hits as part of the job and would otherwise permanently own the top spots.
  const mostTornadoHits = topByKey(
    roster.filter((p) => !isTank(p, specLookup)),
    "tornadoHitCount"
  );
  // Twin Fangs waves — straight top-N like tornadoes, but tanks stay IN: unlike a
  // tornado, touching a wave isn't part of the tank's job (confirmed by the raid lead).
  const mostWaveTouches = topByKey(roster, "waveTouchCount");

  const bossesSummary = [...bossStats.values()].sort((a, b) => a.firstPullNumber - b.firstPullNumber);

  // Orb carries and Feast soaks both used to be hidden unless the boss actually died
  // that night, which meant they vanished on exactly the nights they matter most — a
  // Mythic prog night of pure wipes. Effort counts whether or not the boss falls over.
  const mostOrbCarries = standoutHigh(roster, "orbCarryCount", 3);
  const mostFeastSoaks = standoutHigh(roster, "feastSoakCount", 2);
  // The Caustic Globule fields below still wait for the kill — unlike the two above
  // they include a "least soaks" callout, and naming names for that on a prog night
  // is a separate judgement call nobody's asked for.
  const twinFangsKilled = bossStats.get(FEAST_SOAK_BOSS_NAME)?.killed ?? false;

  // Caustic Globule — a real top 5/bottom 5 ranking (not an outlier check like the
  // two above) since the whole point is comparing everyone who attended the fight,
  // not just flagging extremes. "Least" only ranks people who were actually there.
  const twinFangsAttendees = roster.filter((p) => p.attendedTwinFangs);
  const mostCausticGlobuleSoaks = twinFangsKilled
    ? [...twinFangsAttendees]
        .filter((p) => p.causticGlobuleSoakCount > 0)
        .sort((a, b) => b.causticGlobuleSoakCount - a.causticGlobuleSoakCount)
        .slice(0, TOP_N)
    : [];
  const leastCausticGlobuleSoaks = twinFangsKilled
    ? [...twinFangsAttendees].sort((a, b) => a.causticGlobuleSoakCount - b.causticGlobuleSoakCount).slice(0, TOP_N)
    : [];

  // Toxic Droplets (Entombed Sentinels) — same real top 5/bottom 5 shape as Caustic
  // Globule above, gated on the boss being down and only ranking attendees.
  const entombedSentinelsKilled = bossStats.get(TOXIC_DROPLETS_BOSS_NAME)?.killed ?? false;
  const entombedSentinelsAttendees = roster.filter((p) => p.attendedEntombedSentinels);
  const mostToxicDropletSoaks = entombedSentinelsKilled
    ? [...entombedSentinelsAttendees]
        .filter((p) => p.toxicDropletSoakCount > 0)
        .sort((a, b) => b.toxicDropletSoakCount - a.toxicDropletSoakCount)
        .slice(0, TOP_N)
    : [];
  const leastToxicDropletSoaks = entombedSentinelsKilled
    ? [...entombedSentinelsAttendees].sort((a, b) => a.toxicDropletSoakCount - b.toxicDropletSoakCount).slice(0, TOP_N)
    : [];

  const missingPrep = roster
    .map((p) => ({
      ...p,
      prepIssueScore:
        p.missingEnchantSlots.length +
        p.missingFlaskPulls.length +
        p.missingFoodPulls.length +
        p.missingWeaponEnchantPulls.length +
        (p.missingPrimaryStatGem ? 1 : 0),
    }))
    .filter((p) => p.prepIssueScore > 0)
    .sort((a, b) => b.prepIssueScore - a.prepIssueScore)
    .slice(0, TOP_N);

  // Ranked by how many times they actually failed to buff someone.
  const raidBuffLapses = roster
    .map((p) => ({
      ...p,
      buffLapseScore: p.raidBuffLapses.reduce((sum, b) => sum + b.startMissCount + b.rebuffMissCount, 0),
    }))
    .filter((p) => p.buffLapseScore > 0)
    .sort((a, b) => b.buffLapseScore - a.buffLapseScore)
    .slice(0, TOP_N);

  // Interrupts — healers other than Resto Shaman are dropped from this leaderboard
  // entirely; a healer with 0-2 niche kicks isn't a meaningful ranking.
  const mostInterrupts = topByKey(
    roster.filter((p) => !isInterruptExemptHealer(p.role, p.class)),
    "interruptCount"
  );

  // Dispels — mostly a healer stat but anyone who can dispel counts; plain top-N.
  const mostDispels = topByKey(roster, "dispelCount");
  // Combat resurrections — a rez landed mid-pull instead of eating the wipe. Rare and
  // always worth praising, no gate needed.
  const mostCombatRes = topByKey(roster, "combatResCount");
  // The other half of the same stat: who HAD a battle rez and never pressed it. Only
  // shown when somebody else landed one — on a night with no rezzable moments this
  // stays empty rather than blaming people for an opportunity that never came.
  const anyCombatRes = roster.some((p) => p.combatResCount > 0);
  const neverCombatRessed = anyCombatRes
    ? roster
        .filter(
          (p) =>
            COMBAT_RES_CLASSES.has(p.class) &&
            p.combatResCount === 0 &&
            // A Warlock who put Soulstones out did their job — whether one ever fires
            // depends on whether that player dies, which isn't on the Warlock.
            p.soulstonePlacementCount === 0 &&
            p.attendedPulls >= MIN_ATTENDED_PULLS_FOR_STAT
        )
        .sort((a, b) => b.attendedPulls - a.attendedPulls || a.name.localeCompare(b.name))
    : [];

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
    // The raid-wide version of the deathless praise a personal report already gives
    // (DEATHLESS_PRAISE in praise.js). Sorted by pulls attended — surviving
    // 40 pulls is a bigger deal than surviving 3, and the attendance floor keeps
    // someone who showed up for one pull off a list of people who did the whole night.
    // Uses the same capped death count as every other stat, so a death after the pull
    // was already lost doesn't knock anyone off.
    deathlessRaiders: roster
      .filter((p) => p.totalDeaths === 0 && p.attendedPulls >= MIN_ATTENDED_PULLS_FOR_STAT)
      .sort((a, b) => b.attendedPulls - a.attendedPulls || a.name.localeCompare(b.name)),
    mostWipesTriggered: topByKey(roster, "wipeTriggerCount"),
    highestAvgParse,
    lowestAvgParse,
    diedWithNothingUp,
    mostInterrupts,
    mostDispels,
    mostCombatRes,
    neverCombatRessed,
    noDpsPotions,
    usingOutdatedHealthPotion,
    leastDefensivesUsed,
    mostSupportGiven,
    mostDigInWindowDamage,
    mostTornadoHits,
    mostWaveTouches,
    mostOrbCarries,
    mostFeastSoaks,
    mostCausticGlobuleSoaks,
    leastCausticGlobuleSoaks,
    mostToxicDropletSoaks,
    leastToxicDropletSoaks,
    missingPrep,
    raidBuffLapses,
  };
}
