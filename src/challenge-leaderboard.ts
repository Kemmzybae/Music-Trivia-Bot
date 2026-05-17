import { db } from "./db.js";
import { challengeLeaderboardTable } from "./schema.js";
import { eq, desc } from "drizzle-orm";

export interface ChallengeResult {
  discordUserId: string;
  username: string;
  correct: number;
  totalAnswers: number;
  avgTimeMs: number | null;
  rank: number;
}

export async function getTopChallengeLeaderboard(limit = 10) {
  return db
    .select()
    .from(challengeLeaderboardTable)
    .orderBy(
      desc(challengeLeaderboardTable.challengeWins),
      desc(challengeLeaderboardTable.totalCorrect),
    )
    .limit(limit);
}

export async function getChallengePlayerStats(discordUserId: string) {
  const rows = await db
    .select()
    .from(challengeLeaderboardTable)
    .where(eq(challengeLeaderboardTable.discordUserId, discordUserId))
    .limit(1);
  return rows.length > 0 ? rows[0] : null;
}

export async function recordChallengeResults(results: ChallengeResult[]): Promise<void> {
  for (const r of results) {
    const existing = await db
      .select()
      .from(challengeLeaderboardTable)
      .where(eq(challengeLeaderboardTable.discordUserId, r.discordUserId))
      .limit(1);

    const isWin = r.rank === 1;

    if (existing.length === 0) {
      const newBest = r.avgTimeMs !== null ? r.avgTimeMs : null;
      await db.insert(challengeLeaderboardTable).values({
        discordUserId: r.discordUserId,
        username: r.username,
        challengeWins: isWin ? 1 : 0,
        totalParticipated: 1,
        totalCorrect: r.correct,
        totalAnswers: r.totalAnswers,
        bestAvgTimeMs: newBest,
      });
    } else {
      const row = existing[0];
      const newBest =
        r.avgTimeMs !== null
          ? row.bestAvgTimeMs === null
            ? r.avgTimeMs
            : Math.min(row.bestAvgTimeMs, r.avgTimeMs)
          : row.bestAvgTimeMs;
      await db
        .update(challengeLeaderboardTable)
        .set({
          username: r.username,
          challengeWins: row.challengeWins + (isWin ? 1 : 0),
          totalParticipated: row.totalParticipated + 1,
          totalCorrect: row.totalCorrect + r.correct,
          totalAnswers: row.totalAnswers + r.totalAnswers,
          bestAvgTimeMs: newBest,
          updatedAt: new Date(),
        })
        .where(eq(challengeLeaderboardTable.discordUserId, r.discordUserId));
    }
  }
}
