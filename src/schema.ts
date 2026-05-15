import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";

export const leaderboardTable = pgTable("leaderboard", {
  id: serial("id").primaryKey(),
  discordUserId: text("discord_user_id").notNull(),
  username: text("username").notNull(),
  wins: integer("wins").notNull().default(0),
  totalAnswers: integer("total_answers").notNull().default(0),
  correctAnswers: integer("correct_answers").notNull().default(0),
  bestTimeMs: integer("best_time_ms"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type LeaderboardEntry = typeof leaderboardTable.$inferSelect;
