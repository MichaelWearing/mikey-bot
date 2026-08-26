import "dotenv/config";
import { Client, GatewayIntentBits, Collection } from "discord.js";
import * as analyzeCommand from "./commands/analyze.js";
import * as summaryCommand from "./commands/summary.js";
import * as feedbackCommand from "./commands/feedback.js";
import * as startTrackingLiveCommand from "./commands/startTrackingLive.js";
import * as stopTrackingLiveCommand from "./commands/stopTrackingLive.js";
import * as givePersonalFeedbackToAllCommand from "./commands/givePersonalFeedbackToAll.js";
import * as listDefensivesCommand from "./commands/listDefensives.js";
import * as requestDefensivesCommand from "./commands/requestDefensives.js";
import * as checkHeroUpgradesCommand from "./commands/checkHeroUpgrades.js";

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.commands = new Collection();
for (const cmd of [
  analyzeCommand,
  summaryCommand,
  feedbackCommand,
  startTrackingLiveCommand,
  stopTrackingLiveCommand,
  givePersonalFeedbackToAllCommand,
  listDefensivesCommand,
  requestDefensivesCommand,
  checkHeroUpgradesCommand,
]) {
  client.commands.set(cmd.data.name, cmd);
}

// Nothing runs automatically — polling only starts when /start-tracking-live is
// called, and stops on /stop-tracking-live or a bot restart.
client.once("clientReady", () => {
  console.log(`Logged in as ${client.user.tag}`);
});

const allowedUserIds = new Set(
  (process.env.ALLOWED_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

client.on("interactionCreate", async (interaction) => {
  if (interaction.isAutocomplete()) {
    if (!allowedUserIds.has(interaction.user.id)) return;
    const command = client.commands.get(interaction.commandName);
    if (!command?.autocomplete) return;
    try {
      await command.autocomplete(interaction);
    } catch (err) {
      console.error(`Error in autocomplete for ${interaction.commandName}:`, err);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (!allowedUserIds.has(interaction.user.id)) {
    await interaction.reply({ content: "You're not authorized to use this bot.", ephemeral: true });
    return;
  }

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (err) {
    console.error(`Error executing command ${interaction.commandName}:`, err);
    const reply = { content: "Something went wrong running that command.", ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp(reply);
    } else {
      await interaction.reply(reply);
    }
  }
});

client.login(process.env.DISCORD_BOT_TOKEN);
