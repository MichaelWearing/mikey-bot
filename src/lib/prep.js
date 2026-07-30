// Detects missing raid prep — gear enchants, flask, food, and weapon oil/stone —
// from WCL's CombatantInfo snapshots. Best-effort against real gear data pulled
// from this server; correct the slot list if this custom content differs.

const FLASK_NAME_PATTERN = /^Flask of/i;
const FOOD_NAME_PATTERN = /Well Fed/i;

// Enchantable gear slots, matching CombatantInfo's gear array order (0-indexed,
// mirrors Blizzard's inventory slot order). This is NOT the standard retail-WoW
// slot list — verified against real gear data from this server first: wrist, hands,
// back, and off-hand showed as "missing an enchant" for nearly every single player
// (20/20, 20/20, 18/20, 7/20), meaning this custom content doesn't offer enchants
// for those slots at all. Only slots that showed real variance are included.
const ENCHANTABLE_SLOTS = {
  0: "Head",
  2: "Shoulder",
  4: "Chest",
  6: "Legs",
  7: "Feet",
  10: "Ring 1",
  11: "Ring 2",
  15: "Main Hand",
};
const WEAPON_SLOTS = [15, 16];

export function hasFlask(auras) {
  return auras.some((a) => FLASK_NAME_PATTERN.test(a.name));
}

export function hasFood(auras) {
  return auras.some((a) => FOOD_NAME_PATTERN.test(a.name));
}

// True if there's no weapon equipped to check (skip rather than penalize), or if
// at least one equipped weapon has a temporary enchant (oil/stone/rune) applied.
export function hasWeaponEnchant(gear) {
  const weapons = WEAPON_SLOTS.map((i) => gear[i]).filter((g) => g && g.id !== 0);
  if (weapons.length === 0) return true;
  return weapons.some((g) => g.temporaryEnchant != null);
}

// Enchantable slots with an item equipped but no permanent enchant on it. Empty
// slots (id === 0, e.g. off-hand for a two-hander) are skipped, not flagged.
export function missingEnchantSlots(gear) {
  const missing = [];
  for (const [indexStr, slotName] of Object.entries(ENCHANTABLE_SLOTS)) {
    const item = gear[Number(indexStr)];
    if (!item || item.id === 0) continue;
    if (!item.permanentEnchant) missing.push(slotName);
  }
  return missing;
}

// Raid-wide class buffs — verified against real CombatantInfo aura data first: each
// of these showed 100% raid coverage, sourced entirely from a single class. Not
// every class provides one (Rogue/Hunter/Warlock/DK/DH/Monk didn't show up as a
// source for any raid-wide buff in the sample), so this list is empirical, not
// assumed from standard WoW class design.
export const CLASS_BUFFS = {
  "Mark of the Wild": "Druid",
  "Arcane Intellect": "Mage",
  "Battle Shout": "Warrior",
  "Power Word: Fortitude": "Priest",
  Skyfury: "Shaman",
  "Devotion Aura": "Paladin",
  "Blessing of the Bronze": "Evoker",
};

export function missingClassBuffs(auras) {
  const auraNames = new Set(auras.map((a) => a.name));
  return Object.keys(CLASS_BUFFS).filter((buff) => !auraNames.has(buff));
}
