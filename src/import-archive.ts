import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { db, reindex } from "./db.js";

interface ArchiveLike {
  tweetId?: string;
  fullText?: string;
  expandedUrl?: string;
}

/**
 * The archive stores likes as `window.YTD.like.part0 = [ {like: {...}}, ... ]`.
 * Strip the JS assignment prefix and parse the array. Handles multiple part
 * files for very large accounts (like.js, like-part1.js, ...).
 */
function parseLikeJs({ name, text }: LikeFile): ArchiveLike[] {
  const eq = text.indexOf("=");
  const json = eq >= 0 ? text.slice(eq + 1) : text;
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    throw new Error(`${name} isn't in the format of X's like.js (window.YTD.like.part0 = [...]).`);
  }
  if (!Array.isArray(arr)) throw new Error(`${name} isn't in the format of X's like.js (window.YTD.like.part0 = [...]).`);
  return (arr as Array<{ like?: ArchiveLike } | ArchiveLike>).map((row) =>
    row && typeof row === "object" && "like" in row && row.like ? row.like : (row as ArchiveLike)
  );
}

interface LikeFile {
  name: string;
  text: string;
}

/** Run unzip, with a plain message when it is missing or the file isn't a zip. */
function unzip(args: string[], input: string): string {
  try {
    return execFileSync("unzip", args, { encoding: "utf8", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`Reading a .zip needs the unzip command, which isn't installed. Unzip ${input} yourself and pass the folder instead.`);
    throw new Error(`Couldn't read ${input} as a zip. Is it the archive X sent you, fully downloaded?`);
  }
}

/** The text of every like*.js the input holds: a .zip (read in memory, nothing extracted), a folder or one file. */
function readLikeFiles(input: string): LikeFile[] {
  if (!existsSync(input)) throw new Error(`Path not found: ${input}`);
  const st = statSync(input);

  // A .zip archive: read just the like files straight out of it.
  if (st.isFile() && input.toLowerCase().endsWith(".zip")) {
    const list = unzip(["-Z1", input], input)
      .split("\n")
      .filter((n) => /(^|\/)data\/like.*\.js$/i.test(n));
    if (list.length === 0) throw new Error(`No data/like*.js found inside ${input}. Is it your X archive?`);
    return list.map((name) => ({ name, text: unzip(["-p", input, name], input) }));
  }

  // A single like.js file.
  if (st.isFile()) return [{ name: input, text: readFileSync(input, "utf8") }];

  // A directory — the unzipped archive root or its data/ folder.
  const dataDir = existsSync(join(input, "data")) ? join(input, "data") : input;
  const files = readdirSync(dataDir)
    .filter((n) => /^like.*\.js$/i.test(n))
    .map((n) => join(dataDir, n));
  if (files.length === 0) throw new Error(`No like*.js found in ${dataDir}. Pass your X archive (.zip), its folder or its data/like.js.`);
  return files.map((f) => ({ name: f, text: readFileSync(f, "utf8") }));
}

export interface ImportResult {
  files: number;
  parsed: number;
  inserted: number;
  skipped: number;
}

export function importArchive(input: string): ImportResult {
  const d = db();
  const files = readLikeFiles(input);

  const likes: ArchiveLike[] = [];
  for (const f of files) likes.push(...parseLikeJs(f));

  const insert = d.prepare(
    `INSERT INTO likes (tweet_id, archive_text, expanded_url, liked_order)
     VALUES (@tweet_id, @archive_text, @expanded_url, @liked_order)
     ON CONFLICT(tweet_id) DO NOTHING`
  );
  const ensureState = d.prepare(
    `INSERT INTO hydration_state (tweet_id, status) VALUES (?, 'pending')
     ON CONFLICT(tweet_id) DO NOTHING`
  );

  let inserted = 0;
  let skipped = 0;
  const run = d.transaction((rows: ArchiveLike[]) => {
    rows.forEach((like, i) => {
      if (!like.tweetId) {
        skipped++;
        return;
      }
      const info = insert.run({
        tweet_id: like.tweetId,
        archive_text: like.fullText ?? null,
        expanded_url: like.expandedUrl ?? null,
        liked_order: i,
      });
      if (info.changes > 0) {
        inserted++;
        ensureState.run(like.tweetId);
        reindex(d, like.tweetId);
      } else {
        skipped++;
      }
    });
  });
  run(likes);

  return { files: files.length, parsed: likes.length, inserted, skipped };
}
