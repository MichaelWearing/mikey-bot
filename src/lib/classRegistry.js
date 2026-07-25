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
