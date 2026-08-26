import { wclQuery } from "./wcl.js";
import { findDefensiveBeforeDeath, findExternalBeforeDeath } from "./defensives.js";
import {
  hasFlask,
  hasFood,
  hasWeaponEnchant,
  hasPrimaryStatGem,
  countHeroTrackMaxItems,
  missingEnchantSlots,
  missingClassBuffs,
  CLASS_BUFFS,
} from "./prep.js";

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
          keystoneLevel
          fightPercentage
          bossPercentage
          startTime
          endTime
        }
        masterData {
          actors { id name type subType petOwner }
          abilities { gameID name }
        }
      }
    }
  }
`;

// A busy pull can produce tens of thousands of events (a single spammy resource
// generator ability alone can rack up thousands of casts), and WCL's default page
// size is far smaller than that — always request the max page size and follow
// nextPageTimestamp until each event stream is exhausted, or busy pulls silently
// get truncated with no error.
const EVENTS_PAGE_QUERY = `
  query ($code: String!, $fightId: Int!, $dataType: EventDataType!, $hostilityType: HostilityType, $startTime: Float!) {
    reportData {
      report(code: $code) {
        events(fightIDs: [$fightId], dataType: $dataType, hostilityType: $hostilityType, startTime: $startTime, endTime: 99999999999, limit: 10000) {
          data
          nextPageTimestamp
        }
      }
    }
  }
`;

// playerMetric must be set explicitly — WCL's own docs say the bare-omitted default
// is a plain "dps" ranking for every character regardless of role, not a role-aware
// one. "default" is the actual enum value for "hps for healers, dps for damage roles,
// etc." (confirmed: a healer's rankPercent was coming back as their DPS parse before
// this was added).
const RANKINGS_QUERY = `
  query ($code: String!, $fightId: Int!) {
    reportData {
      report(code: $code) {
        rankings(fightIDs: [$fightId], playerMetric: default)
      }
    }
  }
`;

async function fetchAllEvents(code, fightId, dataType, hostilityType = null) {
  let allData = [];
  let startTime = 0;
  while (startTime != null) {
    const result = await wclQuery(EVENTS_PAGE_QUERY, { code, fightId, dataType, hostilityType, startTime });
    const page = result.reportData.report.events;
    allData = allData.concat(page.data);
    startTime = page.nextPageTimestamp ?? null;
  }
  return allData;
}

function msToClock(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// ============================================================================
// THE VENOMOUS ABYSS (Midnight Season 2) — raid-tier-specific content.
// Every boss/ability name below is scoped to this raid. When the tier rotates,
// delete this whole block plus its usages (isDefensivePreventable, isPersonalMistake,
// NEVER_CALLED_WIPE_ABILITIES's use in markCalledWipeDeaths, the Sszorak/Coiled
// Altar/Twin Fangs event-fetch gates in analyzeSingleReport) rather than letting
// dead-tier entries pile up next to the new tier's.
// ============================================================================

// Boss mechanics that kill regardless of personal defensive usage, so judging "died
// with nothing up" against them just blames players for something no cooldown could
// have stopped. Sourced from published guides ahead of a real log from this raid —
// verify the exact ability text once the guild has pulled these and correct as needed.
const DEFENSIVE_UNPREVENTABLE_DEATHS = new Map([
  ["The Twin Fangs", new Set(["Eternal Venom"])], // fatal stacking DoT, only removed by soaking Ravenous Feast
  ["Ula'tek", new Set(["Circling Prey"])], // P3 arena collapse/knockback, not a damage race a defensive wins
]);

function isDefensivePreventable(bossName, killedBy) {
  return !DEFENSIVE_UNPREVENTABLE_DEATHS.get(bossName)?.has(killedBy);
}

// Raid-wide splash/AoE that can win the "first to die" race on a wipe by pure bad
// luck (lowest HP, most stacks, worst position in the blast) without the victim
// having actually done anything wrong — unlike a positioning/dodge mechanic, nobody
// "triggered" this by making a mistake. Confirmed against a real report: Rambomikey
// was tagged as the wipe trigger twice from Venom Rupture (Coiled Altar's orb-pop
// raid damage) when he was just the unlucky target, not the cause.
const RAID_WIDE_NOT_PERSONAL_MISTAKE = new Map([
  ["The Coiled Altar", new Set(["Venom Rupture"])],
]);

function isPersonalMistake(bossName, killedBy) {
  return !RAID_WIDE_NOT_PERSONAL_MISTAKE.get(bossName)?.has(killedBy);
}

// Sszorak's "Dig In" burn window (~25s, boss takes +30% damage) — worth flagging
// when the raid saves a raid cooldown for it instead of popping on pull. Same
// verify-against-a-real-log caveat as above.
const SSZORAK_BOSS_NAME = "Sszorak";
const DIG_IN_ABILITY_NAME = "Dig In";
const DIG_IN_WINDOW_MS = 25000;
const RAID_COOLDOWN_NAMES = new Set(["Bloodlust", "Heroism", "Time Warp", "Primal Rage", "Fury of the Aspects"]);

// The Coiled Altar's Coalesced Venom orb pickup — carrying one applies this debuff
// until it's walked into the tank's frontal (Sever) and destroyed. Same caveat.
export const ORB_CARRY_BOSS_NAME = "The Coiled Altar";
const ORB_CARRY_DEBUFF_NAMES = new Set(["Volatile Venom", "Mutagenic Venom"]);

// The Twin Fangs' Ravenous Feast — a coordinated group soak that strips a stack of
// the fatal Eternal Venom DoT. "Feasted" is the debuff applied on a successful soak;
// confirmed against a real report — 94/109 "Feasted" applications landed within 1s
// of an actual Eternal Venom stack removal on the same player.
export const FEAST_SOAK_BOSS_NAME = "The Twin Fangs";
const FEAST_SOAK_DEBUFF_NAME = "Feasted";

// Telegraphed mechanics that resolve for everyone at once (a channel finishing, a
// timed blast) — if several people fail to move at the same moment, that's several
// individual mistakes landing on the same timestamp, not a called wipe. Never let
// these get swept into the called-wipe exclusion just because the timing lines up.
// Verify the exact log ability name against a real report and correct as needed.
const NEVER_CALLED_WIPE_ABILITIES = new Set([
  "Soul Transfer", // Nek'zali the Soulcoiler — 15s channel, finishes with a dodgeable blast in a line
]);

// ============================================================================
// END THE VENOMOUS ABYSS content
// ============================================================================

const ROLE_KEY_MAP = { tanks: "tank", healers: "healer", dps: "dps" }; // WCL rankings role bucket keys -> singular

const CASCADE_WINDOW_MS = 3000; // deaths this close together are likely the same wipe cascade

const CALLED_WIPE_MIN_COUNT = 5; // this many deaths, clustered...
const CALLED_WIPE_WINDOW_MS = 5000; // ...within this window, reads as an intentional called wipe

// If 5+ people die within a few seconds of each other, that's almost certainly a raid
// lead calling the wipe and people stopping healing/soaking on purpose — not individual
// mistakes. Clusters by TIME ONLY, not by matching killedBy ability: the same raid-wide
// moment often kills different people via different exact abilities (DoT ticks, a Fire
// Mage's Cauterize delaying their actual killing blow, etc.), so requiring an identical
// ability name missed real called-wipe clusters (confirmed by Capitanfade). Flags every
// death in the cluster so tallying can ignore them entirely, rather than blaming players
// for cooldowns they had no reason to use — except NEVER_CALLED_WIPE_ABILITIES, which stay
// on the hook individually even inside a big simultaneous cluster.
function markCalledWipeDeaths(deaths) {
  const calledWipe = new Set();
  for (let i = 0; i < deaths.length; i++) {
    let j = i;
    while (j < deaths.length && deaths[j].timestamp - deaths[i].timestamp <= CALLED_WIPE_WINDOW_MS) j++;
    if (j - i >= CALLED_WIPE_MIN_COUNT) {
      for (let k = i; k < j; k++) {
        if (!NEVER_CALLED_WIPE_ABILITIES.has(deaths[k].killedBy)) calledWipe.add(deaths[k]);
      }
    }
  }
  return calledWipe;
}

const SHARED_MOMENT_WINDOW_MS = 1000; // same ability, this close together — flag as context, not an exclusion

// Below the called-wipe headcount (5+), a small cluster dying to the exact same ability
// within about a second is genuinely ambiguous — could be a real shared mistake (a few
// people failing to spread from a cleave) or an unavoidable hit (a missed interrupt
// one-shotting whoever it caught). We can't tell those apart from clustering alone, so
// this stays informational only: still counts as a real death, just surfaces the context
// instead of the bot silently deciding it wasn't their fault.
function countSharedMoment(deaths, target) {
  return deaths.filter(
    (d) => d !== target && d.killedBy === target.killedBy && Math.abs(d.timestamp - target.timestamp) <= SHARED_MOMENT_WINDOW_MS
  ).length;
}

// Best-effort heuristic: the first death in a wipe is often what tipped the pull over.
// "First" skips RAID_WIDE_NOT_PERSONAL_MISTAKE deaths — raid-wide splash can win that
// race on pure bad luck without the victim doing anything wrong, so the trigger is
// the first death that's actually attributable to someone. If every death in the wipe
// is raid-wide splash, nobody gets tagged — no attribution beats a wrong one.
// A death that follows within a few seconds AND shares the same killing ability is likely
// genuine fallout from that same mechanic (e.g. a raid-wide hit nobody could react to).
// A death that follows closely but from a *different* ability is probably an unrelated,
// separate mistake that just happened to land in the same window.
function annotateDeaths(deaths, isWipe, bossName) {
  const sorted = [...deaths].sort((a, b) => a.timestamp - b.timestamp);
  const calledWipe = isWipe ? markCalledWipeDeaths(sorted) : new Set();
  // Also skip called-wipe deaths — those are already "not counted against anyone"
  // everywhere else (the embed shows them that way), so the trigger search shouldn't
  // land on one just because it happened to be first among the non-raid-wide deaths.
  const triggerIndex = isWipe ? sorted.findIndex((d) => isPersonalMistake(bossName, d.killedBy) && !calledWipe.has(d)) : -1;
  return sorted.map((d, i) => {
    const isTrigger = i === triggerIndex;
    const prev = i > 0 ? sorted[i - 1] : null;
    const gapMs = prev ? d.timestamp - prev.timestamp : null;
    const withinWindow = isWipe && i > 0 && gapMs <= CASCADE_WINDOW_MS;
    const isChained = withinWindow && d.killedBy === prev.killedBy;
    const isNearbyUnrelated = withinWindow && d.killedBy !== prev.killedBy;
    // 1-indexed position in the pull's death order, so displays can say
    // "3rd to die" / "2 others already down" for context.
    return {
      ...d,
      isTrigger,
      isChained,
      isNearbyUnrelated,
      gapMs,
      deathNumber: i + 1,
      isCalledWipe: calledWipe.has(d),
      sharedMomentCount: calledWipe.has(d) ? 0 : countSharedMoment(sorted, d),
    };
  });
}

const WIPE_DEATH_TALLY_CAP = 3; // a wipe is already lost past this point — don't count the pile-on

// Shared by /summary and /feedback so both apply the exact same "pull was already
// over" cutoff when tallying per-player stats from a wipe. Called-wipe deaths are
// dropped first so they don't eat into the 3-death cap and hide a real mistake.
export function cappedDeathsForTally(pull, cap = WIPE_DEATH_TALLY_CAP) {
  if (pull.kill) return pull.deaths;
  return pull.deaths.filter((d) => !d.isCalledWipe).slice(0, cap);
}

async function analyzeSingleReport(code) {
  const base = await wclQuery(REPORT_QUERY, { code });
  const report = base.reportData.report;
  if (!report) {
    throw new Error(`Report not found: ${code}`);
  }

  const actorsById = new Map(report.masterData.actors.map((a) => [a.id, a]));
  const abilitiesById = new Map(report.masterData.abilities.map((a) => [a.gameID, a.name]));

  // keystoneLevel is only set on Mythic+ dungeon pulls — this is a raid analysis
  // tool, so leave dungeon content (and any non-encounter trash segments) out of
  // every downstream count entirely, rather than filtering it per-display later.
  const pulls = report.fights.filter((f) => f.kill !== null && f.keystoneLevel == null);

  const results = [];
  for (const fight of pulls) {
    const isSszorak = fight.name === SSZORAK_BOSS_NAME;
    const isCoiledAltar = fight.name === ORB_CARRY_BOSS_NAME;
    const isTwinFangs = fight.name === FEAST_SOAK_BOSS_NAME;
    const [deathsRaw, castsRaw, interruptsRaw, combatantInfoRaw, rankingsResult, enemyCastsRaw, orbDebuffsRaw, feastDebuffsRaw] =
      await Promise.all([
        fetchAllEvents(code, fight.id, "Deaths"),
        fetchAllEvents(code, fight.id, "Casts", "Friendlies"),
        fetchAllEvents(code, fight.id, "Interrupts"),
        fetchAllEvents(code, fight.id, "CombatantInfo"),
        fight.kill ? wclQuery(RANKINGS_QUERY, { code, fightId: fight.id }) : Promise.resolve(null),
        isSszorak ? fetchAllEvents(code, fight.id, "Casts", "Enemies") : Promise.resolve([]),
        isCoiledAltar ? fetchAllEvents(code, fight.id, "Debuffs", "Friendlies") : Promise.resolve([]),
        isTwinFangs ? fetchAllEvents(code, fight.id, "Debuffs", "Friendlies") : Promise.resolve([]),
      ]);
    const rankingsData = rankingsResult?.reportData.report.rankings;

    // Prep check (enchants, flask, food, weapon oil) per player at this pull —
    // /feedback and /summary decide independently how to use start/end vs. every-pull.
    const prepChecks = combatantInfoRaw.map((c) => {
      const player = actorsById.get(c.sourceID);
      return {
        playerName: player?.name ?? null,
        playerClass: player?.subType ?? null,
        hasFlask: hasFlask(c.auras ?? []),
        hasFood: hasFood(c.auras ?? []),
        hasWeaponEnchant: hasWeaponEnchant(c.gear ?? []),
        hasPrimaryStatGem: hasPrimaryStatGem(c.gear ?? []),
        heroTrackMaxCount: countHeroTrackMaxItems(c.gear ?? []),
        missingEnchantSlots: missingEnchantSlots(c.gear ?? []),
        missingClassBuffs: missingClassBuffs(c.auras ?? []),
      };
    });

    // Raid-wide class buffs (Arcane Intellect, Battle Shout, etc.) — only worth
    // flagging on pulls long enough to matter, and only attributed to whoever's
    // actually present and capable of providing that buff this pull.
    const MIN_PULL_DURATION_FOR_BUFF_CHECK_MS = 60000;
    const buffGaps = [];
    if (fight.endTime - fight.startTime >= MIN_PULL_DURATION_FOR_BUFF_CHECK_MS) {
      const missingPlayersByBuff = new Map();
      for (const p of prepChecks) {
        for (const buffName of p.missingClassBuffs) {
          if (!missingPlayersByBuff.has(buffName)) missingPlayersByBuff.set(buffName, []);
          missingPlayersByBuff.get(buffName).push(p.playerName);
        }
      }
      for (const [buffName, missingPlayerNames] of missingPlayersByBuff) {
        const providerClass = CLASS_BUFFS[buffName];
        const providerPlayerNames = prepChecks.filter((p) => p.playerClass === providerClass).map((p) => p.playerName);
        if (providerPlayerNames.length === 0) continue; // nobody in the raid can provide it — not fair to flag
        buffGaps.push({
          buffName,
          providerClass,
          missingPlayerNames,
          providerPlayerNames,
          raidSize: prepChecks.length,
          // WCL gives no reliable event evidence of exactly when a still-missing raid
          // buff would have been (re)applied — these buffs are essentially never cast
          // mid-combat, so "missing at pull start" reads as "missing the whole pull".
          durationClock: msToClock(fight.endTime - fight.startTime),
        });
      }
    }

    const casts = castsRaw.map((c) => {
      const source = actorsById.get(c.sourceID);
      const target = actorsById.get(c.targetID);
      return {
        ...c,
        abilityName: abilitiesById.get(c.abilityGameID) ?? "Unknown",
        sourceName: source?.name ?? null,
        sourceClass: source?.subType ?? null,
        targetName: target?.name ?? null,
        targetType: target?.type ?? null,
      };
    });

    const interrupts = interruptsRaw.map((i) => {
      // Pet interrupts (Warlock Felhunter's Spell Lock, etc.) show up in the log
      // under the pet's own actor, not the player's — resolve back to the owner
      // so a Warlock's pet kicks actually count toward their interrupt total.
      let source = actorsById.get(i.sourceID);
      let viaPet = false;
      if (source?.type === "Pet" && source.petOwner != null) {
        const owner = actorsById.get(source.petOwner);
        if (owner) {
          source = owner;
          viaPet = true;
        }
      }
      return {
        sourceName: source?.name ?? null,
        sourceClass: source?.subType ?? null,
        interruptAbility: abilitiesById.get(i.abilityGameID) ?? "Unknown",
        interruptedAbility: abilitiesById.get(i.extraAbilityGameID) ?? "Unknown",
        timestamp: i.timestamp,
        viaPet,
      };
    });

    const rawDeaths = deathsRaw.map((d) => {
      const player = actorsById.get(d.targetID);
      const killedBy = abilitiesById.get(d.killingAbilityGameID) ?? "Unknown ability";
      const defensiveUsed = findDefensiveBeforeDeath(casts, d.targetID, d.timestamp);
      const externalCast = findExternalBeforeDeath(casts, d.targetID, d.timestamp);
      return {
        playerName: player?.name ?? `Unknown (${d.targetID})`,
        playerClass: player?.subType ?? null,
        killedBy,
        timestamp: d.timestamp,
        timeIntoPull: msToClock(d.timestamp - fight.startTime),
        defensiveUsed,
        defensivePreventable: isDefensivePreventable(fight.name, killedBy),
        externalHealer: externalCast ? actorsById.get(externalCast.sourceID)?.name ?? "Someone" : null,
        externalAbility: externalCast?.abilityName ?? null,
      };
    });
    // This is the FULL death list for the pull. embeds.js applies its own display
    // cutoff for /analyze, and summary.js applies its own cutoff when tallying
    // per-player stats for /summary — each caller decides independently how much
    // of a pile-on wipe is still meaningful.
    const deaths = annotateDeaths(rawDeaths, !fight.kill, fight.name);

    let topParses = [];
    let bottomParses = [];
    let allParses = [];
    if (fight.kill) {
      const rankingEntry = rankingsData?.data?.[0];
      const allCharacters = [];
      if (rankingEntry?.roles) {
        // WCL already buckets characters by role here — use that directly instead of
        // guessing role from spec name, so a healer never gets DPS-only stats applied
        // to them (see ROLE_KEY_MAP normalizing "tanks"/"healers"/"dps" -> singular).
        for (const [roleKey, role] of Object.entries(rankingEntry.roles)) {
          for (const c of role.characters ?? []) {
            allCharacters.push({
              name: c.name,
              class: c.class,
              spec: c.spec,
              rankPercent: c.rankPercent,
              role: ROLE_KEY_MAP[roleKey] ?? roleKey,
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

    // Sszorak: did anyone save a raid cooldown for the "Dig In" burn window instead
    // of blowing it on pull? Only meaningful if we can actually find the window.
    let digInBloodlust = null;
    if (isSszorak) {
      const digInCast = enemyCastsRaw.find((c) => abilitiesById.get(c.abilityGameID) === DIG_IN_ABILITY_NAME);
      if (digInCast) {
        const windowEnd = digInCast.timestamp + DIG_IN_WINDOW_MS;
        const cooldownCast = castsRaw.find((c) => {
          const name = abilitiesById.get(c.abilityGameID);
          return RAID_COOLDOWN_NAMES.has(name) && c.timestamp >= digInCast.timestamp && c.timestamp <= windowEnd;
        });
        if (cooldownCast) {
          const source = actorsById.get(cooldownCast.sourceID);
          digInBloodlust = {
            playerName: source?.name ?? null,
            playerClass: source?.subType ?? null,
            abilityName: abilitiesById.get(cooldownCast.abilityGameID),
          };
        }
      }
    }

    // The Coiled Altar: every player who picked up a Coalesced Venom orb this pull —
    // tracked across the whole night (wipes included), not just the kill.
    const orbCarries = orbDebuffsRaw
      .filter((e) => e.type === "applydebuff" && ORB_CARRY_DEBUFF_NAMES.has(abilitiesById.get(e.abilityGameID)))
      .map((e) => {
        const player = actorsById.get(e.targetID);
        return { playerName: player?.name ?? null, playerClass: player?.subType ?? null };
      })
      .filter((o) => o.playerName);

    // The Twin Fangs: every player who landed a Feasted soak this pull — same whole-
    // night, wipes-included tracking as orb carries above.
    const feastSoaks = feastDebuffsRaw
      .filter((e) => e.type === "applydebuff" && abilitiesById.get(e.abilityGameID) === FEAST_SOAK_DEBUFF_NAME)
      .map((e) => {
        const player = actorsById.get(e.targetID);
        return { playerName: player?.name ?? null, playerClass: player?.subType ?? null };
      })
      .filter((o) => o.playerName);

    results.push({
      fightId: fight.id,
      bossName: fight.name,
      kill: fight.kill,
      pullNumber: pulls.indexOf(fight) + 1,
      // Fight start/end are relative offsets from the report's own start — convert to
      // absolute wall-clock time so pulls from different reports can be compared when
      // merging multiple logs of the same night (see mergeReports below).
      absoluteStartTime: report.startTime + fight.startTime,
      absoluteEndTime: report.startTime + fight.endTime,
      durationMs: fight.endTime - fight.startTime,
      durationClock: msToClock(fight.endTime - fight.startTime),
      bossPercentRemaining: fight.bossPercentage,
      deaths,
      topParses,
      bottomParses,
      allParses,
      casts,
      interrupts,
      prepChecks,
      buffGaps,
      digInBloodlust,
      orbCarries,
      feastSoaks,
    });
  }

  return {
    title: report.title,
    reportCode: code,
    pulls: results,
  };
}

const PULL_DEDUP_TOLERANCE_MS = 5000; // same boss/outcome starting within a few seconds
// across two logs is almost certainly the same real pull, captured twice.

// Merges pulls from multiple reports of the same raid night into one chronological
// list, dropping pulls that are clearly the same real attempt logged twice (e.g. two
// people both ran a logging addon). Pulls that don't overlap in time are just two
// different parts of the same night and are kept as-is.
function mergeReports(reports) {
  const allPulls = reports.flatMap((r) => r.pulls);
  allPulls.sort((a, b) => a.absoluteStartTime - b.absoluteStartTime);

  const deduped = [];
  let duplicatesDropped = 0;
  for (const pull of allPulls) {
    const isDuplicate = deduped.some(
      (kept) =>
        kept.bossName === pull.bossName &&
        kept.kill === pull.kill &&
        Math.abs(kept.absoluteStartTime - pull.absoluteStartTime) <= PULL_DEDUP_TOLERANCE_MS
    );
    if (isDuplicate) {
      duplicatesDropped += 1;
    } else {
      deduped.push(pull);
    }
  }

  deduped.forEach((pull, i) => {
    pull.pullNumber = i + 1;
  });

  return { pulls: deduped, duplicatesDropped };
}

// Accepts either a single WCL report code, or several comma-separated codes when a
// night got logged across multiple reports (crashed logging tool, two people both
// running the addon, etc.). Multiple reports are merged into one chronological pull
// list with duplicate pulls collapsed — see mergeReports.
export async function analyzeReport(codeOrCodes) {
  const codes = codeOrCodes
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  if (codes.length === 1) {
    const { title, reportCode, pulls } = await analyzeSingleReport(codes[0]);
    return { title, reportCode, reportCodes: [reportCode], duplicatesDropped: 0, pulls };
  }

  const reports = [];
  for (const code of codes) {
    reports.push(await analyzeSingleReport(code));
  }
  const { pulls, duplicatesDropped } = mergeReports(reports);

  return {
    title: reports[0].title,
    reportCode: reports[0].reportCode,
    reportCodes: codes,
    duplicatesDropped,
    pulls,
  };
}
