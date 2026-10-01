// Best-effort per-spec breakdown of tracked defensives — Vampiric Blood kept as the
// Blood-only tank cooldown; the rest are shared across the class tree. Correct as needed.
//
// Death Pact is dropped from Blood on Jaco's word (he plays it): nobody specs it on
// Blood, so tracking it only ever produced false "never pressed Death Pact" callouts.
// An earlier round assumed the opposite from the talent tree alone and let the callout
// stand — the player who actually runs the spec wins over that reading. Left in place
// for Frost/Unholy, which haven't been checked with their players.
export const Blood = ["Icebound Fortitude", "Anti-Magic Shell", "Vampiric Blood", "Death Strike", "Lichborne"];
export const Frost = ["Icebound Fortitude", "Anti-Magic Shell", "Death Strike", "Lichborne", "Death Pact"];
export const Unholy = ["Icebound Fortitude", "Anti-Magic Shell", "Death Strike", "Lichborne", "Death Pact"];
