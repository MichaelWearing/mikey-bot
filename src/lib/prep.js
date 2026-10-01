// Detects missing raid prep — gear enchants, flask, food, and weapon oil/stone —
// from WCL's CombatantInfo snapshots. Best-effort against real gear data pulled
// from this server; correct the slot list if this custom content differs.

const FLASK_NAME_PATTERN = /^Flask of/i;
const FOOD_NAME_PATTERN = /Well Fed/i;

// Midnight S2's Hero gear track tops out at 6/6 = item level 321. WCL's gear data
// only gives itemLevel (no explicit track/rank label), and Hero 6/6 sits right at
// the boundary where early Myth-track ranks land on the same item level — so a
// Myth-upgraded piece that happens to also be ilvl 321 would get miscounted here.
// Best-effort proxy, not exact — verify against a real report before trusting it.
const HERO_TRACK_MAX_ITEM_LEVEL = 321;

// How many equipped items are sitting at Hero 6/6 — a proxy for "did they spend
// today's 180 crests upgrading 3 items to max," per the raid-day prep checklist.
// Can't actually confirm they started from 3/6 rather than lower (cheaper) or that
// it happened today rather than gearing built up over time — just a headcount.
export function countHeroTrackMaxItems(gear) {
  return gear.filter((item) => item && item.itemLevel === HERO_TRACK_MAX_ITEM_LEVEL).length;
}

// Eversong Diamond — Midnight's unique-equip prismatic gem, grants a primary stat
// bonus (Str/Agi/Int, adapts to the wearer) and is the correct socket choice for
// essentially every spec over the secondary-stat colored gems. Unique-equip, so at
// most one is ever socketed — comes in four named crafted variants, each at two item
// level tiers. WCL's CombatantInfo gear payload only gives gem item IDs, not names,
// so this has to match by ID rather than a name pattern like flask/food above.
// UNVERIFIED against this server's real gear data — Stoic (295) and Telluric (278)
// item IDs weren't confirmed, and the whole list needs checking against a real report.
const EVERSONG_DIAMOND_ITEM_IDS = new Set([
  240982, 240983, // Indecipherable (278 / 295)
  240966, 240967, // Powerful (278 / 295)
  240970, // Stoic (278) — 295 variant not yet confirmed
  240969, // Telluric (295) — 278 variant not yet confirmed
]);

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

// True if any socketed gem across all gear is an Eversong Diamond variant. Unique-
// equip means there's at most one to find, in whichever slot got socketed.
export function hasPrimaryStatGem(gear) {
  return gear.some((item) => (item?.gems ?? []).some((g) => EVERSONG_DIAMOND_ITEM_IDS.has(g.id)));
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
// Devotion Aura is deliberately NOT here — it's a range-limited passive aura, not a
// cast-once raid buff, so a pull-start snapshot showing "1-3/20 missing" almost
// always just means those players were briefly out of the paladin's ~40yd radius,
// not that the paladin let anything lapse. We can't tell those apart, so flagging it
// is ~always a false positive on the paladin (raider feedback from Nèèko).
export const CLASS_BUFFS = {
  "Mark of the Wild": "Druid",
  "Arcane Intellect": "Mage",
  "Battle Shout": "Warrior",
  "Power Word: Fortitude": "Priest",
  Skyfury: "Shaman",
  "Blessing of the Bronze": "Evoker",
};

export function missingClassBuffs(auras) {
  const auraNames = new Set(auras.map((a) => a.name));
  return Object.keys(CLASS_BUFFS).filter((buff) => !auraNames.has(buff));
}
