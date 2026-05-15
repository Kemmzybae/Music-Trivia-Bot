import { REST, Routes, SlashCommandBuilder } from "discord.js";

const commands = [
  new SlashCommandBuilder()
    .setName("quiz")
    .setDescription("Start a music quiz round! Join a voice channel first.")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("leaderboard")
    .setDescription("Show the top players on the music quiz leaderboard.")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("skip")
    .setDescription("Skip the current quiz round and reveal the answer.")
    .toJSON(),
];

export async function registerCommands(): Promise<void> {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;

  if (!token || !clientId) {
    throw new Error("DISCORD_TOKEN and DISCORD_CLIENT_ID must be set");
  }

  const rest = new REST({ version: "10" }).setToken(token);
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log("[bot] Slash commands registered");
}
