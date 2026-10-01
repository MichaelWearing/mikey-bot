import { wclQuery } from "./wcl.js";
import { findDefensiveBeforeDeath, findExternalBeforeDeath } from "./defensives.js";
import { ALL_PAD_ABILITY_NAMES } from "./padAbilities.js";
import {
  hasFlask,
  hasFood,
  hasWeaponEnchant,
  hasPrimaryStatGem,
  countHeroTrackMaxItems,
  missingEnchantSlots,
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
// filterExpression is WCL-side filtering — worth using when a stream would otherwise be
// enormous. The raid-buff query is the case in point: unfiltered Buffs on one 6-minute
// pull blew past the 10000-event page limit (every proc and HoT in the raid), while the
// same query filtered to the six tracked raid buffs returns ~300 events in one page.
const EVENTS_PAGE_QUERY = `
  query ($code: String!, $fightId: Int!, $dataType: EventDataType!, $hostilityType: HostilityType, $startTime: Float!, $filterExpression: String) {
    reportData {
      report(code: $code) {
        events(fightIDs: [$fightId], dataType: $dataType, hostilityType: $hostilityType, startTime: $startTime, endTime: 99999999999, limit: 10000, filterExpression: $filterExpression) {
          data
          nextPageTimestamp
        }
      }
    }
  }
`;

// playerMetric: default does NOT resolve per-role despite WCL's docs describing it
// that way — confirmed directly against this server: requesting "default" returned
// the exact same rankPercent/amount as an explicit "dps" query for a Restoration
// Druid healer, while an explicit "hps" query gave a genuinely different (correct)
// number. So there's no single metric value that works for the whole raid at once —
// fire both queries and merge: hps's "healers" bucket, dps's "tanks"/"dps" buckets.
const RANKINGS_QUERY_DPS = `
  query ($code: String!, $fightId: Int!) {
    reportData {
      report(code: $code) {
        rankings(fightIDs: [$fightId], playerMetric: dps)
      }
    }
  }
`;
const RANKINGS_QUERY_HPS = `
  query ($code: String!, $fightId: Int!) {
    reportData {
      report(code: $code) {
        rankings(fightIDs: [$fightId], playerMetric: hps)
      }
    }
  }
`;

async function fetchAllEvents(code, fightId, dataType, hostilityType = null, filterExpression = null) {
  let allData = [];
  let startTime = 0;
  while (startTime != null) {
    const result = await wclQuery(EVENTS_PAGE_QUERY, { code, fightId, dataType, hostilityType, startTime, filterExpression });
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

// Sszorak's "Dig In" burn window — confirmed against a real Mythic report: it's a
// buff on the boss himself, applied then removed exactly 25000ms later. Originally
// tracked "did someone save a raid cooldown for it," but raider feedback (Mikey)
// dropped that — everyone's cooldowns differ, so alignment isn't a fair signal.
// What's tracked instead: total damage each player dealt during the window itself —
// a direct "did you actually capitalize on the +30% damage taken" number.
export const SSZORAK_BOSS_NAME = "Sszorak";
const DIG_IN_ABILITY_NAME = "Dig In";
const DIG_IN_WINDOW_MS = 25000;

// Sszorak's actual tornado — first guess was "Raging Crosswinds" (a wind-themed
// debuff hitting 8/~20 raiders in synchronized waves); the raid lead corrected that
// to "Tempest." Single-pull data backs it up: Tempest hit 19/20 raiders with an
// uneven 1-5x spread (not a uniform raid-wide tick), dealt by far the most damage of
// anything Sszorak does (27.6M in one 214s pull vs. Caustic Residue's 660k), and was
// the #1 killer. Cross-pull skew (the same "consistent per-player pattern" check
// that confirmed Caustic Residue) hasn't been run yet — WCL rate-limited us
// mid-investigation — so this is provisional pending that check.
//
// Tempest is a hit-then-DoT mechanic: a big upfront burst followed by a ~5-6s poison
// tick that's dispellable. Raid lead only cares about the upfront hit (the DoT is
// just a consequence a healer/dispeller can clean up, and dispelling makes someone
// who got hit "look better" on the tick count even though they still made the
// mistake) — confirmed directly against a real pull's damage events: every
// applydebuff/applydebuffstack lands alongside a `tick: false` damage event several
// times the size of the `tick: true` entries that follow it (e.g. Öc took a 450284
// non-tick hit at 9.8s, then five ~170-190k tick hits over the next 5.4s before the
// debuff fell off). So the upfront hit is tracked directly off damage (`tick` false),
// not off the debuff-apply event — see tornadoHits below.
const TORNADO_ABILITY_NAME = "Tempest";

// The Coiled Altar's Coalesced Venom orb pickup — carrying one applies this debuff
// until it's walked into the tank's frontal (Sever) and destroyed. Same caveat.
export const ORB_CARRY_BOSS_NAME = "The Coiled Altar";
// The two orb colours the raid calls out. Green (Volatile Venom) is the only one that
// exists on Heroic, which is where this tracking grew up; Mythic adds the purple one
// (Mutagenic Venom), carried by a different and much smaller group — on a real Mythic
// kill green was spread over 15 raiders while purple sat on 4. Carries are counted
// together, with the colours kept separable so one total can't hide who did which.
export const GREEN_ORB_DEBUFF_NAME = "Volatile Venom";
export const PURPLE_ORB_DEBUFF_NAME = "Mutagenic Venom";
const ORB_CARRY_DEBUFF_NAMES = new Set([GREEN_ORB_DEBUFF_NAME, PURPLE_ORB_DEBUFF_NAME]);

// The Twin Fangs' Ravenous Feast — a coordinated group soak that strips a stack of
// the fatal Eternal Venom DoT. "Feasted" is the debuff applied on a successful soak;
// confirmed against a real report — 94/109 "Feasted" applications landed within 1s
// of an actual Eternal Venom stack removal on the same player.
export const FEAST_SOAK_BOSS_NAME = "The Twin Fangs";
const FEAST_SOAK_DEBUFF_NAME = "Feasted";

// The Twin Fangs' Caustic Globule — if not soaked it hits the whole raid, if soaked
// it only hits whoever took it. Tracked by CAST count (who the boss targeted it at),
// not damage taken — confirmed against a real report: there's no "Caustic Globule"
// DamageDone event at all (damage likely ticks under a different ability name, or
// the enemy-cast event is the only trace), and damage taken can read as 0 anyway if
// the soaker used an immunity (Turtle, Cloak of Shadows) to no-sell it while still
// having been the one who took the cast.
const CAUSTIC_GLOBULE_ABILITY_NAME = "Caustic Globule";

// The Twin Fangs' Caustic Globule orb PICKUPS — the mechanic is: the boss casts,
// orbs spawn, the raid CCs them, and then a player chooses to run over one and eat
// the big initial hit. So the number that matters is "how many orbs did you pick
// up", and it's a deliberate action, not something the boss assigns.
//
// The only trustworthy signal is Caustic Globule damage sourced from ENVIRONMENT.
// Confirmed against a real 40-pull Mythic report:
//
//   - Caustic Globule damage comes from two different sources under one name.
//     Environment (sourceID -1) is the orb itself: 2097 events. Vexhul is the boss
//     dealing raid-wide splash: 790 events, including ten 20-player bursts. Counting
//     both together inflated every player's number by ~27% with damage that has
//     nothing to do with picking an orb up.
//   - Environment hits are exactly 1:1 with the 2097 Caustic Globule casts — same
//     player, median lag 1ms, max 65ms. A control test (does a RANDOM other player
//     also have a hit in the same window?) scored 38%, so the 100% match is a real
//     link and not event density. One Environment event = one orb picked up, which
//     is why this needs no merge window or burst-size heuristic.
//   - It applies NO debuff of its own — there is no "Caustic Globule" debuff in the
//     event stream at all, so the follow-up DoT the raid describes is just the
//     Eternal Venom stack it grants (99% of hits apply one within 1s), and there is
//     nothing here to double-count.
//   - Eternal Venom can't be the signal instead, because wave touches (Stir the
//     Depths) and the Rouse the Brood / Venomous Emergence raid pulses stack it too.
//
// Ruled out as the orb: Venomous Emergence and Rouse the Brood both hit every single
// player 99-107 times across the night (spread ratio 1.07) with zero player-targeted
// casts — unavoidable raid-wide pulses, not anything a player picks up.
const ENVIRONMENT_SOURCE_ID = -1;

// The Twin Fangs' waves. Touching one applies a short "Stir the Depths" debuff AND
// an Eternal Venom stack immediately — but the wave only DEALS damage if you're
// still in it a full second later. Confirmed against a real Heroic kill: 32/34 touches
// landed an Eternal Venom stack at the instant of touch, all 4 touches held 1s+ took
// Stir the Depths damage, and 0 of the 30 sub-second touches took any. So counting
// damage would miss nearly every touch — worse, 249 of the 253 Stir the Depths damage
// events on that kill weren't wave touches at all (a raid-wide pulse on the cast).
// The debuff application is the only trustworthy "ate a wave" signal. (Tip via a
// friend of the raid lead; not yet seen on a Mythic pull that lasted long enough to
// get touches — the one Mythic pull on record wiped 2s after the first wave.)
const WAVE_TOUCH_DEBUFF_NAME = "Stir the Depths";
// Gaps between one player's consecutive applications on a real night split cleanly:
// 32 under 2s (same wave, re-applied while wading through it) vs. 29 over 15s (a new
// wave), with almost nothing in between — 5s sits safely in that gap.
const WAVE_TOUCH_MERGE_MS = 5000;

// Entombed Sentinels — Breath of Ula'tek's Toxic Droplets: a green orb-spawning
// mechanic, players must stand on the droplets to pop them. Tracked by DamageDone
// hit count (how many times each player got tagged by a droplet), gated with the
// same 3-death wipe cap as everything else. Confirmed against a real report: this
// specific query needs hostilityType: "Enemies" explicitly — omitting it (the usual
// workaround for player-dealt damage queries) returns zero results here, since
// omitting hostilityType actually defaults to "Friendlies" (player-dealt damage
// only) rather than "everything." "Enemies" is boss/NPC-dealt damage, i.e. exactly
// the damage-taken-by-players direction this mechanic needs.
export const TOXIC_DROPLETS_BOSS_NAME = "Entombed Sentinels";
const TOXIC_DROPLETS_ABILITY_NAME = "Toxic Droplets";

// Telegraphed mechanics that resolve for everyone at once (a channel finishing, a
// timed blast) — if several people fail to move at the same moment, that's several
// individual mistakes landing on the same timestamp, not a called wipe. Never let
// these get swept into the called-wipe exclusion just because the timing lines up.
// Verify the exact log ability name against a real report and correct as needed.
const NEVER_CALLED_WIPE_ABILITIES = new Set([
  "Soul Transfer", // Nek'zali the Soulcoiler — 15s channel, finishes with a dodgeable blast in a line
]);

// Fights with an add meant to be passively cleaved down rather than actively farmed.
// /pad tracks total damage from every ability against these targets and flags
// whoever's total is a statistical outlier vs the rest of the raid (not an ability
// allowlist — that approach was tried and rejected: it either missed real padding
// from AoE-capable abilities being spammed on the add, like Divine Storm or Black
// Powder, or falsely flagged a one-off single-target hit as certain padding when it
// was just a stray target-switch). Extend this list as more fights need the same
// check — /pad reads it directly. Confirmed against a real report: DamageDone must
// be fetched WITHOUT hostilityType and filtered by actor type manually — passing
// hostilityType: "Enemies" silently returned an unfiltered/wrong event mix (damage
// taken mixed with damage done).
export const PAD_TRACKED_TARGETS = [
  { bossName: "Ula'tek", targetName: "Blightscale Rawling" }, // P3's "Call of the Serpent" adds
];
const PAD_TRACKED_BOSS_NAMES = new Set(PAD_TRACKED_TARGETS.map((t) => t.bossName));
const PAD_TARGET_NAMES_BY_BOSS = new Map(PAD_TRACKED_TARGETS.map((t) => [t.bossName, t.targetName]));

// ============================================================================
// END THE VENOMOUS ABYSS content
// ============================================================================

const ROLE_KEY_MAP = { tanks: "tank", healers: "healer", dps: "dps" }; // WCL rankings role bucket keys -> singular

// Raid buff uptime. This used to be a single snapshot of everyone's auras at the pull
// start, which could only ever answer "did they start the pull with it" — a buff that
// fell off at 2:00 and was never recast looked perfect, and someone buffed 5s late
// looked like they went the whole pull without it. This measures the real thing.
//
// Two things make it harder than it looks, both confirmed against real pulls:
//   - With two providers of the same buff (two Druids), one's Mark of the Wild being
//     removed in the same millisecond another's is applied is a HANDOVER, not a gap.
//     Tracking a single has/hasn't flag read those as the buff dropping and produced
//     nonsense (47% uptime on a clean kill). So each player's active providers are
//     tracked as a SET — they have the buff while any source is on them.
//   - Dying drops every buff. That's not the buffer's fault, so time between a death
//     and the rez (first cast back) doesn't count against anyone.
const RAID_BUFF_FILTER_EXPRESSION = `ability.name in (${Object.keys(CLASS_BUFFS)
  .map((name) => `"${name}"`)
  .join(",")})`;
// Gaps shorter than this are ignored — a buff landing a few seconds after a rez is
// normal raiding, not a lapse worth naming anyone over.
const RAID_BUFF_GAP_GRACE_MS = 10000;
// Short pulls aren't worth checking (and aren't worth an extra WCL fetch each).
const MIN_PULL_DURATION_FOR_BUFF_CHECK_MS = 60000;

// Combat/battle resurrections — bringing a dead player back mid-pull instead of
// eating the wipe. Praise-worthy, so tracked raid-wide like dispels/Innervate.
// Confirmed ability names: Rebirth (Druid), Raise Ally (Death Knight). Warlock's
// Soulstone works differently (pre-placed on a living player; the target
// self-resurrects on release rather than the Warlock casting something at the
// moment of death), so it's deliberately left out until a real log confirms what
// that actually looks like in the event stream.
const RESURRECT_FILTER_EXPRESSION = 'type="resurrect"';
const SOULSTONE_ABILITY_NAME = "Soulstone";

// Who can be judged for NOT using a battle rez. Rebirth (Druid), Raise Ally (Death
// Knight) and Soulstone (Warlock) are baseline for their classes, so every one of
// them has a rez regardless of spec.
//
// Paladin is deliberately NOT here even though Intercession is now counted: it's a
// talent, and it isn't confirmed that every paladin spec takes it. Counting a rez
// someone landed is always safe; accusing someone of not using an ability they may
// not have is not. Add Paladin once a paladin confirms all specs can take it.
export const COMBAT_RES_CLASSES = new Set(["Druid", "DeathKnight", "Warlock"]);

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
//
// Chains by the gap between CONSECUTIVE deaths, not distance from a fixed anchor —
// a continuous death cascade (steady trickle, no single gap ever exceeding the
// window) needs to stay one cluster all the way to its actual end. Measuring every
// death's distance from a fixed start point instead let a cascade's tail end "fall
// off" the cluster once the cumulative span from that start passed the window, even
// though every consecutive gap along the way was well within it (confirmed against a
// real report — an 18-person pile-on's last 4 deaths escaped detection this way,
// despite one of them being explicitly chained to the death right before it).
function markCalledWipeDeaths(deaths) {
  const calledWipe = new Set();
  let clusterStart = 0;
  for (let i = 1; i <= deaths.length; i++) {
    const gapExceeded = i === deaths.length || deaths[i].timestamp - deaths[i - 1].timestamp > CALLED_WIPE_WINDOW_MS;
    if (!gapExceeded) continue;
    if (i - clusterStart >= CALLED_WIPE_MIN_COUNT) {
      for (let k = clusterStart; k < i; k++) {
        if (!NEVER_CALLED_WIPE_ABILITIES.has(deaths[k].killedBy)) calledWipe.add(deaths[k]);
      }
    }
    clusterStart = i;
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
function annotateDeaths(deaths, isWipe, bossName, raidSize) {
  const sorted = [...deaths].sort((a, b) => a.timestamp - b.timestamp);
  const calledWipe = isWipe ? markCalledWipeDeaths(sorted) : new Set();
  // Also skip called-wipe deaths — those are already "not counted against anyone"
  // everywhere else (the embed shows them that way), so the trigger search shouldn't
  // land on one just because it happened to be first among the non-raid-wide deaths.
  const triggerIndex = isWipe ? sorted.findIndex((d) => isPersonalMistake(bossName, d.killedBy) && !calledWipe.has(d)) : -1;
  // Once more than half the raid is already down, the pull is over — a slow trickle
  // of deaths after that point (or the tail of a cascade that broke the called-wipe
  // clustering with one >5s gap) shouldn't be evaluated as individual mistakes.
  // Confirmed against a real report: a death with "18 others already dead" was still
  // being flagged "no defensive used" because it fell outside the 5-in-5s cluster and
  // the 3-death cap only counts non-called-wipe deaths.
  const raidWipedAfter = raidSize / 2;
  return sorted.map((d, i) => {
    // A death past the point the raid was already wiped isn't a "trigger" — the pull
    // was lost long before it. Keeps the trigger passthrough in cappedDeathsForTally
    // from resurrecting a "died 17th, 16 already dead" line.
    const isTrigger = i === triggerIndex && !(isWipe && i > raidWipedAfter);
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
      raidEffectivelyWiped: isWipe && i > raidWipedAfter,
      sharedMomentCount: calledWipe.has(d) ? 0 : countSharedMoment(sorted, d),
    };
  });
}

const WIPE_DEATH_TALLY_CAP = 3; // a wipe is already lost past this point — don't count the pile-on

// Shared by /summary and /feedback so both apply the exact same "pull was already
// over" cutoff when tallying per-player stats from a wipe. On a wipe only the first
// few deaths are worth evaluating — "died 10th, 9 already down" is noise (repeated
// raider feedback). The cap is on actual death ORDER (deathNumber), not on a count
// of non-excused deaths, so a wall of called-wipe deaths can't push the window out
// to the 8th/9th death. Called-wipe deaths and deaths after the raid was effectively
// wiped are still dropped within that window. The identified wipe trigger is always
// kept even if it landed past the cap — that's the one death past #3 still worth
// showing. Result stays sorted by timestamp.
export function cappedDeathsForTally(pull, cap = WIPE_DEATH_TALLY_CAP) {
  if (pull.kill) return pull.deaths;
  const kept = pull.deaths.filter(
    (d) => d.deathNumber <= cap && !d.isCalledWipe && !d.raidEffectivelyWiped
  );
  const trigger = pull.deaths.find((d) => d.isTrigger);
  if (trigger && !kept.includes(trigger)) kept.push(trigger);
  return kept.sort((a, b) => a.timestamp - b.timestamp);
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
    const isPadTracked = PAD_TRACKED_BOSS_NAMES.has(fight.name);
    const isEntombedSentinels = fight.name === TOXIC_DROPLETS_BOSS_NAME;
    const [
      deathsRaw,
      castsRaw,
      interruptsRaw,
      combatantInfoRaw,
      rankingsDpsResult,
      rankingsHpsResult,
      enemyCastsRaw,
      orbDebuffsRaw,
      feastDebuffsRaw,
      globuleDamageRaw,
      padDamageRaw,
      toxicDropletsDamageRaw,
      dispelsRaw,
      raidBuffEventsRaw,
      resurrectsRaw,
      sszorakDamageRaw,
      sszorakTempestDamageRaw,
    ] = await Promise.all([
      fetchAllEvents(code, fight.id, "Deaths"),
      fetchAllEvents(code, fight.id, "Casts", "Friendlies"),
      fetchAllEvents(code, fight.id, "Interrupts"),
      fetchAllEvents(code, fight.id, "CombatantInfo"),
      fight.kill ? wclQuery(RANKINGS_QUERY_DPS, { code, fightId: fight.id }) : Promise.resolve(null),
      fight.kill ? wclQuery(RANKINGS_QUERY_HPS, { code, fightId: fight.id }) : Promise.resolve(null),
      isSszorak || isTwinFangs ? fetchAllEvents(code, fight.id, "Casts", "Enemies") : Promise.resolve([]),
      isCoiledAltar ? fetchAllEvents(code, fight.id, "Debuffs", "Friendlies") : Promise.resolve([]),
      isTwinFangs ? fetchAllEvents(code, fight.id, "Debuffs", "Friendlies") : Promise.resolve([]),
      // Caustic Globule orb pickups — damage taken BY players, so "Friendlies" here is
      // the damage-taken direction (see ENVIRONMENT_SOURCE_ID above).
      isTwinFangs ? fetchAllEvents(code, fight.id, "DamageTaken", "Friendlies") : Promise.resolve([]),
      // No hostilityType — passing "Enemies" here returns a wrong/unfiltered event mix
      // (confirmed against a real report), so source/target types are checked by hand.
      isPadTracked ? fetchAllEvents(code, fight.id, "DamageDone") : Promise.resolve([]),
      // Toxic Droplets is boss-dealt damage taken BY players — this direction needs
      // hostilityType: "Enemies" explicitly (see comment on TOXIC_DROPLETS_BOSS_NAME).
      // Wipes only — see toxicDropletSoaks below for why kill pulls are skipped.
      isEntombedSentinels && !fight.kill ? fetchAllEvents(code, fight.id, "DamageDone", "Enemies") : Promise.resolve([]),
      // Dispels/purges the raid landed this pull — who cleansed what off whom.
      fetchAllEvents(code, fight.id, "Dispels", "Friendlies"),
      // Raid buff apply/remove/refresh, for real uptime (see RAID_BUFF_FILTER_EXPRESSION).
      // Skipped on short pulls, which aren't judged anyway — saves a fetch per pull.
      fight.endTime - fight.startTime >= MIN_PULL_DURATION_FOR_BUFF_CHECK_MS
        ? fetchAllEvents(code, fight.id, "Buffs", "Friendlies", RAID_BUFF_FILTER_EXPRESSION)
        : Promise.resolve([]),
      // Battle rezzes. There's no "Resurrects" dataType — the enum genuinely doesn't
      // have one — but the RAW stream carries `type: "resurrect"` events, and a
      // filterExpression pulls just those out of it cheaply. Worth remembering: the
      // absence of a dataType does NOT mean the event doesn't exist.
      fetchAllEvents(code, fight.id, "All", null, RESURRECT_FILTER_EXPRESSION),
      // Damage during the Dig In window — player-dealt damage, so same "no
      // hostilityType, filter by actor type" pattern as /pad above.
      isSszorak ? fetchAllEvents(code, fight.id, "DamageDone") : Promise.resolve([]),
      // Tempest is tracked off damage, not the debuff-apply event, so the upfront
      // burst can be told apart from the DoT it leaves behind — boss-dealt damage
      // taken BY players needs hostilityType: "Enemies" explicitly (see
      // TOXIC_DROPLETS_BOSS_NAME above for the same pattern).
      isSszorak ? fetchAllEvents(code, fight.id, "DamageDone", "Enemies") : Promise.resolve([]),
    ]);
    const rankingsDps = rankingsDpsResult?.reportData.report.rankings;
    const rankingsHps = rankingsHpsResult?.reportData.report.rankings;

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
      };
    });


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
        // ms into the pull — for judging whether a defensive goes out at a
        // consistent point every pull (planned) or scattered (reactive panic).
        timeIntoPullMs: c.timestamp - fight.startTime,
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
    // raidSize from CombatantInfo count (one entry per raider); fall back to 20 if
    // this pull has no combatant info at all so the "half the raid is dead" cutoff
    // still has a sane denominator.
    const deaths = annotateDeaths(rawDeaths, !fight.kill, fight.name, prepChecks.length || 20);

    // Shared by every mechanic below that tallies whole-night, wipes-included stats —
    // once a wipe is lost, nobody's still optimizing anything, so nothing after that
    // point counts. "Lost" = the 3rd death of ANY kind, or the first called-wipe
    // death, whichever is earlier. This deliberately does NOT reuse
    // cappedDeathsForTally: that drops called-wipe deaths (right for blame), so a pull
    // wiped by a call never reached 3 "real" deaths and got counted to the very end —
    // Pynky caught it: 14 wave stacks shown vs. 4 in WCL filtered to the 3rd death.
    const orderedDeaths = [...deaths].sort((a, b) => a.timestamp - b.timestamp);
    const wipeCutoffTimestamp = fight.kill
      ? Infinity
      : Math.min(
          orderedDeaths[WIPE_DEATH_TALLY_CAP - 1]?.timestamp ?? Infinity,
          orderedDeaths.find((d) => d.isCalledWipe)?.timestamp ?? Infinity
        );

    // Raid buff uptime for this pull — see RAID_BUFF_FILTER_EXPRESSION for the two
    // traps (provider handovers, and deaths dropping buffs). Measured only up to the
    // wipe cutoff, like every other mechanic: nobody's rebuffing through a wipe.
    const buffWindowEnd = Math.min(wipeCutoffTimestamp, fight.endTime);
    const buffPlayers = combatantInfoRaw.filter((c) => actorsById.get(c.sourceID)?.type === "Player");
    const buffGaps = [];
    if (raidBuffEventsRaw.length > 0 && buffPlayers.length > 0) {
      // When each player died and when they were back up (first cast after dying).
      const deadFrom = new Map();
      for (const d of orderedDeaths) if (!deadFrom.has(d.playerName)) deadFrom.set(d.playerName, d.timestamp);
      const deadWindowFor = (playerName) => {
        const diedAt = deadFrom.get(playerName);
        if (diedAt == null || diedAt >= buffWindowEnd) return null;
        const rez = castsRaw.find(
          (c) => actorsById.get(c.sourceID)?.name === playerName && c.timestamp > diedAt + 1000
        );
        return [diedAt, rez && rez.timestamp < buffWindowEnd ? rez.timestamp : buffWindowEnd];
      };

      for (const [buffName, providerClass] of Object.entries(CLASS_BUFFS)) {
        const providerPlayerNames = buffPlayers
          .filter((c) => actorsById.get(c.sourceID)?.subType === providerClass)
          .map((c) => actorsById.get(c.sourceID).name);
        if (providerPlayerNames.length === 0) continue; // nobody could provide it — not fair to flag

        const buffEvents = raidBuffEventsRaw
          .filter((e) => abilitiesById.get(e.abilityGameID) === buffName && e.timestamp <= buffWindowEnd)
          .sort((a, b) => a.timestamp - b.timestamp);

        let missingMs = 0;
        let worstGapMs = 0;
        let startMissCount = 0;
        let rebuffMissCount = 0;
        const missingByPlayer = new Map();
        for (const combatant of buffPlayers) {
          const player = actorsById.get(combatant.sourceID);
          const deadWindow = deadWindowFor(player.name);

          // Providers currently buffing this player. Non-empty means they have it —
          // that's what makes a two-Druid handover a non-event.
          const sources = new Set();
          const startingAura = (combatant.auras ?? []).find((a) => a.name === buffName);
          if (startingAura) sources.add(startingAura.source ?? "pull-start");

          let missingSince = fight.startTime;
          let playerMissingMs = 0;
          // The two failures worth reporting, kept apart because they're different
          // mistakes: not buffing before the pull, vs. not re-buffing someone who lost
          // it mid-fight (almost always a rez). Everything else is noise.
          let missedAtPullStart = false;
          let missedRebuffs = 0;
          const countGap = (from, to) => {
            let end = Math.min(to, buffWindowEnd);
            if (deadWindow) {
              const overlap = Math.min(end, deadWindow[1]) - Math.max(from, deadWindow[0]);
              if (overlap > 0) end -= overlap;
            }
            const gap = end - from;
            if (gap > RAID_BUFF_GAP_GRACE_MS) {
              playerMissingMs += gap;
              worstGapMs = Math.max(worstGapMs, gap);
              if (from === fight.startTime) missedAtPullStart = true;
              else missedRebuffs += 1;
            }
          };
          for (const e of buffEvents) {
            if (e.targetID !== combatant.sourceID) continue;
            const hadBuff = sources.size > 0;
            if (e.type === "removebuff") sources.delete(e.sourceID);
            else sources.add(e.sourceID);
            if (hadBuff && sources.size === 0) missingSince = e.timestamp;
            else if (!hadBuff && sources.size > 0) countGap(missingSince, e.timestamp);
          }
          if (sources.size === 0) countGap(missingSince, buffWindowEnd);
          if (playerMissingMs > 0) {
            missingByPlayer.set(player.name, { missingMs: playerMissingMs, missedAtPullStart, missedRebuffs });
            missingMs += playerMissingMs;
            if (missedAtPullStart) startMissCount += 1;
            rebuffMissCount += missedRebuffs;
          }
        }

        if (missingMs === 0) continue; // buff never dropped on anyone — nothing to report

        buffGaps.push({
          buffName,
          providerClass,
          providerPlayerNames,
          raidSize: buffPlayers.length,
          // How many raiders started the pull without it, and how many times someone
          // lost it mid-pull and never got it back.
          startMissCount,
          rebuffMissCount,
          worstGapMs,
          missingMs,
          // Worst-affected first, so the display can name who actually went without it.
          missingPlayers: [...missingByPlayer.entries()]
            .sort((a, b) => b[1].missingMs - a[1].missingMs)
            .map(([playerName, v]) => ({ playerName, ...v })),
        });
      }
    }

    // Defensive dispels/cleanses off a raid member — resolve pet-sourced ones (rare)
    // back to the owner, same as interrupts. Offensive purges (target is an NPC) are
    // dropped: "staying on top of raid debuffs" is the stat we want, not enemy-buff
    // stripping.
    const dispels = dispelsRaw
      .map((e) => {
        let source = actorsById.get(e.sourceID);
        if (source?.type === "Pet" && source.petOwner != null) source = actorsById.get(source.petOwner) ?? source;
        const target = actorsById.get(e.targetID);
        return {
          sourceName: source?.name ?? null,
          sourceClass: source?.subType ?? null,
          targetName: target?.name ?? null,
          targetType: target?.type ?? null,
          dispelAbility: abilitiesById.get(e.abilityGameID) ?? "Unknown",
          removedAbility: abilitiesById.get(e.extraAbilityGameID) ?? "Unknown",
          timestamp: e.timestamp,
        };
      })
      .filter((e) => e.targetType === "Player");

    // Innervate — a Druid handing mana back to a healer (or themselves). Basic
    // who-gave-it-to-whom count; target mana% isn't tracked yet.
    const innervates = casts
      .filter((c) => c.abilityName === "Innervate" && c.type === "cast")
      .map((c) => ({
        sourceName: c.sourceName,
        sourceClass: c.sourceClass,
        targetName: c.targetType === "Player" ? c.targetName : c.sourceName,
        selfCast: c.targetType !== "Player" || c.targetName === c.sourceName,
      }))
      .filter((i) => i.sourceName);

    let topParses = [];
    let bottomParses = [];
    let allParses = [];
    if (fight.kill) {
      const dpsEntry = rankingsDps?.data?.[0];
      const hpsEntry = rankingsHps?.data?.[0];
      const allCharacters = [];
      // Healers' numbers come from the hps-metric query, everyone else's (tanks
      // included — modern WCL ranks tanks by damage, not a separate survivability
      // metric) from the dps-metric query. WCL buckets by role in both queries — use
      // that directly instead of guessing role from spec name (see ROLE_KEY_MAP
      // normalizing "tanks"/"healers"/"dps" -> singular).
      for (const [roleKey, role] of Object.entries(hpsEntry?.roles ?? {})) {
        if (roleKey !== "healers") continue;
        for (const c of role.characters ?? []) {
          allCharacters.push({ name: c.name, class: c.class, spec: c.spec, rankPercent: c.rankPercent, role: "healer" });
        }
      }
      for (const [roleKey, role] of Object.entries(dpsEntry?.roles ?? {})) {
        if (roleKey === "healers") continue;
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
      const sorted = [...allCharacters].sort((a, b) => b.rankPercent - a.rankPercent);
      allParses = sorted;
      const topCount = Math.min(5, sorted.length);
      const bottomCount = Math.min(5, Math.max(0, sorted.length - topCount));
      topParses = sorted.slice(0, topCount);
      bottomParses = sorted.slice(sorted.length - bottomCount).reverse();
    }

    // Sszorak: total damage each player dealt during the "Dig In" +30%-damage-taken
    // window — see the comment on DIG_IN_WINDOW_MS for why this replaced the old
    // "did they save a cooldown for it" check. Only meaningful if we can find the
    // window at all (a pull that wipes before the boss digs in never has one).
    let digInWindowDamage = [];
    if (isSszorak) {
      const digInCast = enemyCastsRaw.find((c) => abilitiesById.get(c.abilityGameID) === DIG_IN_ABILITY_NAME);
      if (digInCast) {
        const windowEnd = digInCast.timestamp + DIG_IN_WINDOW_MS;
        const totals = new Map(); // characterName -> { playerName, playerClass, damage }
        for (const e of sszorakDamageRaw) {
          if (e.timestamp < digInCast.timestamp || e.timestamp > windowEnd) continue;
          let source = actorsById.get(e.sourceID);
          if (source?.type === "Pet" && source.petOwner != null) source = actorsById.get(source.petOwner) ?? source;
          if (source?.type !== "Player") continue;
          const target = actorsById.get(e.targetID);
          if (target?.type !== "NPC" && target?.type !== "Boss") continue;
          const entry = totals.get(source.name) ?? { playerName: source.name, playerClass: source.subType, damage: 0 };
          entry.damage += e.amount ?? 0;
          totals.set(source.name, entry);
        }
        digInWindowDamage = [...totals.values()];
      }
    }

    // Sszorak: every time a player got caught by the actual tornado (Tempest) this
    // pull. Tracked off the upfront burst damage event (`tick` falsy), not the
    // DoT ticks that follow it or the debuff-apply event — see TORNADO_ABILITY_NAME
    // above for why. Same wipe cutoff as everything else.
    const tornadoHits = sszorakTempestDamageRaw
      .filter((e) => !e.tick && abilitiesById.get(e.abilityGameID) === TORNADO_ABILITY_NAME)
      .filter((e) => e.timestamp <= wipeCutoffTimestamp)
      .map((e) => {
        const target = actorsById.get(e.targetID);
        if (target?.type !== "Player") return null;
        return { playerName: target.name, playerClass: target.subType };
      })
      .filter(Boolean);

    // The Twin Fangs: every time a player was the one the boss aimed Caustic Globule
    // at this pull — see CAUSTIC_GLOBULE_ABILITY_NAME above for why this counts casts
    // rather than damage.
    const causticGlobuleSoaks = isTwinFangs
      ? enemyCastsRaw
          .filter((c) => abilitiesById.get(c.abilityGameID) === CAUSTIC_GLOBULE_ABILITY_NAME)
          .map((c) => {
            const target = actorsById.get(c.targetID);
            if (target?.type !== "Player") return null;
            return { playerName: target.name, playerClass: target.subType };
          })
          .filter(Boolean)
      : [];

    // The Twin Fangs: every Caustic Globule orb each player picked up this pull. One
    // Environment-sourced hit is one orb — see ENVIRONMENT_SOURCE_ID above for why
    // the boss-sourced hits of the same name are excluded. Same 3-death wipe cutoff
    // as every other mechanic count.
    const orbPickups = isTwinFangs
      ? globuleDamageRaw
          .filter((e) => e.type === "damage" && abilitiesById.get(e.abilityGameID) === CAUSTIC_GLOBULE_ABILITY_NAME)
          .filter((e) => e.sourceID === ENVIRONMENT_SOURCE_ID)
          .filter((e) => e.timestamp <= wipeCutoffTimestamp)
          .map((e) => {
            const player = actorsById.get(e.targetID);
            if (player?.type !== "Player") return null;
            return { playerName: player.name, playerClass: player.subType, amount: e.amount ?? 0 };
          })
          .filter(Boolean)
      : [];

    // The Coiled Altar: every orb a player picked up this pull — tracked across the
    // whole night, wipes included, with the same 3-death cutoff as everything else
    // (grabbing an orb once the pull is already lost isn't effort worth counting).
    const orbCarries = orbDebuffsRaw
      .filter((e) => e.type === "applydebuff" && ORB_CARRY_DEBUFF_NAMES.has(abilitiesById.get(e.abilityGameID)))
      .filter((e) => e.timestamp <= wipeCutoffTimestamp)
      .map((e) => {
        const player = actorsById.get(e.targetID);
        return {
          playerName: player?.name ?? null,
          playerClass: player?.subType ?? null,
          // Which orb — Heroic only ever has Volatile Venom; Mythic adds Mutagenic
          // Venom as a second type handled by a different set of people.
          ability: abilitiesById.get(e.abilityGameID),
        };
      })
      .filter((o) => o.playerName);

    // The Twin Fangs: every player who landed a Feasted soak this pull — same whole-
    // night, wipes-included, 3-death-cutoff tracking as orb carries above.
    const feastSoaks = feastDebuffsRaw
      .filter((e) => e.type === "applydebuff" && abilitiesById.get(e.abilityGameID) === FEAST_SOAK_DEBUFF_NAME)
      .filter((e) => e.timestamp <= wipeCutoffTimestamp)
      .map((e) => {
        const player = actorsById.get(e.targetID);
        return { playerName: player?.name ?? null, playerClass: player?.subType ?? null };
      })
      .filter((o) => o.playerName);

    // The Twin Fangs: every wave touch (see WAVE_TOUCH_DEBUFF_NAME for why the debuff,
    // not damage). Each application is one extra Eternal Venom stack — including
    // re-applications while wading through the SAME wave (confirmed on a real night:
    // 165/171 applications gained a stack within 150ms, 36/41 same-wave repeats did,
    // and one player went 4 -> 9 stacks inside a single wave). So every application
    // is kept (= stacks), and `newWave` marks the ones that start a fresh wave (no
    // application for that player in the previous WAVE_TOUCH_MERGE_MS) for anyone
    // who wants distinct waves instead. Same 3-death wipe cutoff.
    const lastWaveApplyByPlayer = new Map(); // targetID -> timestamp of their latest application
    const waveTouches = feastDebuffsRaw
      .filter((e) => e.type === "applydebuff" && abilitiesById.get(e.abilityGameID) === WAVE_TOUCH_DEBUFF_NAME)
      .filter((e) => e.timestamp <= wipeCutoffTimestamp)
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((e) => {
        const target = actorsById.get(e.targetID);
        if (target?.type !== "Player") return null;
        const previous = lastWaveApplyByPlayer.get(e.targetID);
        lastWaveApplyByPlayer.set(e.targetID, e.timestamp);
        const newWave = previous == null || e.timestamp - previous >= WAVE_TOUCH_MERGE_MS;
        return { playerName: target.name, playerClass: target.subType, newWave };
      })
      .filter(Boolean);

    // Padding check against a PAD_TRACKED_TARGETS add: total damage from every
    // ability against the tracked target for this boss. Every hit is tagged
    // isConfirmedPad — /pad shows two signals off this: whoever's total is a
    // statistical outlier vs. the raid (any ability), and, separately, anyone who
    // landed a confirmed AoE-only-spender hit at all (see padAbilities.js — a single
    // hit from that list is already the signal, no outlier threshold needed).
    const padTargetName = PAD_TARGET_NAMES_BY_BOSS.get(fight.name);
    const padDamage = padTargetName
      ? padDamageRaw
          .filter((e) => e.timestamp <= wipeCutoffTimestamp)
          .filter((e) => actorsById.get(e.targetID)?.name === padTargetName)
          .map((e) => {
            let source = actorsById.get(e.sourceID);
            if (source?.type === "Pet" && source.petOwner != null) source = actorsById.get(source.petOwner) ?? source;
            if (source?.type !== "Player") return null;
            return {
              playerName: source.name,
              playerClass: source.subType,
              ability: abilitiesById.get(e.abilityGameID),
              damage: e.amount ?? 0,
              isConfirmedPad: ALL_PAD_ABILITY_NAMES.has(abilitiesById.get(e.abilityGameID)),
              bossName: fight.name,
              targetName: padTargetName,
            };
          })
          .filter(Boolean)
      : [];

    // Entombed Sentinels — every time a player was tagged by a Toxic Droplets hit
    // this pull (see TOXIC_DROPLETS_BOSS_NAME above). Wipes only, each capped at the
    // 3-death wipe cutoff — confirmed against the real report and the user's own
    // count from WCL's own wipes-only/cutoff=3 table view: including the kill pull
    // overcounted every player (e.g. Tigrane 103 vs. the real 84), since a full,
    // successful kill runs the mechanic for the whole fight with a much later (or no)
    // 3-death cutoff, drowning out the wipe data this is actually meant to compare.
    const toxicDropletSoaks = !fight.kill
      ? toxicDropletsDamageRaw
          .filter((e) => e.timestamp <= wipeCutoffTimestamp)
          .filter((e) => abilitiesById.get(e.abilityGameID) === TOXIC_DROPLETS_ABILITY_NAME)
          .map((e) => {
            const target = actorsById.get(e.targetID);
            if (target?.type !== "Player") return null;
            return { playerName: target.name, playerClass: target.subType };
          })
          .filter(Boolean)
      : [];

    // Combat resurrections — same "pull's already lost" cutoff as everything else
    // above: a rez thrown after 3 real deaths isn't saving the pull, it's just
    // delaying the wipe, so it doesn't count as the praise-worthy version.
    //
    // Counted from actual `resurrect` events rather than casts of a known ability
    // list. Casting worked, but only for abilities we'd thought to list, and that
    // silently missed two whole classes: Paladin Intercession (9 rezzes in one real
    // night, the joint-most in the raid) and Warlock Soulstone (2). Resurrect events
    // name whoever actually brought someone back, whatever they pressed, so nothing
    // new needs adding when a class gets a rez. Self-resurrects (Reincarnation,
    // a Soulstone the player put on themselves) are dropped — bringing yourself back
    // isn't the same favour as saving someone else.
    const combatRes = resurrectsRaw
      .filter((e) => e.timestamp <= wipeCutoffTimestamp && e.sourceID !== e.targetID)
      .map((e) => {
        const source = actorsById.get(e.sourceID);
        const target = actorsById.get(e.targetID);
        if (source?.type !== "Player") return null;
        return {
          sourceName: source.name,
          sourceClass: source.subType,
          targetName: target?.type === "Player" ? target.name : null,
          ability: abilitiesById.get(e.abilityGameID) ?? null,
        };
      })
      .filter(Boolean);

    // Warlocks are a special case for "did you do your rez job". A Druid presses
    // Rebirth when someone dies, so no rez means they didn't react. A Warlock's job is
    // PLACING the Soulstone — whether it ever fires is up to whether that person dies,
    // which isn't the Warlock's doing. So placements are tracked separately and are
    // what a Warlock is judged on. No wipe cutoff: a stone put out at any point in the
    // pull still counts as having done the job.
    const soulstonePlacements = casts
      .filter((c) => c.type === "cast" && c.abilityName === SOULSTONE_ABILITY_NAME && c.sourceName)
      .map((c) => ({ sourceName: c.sourceName, sourceClass: c.sourceClass, targetName: c.targetName ?? null }));

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
      dispels,
      innervates,
      combatRes,
      soulstonePlacements,
      prepChecks,
      buffGaps,
      digInWindowDamage,
      tornadoHits,
      orbCarries,
      orbPickups,
      feastSoaks,
      waveTouches,
      causticGlobuleSoaks,
      padDamage,
      toxicDropletSoaks,
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
