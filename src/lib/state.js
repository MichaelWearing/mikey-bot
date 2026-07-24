import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const STATE_PATH = path.resolve("data/state.json");

async function readState() {
  try {
    const raw = await readFile(STATE_PATH, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return { lastSeenStartTime: null };
    throw err;
  }
}

async function writeState(state) {
  await mkdir(path.dirname(STATE_PATH), { recursive: true });
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

// Returns null if no state has ever been recorded (first run) — distinct
// from 0, so the poller can bootstrap without backfill-posting old reports.
export async function getLastSeenStartTime() {
  const state = await readState();
  return state.lastSeenStartTime ?? null;
}

export async function setLastSeenStartTime(startTime) {
  const state = await readState();
  state.lastSeenStartTime = startTime;
  await writeState(state);
}
