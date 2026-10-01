// Best-effort per-spec breakdown of tracked defensives. Ice Block/Ice Cold is a
// talent-driven rename of the SAME defensive (shared class tree) — either name can
// show up in the log depending on the player's talent choice, so both are listed for
// every spec; DEFENSIVE_ALIAS_GROUPS in defensives.js makes sure using one doesn't
// flag the other as missing. The barrier shield, unlike Ice Block, is spec-locked —
// NOT a free choice across specs (corrected after this wrongly flagged Tkpmage, a
// Fire mage, for never using Prismatic/Ice Barrier — abilities his spec can't take
// at all). Correct as needed.
// Mirror Image is Arcane-only here on raider feedback (TKPStefan): baseline for every
// mage, but this tier an Arcane talent turns it into a real damage-reduction cooldown
// worth tracking. Add it to Fire/Frost too if one of them starts using it defensively.
export const Arcane = ["Ice Block", "Ice Cold", "Alter Time", "Prismatic Barrier", "Mirror Image"];
export const Fire = ["Ice Block", "Ice Cold", "Alter Time", "Blazing Barrier"];
export const Frost = ["Ice Block", "Ice Cold", "Alter Time", "Ice Barrier"];
