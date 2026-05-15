import { db } from "./db.js";
import { leaderboardTable } from "./schema.js";
import { eq, desc } from "drizzle-orm";

export async function recordAnswer(
  discordUserId: string,
  username: string,
  correct: boolean,
  timeMs: number | null,
): Promise<void> {
  const existing = await db
    .select()
    .from(leaderboardTable)
    .where(eq(leaderboardTable.discordUserId, discordUserId))
    .limit(1);

  if (existing.length === 0) {
    await db.insert(leaderboardTable).values({
      discordUserId,
      username,
      wins: 0,
      totalAnswers: 1,
      correctAnswers: correct ? 1 : 0,
      bestTimeMs: correct && timeMs !== null ? timeMs : null,
    });
  } else {
    const row = existing[0];
    const newBest =
      correct && timeMs !== null
        ? row.bestTimeMs === null
          ? timeMs
          : Math.min(row.bestTimeMs, timeMs)
        : row.bestTimeMs;

    await db
      .update(leaderboardTable)
      .set({
        username,
        totalAnswers: row.totalAnswers + 1,
        correctAnswers: row.correctAnswers + (correct ? 1 : 0),
        bestTimeMs: newBest,
        updatedAt: new Date(),
      })
      .where(eq(leaderboardTable.discordUserId, discordUserId));
  }
}

export async function recordWin(discordUserId: string): Promise<void> {
  const existing = await db
    .select()
    .from(leaderboardTable)
    .where(eq(leaderboardTable.discordUserId, discordUserId))
    .limit(1);

  if (existing.length > 0) {
    const row = existing[0];
    await db
      .update(leaderboardTable)
      .set({ wins: row.wins + 1, updatedAt: new Date() })
      .where(eq(leaderboardTable.discordUserId, discordUserId));
  }
}

export async function getTopLeaderboard(limit = 10) {
  return db
    .select()
    .from(leaderboardTable)
    .orderBy(desc(leaderboardTable.wins), desc(leaderboardTable.correctAnswers))
    .limit(limit);
}
