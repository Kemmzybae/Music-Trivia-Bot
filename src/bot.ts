import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  GuildMember,
  VoiceChannel,
  ChatInputCommandInteraction,
  ButtonInteraction,
  InteractionType,
  type Interaction,
  type Message,
} from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  AudioPlayerStatus,
  type VoiceConnection,
} from "@discordjs/voice";
import { spawn } from "child_process";
import { Readable } from "stream";
import ffmpegPath from "ffmpeg-static";
import { getRandomSong, getWrongChoices, type SongEntry, SONGS } from "./songs.js";
import { recordAnswer, recordWin, getTopLeaderboard, getPlayerStats, resetLeaderboard } from "./leaderboard.js";
import { startChallenge, forceEndChallenge, handleChallengeButton } from "./challenge.js";
import { getTopChallengeLeaderboard, getChallengePlayerStats } from "./challenge-leaderboard.js";
import { registerCommands } from "./register-commands.js";
import {
  addSong,
  removeSong,
  listSongs,
  getAllSongsAsEntries,
  getSongCount,
  setAudioUrl,
} from "./song-library.js";

const QUIZ_DURATION_MS = 10_000;
const VOICE_CONNECT_TIMEOUT_MS = 15_000;
const CHOICES = ["A", "B", "C"] as const;

interface ActiveRound {
  correctSong: SongEntry;
  choices: SongEntry[];
  correctIndex: number;
  startTime: number;
  guildId: string;
  responses: Map<string, { username: string; choiceIndex: number; timeMs: number }>;
  timer: ReturnType<typeof setTimeout>;
  message: Message;
}

const activeRounds = new Map<string, ActiveRound>();

export function createBot(): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
    ],
  });

  client.once("ready", async () => {
    console.log(`[bot] Logged in as ${client.user?.tag}`);
    try {
      await registerCommands();
    } catch (err) {
      console.error("[bot] Failed to register slash commands:", err);
    }
  });

  client.on("interactionCreate", async (interaction: Interaction) => {
    try {
      if (interaction.type === InteractionType.ApplicationCommand) {
        const cmd = interaction as ChatInputCommandInteraction;
        if (cmd.commandName === "quiz") await handleQuizCommand(cmd);
        else if (cmd.commandName === "leaderboard") await handleLeaderboardCommand(cmd);
        else if (cmd.commandName === "skip") await handleSkipCommand(cmd);
        else if (cmd.commandName === "addsong") await handleAddSongCommand(cmd);
        else if (cmd.commandName === "removesong") await handleRemoveSongCommand(cmd);
        else if (cmd.commandName === "listsongs") await handleListSongsCommand(cmd);
        else if (cmd.commandName === "stats") await handleStatsCommand(cmd);
        else if (cmd.commandName === "uploadsong") await handleUploadSongCommand(cmd);
        else if (cmd.commandName === "help") await handleHelpCommand(cmd);
        else if (cmd.commandName === "resetleaderboard") await handleResetLeaderboardCommand(cmd);
        else if (cmd.commandName === "challenge") await handleChallengeCommand(cmd);
        else if (cmd.commandName === "endchallenge") await handleEndChallengeCommand(cmd);
        else if (cmd.commandName === "challengeleaderboard") await handleChallengeLeaderboardCommand(cmd);
        else if (cmd.commandName === "challengestats") await handleChallengeStatsCommand(cmd);
      } else if (interaction.isButton()) {
        await handleButtonInteraction(interaction as ButtonInteraction);
      }
    } catch (err) {
      console.error("[bot] Interaction error:", err);
    }
  });

  const token = process.env.DISCORD_TOKEN;
  if (!token) throw new Error("DISCORD_TOKEN is required");

  client.login(token).catch((err) => {
    console.error("[bot] Login failed:", err);
    process.exit(1);
  });

  return client;
}

async function getDeezerPreviewUrl(song: SongEntry): Promise<string | null> {
  try {
    const query = encodeURIComponent(song.title + " " + song.artist);
    const res = await fetch("https://api.deezer.com/search?q=" + query + "&limit=5");
    const data = await res.json() as any;
    if (!data.data || data.data.length === 0) return null;
    // Take the first result that actually has a non-empty preview URL
    for (const track of data.data) {
      if (track.preview) return track.preview as string;
    }
    return null;
  } catch {
    return null;
  }
}

async function pickSongWithPreview(maxAttempts = 5): Promise<{ song: SongEntry; previewUrl: string } | null> {
  const customSongs = await getAllSongsAsEntries();
  const pool = customSongs.length >= 3 ? customSongs : SONGS;

  for (let i = 0; i < maxAttempts; i++) {
    const song = getRandomSong(pool);

    // Use uploaded audio directly — no Deezer needed
    if (song.audioUrl) {
      return { song, previewUrl: song.audioUrl };
    }

    // Fall back to Deezer preview
    const previewUrl = await getDeezerPreviewUrl(song);
    if (previewUrl) {
      return { song, previewUrl };
    }
    console.warn(`[quiz] No preview for "${song.title}" — trying another song (attempt ${i + 1}/${maxAttempts})`);
  }
  return null;
}

function destroyVoiceConnection(guildId: string): void {
  try { getVoiceConnection(guildId)?.destroy(); } catch { /* already gone */ }
}

async function tryVoicePlayback(song: SongEntry, voiceChannel: VoiceChannel, previewUrl: string): Promise<void> {
  const guildId = voiceChannel.guild.id;

  // Destroy any stale connection immediately — no delay needed
  destroyVoiceConnection(guildId);

  let connection: VoiceConnection | undefined;
  try {
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false,
    });

    // On disconnect, give it 5s to recover into a reconnecting state before destroying
    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(connection!, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection!, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        destroyVoiceConnection(guildId);
      }
    });

    const NOISY_STATES = new Set([VoiceConnectionStatus.Connecting, VoiceConnectionStatus.Signalling]);
    connection.on("stateChange", (oldState, newState) => {
      if (NOISY_STATES.has(oldState.status as VoiceConnectionStatus) && NOISY_STATES.has(newState.status as VoiceConnectionStatus)) return;
      console.log(`[voice] ${oldState.status} → ${newState.status}`);
    });

    await entersState(connection, VoiceConnectionStatus.Ready, VOICE_CONNECT_TIMEOUT_MS);
    console.log("[voice] Connection ready — starting playback");

    const response = await fetch(previewUrl);
    if (!response.ok) throw new Error(`Deezer fetch failed: ${response.status}`);
    const mp3Stream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);

    const ffmpeg = spawn(ffmpegPath!, [
      "-f", "mp3",
      "-i", "pipe:0",
      "-f", "s16le",
      "-ar", "48000",
      "-ac", "2",
      "pipe:1",
    ]);
    ffmpeg.on("error", (err: Error) => console.error("[ffmpeg] Spawn error:", err.message));
    ffmpeg.stderr.on("data", (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) console.warn("[ffmpeg]", msg);
    });
    ffmpeg.stdin.on("error", () => { /* ignore EPIPE when player stops early */ });
    mp3Stream.pipe(ffmpeg.stdin);

    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });

    const player = createAudioPlayer();
    player.on("error", (err) => console.error("[voice] Player error:", err.message));
    player.on(AudioPlayerStatus.Idle, () => {
      destroyVoiceConnection(guildId);
    });

    connection.subscribe(player);
    player.play(resource);
    console.log(`[voice] Now playing: ${song.title}`);
  } catch (err) {
    console.error("[voice] Playback failed:", (err as Error).message);
    if (connection) destroyVoiceConnection(guildId);
  }
}
// ───────────────────────────────────────────────────────────────────────────

function buildQuizEmbed(choices: SongEntry[], songUrl: string, voiceAttempted: boolean): EmbedBuilder {
  const listenLine = voiceAttempted
    ? `🔊 **Playing in your voice channel** *(or use the link)*: [▶ Listen](${songUrl})`
    : `▶️ **Open and listen**: [▶ Listen](${songUrl})`;

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🎵 Music Quiz — Name That Song!")
    .setDescription(
      `${listenLine}\n\n` +
        `You have **${QUIZ_DURATION_MS / 1000} seconds** to guess!\n\n` +
        choices.map((c, i) => `**${CHOICES[i]}.** ${c.title} — *${c.artist}*`).join("\n"),
    )
    .setFooter({ text: "Click A, B or C to lock in your answer!" })
    .setTimestamp();
}

function buildButtonRow(choices: SongEntry[]): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  choices.forEach((_, i) => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`quiz_answer_${i}`)
        .setLabel(CHOICES[i])
        .setStyle(ButtonStyle.Primary),
    );
  });
  return row;
}

async function handleQuizCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "❌ This command only works in a server.", ephemeral: true });
    return;
  }

  if (activeRounds.has(guildId)) {
    await interaction.reply({ content: "⚠️ A quiz round is already in progress!", ephemeral: true });
    return;
  }

  // Acknowledge immediately so Discord doesn't time out the interaction (3s limit)
  await interaction.deferReply();

  const picked = await pickSongWithPreview(5);
  if (!picked) {
    await interaction.editReply({ content: "❌ Couldn't find a song with an audio preview right now — please try again!" });
    return;
  }
  const { song: correctSong, previewUrl } = picked;

  const wrongChoices = getWrongChoices(correctSong, 2);
  const allChoices = [correctSong, ...wrongChoices].sort(() => Math.random() - 0.5);
  const correctIndex = allChoices.findIndex((s) => s.title === correctSong.title);

  const member = interaction.member as GuildMember;
  const voiceChannel = member?.voice?.channel as VoiceChannel | null;
  const voiceAttempted = voiceChannel !== null;

  const embed = buildQuizEmbed(allChoices, correctSong.youtubeUrl, voiceAttempted);
  const row = buildButtonRow(allChoices);

  const message = await interaction.editReply({ embeds: [embed], components: [row] });

  const round: ActiveRound = {
    correctSong,
    choices: allChoices,
    correctIndex,
    startTime: Date.now(),
    guildId,
    responses: new Map(),
    message: message as Message,
    timer: setTimeout(() => endRound(guildId), QUIZ_DURATION_MS),
  };
  activeRounds.set(guildId, round);

  if (voiceChannel) {
    tryVoicePlayback(correctSong, voiceChannel, previewUrl).catch((err) => {
      console.error("[voice] Unexpected error:", err);
    });
  }
}

async function handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) return;

  if (handleChallengeButton(interaction)) return;

  const round = activeRounds.get(guildId);
  if (!round) {
    await interaction.reply({ content: "⏰ No active quiz round right now.", ephemeral: true });
    return;
  }

  const userId = interaction.user.id;
  if (round.responses.has(userId)) {
    await interaction.reply({ content: "✅ You already answered!", ephemeral: true });
    return;
  }

  const match = interaction.customId.match(/^quiz_answer_(\d+)$/);
  if (!match) return;

  const choiceIndex = parseInt(match[1], 10);
  const timeMs = Date.now() - round.startTime;

  round.responses.set(userId, {
    username: interaction.user.displayName ?? interaction.user.username,
    choiceIndex,
    timeMs,
  });

  const isCorrect = choiceIndex === round.correctIndex;
  const content = isCorrect
    ? `✅ **Correct!** You answered in **${(timeMs / 1000).toFixed(2)}s**`
    : `❌ **Wrong!** You chose **${CHOICES[choiceIndex]}**`;
  try {
    await interaction.reply({ content, ephemeral: true });
  } catch {
    // Interaction expired — answer is already recorded, nothing else to do
  }
}

async function endRound(guildId: string, skippedBy?: string): Promise<void> {
  const round = activeRounds.get(guildId);
  if (!round) return;

  activeRounds.delete(guildId);
  clearTimeout(round.timer);

  getVoiceConnection(guildId)?.destroy();

  const { correctSong, correctIndex, choices, responses } = round;
  const correctLabel = CHOICES[correctIndex];

  const correctResponders = [...responses.entries()]
    .filter(([, r]) => r.choiceIndex === correctIndex)
    .sort((a, b) => a[1].timeMs - b[1].timeMs);

  const winner = correctResponders[0];

  await Promise.allSettled(
    [...responses.entries()].map(([userId, r]) => {
      const correct = r.choiceIndex === correctIndex;
      return recordAnswer(userId, r.username, correct, correct ? r.timeMs : null);
    }),
  );

  if (winner) await recordWin(winner[0]);

  const title = skippedBy ? `⏭️ Round Skipped by ${skippedBy}` : "⏰ Time's Up!";
  const embed = new EmbedBuilder()
    .setColor(winner ? 0x57f287 : 0xed4245)
    .setTitle(title)
    .setDescription(
      `🎵 The song was: **${correctSong.title}** by **${correctSong.artist}** *(${correctLabel})*\n\n` +
        (winner
          ? `🏆 **Winner:** <@${winner[0]}> answered correctly in **${(winner[1].timeMs / 1000).toFixed(2)}s**!`
          : `😔 Nobody got it right this round!`),
    );

  if (correctResponders.length > 1) {
    const runners = correctResponders
      .slice(1, 4)
      .map(([, r], i) => `${i + 2}. ${r.username} — ${(r.timeMs / 1000).toFixed(2)}s`)
      .join("\n");
    embed.addFields({ name: "🥈 Also correct", value: runners });
  }

  const disabledRow = new ActionRowBuilder<ButtonBuilder>();
  choices.forEach((_, i) => {
    disabledRow.addComponents(
      new ButtonBuilder()
        .setCustomId(`quiz_answer_${i}_done`)
        .setLabel(CHOICES[i])
        .setStyle(i === correctIndex ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(true),
    );
  });

  try {
    await round.message.edit({ embeds: [embed], components: [disabledRow] });
  } catch {
    // Message may have been deleted
  }
}

async function handleSkipCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "❌ This command only works in a server.", ephemeral: true });
    return;
  }

  if (!activeRounds.has(guildId)) {
    await interaction.reply({ content: "⚠️ There is no active quiz round to skip.", ephemeral: true });
    return;
  }

  const username = interaction.user.displayName ?? interaction.user.username;
  await interaction.reply({ content: `⏭️ **${username}** skipped the round!`, ephemeral: false });
  await endRound(guildId, username);
}

async function handleLeaderboardCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const entries = await getTopLeaderboard(10);

  if (entries.length === 0) {
    await interaction.editReply("📋 No scores yet — start a round with `/quiz`!");
    return;
  }

  const medals = ["🥇", "🥈", "🥉"];
  const rows = entries.map((e, i) => {
    const medal = medals[i] ?? `**${i + 1}.**`;
    const accuracy = e.totalAnswers > 0 ? Math.round((e.correctAnswers / e.totalAnswers) * 100) : 0;
    const best = e.bestTimeMs !== null ? `${(e.bestTimeMs / 1000).toFixed(2)}s` : "—";
    return `${medal} **${e.username}** — 🏆 ${e.wins} wins · ✅ ${accuracy}% accuracy · ⚡ Best: ${best}`;
  });

  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle("🎵 Music Quiz Leaderboard")
    .setDescription(rows.join("\n"))
    .setTimestamp()
    .setFooter({ text: "Play with /quiz!" });

  await interaction.editReply({ embeds: [embed] });
}

function hasModeratorRole(interaction: ChatInputCommandInteraction): boolean {
  const member = interaction.member;
  if (!member || !("roles" in member)) return false;
  const roles = member.roles;
  if (Array.isArray(roles)) {
    return roles.some((r) => typeof r === "string");
  }
  return roles.cache.some((r) => r.name.toLowerCase() === "moderator");
}

async function replyNoPermission(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({
    content: "🚫 You don't have permission to use this command. The **Moderator** role is required.",
    ephemeral: true,
  });
}

async function handleAddSongCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!hasModeratorRole(interaction)) { await replyNoPermission(interaction); return; }

  const title = interaction.options.getString("title", true).trim();
  const artist = interaction.options.getString("artist", true).trim();
  const url = interaction.options.getString("url")?.trim() ?? "";
  const addedBy = interaction.user.displayName ?? interaction.user.username;

  await interaction.deferReply({ ephemeral: true });

  await addSong(title, artist, url, addedBy);
  const count = await getSongCount();

  await interaction.editReply(
    `✅ **${title}** by **${artist}** added to the song library! (${count} songs total)\n` +
    (url ? `🔗 ${url}` : "_No YouTube URL provided — Deezer will be used for the audio preview._"),
  );
}

async function handleRemoveSongCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!hasModeratorRole(interaction)) { await replyNoPermission(interaction); return; }

  const id = interaction.options.getInteger("id", true);

  await interaction.deferReply({ ephemeral: true });

  const removed = await removeSong(id);
  if (removed) {
    const count = await getSongCount();
    await interaction.editReply(`🗑️ Song #${id} removed from the library. (${count} songs remaining)`);
  } else {
    await interaction.editReply(`❌ No song with ID **${id}** found. Use \`/listsongs\` to see valid IDs.`);
  }
}

async function handleListSongsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!hasModeratorRole(interaction)) { await replyNoPermission(interaction); return; }

  await interaction.deferReply({ ephemeral: true });

  const songs = await listSongs();

  if (songs.length === 0) {
    await interaction.editReply(
      "📭 Your custom library is empty.\nUse `/addsong` to add songs — the bot will use the built-in list until you have at least 3.",
    );
    return;
  }

  const PAGE_SIZE = 20;
  const lines = songs.map(
    (s) => `\`#${s.id}\` **${s.title}** — *${s.artist}*${s.youtubeUrl ? ` 🔗` : ""}`,
  );

  const pages: string[] = [];
  for (let i = 0; i < lines.length; i += PAGE_SIZE) {
    pages.push(lines.slice(i, i + PAGE_SIZE).join("\n"));
  }

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`🎵 Custom Song Library (${songs.length} songs)`)
    .setDescription(pages[0])
    .setFooter({ text: pages.length > 1 ? `Showing 1–${Math.min(PAGE_SIZE, songs.length)} of ${songs.length}` : `${songs.length} song${songs.length === 1 ? "" : "s"} · Use /addsong or /removesong to manage` });

  await interaction.editReply({ embeds: [embed] });
}

async function handleStatsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const target = interaction.options.getUser("player") ?? interaction.user;
  const stats = await getPlayerStats(target.id);

  if (!stats) {
    const isSelf = target.id === interaction.user.id;
    await interaction.editReply(
      isSelf
        ? "📊 You haven't played any rounds yet — start one with `/quiz`!"
        : `📊 **${target.displayName ?? target.username}** hasn't played any rounds yet.`,
    );
    return;
  }

  const accuracy = stats.totalAnswers > 0
    ? Math.round((stats.correctAnswers / stats.totalAnswers) * 100)
    : 0;
  const best = stats.bestTimeMs !== null ? `${(stats.bestTimeMs / 1000).toFixed(2)}s` : "—";
  const winRate = stats.totalAnswers > 0
    ? Math.round((stats.wins / stats.totalAnswers) * 100)
    : 0;

  const embed = new EmbedBuilder()
    .setColor(0x57f287)
    .setTitle(`📊 Stats for ${stats.username}`)
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      { name: "🏆 Wins", value: `${stats.wins}`, inline: true },
      { name: "✅ Correct Answers", value: `${stats.correctAnswers} / ${stats.totalAnswers}`, inline: true },
      { name: "🎯 Accuracy", value: `${accuracy}%`, inline: true },
      { name: "⚡ Best Answer Time", value: best, inline: true },
      { name: "📈 Win Rate", value: `${winRate}%`, inline: true },
    )
    .setTimestamp()
    .setFooter({ text: "Play more rounds with /quiz!" });

  await interaction.editReply({ embeds: [embed] });
}

async function handleHelpCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🎵 Music Trivia Bot — Commands")
    .addFields(
      {
        name: "🎮 Playing",
        value: [
          "`/quiz` — Start a music quiz round (join a voice channel first!)",
          "`/skip` — Skip the current round and reveal the answer",
        ].join("\n"),
      },
      {
        name: "📚 Song Library",
        value: [
          "`/addsong title: … artist: …` — Add a song (Deezer finds the audio)",
          "`/uploadsong title: … artist: …` + attach file — Add a song with your own audio file (MP3, OGG, WAV, etc.)",
          "`/removesong id: …` — Remove a song by its ID",
          "`/listsongs` — View all songs in your custom library",
        ].join("\n"),
      },
      {
        name: "🏆 Stats",
        value: [
          "`/leaderboard` — Top 10 players",
          "`/stats` — Your personal stats",
          "`/stats player: @someone` — Look up another player's stats",
        ].join("\n"),
      },
      {
        name: "💡 Tips",
        value: [
          "• The bot uses your custom library once you have **3+ songs** added",
          "• Songs with uploaded files use your audio — others fall back to Deezer",
          "• Fastest correct answer wins the round!",
        ].join("\n"),
      },
    )
    .setFooter({ text: "Good luck! 🎶" });

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

const RESET_ALLOWED_ROLES = new Set(["moderator", "senior mod", "local host", "host", "co-host", "staff"]);

function hasResetPermission(interaction: ChatInputCommandInteraction): boolean {
  const member = interaction.member;
  if (!member || !("roles" in member)) return false;
  const roles = member.roles;
  if (Array.isArray(roles)) return false;
  return roles.cache.some((r) => RESET_ALLOWED_ROLES.has(r.name.toLowerCase()));
}

async function handleResetLeaderboardCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!hasResetPermission(interaction)) {
    await interaction.reply({
      content: "🚫 You don't have permission to use this command. Required roles: **Moderator**, **Senior Mod**, **Local Host**, **Host**, **Co-Host**, or **Staff**.",
      ephemeral: true,
    });
    return;
  }

  if (!interaction.guildId) {
    await interaction.reply({ content: "❌ This command only works in a server.", ephemeral: true });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  const count = await resetLeaderboard();

  await interaction.editReply(
    `🗑️ Leaderboard reset! **${count}** player record${count === 1 ? "" : "s"} wiped. All scores start fresh from here.`,
  );
}

async function handleUploadSongCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!hasModeratorRole(interaction)) { await replyNoPermission(interaction); return; }

  const attachment = interaction.options.getAttachment("file", true);
  const title = interaction.options.getString("title", true).trim();
  const artist = interaction.options.getString("artist", true).trim();
  const url = interaction.options.getString("url")?.trim() ?? "";
  const addedBy = interaction.user.displayName ?? interaction.user.username;

  await interaction.deferReply({ ephemeral: true });

  const contentType = attachment.contentType ?? "";
  if (!contentType.startsWith("audio/") && !attachment.name.match(/\.(mp3|ogg|wav|flac|m4a|aac)$/i)) {
    await interaction.editReply("❌ Please attach an audio file (MP3, OGG, WAV, FLAC, M4A, or AAC).");
    return;
  }

  await addSong(title, artist, url, addedBy, attachment.url);
  const count = await getSongCount();

  await interaction.editReply(
    `✅ **${title}** by **${artist}** added with your uploaded audio!\n` +
    `🎵 This song will use your file for playback — no Deezer needed.\n` +
    `📚 Library now has **${count}** song${count === 1 ? "" : "s"}.`,
  );
}

async function handleChallengeCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "❌ This command only works in a server.", ephemeral: true });
    return;
  }

  await interaction.deferReply();

  const channel = interaction.channel;
  if (!channel || !("send" in channel)) {
    await interaction.editReply("❌ This command must be used in a text channel.");
    return;
  }

  const member = interaction.member as GuildMember;
  const voiceChannel = member?.voice?.channel as VoiceChannel | null;

  const result = await startChallenge(guildId, channel as import("discord.js").TextChannel, voiceChannel);

  if (!result.started) {
    await interaction.editReply(result.message);
  } else {
    await interaction.editReply("🏆 Challenge started! Good luck everyone!");
  }
}

async function handleChallengeLeaderboardCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const entries = await getTopChallengeLeaderboard(10);

  if (entries.length === 0) {
    await interaction.editReply("📋 No challenge results yet — start one with `/challenge`!");
    return;
  }

  const medals = ["🥇", "🥈", "🥉"];
  const rows = entries.map((e, i) => {
    const medal = medals[i] ?? `**${i + 1}.**`;
    const accuracy = e.totalAnswers > 0 ? Math.round((e.totalCorrect / e.totalAnswers) * 100) : 0;
    const best = e.bestAvgTimeMs !== null ? `${(e.bestAvgTimeMs / 1000).toFixed(2)}s` : "—";
    return `${medal} **${e.username}** — 🏆 ${e.challengeWins} wins · ✅ ${accuracy}% accuracy · ⚡ Best avg: ${best} · 🎮 ${e.totalParticipated} played`;
  });

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🏆 Challenge Mode — All-Time Hall of Fame")
    .setDescription(rows.join("\n"))
    .setTimestamp()
    .setFooter({ text: "Ranked by challenge wins · Ties broken by total correct answers" });

  await interaction.editReply({ embeds: [embed] });
}

async function handleChallengeStatsCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply();

  const target = interaction.options.getUser("player") ?? interaction.user;
  const stats = await getChallengePlayerStats(target.id);

  if (!stats) {
    const isSelf = target.id === interaction.user.id;
    await interaction.editReply(
      isSelf
        ? "📊 You haven't completed any challenges yet — start one with `/challenge`!"
        : `📊 **${target.displayName ?? target.username}** hasn't completed any challenges yet.`,
    );
    return;
  }

  const accuracy = stats.totalAnswers > 0
    ? Math.round((stats.totalCorrect / stats.totalAnswers) * 100)
    : 0;
  const best = stats.bestAvgTimeMs !== null
    ? `${(stats.bestAvgTimeMs / 1000).toFixed(2)}s`
    : "—";
  const winRate = stats.totalParticipated > 0
    ? Math.round((stats.challengeWins / stats.totalParticipated) * 100)
    : 0;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(`📊 Challenge Stats for ${stats.username}`)
    .setThumbnail(target.displayAvatarURL())
    .addFields(
      { name: "🏆 Challenge Wins", value: `${stats.challengeWins}`, inline: true },
      { name: "🎮 Challenges Played", value: `${stats.totalParticipated}`, inline: true },
      { name: "📈 Win Rate", value: `${winRate}%`, inline: true },
      { name: "✅ Correct Answers", value: `${stats.totalCorrect} / ${stats.totalAnswers}`, inline: true },
      { name: "🎯 Accuracy", value: `${accuracy}%`, inline: true },
      { name: "⚡ Best Avg Answer Time", value: best, inline: true },
    )
    .setTimestamp()
    .setFooter({ text: "Play more challenges with /challenge!" });

  await interaction.editReply({ embeds: [embed] });
}

async function handleEndChallengeCommand(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!hasResetPermission(interaction)) {
    await interaction.reply({
      content: "🚫 You need a mod role to end a challenge. Required: **Moderator**, **Senior Mod**, **Local Host**, **Host**, **Co-Host**, or **Staff**.",
      ephemeral: true,
    });
    return;
  }

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "❌ This command only works in a server.", ephemeral: true });
    return;
  }

  const channel = interaction.channel;
  if (!channel || !("send" in channel)) {
    await interaction.reply({ content: "❌ Must be used in a text channel.", ephemeral: true });
    return;
  }

  const username = (interaction.member as GuildMember)?.displayName ?? interaction.user.displayName ?? interaction.user.username;
  const stopped = await forceEndChallenge(guildId, channel as import("discord.js").TextChannel, username);

  if (stopped) {
    await interaction.reply({ content: "⏹️ Challenge ended.", ephemeral: true });
  } else {
    await interaction.reply({ content: "⚠️ No active challenge to end.", ephemeral: true });
  }
}
