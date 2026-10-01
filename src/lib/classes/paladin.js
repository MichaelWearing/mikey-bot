// Best-effort per-spec breakdown of tracked defensives — Ardent Defender and Guardian
// of Ancient Kings are both Protection-only tank cooldowns; the rest are shared.
// Divine Protection is NOT available to Protection specifically (confirmed by raider
// feedback — presumably baked into/replaced by one of the tank cooldowns for that
// spec), so it's left off that list only. Blessing of Spellwarding is a Protection
// talent that shares Blessing of Protection's cooldown (using one locks out the
// other), so the two are an alias group in defensives.js — raider feedback from
// Nèèko, flagged for "never using" BoP on nights they used Spellwarding instead.
// Correct as needed.
export const Holy = ["Divine Shield", "Divine Protection", "Blessing of Protection", "Blessing of Sacrifice", "Lay on Hands"];
export const Protection = ["Divine Shield", "Ardent Defender", "Guardian of Ancient Kings", "Blessing of Protection", "Blessing of Spellwarding", "Blessing of Sacrifice", "Lay on Hands"];
export const Retribution = ["Divine Shield", "Divine Protection", "Blessing of Protection", "Blessing of Sacrifice", "Lay on Hands"];
