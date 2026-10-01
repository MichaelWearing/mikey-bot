// Confirmed AoE-only spenders — abilities a guide explicitly confirms get swapped in
// for AoE situations (2+ targets) and would never come up during pure single-target
// combat. If one of these lands on a tracked pad target at all, that's a deliberate
// choice, not incidental splash — no statistical-outlier threshold needed the way
// /pad's general volume detection needs one.
//
// This is NOT the same idea as an earlier version of this file, which listed
// single-target-only abilities instead — that had it backwards (it missed real
// padding from AoE-capable abilities like these, and could flag a one-off stray
// single-target hit as certain padding when it was just a stray target-switch).
//
// Deliberately narrow — only specs where a guide explicitly confirms the swap-in
// behavior are listed here. Talent-dependent or ambiguous cases are left out rather
// than guessed at: Demonology Warlock's Implosion is excluded because one talent
// (To Hell and Back) makes it single-target-viable too; Havoc DH's Glaive Tempest is
// excluded because it's now a passive Blade Dance proc, not something cast directly.
// Extend this as more specs get confirmed against a real guide or real log data.
export const PAD_ABILITIES = {
  Paladin: {
    Retribution: ["Divine Storm"], // AoE Holy Power spender, swapped in at 2+ targets instead of Final Verdict
  },
  Rogue: {
    Subtlety: ["Black Powder"], // AoE finisher — guides themselves call non-priority use of this "pad damage"
  },
  DeathKnight: {
    Unholy: ["Epidemic"], // AoE Runic Power spender, swapped in at 3+ targets instead of Death Coil
  },
  Warrior: {
    Arms: ["Cleave"], // deliberate AoE cast, confirmed by raider feedback
  },
  Mage: {
    Fire: ["Flamestrike"], // AoE Hot Streak payoff, swapped in at 5+ targets instead of Pyroblast
  },
};

// Flat set of every tracked ability name, for a quick membership check when the
// caller doesn't need to know which class/spec it came from.
export const ALL_PAD_ABILITY_NAMES = new Set(Object.values(PAD_ABILITIES).flatMap((specs) => Object.values(specs).flat()));
