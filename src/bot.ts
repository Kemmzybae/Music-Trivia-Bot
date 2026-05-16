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
import { getRandomSong, getWrongChoices, type SongEntry } from "./songs.js";
import { recordAnswer, recordWin, getTopLeaderboard } from "./leaderboard.js";
import { registerCommands } from "./register-commands.js";

const QUIZ_DURATION_MS = 10_000;
const VOICE_CONNECT_TIMEOUT_MS = 30_000;
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
    const res = await fetch("https://api.deezer.com/search?q=" + query + "&limit=1");
    const data = await res.json() as any;
    if (!data.data || data.data.length === 0) return null;
    const preview = data.data[0].preview;
    if (!preview) return null;
    return preview;
  } catch {
    return null;
  }
}

async function pickSongWithPreview(maxAttempts = 5): Promise<{ song: SongEntry; previewUrl: string } | null> {
  for (let i = 0; i < maxAttempts; i++) {
    const song = getRandomSong();
    const previewUrl = await getDeezerPreviewUrl(song);
    if (previewUrl) {
      return { song, previewUrl };
    }
    console.warn(`[quiz] No preview for "${song.title}" — trying another song (attempt ${i + 1}/${maxAttempts})`);
  }
  return null;
}

async function tryVoicePlayback(song: SongEntry, voiceChannel: VoiceChannel, previewUrl: string): Promise<void> {
  const guildId = voiceChannel.guild.id;
  let connection: VoiceConnection;

  // Clean up any lingering connection before joining fresh
  const existing = getVoiceConnection(guildId);
  if (existing) {
    console.log("[voice] Destroying stale connection before rejoining");
    try { existing.destroy(); } catch { /* already gone */ }
    await new Promise(r => setTimeout(r, 500));
  }

  try {
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: true,
    });

    connection.on("stateChange", (oldState, newState) => {
      console.log(`[voice] ${oldState.status} → ${newState.status}`);
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        // If it moves back to Signalling or Connecting within 5s it's rejoining — wait for it
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        // Didn't recover — clean up
        try { connection.destroy(); } catch { /* already gone */ }
      }
    });

    await entersState(connection, VoiceConnectionStatus.Ready, VOICE_CONNECT_TIMEOUT_MS);
    console.log("[voice] Connection ready — fetching audio stream");

    const streamUrl = previewUrl;
    console.log("[voice] Got stream URL, piping through ffmpeg");

    const response = await fetch(streamUrl);
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

    const resource = createAudioResource(ffmpeg.stdout, {
      inputType: StreamType.Raw,
    });

    const player = createAudioPlayer();
    player.on("error", (err) => console.error("[voice] Player error:", err.message));
    player.on(AudioPlayerStatus.Idle, () => {
      getVoiceConnection(guildId)?.destroy();
    });

    connection.subscribe(player);
    player.play(resource);
    console.log(`[voice] Now playing: ${song.title}`);
  } catch (err) {
    console.error("[voice] Stream error:", (err as Error).message);
    try { connection!.destroy(); } catch { /* already destroyed */ }
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
  if (Date.now() - interaction.createdTimestamp > 2500) return;

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: "❌ This command only works in a server.", ephemeral: true });
    return;
  }

  if (activeRounds.has(guildId)) {
    await interaction.reply({ content: "⚠️ A quiz round is already in progress!", ephemeral: true });
    return;
  }

  const picked = await pickSongWithPreview(5);
  if (!picked) {
    await interaction.reply({ content: "❌ Couldn't find a song with an audio preview right now — please try again!", ephemeral: true });
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

  let message: Message;
  try {
    message = await interaction.reply({ embeds: [embed], components: [row], fetchReply: true });
  } catch {
    if (!interaction.channel?.isTextBased()) {
      console.error("[quiz] Interaction expired and no text channel available");
      return;
    }
    console.warn("[quiz] Interaction expired — falling back to channel.send()");
    message = await interaction.channel.send({ embeds: [embed], components: [row] });
  }

  const round: ActiveRound = {
    correctSong,
    choices: allChoices,
    correctIndex,
    startTime: Date.now(),
    guildId,
    responses: new Map(),
    message,
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
