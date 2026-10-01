import * as Warrior from "./classes/warrior.js";
import * as Paladin from "./classes/paladin.js";
import * as DeathKnight from "./classes/deathknight.js";
import * as Druid from "./classes/druid.js";
import * as Monk from "./classes/monk.js";
import * as Warlock from "./classes/warlock.js";
import * as Priest from "./classes/priest.js";
import * as Shaman from "./classes/shaman.js";
import * as Mage from "./classes/mage.js";
import * as Rogue from "./classes/rogue.js";
import * as Hunter from "./classes/hunter.js";
import * as DemonHunter from "./classes/demonhunter.js";
import * as Evoker from "./classes/evoker.js";

// Every tank spec name is unique across classes (no DPS or healer spec shares one),
// so a flat name set is enough here — no class disambiguation needed. DH's custom
// "Devourer" spec is deliberately absent: its role isn't confirmed, and wrongly
// listing it would silently drop a DPS out of tank-excluded stats.
export const TANK_SPEC_NAMES = new Set(["Protection", "Blood", "Guardian", "Brewmaster", "Vengeance"]);

// className keys match actor.subType from WCL (e.g. "DeathKnight", "DemonHunter" — no
// spaces) so this lines up with the rest of the codebase's class handling.
export const CLASS_SPECS = {
  Warrior,
  Paladin,
  DeathKnight,
  Druid,
  Monk,
  Warlock,
  Priest,
  Shaman,
  Mage,
  Rogue,
  Hunter,
  DemonHunter,
  Evoker,
};
