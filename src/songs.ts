export interface SongEntry {
  title: string;
  artist: string;
  youtubeUrl: string;
}

export const SONGS: SongEntry[] = [
  { title: "Bohemian Rhapsody", artist: "Queen", youtubeUrl: "https://www.youtube.com/watch?v=fJ9rUzIMcZQ" },
  { title: "Blinding Lights", artist: "The Weeknd", youtubeUrl: "https://www.youtube.com/watch?v=4NRXx6U8ABQ" },
  { title: "Shape of You", artist: "Ed Sheeran", youtubeUrl: "https://www.youtube.com/watch?v=JGwWNGJdvx8" },
  { title: "Uptown Funk", artist: "Mark Ronson ft. Bruno Mars", youtubeUrl: "https://www.youtube.com/watch?v=OPf0YbXqDm0" },
  { title: "Rolling in the Deep", artist: "Adele", youtubeUrl: "https://www.youtube.com/watch?v=rYEDA3JcQqw" },
  { title: "Stay With Me", artist: "Sam Smith", youtubeUrl: "https://www.youtube.com/watch?v=pB-5XG-DbAA" },
  { title: "Bad Guy", artist: "Billie Eilish", youtubeUrl: "https://www.youtube.com/watch?v=DyDfgMOUjCI" },
  { title: "Old Town Road", artist: "Lil Nas X", youtubeUrl: "https://www.youtube.com/watch?v=w2Ov5jzm3j8" },
  { title: "Levitating", artist: "Dua Lipa", youtubeUrl: "https://www.youtube.com/watch?v=TUVcZfQe-Kw" },
  { title: "Watermelon Sugar", artist: "Harry Styles", youtubeUrl: "https://www.youtube.com/watch?v=E07s5ZYygMg" },
  { title: "Peaches", artist: "Justin Bieber", youtubeUrl: "https://www.youtube.com/watch?v=tQ0yjYUFKAE" },
  { title: "drivers license", artist: "Olivia Rodrigo", youtubeUrl: "https://www.youtube.com/watch?v=ZmDBbnmKpqQ" },
  { title: "Good 4 U", artist: "Olivia Rodrigo", youtubeUrl: "https://www.youtube.com/watch?v=gNi_6U5Pm_o" },
  { title: "Stay", artist: "The Kid LAROI & Justin Bieber", youtubeUrl: "https://www.youtube.com/watch?v=kTJczUoc26U" },
  { title: "As It Was", artist: "Harry Styles", youtubeUrl: "https://www.youtube.com/watch?v=H5v3kku4y6Q" },
  { title: "Anti-Hero", artist: "Taylor Swift", youtubeUrl: "https://www.youtube.com/watch?v=b1kbLwvqugk" },
  { title: "Flowers", artist: "Miley Cyrus", youtubeUrl: "https://www.youtube.com/watch?v=G7KNmW9a75Y" },
  { title: "Cruel Summer", artist: "Taylor Swift", youtubeUrl: "https://www.youtube.com/watch?v=ic8j13piAhQ" },
  { title: "Happier Than Ever", artist: "Billie Eilish", youtubeUrl: "https://www.youtube.com/watch?v=5GJWxDKyk3A" },
  { title: "Montero", artist: "Lil Nas X", youtubeUrl: "https://www.youtube.com/watch?v=6swmTBVI83k" },
];

export function getRandomSong(): SongEntry {
  return SONGS[Math.floor(Math.random() * SONGS.length)];
}

export function getWrongChoices(correct: SongEntry, count = 2): SongEntry[] {
  const pool = SONGS.filter((s) => s.title !== correct.title);
  const shuffled = pool.sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}
