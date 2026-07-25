import { SlashCommandBuilder, EmbedBuilder } from "discord.js";
import { CLASS_SPECS } from "../lib/classRegistry.js";
import { CLASS_EMOJI } from "../lib/embeds.js";

// "BeastMastery" -> "Beast Mastery" for display; export names have to be valid JS
// identifiers so multi-word specs are stored without spaces.
function specDisplayName(specName) {
  return specName.replace(/([a-z])([A-Z])/g, "$1 $2");
}

const ENTRIES = [];
for (const [className, specs] of Object.entries(CLASS_SPECS)) {
  for (const [specName, abilities] of Object.entries(specs)) {
    const classDisplay = specDisplayName(className);
    const specDisplay = specDisplayName(specName);
    ENTRIES.push({
      className,
      label: `${classDisplay} - ${specDisplay}`,
      value: `${className}:${specName}`,
      abilities,
    });
  }
}

export const data = new SlashCommandBuilder()
  .setName("list-defensives")
  .setDescription("List the defensives tracked for a class/spec")
  .addStringOption((opt) =>
    opt
      .setName("spec")
      .setDescription("Start typing a class or spec to search")
      .setRequired(true)
      .setAutocomplete(true)
  );

export async function autocomplete(interaction) {
  const focused = interaction.options.getFocused().toLowerCase();
  const matches = ENTRIES.filter((e) => e.label.toLowerCase().includes(focused)).slice(0, 25);
  await interaction.respond(matches.map((e) => ({ name: e.label, value: e.value })));
}

export async function execute(interaction) {
  const value = interaction.options.getString("spec", true);
  const entry = ENTRIES.find((e) => e.value === value);

  if (!entry) {
    await interaction.reply({
      content: "Didn't recognize that spec — pick one from the autocomplete suggestions.",
      ephemeral: true,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0x1abc9c)
    .setTitle(`${CLASS_EMOJI[entry.className] ?? "🛡️"} ${entry.label} Defensives`)
    .setDescription(
      entry.abilities.length > 0
        ? entry.abilities.map((a) => `• ${a}`).join("\n")
        : "No defensives tracked for this spec yet."
    );

  await interaction.reply({ embeds: [embed] });
}
