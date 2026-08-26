import "dotenv/config";
import { REST, Routes } from "discord.js";
import * as analyzeCommand from "./commands/analyze.js";
import * as summaryCommand from "./commands/summary.js";
import * as feedbackCommand from "./commands/feedback.js";
import * as startTrackingLiveCommand from "./commands/startTrackingLive.js";
import * as stopTrackingLiveCommand from "./commands/stopTrackingLive.js";
import * as givePersonalFeedbackToAllCommand from "./commands/givePersonalFeedbackToAll.js";
import * as listDefensivesCommand from "./commands/listDefensives.js";
import * as requestDefensivesCommand from "./commands/requestDefensives.js";
import * as checkHeroUpgradesCommand from "./commands/checkHeroUpgrades.js";

const commands = [
  analyzeCommand.data.toJSON(),
  summaryCommand.data.toJSON(),
  feedbackCommand.data.toJSON(),
  startTrackingLiveCommand.data.toJSON(),
  stopTrackingLiveCommand.data.toJSON(),
  givePersonalFeedbackToAllCommand.data.toJSON(),
  listDefensivesCommand.data.toJSON(),
  requestDefensivesCommand.data.toJSON(),
  checkHeroUpgradesCommand.data.toJSON(),
];

const rest = new REST().setToken(process.env.DISCORD_BOT_TOKEN);

const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;

try {
  if (guildId) {
    // Guild-scoped commands update instantly — best for development.
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log(`Registered ${commands.length} command(s) to guild ${guildId}.`);
  } else {
    // Global commands can take up to an hour to propagate.
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log(`Registered ${commands.length} global command(s).`);
  }
} catch (err) {
  console.error("Failed to register commands:", err);
  process.exit(1);
}
