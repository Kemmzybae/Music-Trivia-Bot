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
  new SlashCommandBuilder()
    .setName("addsong")
    .setDescription("Add a song to the custom quiz library.")
    .addStringOption((o) =>
      o.setName("title").setDescription("Song title").setRequired(true),
    )
    .addStringOption((o) =>
      o.setName("artist").setDescription("Artist name").setRequired(true),
    )
    .addStringOption((o) =>
      o.setName("url").setDescription("YouTube URL (optional)").setRequired(false),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("removesong")
    .setDescription("Remove a song from the custom quiz library by its ID.")
    .addIntegerOption((o) =>
      o.setName("id").setDescription("Song ID from /listsongs").setRequired(true),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("listsongs")
    .setDescription("List all songs in the custom quiz library.")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("stats")
    .setDescription("Show a player's personal quiz stats.")
    .addUserOption((o) =>
      o.setName("player").setDescription("The player to look up (defaults to you)").setRequired(false),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show all available bot commands.")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("resetleaderboard")
    .setDescription("Wipe all quiz stats and leaderboard entries for this server. Staff only.")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("challenge")
    .setDescription("Start a 20-round music trivia challenge. No repeats, final standings at the end!")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("challengeleaderboard")
    .setDescription("Show the all-time hall of fame for challenge mode.")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("challengestats")
    .setDescription("Show a player's personal challenge mode stats.")
    .addUserOption((o) =>
      o.setName("player").setDescription("The player to look up (defaults to you)").setRequired(false),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("endchallenge")
    .setDescription("Force-stop a running challenge. Staff only.")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("resetchallengestats")
    .setDescription("Wipe all challenge leaderboard stats for this server. Staff only.")
    .toJSON(),
  new SlashCommandBuilder()
    .setName("uploadsong")
    .setDescription("Upload an audio file from your library as a quiz song.")
    .addAttachmentOption((o) =>
      o.setName("file").setDescription("MP3 or audio file to use for playback").setRequired(true),
    )
    .addStringOption((o) =>
      o.setName("title").setDescription("Song title").setRequired(true),
    )
    .addStringOption((o) =>
      o.setName("artist").setDescription("Artist name").setRequired(true),
    )
    .addStringOption((o) =>
      o.setName("url").setDescription("YouTube URL (optional)").setRequired(false),
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("checksongs")
    .setDescription("Scan the entire song library for expired Discord CDN URLs. Moderator only.")
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
