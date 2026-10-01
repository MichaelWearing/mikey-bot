// Trash-pull analysis — deliberately separate from analyze.js, which filters trash
// segments (fights with kill === null) out entirely for boss-focused reporting.
// WCL has no "Loot" event type at all (confirmed directly against the API), so this
// only covers damage/healing — there's no way to see who looted what from a combat log.
import { wclQuery } from "./wcl.js";
import { analyzeReport } from "./analyze.js";
import { getRoster } from "./roster.js";

const REPORT_QUERY = `
  query ($code: String!) {
    reportData {
      report(code: $code) {
        title
        fights { id name kill keystoneLevel startTime endTime }
        masterData {
          actors { id name type subType petOwner }
        }
      }
    }
  }
`;

const EVENTS_PAGE_QUERY = `
  query ($code: String!, $fightId: Int!, $dataType: EventDataType!, $startTime: Float!) {
    reportData {
      report(code: $code) {
        events(fightIDs: [$fightId], dataType: $dataType, startTime: $startTime, endTime: 99999999999, limit: 10000) {
          data
          nextPageTimestamp
        }
      }
    }
  }
`;

// No hostilityType — passing "Enemies" for DamageDone silently returned a wrong,
// unfiltered event mix on a real report (damage taken mixed in with damage done), so
// source/target types are always checked by hand here instead of trusting that filter.
async function fetchAllEvents(code, fightId, dataType) {
  let all = [];
  let startTime = 0;
  while (startTime != null) {
    const result = await wclQuery(EVENTS_PAGE_QUERY, { code, fightId, dataType, startTime });
    const page = result.reportData.report.events;
    all = all.concat(page.data);
    startTime = page.nextPageTimestamp ?? null;
  }
  return all;
}

// Real trash pulls run tens of seconds to a few minutes. WCL also logs near-instant
// (0-60ms) fight entries around boss pulls as transition/wipe-recovery markers —
// these aren't real trash combat, so a duration floor filters them out.
const MIN_TRASH_DURATION_MS = 10000;

async function analyzeSingleTrashReport(code) {
  const base = await wclQuery(REPORT_QUERY, { code });
  const report = base.reportData.report;
  if (!report) {
    throw new Error(`Report not found: ${code}`);
  }

  const actorsById = new Map(report.masterData.actors.map((a) => [a.id, a]));

  const trashFights = report.fights.filter(
    (f) => f.kill === null && f.keystoneLevel == null && f.endTime - f.startTime >= MIN_TRASH_DURATION_MS
  );

  const totalsByPlayer = new Map(); // name -> { name, class, damage, healing }

  function resolvePlayerSource(actorId) {
    let source = actorsById.get(actorId);
    if (!source) return null;
    // Pet output counts toward its owner, same resolution analyze.js uses for pet
    // interrupts — otherwise a Warlock's pet shows up as its own "player."
    if (source.type === "Pet" && source.petOwner != null) {
      source = actorsById.get(source.petOwner) ?? source;
    }
    return source.type === "Player" ? source : null;
  }

  for (const fight of trashFights) {
    const [dmgEvents, healEvents] = await Promise.all([
      fetchAllEvents(code, fight.id, "DamageDone"),
      fetchAllEvents(code, fight.id, "Healing"),
    ]);
    for (const e of dmgEvents) {
      const source = resolvePlayerSource(e.sourceID);
      if (!source) continue;
      const entry = totalsByPlayer.get(source.name) ?? { name: source.name, class: source.subType, damage: 0, healing: 0 };
      entry.damage += e.amount ?? 0;
      totalsByPlayer.set(source.name, entry);
    }
    for (const e of healEvents) {
      const source = resolvePlayerSource(e.sourceID);
      if (!source) continue;
      const entry = totalsByPlayer.get(source.name) ?? { name: source.name, class: source.subType, damage: 0, healing: 0 };
      entry.healing += e.amount ?? 0; // effective healing only, WCL tracks overheal separately
      totalsByPlayer.set(source.name, entry);
    }
  }

  return {
    title: report.title,
    playerTotals: [...totalsByPlayer.values()],
    trashPullCount: trashFights.length,
    totalTrashDurationMs: trashFights.reduce((sum, f) => sum + (f.endTime - f.startTime), 0),
  };
}

// codeOrCodes: comma-separated for a night split across multiple logs, same
// convention as analyzeReport. Unlike boss pulls, trash segments aren't deduped
// across logs (no clean identity to match on) — if the same trash got logged twice
// by two people, it'll double count here. Narrow edge case, not worth the added
// complexity for a first pass at this.
export async function analyzeTrash(codeOrCodes) {
  const codes = codeOrCodes
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);

  const reports = [];
  for (const code of codes) {
    reports.push(await analyzeSingleTrashReport(code));
  }

  // Role comes from the report's own boss kill-pull rankings (same source /summary
  // and /feedback use) — healers get judged on healing, everyone else on damage.
  // Best-effort: if this fails for some reason, everyone just falls back to damage
  // rather than losing the whole report over it.
  let roleByName = new Map();
  try {
    const roleAnalysis = await analyzeReport(codeOrCodes);
    for (const pull of roleAnalysis.pulls) {
      for (const p of pull.allParses ?? []) {
        if (p.role) roleByName.set(p.name, p.role);
      }
    }
  } catch (err) {
    console.error("Couldn't determine roles for trash DPS/HPS split:", err);
  }

  // Someone who swaps to an alt mid-night is one person doing one night's work, so
  // their characters are merged into a single row rather than splitting their total in
  // half and making both look weak. Roster is best-effort: unknown characters just
  // stay as themselves.
  let personByCharacter = new Map();
  try {
    for (const entry of await getRoster()) {
      for (const character of entry.characters) {
        personByCharacter.set(character.name, entry.characters[0]?.name ?? character.name);
      }
    }
  } catch (err) {
    console.error("Couldn't load roster to merge alts for trash damage:", err);
  }

  const totalsByPlayer = new Map();
  for (const report of reports) {
    for (const p of report.playerTotals) {
      const key = personByCharacter.get(p.name) ?? p.name;
      const entry = totalsByPlayer.get(key) ?? { name: key, class: p.class, damage: 0, healing: 0, characters: new Map() };
      entry.damage += p.damage;
      entry.healing += p.healing;
      // Kept per character so the row can show which alt did what, and so the role
      // split below can judge each character on its own job.
      const per = entry.characters.get(p.name) ?? { name: p.name, class: p.class, damage: 0, healing: 0 };
      per.damage += p.damage;
      per.healing += p.healing;
      entry.characters.set(p.name, per);
      totalsByPlayer.set(key, entry);
    }
  }

  const totalSeconds = reports.reduce((sum, r) => sum + r.totalTrashDurationMs, 0) / 1000;
  const roster = [...totalsByPlayer.values()]
    .map((p) => {
      // Each character is judged on its own job before being added up — a healer alt
      // contributes healing, a dps main contributes damage — so a role swap doesn't
      // get measured against the wrong number.
      const parts = [...p.characters.values()]
        .map((c) => {
          const isHealer = roleByName.get(c.name) === "healer";
          return { ...c, isHealer, total: isHealer ? c.healing : c.damage };
        })
        .filter((c) => c.total > 0)
        .sort((a, b) => b.total - a.total);
      const total = parts.reduce((sum, c) => sum + c.total, 0);
      const lead = parts[0];
      return {
        // Named for whichever character did the most, since that's the one people
        // picture; any others they played are listed alongside.
        name: lead?.name ?? p.name,
        class: lead?.class ?? p.class,
        isHealer: lead?.isHealer ?? false,
        alts: parts.slice(1).map((c) => c.name),
        total,
        perSecond: totalSeconds > 0 ? total / totalSeconds : 0,
      };
    })
    .filter((p) => p.total > 0)
    .sort((a, b) => b.total - a.total);

  return {
    title: reports[0].title,
    reportCode: codes[0],
    reportCodes: codes,
    trashPullCount: reports.reduce((sum, r) => sum + r.trashPullCount, 0),
    totalTrashDurationMs: reports.reduce((sum, r) => sum + r.totalTrashDurationMs, 0),
    roster,
  };
}
