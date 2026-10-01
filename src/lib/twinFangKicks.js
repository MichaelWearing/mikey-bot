// /twin-fang-kicks — the Twin Fangs kick rotation is assigned to a fixed group who
// should all be pulling roughly equal weight (the two Prot Paladin tanks will top
// the raw interrupt list regardless, so they're shown separately as context only).
import { analyzeReport, FEAST_SOAK_BOSS_NAME } from "./analyze.js";
import { getRoster } from "./roster.js";

// Matched by roster channelName rather than character name, so a kicker swapping
// to an alt (e.g. Páz on Pàzdh) still counts toward the same person.
const KICK_GROUP_CHANNELS = ["mikey", "paz", "throne", "goilen", "oc", "nygzy"];

// A kicker's per-pull rate this far off the group's average gets flagged — loose
// enough that a one-kick difference on a short night doesn't read as a problem.
const BEHIND_RATIO = 0.75;
const AHEAD_RATIO = 1.25;

export async function analyzeTwinFangKicks(codeOrCodes) {
  const [analysis, roster] = await Promise.all([analyzeReport(codeOrCodes), getRoster()]);

  const personByCharacter = new Map(); // characterName -> channelName
  const displayNameByChannel = new Map(); // channelName -> roster main name, for anyone absent
  for (const entry of roster) {
    if (!KICK_GROUP_CHANNELS.includes(entry.channelName)) continue;
    displayNameByChannel.set(entry.channelName, entry.names[0]);
    for (const c of entry.characters) personByCharacter.set(c.name, entry.channelName);
  }

  const pulls = analysis.pulls.filter((p) => p.bossName === FEAST_SOAK_BOSS_NAME);

  const group = new Map(
    KICK_GROUP_CHANNELS.map((channel) => [channel, { channel, characters: new Set(), class: null, kicks: 0, pullsPresent: 0 }])
  );
  const others = new Map(); // name -> { name, class, kicks }
  const perPull = [];

  for (const pull of pulls) {
    const kicksThisPull = new Map(); // channel -> kicks
    for (const p of pull.prepChecks ?? []) {
      const channel = personByCharacter.get(p.playerName);
      if (!channel) continue;
      const entry = group.get(channel);
      entry.pullsPresent++;
      entry.characters.add(p.playerName);
      entry.class ??= p.playerClass;
      kicksThisPull.set(channel, 0);
    }

    for (const i of pull.interrupts ?? []) {
      if (!i.sourceName) continue;
      const channel = personByCharacter.get(i.sourceName);
      if (channel) {
        const entry = group.get(channel);
        entry.kicks++;
        entry.characters.add(i.sourceName);
        entry.class ??= i.sourceClass;
        kicksThisPull.set(channel, (kicksThisPull.get(channel) ?? 0) + 1);
      } else {
        const entry = others.get(i.sourceName) ?? { name: i.sourceName, class: i.sourceClass, kicks: 0 };
        entry.kicks++;
        others.set(i.sourceName, entry);
      }
    }

    perPull.push({ pullNumber: pull.pullNumber, kill: pull.kill, kicksByChannel: kicksThisPull });
  }

  const present = [...group.values()].filter((g) => g.pullsPresent > 0);
  const groupTotalKicks = present.reduce((sum, g) => sum + g.kicks, 0);
  const groupTotalPulls = present.reduce((sum, g) => sum + g.pullsPresent, 0);
  const avgRate = groupTotalPulls > 0 ? groupTotalKicks / groupTotalPulls : 0;

  const kickers = [...group.values()]
    .map((g) => {
      const rate = g.pullsPresent > 0 ? g.kicks / g.pullsPresent : 0;
      let standing = "even";
      if (g.pullsPresent === 0) standing = "absent";
      else if (avgRate > 0 && rate < avgRate * BEHIND_RATIO) standing = "behind";
      else if (avgRate > 0 && rate > avgRate * AHEAD_RATIO) standing = "ahead";
      return {
        channel: g.channel,
        name: g.characters.size > 0 ? [...g.characters].join("/") : displayNameByChannel.get(g.channel) ?? g.channel,
        class: g.class,
        kicks: g.kicks,
        pullsPresent: g.pullsPresent,
        rate,
        sharePct: groupTotalKicks > 0 ? (g.kicks / groupTotalKicks) * 100 : 0,
        standing,
      };
    })
    .sort((a, b) => b.rate - a.rate || b.kicks - a.kicks);

  const channelNames = new Map(kickers.map((k) => [k.channel, k.name]));

  return {
    title: analysis.title,
    reportCode: analysis.reportCode,
    reportCodes: analysis.reportCodes,
    duplicatesDropped: analysis.duplicatesDropped,
    pullCount: pulls.length,
    killed: pulls.some((p) => p.kill),
    avgRate,
    behindRatio: BEHIND_RATIO,
    aheadRatio: AHEAD_RATIO,
    // Equal split = each present kicker gets 1/n of the group's kicks.
    fairSharePct: present.length > 0 ? 100 / present.length : 0,
    kickers,
    perPull: perPull.map((p) => ({
      pullNumber: p.pullNumber,
      kill: p.kill,
      // Same order as the kickers list, so each column lines up pull to pull.
      counts: kickers
        .filter((k) => p.kicksByChannel.has(k.channel))
        .map((k) => ({ name: channelNames.get(k.channel), kicks: p.kicksByChannel.get(k.channel) })),
    })),
    otherKickers: [...others.values()].sort((a, b) => b.kicks - a.kicks),
  };
}
