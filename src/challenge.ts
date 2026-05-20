import {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  GuildMember,
  type Message,
  type TextChannel,
  type VoiceChannel,
  type ButtonInteraction,
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
import { SONGS, getWrongChoices, type SongEntry } from "./songs.js";
import { getAllSongsAsEntries } from "./song-library.js";
import { recordChallengeResults, type ChallengeResult } from "./challenge-leaderboard.js";

const ROUND_DURATION_MS = 10_000;
const ROUND_GAP_MS = 3_000;
const TOTAL_ROUNDS = 20;
const MIN_ROUNDS = 5;
const CHOICES = ["A", "B", "C"] as const;
const VOICE_CONNECT_TIMEOUT_MS = 15_000;

interface RoundData {
  song: SongEntry;
  previewUrl: string;
  choices: SongEntry[];
  correctIndex: number;
}

interface PlayerScore {
  username: string;
  correct: number;
  totalAnswers: number;
  correctTimesMs: number[];
}

interface RoundResponse {
  choiceIndex: number;
  timeMs: number;
  username: string;
}

interface ChallengeSession {
  guildId: string;
  rounds: RoundData[];
  currentRound: number;
  scores: Map<string, PlayerScore>;
  roundResponses: Map<string, RoundResponse>;
  roundStartTime: number;
  roundTimer: ReturnType<typeof setTimeout> | null;
  currentMessage: Message | null;
  voiceChannel: VoiceChannel | null;
  cancelled: boolean;
}

export const activeChallenges = new Map<string, ChallengeSession>();

async function isAudioUrlValid(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.ok;
  } catch {
    return false;
  }
}

async function getDeezerPreviewUrl(song: SongEntry): Promise<string | null> {
  try {
    const query = encodeURIComponent(`${song.title} ${song.artist}`);
    const res = await fetch(`https://api.deezer.com/search?q=${query}&limit=5`);
    const data = (await res.json()) as { data?: { preview?: string }[] };
    if (!data.data || data.data.length === 0) return null;
    for (const track of data.data) {
      if (track.preview) return track.preview;
    }
    return null;
  } catch {
    return null;
  }
}

async function buildRounds(pool: SongEntry[]): Promise<{ rounds: RoundData[]; expiredSongs: SongEntry[] }> {
  const shuffled = [...pool].sort(() => Math.random() - 0.5);
  const rounds: RoundData[] = [];
  const usedTitles = new Set<string>();
  const expiredSongs: SongEntry[] = [];
  const expiredTitles = new Set<string>();

  for (const song of shuffled) {
    if (rounds.length >= TOTAL_ROUNDS) break;
    if (usedTitles.has(song.title)) continue;

    let previewUrl: string | null = null;
    if (song.audioUrl) {
      const valid = await isAudioUrlValid(song.audioUrl);
      if (valid) {
        previewUrl = song.audioUrl;
      } else {
        // URL is expired — track it and try Deezer as fallback
        console.warn(`[challenge] Audio URL expired for "${song.title}" — falling back to Deezer`);
        if (!expiredTitles.has(song.title)) {
          expiredSongs.push(song);
          expiredTitles.add(song.title);
        }
        previewUrl = await getDeezerPreviewUrl(song);
      }
    } else {
      previewUrl = await getDeezerPreviewUrl(song);
    }

    if (!previewUrl) continue;

    const wrongPool = pool.length >= 3 ? pool : SONGS;
    const wrongChoices = getWrongChoices(song, 2, wrongPool);
    const choices = [song, ...wrongChoices].sort(() => Math.random() - 0.5);
    const correctIndex = choices.findIndex((s) => s.title === song.title);

    rounds.push({ song, previewUrl, choices, correctIndex });
    usedTitles.add(song.title);
  }

  return { rounds, expiredSongs };
}

function destroyVoiceConnection(guildId: string): void {
  try {
    getVoiceConnection(guildId)?.destroy();
  } catch { /* already gone */ }
}

async function tryVoicePlayback(
  song: SongEntry,
  voiceChannel: VoiceChannel,
  previewUrl: string,
): Promise<void> {
  const guildId = voiceChannel.guild.id;
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

    await entersState(connection, VoiceConnectionStatus.Ready, VOICE_CONNECT_TIMEOUT_MS);

    const response = await fetch(previewUrl);
    if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
    const mp3Stream = Readable.fromWeb(
      response.body as Parameters<typeof Readable.fromWeb>[0],
    );

    const ffmpeg = spawn(ffmpegPath!, [
      "-f", "mp3", "-i", "pipe:0",
      "-f", "s16le", "-ar", "48000", "-ac", "2", "pipe:1",
    ]);

    // Single cleanup path — kills ffmpeg and destroys the stream exactly once
    let cleaned = false;
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      mp3Stream.unpipe(ffmpeg.stdin);
      mp3Stream.destroy();
      if (!ffmpeg.killed) ffmpeg.kill("SIGTERM");
      destroyVoiceConnection(guildId);
    }

    ffmpeg.on("error", (err: Error) =>
      console.error("[challenge/ffmpeg] Spawn error:", err.message),
    );
    ffmpeg.on("close", (code) => {
      if (code !== 0 && code !== null) console.warn(`[challenge/ffmpeg] Exited with code ${code}`);
    });
    ffmpeg.stderr.on("data", () => {});
    ffmpeg.stdin.on("error", () => {});
    mp3Stream.pipe(ffmpeg.stdin);

    const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.Raw });
    const player = createAudioPlayer();
    player.on("error", (err) => {
      console.error("[challenge/voice] Player error:", err.message);
      cleanup();
    });
    player.on(AudioPlayerStatus.Idle, () => cleanup());

    connection.subscribe(player);
    player.play(resource);
    console.log(`[challenge/voice] Playing: ${song.title}`);
  } catch (err) {
    console.error("[challenge/voice] Playback failed:", (err as Error).message);
    if (connection) destroyVoiceConnection(guildId);
  }
}

function buildRoundEmbed(session: ChallengeSession): EmbedBuilder {
  const round = session.rounds[session.currentRound - 1];
  const { choices, song } = round;
  const remaining = session.rounds.length - session.currentRound;
  const voiceAttempted = session.voiceChannel !== null;

  const listenLine = voiceAttempted
    ? `🔊 **Playing in your voice channel** *(or use the link)*: [▶ Listen](${song.youtubeUrl})`
    : `▶️ **Open and listen**: [▶ Listen](${song.youtubeUrl})`;

  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(
      `🏆 Challenge — Round ${session.currentRound} / ${session.rounds.length}`,
    )
    .setDescription(
      `${listenLine}\n\n` +
        `You have **${ROUND_DURATION_MS / 1000} seconds** to guess!\n\n` +
        choices
          .map((c, i) => `**${CHOICES[i]}.** ${c.title} — *${c.artist}*`)
          .join("\n"),
    )
    .setFooter({
      text:
        remaining > 0
          ? `${remaining} round${remaining === 1 ? "" : "s"} remaining after this`
          : "Final round!",
    })
    .setTimestamp();
}

function buildButtonRow(
  roundIndex: number,
  choices: SongEntry[],
  disabled = false,
  correctIndex = -1,
): ActionRowBuilder<ButtonBuilder> {
  const row = new ActionRowBuilder<ButtonBuilder>();
  choices.forEach((_, i) => {
    const btn = new ButtonBuilder()
      .setCustomId(
        disabled
          ? `challenge_done_${roundIndex}_${i}`
          : `challenge_answer_${roundIndex}_${i}`,
      )
      .setLabel(CHOICES[i])
      .setDisabled(disabled);

    if (disabled) {
      btn.setStyle(
        i === correctIndex ? ButtonStyle.Success : ButtonStyle.Secondary,
      );
    } else {
      btn.setStyle(ButtonStyle.Primary);
    }

    row.addComponents(btn);
  });
  return row;
}

function computeRankings(session: ChallengeSession) {
  return [...session.scores.entries()]
    .map(([userId, s]) => {
      const avgTimeMs =
        s.correctTimesMs.length > 0
          ? s.correctTimesMs.reduce((a, b) => a + b, 0) / s.correctTimesMs.length
          : null;
      return {
        userId,
        username: s.username,
        correct: s.correct,
        totalAnswers: s.totalAnswers,
        avgTimeMs,
      };
    })
    .sort((a, b) => {
      if (b.correct !== a.correct) return b.correct - a.correct;
      if (a.avgTimeMs === null && b.avgTimeMs === null) return 0;
      if (a.avgTimeMs === null) return 1;
      if (b.avgTimeMs === null) return -1;
      return a.avgTimeMs - b.avgTimeMs;
    });
}

async function startRound(
  session: ChallengeSession,
  channel: TextChannel,
): Promise<void> {
  if (session.cancelled) return;

  const roundIndex = session.currentRound - 1;
  const round = session.rounds[roundIndex];
  session.roundResponses = new Map();
  session.roundStartTime = Date.now();

  const embed = buildRoundEmbed(session);
  const row = buildButtonRow(roundIndex, round.choices);
  const msg = await channel.send({ embeds: [embed], components: [row] });
  session.currentMessage = msg;

  if (session.voiceChannel) {
    tryVoicePlayback(round.song, session.voiceChannel, round.previewUrl).catch(
      () => {},
    );
  }

  session.roundTimer = setTimeout(() => {
    endCurrentRound(session, channel).catch((err) =>
      console.error("[challenge] endCurrentRound error:", err),
    );
  }, ROUND_DURATION_MS);
}

async function endCurrentRound(
  session: ChallengeSession,
  channel: TextChannel,
): Promise<void> {
  if (session.cancelled) return;

  if (session.roundTimer) {
    clearTimeout(session.roundTimer);
    session.roundTimer = null;
  }

  destroyVoiceConnection(session.guildId);

  const roundIndex = session.currentRound - 1;
  const round = session.rounds[roundIndex];
  const { correctIndex, choices, song } = round;

  for (const [userId, response] of session.roundResponses.entries()) {
    const isCorrect = response.choiceIndex === correctIndex;
    if (!session.scores.has(userId)) {
      session.scores.set(userId, {
        username: response.username,
        correct: 0,
        totalAnswers: 0,
        correctTimesMs: [],
      });
    }
    const score = session.scores.get(userId)!;
    score.totalAnswers += 1;
    if (isCorrect) {
      score.correct += 1;
      score.correctTimesMs.push(response.timeMs);
    }
  }

  const correctResponders = [...session.roundResponses.entries()]
    .filter(([, r]) => r.choiceIndex === correctIndex)
    .sort((a, b) => a[1].timeMs - b[1].timeMs);

  const disabledRow = buildButtonRow(roundIndex, choices, true, correctIndex);

  const isLastRound = session.currentRound >= session.rounds.length;
  const standingsTop5 = computeRankings(session).slice(0, 5);
  const standingsText =
    standingsTop5.length > 0
      ? "\n\n**Standings so far:**\n" +
        standingsTop5
          .map(
            (r, i) =>
              `${["🥇", "🥈", "🥉"][i] ?? `**${i + 1}.**`} ${r.username} — ${r.correct} pts`,
          )
          .join("\n")
      : "";

  const roundResultEmbed = new EmbedBuilder()
    .setColor(correctResponders.length > 0 ? 0x57f287 : 0xed4245)
    .setTitle(
      `Round ${session.currentRound}/${session.rounds.length} — ${CHOICES[correctIndex]}: ${song.title}`,
    )
    .setDescription(
      `🎵 **${song.title}** by *${song.artist}*\n\n` +
        (correctResponders.length > 0
          ? correctResponders
              .slice(0, 5)
              .map(
                ([, r], i) =>
                  `${["🥇", "🥈", "🥉"][i] ?? `**${i + 1}.**`} ${r.username} — ${(r.timeMs / 1000).toFixed(2)}s`,
              )
              .join("\n")
          : "😔 Nobody got it!") +
        standingsText +
        (!isLastRound
          ? `\n\n*Next round in ${ROUND_GAP_MS / 1000}s...*`
          : ""),
    )
    .setTimestamp();

  try {
    await session.currentMessage?.edit({
      embeds: [roundResultEmbed],
      components: [disabledRow],
    });
  } catch { /* message may have been deleted */ }

  if (isLastRound) {
    await finishChallenge(session, channel);
    return;
  }

  await new Promise<void>((resolve) => setTimeout(resolve, ROUND_GAP_MS));
  if (!session.cancelled) {
    session.currentRound += 1;
    await startRound(session, channel);
  }
}

async function finishChallenge(
  session: ChallengeSession,
  channel: TextChannel,
): Promise<void> {
  activeChallenges.delete(session.guildId);

  if (session.scores.size === 0) {
    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0xed4245)
          .setTitle("🏆 Challenge Complete — No Scores!")
          .setDescription(
            "Nobody answered any questions. Better luck next time!",
          ),
      ],
    });
    return;
  }

  const rankings = computeRankings(session);
  const medals = ["🥇", "🥈", "🥉"];

  const rows = rankings.map((r, i) => {
    const medal = medals[i] ?? `**${i + 1}.**`;
    const accuracy = Math.round((r.correct / session.rounds.length) * 100);
    const avg =
      r.avgTimeMs !== null ? `${(r.avgTimeMs / 1000).toFixed(2)}s avg` : "—";
    return `${medal} <@${r.userId}> — ✅ ${r.correct}/${session.rounds.length} · 🎯 ${accuracy}% · ⚡ ${avg}`;
  });

  const embed = new EmbedBuilder()
    .setColor(0xfee75c)
    .setTitle("🏆 Challenge Complete — Final Standings!")
    .setDescription(rows.join("\n"))
    .setTimestamp()
    .setFooter({
      text: `${session.rounds.length} rounds completed · Play again with /challenge!`,
    });

  await channel.send({ embeds: [embed] });

  try {
    const results: ChallengeResult[] = rankings.map((r, i) => ({
      discordUserId: r.userId,
      username: r.username,
      correct: r.correct,
      totalAnswers: r.totalAnswers,
      avgTimeMs: r.avgTimeMs !== null ? Math.round(r.avgTimeMs) : null,
      rank: i + 1,
    }));
    await recordChallengeResults(results);
  } catch (err) {
    console.error("[challenge] Failed to save results:", err);
  }
}

export async function startChallenge(
  guildId: string,
  channel: TextChannel,
  voiceChannel: VoiceChannel | null,
): Promise<{ started: boolean; message: string; expiredSongs: SongEntry[] }> {
  if (activeChallenges.has(guildId)) {
    return {
      started: false,
      message:
        "⚠️ A challenge is already running in this server! Wait for it to finish or have a mod use `/endchallenge`.",
      expiredSongs: [],
    };
  }

  const customSongs = await getAllSongsAsEntries();
  const pool = customSongs.length >= 3 ? customSongs : SONGS;

  const progressMsg = await channel.send(
    "🎵 **Building your challenge...** Fetching song previews, please wait!",
  );

  const { rounds, expiredSongs } = await buildRounds(pool);
  await progressMsg.delete().catch(() => {});

  if (rounds.length < MIN_ROUNDS) {
    return {
      started: false,
      message: `❌ Couldn't find enough songs with audio previews (found ${rounds.length}, need at least ${MIN_ROUNDS}). Please try again!`,
      expiredSongs,
    };
  }

  const session: ChallengeSession = {
    guildId,
    rounds,
    currentRound: 1,
    scores: new Map(),
    roundResponses: new Map(),
    roundStartTime: 0,
    roundTimer: null,
    currentMessage: null,
    voiceChannel,
    cancelled: false,
  };

  activeChallenges.set(guildId, session);

  const announceEmbed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("🏆 Music Trivia Challenge Starting!")
    .setDescription(
      `**${rounds.length} rounds**, no repeats, **${ROUND_DURATION_MS / 1000} seconds** per song.\n` +
        `Score points for correct answers — fastest average answer time breaks ties!\n\n` +
        `🎵 Round 1 begins in 3 seconds...`,
    )
    .setTimestamp();

  await channel.send({ embeds: [announceEmbed] });

  setTimeout(() => {
    startRound(session, channel).catch((err) => {
      console.error("[challenge] Failed to start round 1:", err);
      activeChallenges.delete(guildId);
    });
  }, 3_000);

  return { started: true, message: "", expiredSongs };
}

export async function forceEndChallenge(
  guildId: string,
  channel: TextChannel,
  cancelledBy: string,
): Promise<boolean> {
  const session = activeChallenges.get(guildId);
  if (!session) return false;

  session.cancelled = true;
  activeChallenges.delete(guildId);

  if (session.roundTimer) {
    clearTimeout(session.roundTimer);
    session.roundTimer = null;
  }
  destroyVoiceConnection(guildId);

  if (session.currentMessage) {
    const round = session.rounds[session.currentRound - 1];
    const disabledRow = buildButtonRow(
      session.currentRound - 1,
      round.choices,
      true,
      round.correctIndex,
    );
    try {
      await session.currentMessage.edit({ components: [disabledRow] });
    } catch { /* ok */ }
  }

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle("⏹️ Challenge Ended Early")
        .setDescription(
          `The challenge was stopped by **${cancelledBy}** on round ${session.currentRound} of ${session.rounds.length}.`,
        )
        .setTimestamp(),
    ],
  });

  return true;
}

export function handleChallengeButton(interaction: ButtonInteraction): boolean {
  if (!interaction.customId.startsWith("challenge_answer_")) return false;

  const match = interaction.customId.match(/^challenge_answer_(\d+)_(\d+)$/);
  if (!match) {
    interaction
      .reply({ content: "⏰ This round has already ended.", ephemeral: true })
      .catch(() => {});
    return true;
  }

  const guildId = interaction.guildId;
  if (!guildId) return true;

  const session = activeChallenges.get(guildId);
  if (!session) {
    interaction
      .reply({ content: "⏰ No active challenge right now.", ephemeral: true })
      .catch(() => {});
    return true;
  }

  const roundIndex = parseInt(match[1], 10);
  const choiceIndex = parseInt(match[2], 10);

  if (roundIndex !== session.currentRound - 1) {
    interaction
      .reply({ content: "⏰ That round has already ended.", ephemeral: true })
      .catch(() => {});
    return true;
  }

  const userId = interaction.user.id;
  if (session.roundResponses.has(userId)) {
    interaction
      .reply({ content: "✅ You already answered this round!", ephemeral: true })
      .catch(() => {});
    return true;
  }

  const timeMs = Date.now() - session.roundStartTime;
  const round = session.rounds[session.currentRound - 1];
  const isCorrect = choiceIndex === round.correctIndex;
  const username =
    (interaction.member as GuildMember)?.displayName ??
    interaction.user.displayName ??
    interaction.user.username;

  if (!session.scores.has(userId)) {
    session.scores.set(userId, {
      username,
      correct: 0,
      totalAnswers: 0,
      correctTimesMs: [],
    });
  }

  session.roundResponses.set(userId, { choiceIndex, timeMs, username });

  const content = isCorrect
    ? `✅ **Correct!** You answered in **${(timeMs / 1000).toFixed(2)}s**`
    : `❌ **Wrong!** You chose **${CHOICES[choiceIndex]}**`;

  interaction.reply({ content, ephemeral: true }).catch(() => {});
  return true;
}
