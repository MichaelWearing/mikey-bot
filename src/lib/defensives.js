import { CLASS_SPECS } from "./classRegistry.js";

// Explicit current-tier consumables, categorized for display. Extend these as the
// tier changes — provide the exact ability name as it appears in the log.
const HEALTH_CONSUMABLE_NAMES = new Set([
  "Healthstone", "Demonic Healthstone", "Silvermoon Health Potion", "Concentrated Silvermoon Health Potion",
  "Healing Potion", "Draenic Healing Potion", "Algari Healing Potion",
]);
// Liquid Luster and Draught of Rampant Abandon don't have "potion" in their names, so
// they need to be listed here explicitly — the /potion/i fallback in
// isConsumableAbility below won't catch them. (Draught reported missing by Nèèko and
// confirmed present in two real reports under exactly this name.)
const DPS_CONSUMABLE_NAMES = new Set([
  "Potion of Recklessness",
  "Light's Potential",
  "Liquid Luster",
  "Draught of Rampant Abandon",
]);
const MANA_CONSUMABLE_NAMES = new Set(["Lightfused Mana Potion", "Potion of Devoured Dreams"]);

// Midnight S2: Concentrated Silvermoon Health Potion is crafted from 25 plain
// Silvermoon Health Potions and heals for far more — a straight upgrade, not a
// preference. Worth flagging anyone still drinking the old one who never touched
// the new one. Update these if a future tier repeats the "concentrated" pattern.
export const OUTDATED_HEALTH_POTION_NAME = "Silvermoon Health Potion";
export const UPGRADED_HEALTH_POTION_NAME = "Concentrated Silvermoon Health Potion";

// Ability names that count as "used a defensive" when cast shortly before a death.
// Includes every health consumable (drinking a health pot to survive counts), but
// not DPS/mana potions — those don't help you live. The class abilities themselves
// come from src/lib/classes/*.js (per-class, per-spec) via classRegistry.js — edit
// those files (or use /list-defensives to review them) rather than this list directly.
const ALL_CLASS_DEFENSIVES = Object.values(CLASS_SPECS).flatMap((specs) => Object.values(specs).flat());
export const DEFENSIVE_ABILITY_NAMES = new Set([...HEALTH_CONSUMABLE_NAMES, ...ALL_CLASS_DEFENSIVES]);

// Falls back to name pattern matching for anything not in the explicit lists above.
export function isConsumableAbility(abilityName) {
  return (
    HEALTH_CONSUMABLE_NAMES.has(abilityName) ||
    DPS_CONSUMABLE_NAMES.has(abilityName) ||
    MANA_CONSUMABLE_NAMES.has(abilityName) ||
    /potion/i.test(abilityName)
  );
}

export function consumableCategory(abilityName) {
  if (HEALTH_CONSUMABLE_NAMES.has(abilityName)) return "health";
  if (DPS_CONSUMABLE_NAMES.has(abilityName)) return "dps";
  if (MANA_CONSUMABLE_NAMES.has(abilityName)) return "mana";
  if (/mana/i.test(abilityName)) return "mana";
  if (/health/i.test(abilityName)) return "health";
  return "other";
}

// Single-target externals a healer/support might land on someone right before they die.
export const EXTERNAL_ABILITY_NAMES = new Set([
  "Pain Suppression", "Guardian Spirit",
  "Blessing of Protection", "Blessing of Spellwarding", "Blessing of Sacrifice", "Lay on Hands",
  "Ironbark", "Life Cocoon",
  "Power Word: Shield", // healer shields the raid — an external given, not a self-CD
  "Darkness", // Devourer DH only (custom content) — confirmed dual-purpose
  "Rallying Cry", // Warrior raid-wide -20% — read as support given, not a personal CD
]);

// Externals that are spammed as routine maintenance rather than thrown as a clutch
// save — counted in a player's per-report Externals Given breakdown, but NOT toward
// the /summary "Most Support Given" leaderboard, where a Disc priest's 300 shields
// would bury everyone else's actual panic-button saves.
export const MAINTENANCE_EXTERNAL_NAMES = new Set(["Power Word: Shield"]);

// Raid-wide damage-reduction cooldowns that get ASSIGNED to a rotation, not pressed
// as a personal panic button. Excluded from the "did you have a defensive available
// when you died" check and the "never touched X all night" check — an individual
// isn't judged on the raid CD assignment (raider feedback: Öc flagged for not
// pressing Rallying Cry on a death where it was 'available').
export const RAID_DEFENSIVE_COOLDOWN_NAMES = new Set([
  "Rallying Cry", // Warrior
  "Darkness", // Demon Hunter
  "Spirit Link Totem", // Restoration Shaman
  "Rewind", // Preservation Evoker
  "Aura Mastery", // Holy Paladin
  "Anti-Magic Zone", // Death Knight
]);

// Defensives that also double as a normal rotational ability, so raw cast counts don't
// reflect deliberate cooldown usage — Death Strike is a DK's core resource spender,
// confirmed via real data to rack up 2000+ casts a night vs. ~100-300 for genuine
// cooldowns. Still a legitimate defensive for "did they have something up when they
// died," just excluded from usage-count leaderboards (Most/Least Defensives Used).
export const ROTATIONAL_DEFENSIVE_NAMES = new Set(["Death Strike"]);

// Some defensives are a talent-driven rename of the SAME ability slot — only one is
// ever actually available to a given player at a time, so using one shouldn't leave
// the other flagged as "never used" (confirmed by raider feedback: Ice Block becomes
// Ice Cold under a specific Mage talent). Add more groups here as they're found —
// this is distinct from spec-locked variants (like Mage's barrier shield), which
// just shouldn't be in a spec's tracked list at all rather than needing a group.
export const DEFENSIVE_ALIAS_GROUPS = [
  ["Ice Block", "Ice Cold"],
  // Prot Paladin talent — Spellwarding shares BoP's cooldown, so it's one button either way.
  ["Blessing of Protection", "Blessing of Spellwarding"],
];

// Base cooldowns (seconds) for the "real" emergency defensives — the big buttons you
// hold for a dangerous moment, not the short rotational mitigation (barriers, Feint,
// Crimson Vial, PW:S) which is up so often that "was it available" tells you nothing.
// Used to answer "did they actually have a defensive to press when they died" instead
// of blaming someone for a cooldown that was genuinely down (raider feedback: people
// flagged for "no defensive" on a death where their one big CD had been used earlier
// the same pull). Talents shift some of these; base values are a good-enough
// approximation and the feedback carries a caveat. Only abilities in
// BOTH this map and a player's spec kit (classes/*.js) are considered. Externals that
// double as self-saves (Lay on Hands, Darkness) are kept; pure externals given to
// others (Ironbark, Pain Suppression, ...) are deliberately left out.
export const DEFENSIVE_COOLDOWNS = {
  // Warrior — Rallying Cry omitted: raid-assigned CD, not a personal button (see
  // RAID_DEFENSIVE_COOLDOWN_NAMES).
  "Die by the Sword": 120,
  "Shield Wall": 210,
  "Last Stand": 180,
  // Paladin
  "Divine Shield": 300,
  "Divine Protection": 60,
  "Lay on Hands": 600,
  "Ardent Defender": 120,
  "Guardian of Ancient Kings": 300,
  // Death Knight
  "Icebound Fortitude": 180,
  "Anti-Magic Shell": 60,
  "Vampiric Blood": 90,
  "Lichborne": 120,
  "Death Pact": 120,
  // Druid — Heart of the Wild omitted: not findable in this server's logs (see druid.js).
  "Barkskin": 60,
  "Survival Instincts": 180,
  // Monk
  "Fortifying Brew": 360,
  "Touch of Karma": 90,
  // Warlock
  "Unending Resolve": 180,
  "Dark Pact": 60,
  "Mortal Coil": 45,
  // Priest
  "Desperate Prayer": 90,
  // Shaman
  "Astral Shift": 90,
  "Earth Elemental": 300,
  // Mage
  "Ice Block": 240,
  "Ice Cold": 240,
  "Mirror Image": 120,
  // Rogue
  "Cloak of Shadows": 120,
  "Evasion": 120,
  // Hunter
  "Aspect of the Turtle": 180,
  "Exhilaration": 120,
  // Demon Hunter — Darkness omitted: raid-assigned CD (see RAID_DEFENSIVE_COOLDOWN_NAMES).
  "Blur": 60,
  // Evoker — Rewind omitted: raid-assigned CD (see RAID_DEFENSIVE_COOLDOWN_NAMES).
  "Obsidian Scales": 150,
  "Zephyr": 120,
};

// Of a player's real defensive cooldowns, which were off cooldown (or never used
// this pull) at `atTimestamp`, judged only from their own casts earlier in the same
// pull. `kit` is the spec's tracked ability list; `playerPullCasts` are that
// player's casts for the pull (each { abilityName, timestamp }). Returns the names
// that were available — empty means every big defensive they have was genuinely down.
export function realDefensivesAvailableAt(kit, playerPullCasts, atTimestamp) {
  const tracked = (kit ?? []).filter(
    (name) => DEFENSIVE_COOLDOWNS[name] != null && !RAID_DEFENSIVE_COOLDOWN_NAMES.has(name)
  );
  const available = [];
  for (const name of tracked) {
    let lastCast = -Infinity;
    for (const c of playerPullCasts) {
      if (c.abilityName === name && c.timestamp <= atTimestamp && c.timestamp > lastCast) lastCast = c.timestamp;
    }
    if (lastCast === -Infinity || atTimestamp - lastCast >= DEFENSIVE_COOLDOWNS[name] * 1000) {
      available.push(name);
    }
  }
  return available;
}

// Classifies a single friendly cast for tallying purposes — shared by playerFeedback.js
// and summary.js so both agree on what counts as a consumable vs. a personal defensive
// vs. an external given to someone else (rather than duplicating this logic twice and
// risking it drifting out of sync).
//
// Returns one of:
//   { type: "consumable", category: "health" | "dps" | "mana" | "other" }
//   { type: "defensive", countsTowardUsageStats: boolean }
//   { type: "external" }    — a dual-purpose ability actually cast on another player
//   null                     — not a tracked ability at all
export function classifyCast(c) {
  if (isConsumableAbility(c.abilityName)) {
    return { type: "consumable", category: consumableCategory(c.abilityName) };
  }
  if (DEFENSIVE_ABILITY_NAMES.has(c.abilityName)) {
    // A handful of these can also be cast on someone else (Blessing of Protection,
    // Lay on Hands, etc.). Untargeted self-casts (Divine Protection, Divine Shield,
    // ...) log with whatever enemy is currently targeted, not "self" — that's not a
    // real external, so it only counts as one if the target is an actual player.
    const isDualPurpose = EXTERNAL_ABILITY_NAMES.has(c.abilityName);
    const isRealPlayerTarget = c.targetType === "Player" && c.targetID !== c.sourceID;
    if (isDualPurpose && isRealPlayerTarget) return { type: "external" };
    return { type: "defensive", countsTowardUsageStats: !ROTATIONAL_DEFENSIVE_NAMES.has(c.abilityName) };
  }
  return null;
}

export function findDefensiveBeforeDeath(casts, actorId, deathTimestamp, windowMs = 10000) {
  const used = casts.filter(
    (c) =>
      c.sourceID === actorId &&
      c.timestamp <= deathTimestamp &&
      c.timestamp >= deathTimestamp - windowMs &&
      DEFENSIVE_ABILITY_NAMES.has(c.abilityName)
  );
  return used.length > 0 ? used[used.length - 1].abilityName : null;
}

// An external cooldown someone else landed on the dying player — even if it wasn't enough to save them.
export function findExternalBeforeDeath(casts, actorId, deathTimestamp, windowMs = 10000) {
  const used = casts.filter(
    (c) =>
      c.targetID === actorId &&
      c.sourceID !== actorId &&
      c.timestamp <= deathTimestamp &&
      c.timestamp >= deathTimestamp - windowMs &&
      EXTERNAL_ABILITY_NAMES.has(c.abilityName)
  );
  return used.length > 0 ? used[used.length - 1] : null;
}
