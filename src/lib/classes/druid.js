// Best-effort per-spec breakdown of tracked defensives — Ironbark is Restoration's
// external heal; Survival Instincts confirmed Feral/Guardian only (not Balance or
// Restoration). Bear Form counts as a defensive for Balance/Feral/Restoration (going
// bear is purely a survival move for them) but NOT Guardian, since that's just their
// normal tank form, not a choice.
//
// Heart of the Wild is deliberately OMITTED: two druids (Kata, and Mikey confirming
// he used it every kill + most Sentinels wipes) reported it never registering, and it
// genuinely does not show up as a findable cast/aura in this server's logs — so
// tracking it only ever produced false "never used" / "was available, pressed
// nothing" callouts. Re-add if a real log ever surfaces the ability name it uses.
export const Balance = ["Barkskin", "Bear Form"];
export const Feral = ["Barkskin", "Survival Instincts", "Bear Form"];
export const Guardian = ["Barkskin", "Survival Instincts"];
export const Restoration = ["Barkskin", "Ironbark", "Bear Form"];
