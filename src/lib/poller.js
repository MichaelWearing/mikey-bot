import { wclQuery } from "./wcl.js";
import { analyzeReport } from "./analyze.js";
import { buildReportEmbeds, chunkEmbeds } from "./embeds.js";
import { getLastSeenStartTime, setLastSeenStartTime } from "./state.js";

const RECENT_REPORTS_QUERY = `
  query ($guildId: Int!) {
    reportData {
      reports(guildID: $guildId, limit: 10) {
        data { code startTime }
      }
    }
  }
`;

const POLL_INTERVAL_MS = 5 * 60 * 1000;

let intervalHandle = null;
let trackingChannelId = null;

async function pollOnce(channel, guildId) {
  const data = await wclQuery(RECENT_REPORTS_QUERY, { guildId });
  const reports = data.reportData.reports.data;

  const lastSeen = await getLastSeenStartTime();

  if (lastSeen === null) {
    // First run ever: mark all currently-existing reports as seen without
    // posting them, so we only report on raids from here on out.
    const newestStartTime = Math.max(0, ...reports.map((r) => r.startTime));
    await setLastSeenStartTime(newestStartTime);
    console.log(`Bootstrapped poller state — will report on new logs from now on.`);
    return;
  }

  const newReports = reports
    .filter((r) => r.startTime > lastSeen)
    .sort((a, b) => a.startTime - b.startTime);

  for (const report of newReports) {
    console.log(`New report detected: ${report.code}`);
    try {
      const analysis = await analyzeReport(report.code);
      const embeds = buildReportEmbeds(analysis);
      const chunks = chunkEmbeds(embeds);
      for (const chunk of chunks) {
        await channel.send({ embeds: chunk });
      }
    } catch (err) {
      console.error(`Failed to analyze/post report ${report.code}:`, err);
      // Don't advance lastSeenStartTime past a report we failed to post,
      // so it gets retried on the next poll.
      break;
    }
    await setLastSeenStartTime(report.startTime);
  }
}

export function isPollingActive() {
  return { active: intervalHandle !== null, channelId: trackingChannelId };
}

// Nothing polls automatically anymore — this only runs once a command starts it,
// and stops the moment /stop-tracking-live is called (or the bot restarts).
export function startPolling(client, channelId) {
  if (intervalHandle !== null) {
    return { alreadyRunning: true, channelId: trackingChannelId };
  }

  const guildId = Number(process.env.WCL_GUILD_ID);
  if (!guildId) {
    throw new Error("WCL_GUILD_ID is not set in .env");
  }

  trackingChannelId = channelId;

  const poll = async () => {
    try {
      const channel = await client.channels.fetch(trackingChannelId);
      await pollOnce(channel, guildId);
    } catch (err) {
      console.error("Poll cycle failed:", err);
    }
  };

  poll();
  intervalHandle = setInterval(poll, POLL_INTERVAL_MS);
  return { alreadyRunning: false, channelId };
}

export function stopPolling() {
  if (intervalHandle === null) {
    return { wasRunning: false };
  }
  clearInterval(intervalHandle);
  intervalHandle = null;
  const channelId = trackingChannelId;
  trackingChannelId = null;
  return { wasRunning: true, channelId };
}
