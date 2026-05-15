import path from "path";
import ffmpegPath from "ffmpeg-static";
import playdl from "play-dl";
import { migrateDb } from "./db.js";
import { createBot } from "./bot.js";

// Ensure @discordjs/voice can find ffmpeg.
// ffmpeg-static ships a pre-built binary — prepend its directory to PATH so
// the voice module finds it even if the system PATH isn't configured yet.
if (ffmpegPath) {
  const dir = path.dirname(ffmpegPath);
  process.env.PATH = `${dir}:${process.env.PATH ?? ""}`;
  console.log(`[startup] ffmpeg found at: ${ffmpegPath}`);
} else {
  console.warn("[startup] ffmpeg-static returned null — relying on system ffmpeg");
}

// Pass a YouTube cookie to play-dl if one is set.
// Railway's IP ranges are sometimes flagged by YouTube and return 403 errors.
// Fix: log into YouTube in your browser, export the cookie string, and set
// YOUTUBE_COOKIE in your Railway environment variables.
// How to get it: browser DevTools → Application → Cookies → youtube.com
// → copy the full "Cookie" header value (one long string of key=value pairs).
const youtubeCookie = process.env.YOUTUBE_COOKIE;
if (youtubeCookie) {
  await playdl.setToken({ youtube: { cookie: youtubeCookie } });
  console.log("[startup] YouTube cookie loaded — authenticated requests enabled");
} else {
  console.warn(
    "[startup] YOUTUBE_COOKIE not set — unauthenticated. " +
    "If you get 403 errors, add this variable in Railway."
  );
}

console.log("[startup] Music Trivia Bot starting…");

migrateDb()
  .then(() => {
    createBot();
    console.log("[startup] Bot is running");
  })
  .catch((err) => {
    console.error("[startup] Failed to migrate database:", err);
    process.exit(1);
  });
