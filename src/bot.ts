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
} from "discord.js";
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  AudioPlayerStatus,
} from "@discordjs/voice";
import playdl from "play-dl";
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
  interaction: ChatInputCommandInteraction;
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

async function tryVoicePlayback(song: SongEntry, voiceChannel: VoiceChannel): Promise<void> {
  const guildId = voiceChannel.guild.id;
  let connection;

  try {
    connection = joinVoiceChannel({
      channelId: voiceChannel.id,
      guildId,
      adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      selfDeaf: false,
    });

    console.log(`[voice] Connecting to ${voiceChannel.name}…`);
    await entersState(connection, VoiceConnectionStatus.Ready, VOICE_CONNECT_TIMEOUT_MS);
    console.log("[voice] Connection ready — streaming audio");
  } catch (err) {
    console.warn("[voice] Could not reach Ready state:", (err as Error).message);
    connection?.destroy();
    return;
  }

  try {
    const playStream = await playdl.stream(song.youtubeUrl, { quality: 1 });
    const resource = createAudioResource(playStream.stream, { inputType: playStream.type });
    const player = createAudioPlayer();

    player.on("error", (err) => console.warn("[voice] Player error:", err.message));
    player.on(AudioPlayerStatus.Idle, () => {
      getVoiceConnection(guildId)?.destroy();
    });

    connection.subscribe(player);
    player.play(resource);
    console.log(`[voice] Now playing: ${song.title}`);
  } catch (err) {
    console.warn("[voice] Stream error:", (err as Error).message);
    connection.destroy();
  }
}

function buildQuizEmbed(choices: SongEntry[], songUrl: string, voiceAttempted: boolean): EmbedBuilder {
  const listenLine = voiceAttempted
    ? `🔊 **Playing in your voice channel** *(or use the link)*: [▶ YouTube](${songUrl})`
    : `▶️ **Open and listen**: [▶ YouTube](${songUrl})`;

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

  await interaction.deferReply();

  const correctSong = getRandomSong();
  const wrongChoices = getWrongChoices(correctSong, 2);
  const allChoices = [correctSong, ...wrongChoices].sort(() => Math.random() - 0.5);
  const correctIndex = allChoices.findIndex((s) => s.title === correctSong.title);

  const member = interaction.member as GuildMember;
  const voiceChannel = member?.voice?.channel as VoiceChannel | null;

  const voiceAttempted = voiceChannel !== null;
  if (voiceChannel) {
    tryVoicePlayback(correctSong, voiceChannel).catch((err) => {
      console.error("[voice] Unexpected error:", err);
    });
  }

  const embed = buildQuizEmbed(allChoices, correctSong.youtubeUrl, voiceAttempted);
  const row = buildButtonRow(allChoices);
  await interaction.editReply({ embeds: [embed], components: [row] });

  const round: ActiveRound = {
    correctSong,
    choices: allChoices,
    correctIndex,
    startTime: Date.now(),
    guildId,
    responses: new Map(),
    interaction,
    timer: setTimeout(() => endRound(guildId), QUIZ_DURATION_MS),
  };

  activeRounds.set(guildId, round);
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
  await interaction.reply({
    content: isCorrect
      ? `✅ **Correct!** You answered in **${(timeMs / 1000).toFixed(2)}s**`
      : `❌ **Wrong!** You chose **${CHOICES[choiceIndex]}**`,
    ephemeral: true,
  });
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
    await round.interaction.editReply({ embeds: [embed], components: [disabledRow] });
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
