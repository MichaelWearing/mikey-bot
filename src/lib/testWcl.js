import "dotenv/config";
import { wclQuery } from "./wcl.js";

const guildId = Number(process.env.WCL_GUILD_ID);

const query = `
  query ($guildId: Int!) {
    reportData {
      reports(guildID: $guildId, limit: 5) {
        data {
          code
          title
          startTime
          zone { name }
        }
      }
    }
    rateLimitData {
      limitPerHour
      pointsSpentThisHour
      pointsResetIn
    }
  }
`;

const data = await wclQuery(query, { guildId });
console.log("WCL credentials OK. Recent reports:");
console.log(JSON.stringify(data.reportData.reports.data, null, 2));
console.log("Rate limit:", JSON.stringify(data.rateLimitData, null, 2));
