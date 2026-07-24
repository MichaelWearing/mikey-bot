import { readFile } from "node:fs/promises";
import path from "node:path";

const ROSTER_PATH = path.resolve("data/roster.json");

// Each entry: { names: ["Main", "Alt"], channelName: "discord-channel-name" }
// Edit data/roster.json directly to add/remove people — no code changes needed.
export async function getRoster() {
  const raw = await readFile(ROSTER_PATH, "utf-8");
  return JSON.parse(raw);
}
