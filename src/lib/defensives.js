// Explicit current-tier consumables, categorized for display. Extend these as the
// tier changes — provide the exact ability name as it appears in the log.
const HEALTH_CONSUMABLE_NAMES = new Set([
  "Healthstone", "Silvermoon Health Potion", "Healing Potion", "Draenic Healing Potion", "Algari Healing Potion",
]);
const DPS_CONSUMABLE_NAMES = new Set(["Potion of Recklessness", "Light's Potential"]);
const MANA_CONSUMABLE_NAMES = new Set(["Lightfused Mana Potion", "Potion of Devoured Dreams"]);

// Ability names that count as "used a defensive" when cast shortly before a death.
// Includes every health consumable (drinking a health pot to survive counts), but
// not DPS/mana potions — those don't help you live. Not exhaustive beyond that —
// extend as you notice gaps in real reports.
export const DEFENSIVE_ABILITY_NAMES = new Set([
  ...HEALTH_CONSUMABLE_NAMES,
  // Warrior
  "Shield Wall", "Last Stand", "Die by the Sword", "Spell Reflection", "Rallying Cry",
  // Paladin
  "Divine Shield", "Divine Protection", "Ardent Defender", "Guardian of Ancient Kings", "Blessing of Protection", "Blessing of Sacrifice", "Lay on Hands",
  // Death Knight
  "Icebound Fortitude", "Anti-Magic Shell", "Vampiric Blood", "Death Strike", "Lichborne",
  // Druid
  "Barkskin", "Survival Instincts", "Ironbark",
  // Monk
  "Fortifying Brew", "Diffuse Magic", "Touch of Karma", "Zen Meditation", "Life Cocoon",
  // Warlock
  "Unending Resolve", "Dark Pact", "Demonic Circle: Teleport",
  // Priest
  "Pain Suppression", "Guardian Spirit", "Desperate Prayer", "Fade", "Power Word: Shield",
  // Shaman
  "Astral Shift", "Shamanistic Rage", "Spirit Link Totem",
  // Mage
  "Ice Block", "Alter Time", "Mass Barrier", "Prismatic Barrier",
  // Rogue
  "Cloak of Shadows", "Evasion", "Feint", "Crimson Vial",
  // Hunter
  "Aspect of the Turtle", "Exhilaration",
  // Demon Hunter
  "Blur", "Darkness", "Netherwalk",
  // Evoker
  "Obsidian Scales", "Renewing Blaze", "Rewind", "Zephyr",
]);

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
]);

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
