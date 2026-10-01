import { readFile } from "node:fs/promises";
import path from "node:path";

const ROSTER_PATH = path.resolve("data/roster.json");

// Each entry: { names: ["Main", "Alt"], channelName: "discord-channel-name" }
// Edit data/roster.json directly to add/remove people — no code changes needed.
export async function getRoster() {
  const raw = await readFile(ROSTER_PATH, "utf-8");
  return JSON.parse(raw);
}

// Map<characterName, {class, spec}> — hand-maintained ground truth, preferred over
// WCL's own per-report spec detection wherever that's shown to be unreliable (see
// neverUsedDefensives in playerFeedback.js).
export function buildSpecLookup(roster) {
  const lookup = new Map();
  for (const entry of roster) {
    for (const character of entry.characters) {
      lookup.set(character.name, { class: character.class, spec: character.spec });
    }
  }
  return lookup;
}
