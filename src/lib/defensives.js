import { CLASS_SPECS } from "./classRegistry.js";

// Explicit current-tier consumables, categorized for display. Extend these as the
// tier changes — provide the exact ability name as it appears in the log.
const HEALTH_CONSUMABLE_NAMES = new Set([
  "Healthstone", "Demonic Healthstone", "Silvermoon Health Potion", "Concentrated Silvermoon Health Potion",
  "Healing Potion", "Draenic Healing Potion", "Algari Healing Potion",
]);
const DPS_CONSUMABLE_NAMES = new Set(["Potion of Recklessness", "Light's Potential"]);
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
  "Blessing of Protection", "Blessing of Sacrifice", "Lay on Hands",
  "Ironbark", "Life Cocoon",
  "Darkness", // Devourer DH only (custom content) — confirmed dual-purpose
]);

// Defensives that also double as a normal rotational ability, so raw cast counts don't
// reflect deliberate cooldown usage — Death Strike is a DK's core resource spender,
// confirmed via real data to rack up 2000+ casts a night vs. ~100-300 for genuine
// cooldowns. Still a legitimate defensive for "did they have something up when they
// died," just excluded from usage-count leaderboards (Most/Least Defensives Used).
const ROTATIONAL_DEFENSIVE_NAMES = new Set(["Death Strike"]);

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
