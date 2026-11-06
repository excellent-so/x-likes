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
function parseLikeJs(source: string): ArchiveLike[] {
  const eq = source.indexOf("=");
  const json = eq >= 0 ? source.slice(eq + 1) : source;
  const arr = JSON.parse(json) as Array<{ like?: ArchiveLike } | ArchiveLike>;
  return arr.map((row) => ("like" in row && row.like ? row.like : (row as ArchiveLike)));
}

/** Resolve an input path to the list of like*.js files to parse. */
function resolveLikeFiles(input: string): string[] {
  if (!existsSync(input)) throw new Error(`Path not found: ${input}`);
  const st = statSync(input);

  // A .zip archive — unzip just the like files to a temp dir.
  if (st.isFile() && input.toLowerCase().endsWith(".zip")) {
    const list = execFileSync("unzip", ["-Z1", input], { encoding: "utf8" })
      .split("\n")
      .filter((n) => /(^|\/)data\/like.*\.js$/i.test(n));
    if (list.length === 0) throw new Error(`No data/like*.js found inside ${input}`);
    const tmp = join(process.env.TMPDIR || "/tmp", `x-likes-${process.pid}`);
    execFileSync("unzip", ["-o", "-j", input, ...list, "-d", tmp], { stdio: "ignore" });
    return readdirSync(tmp)
      .filter((n) => /^like.*\.js$/i.test(n))
      .map((n) => join(tmp, n));
  }

  // A single like.js file.
  if (st.isFile()) return [input];

  // A directory — the unzipped archive root or its data/ folder.
  const dataDir = existsSync(join(input, "data")) ? join(input, "data") : input;
  const files = readdirSync(dataDir)
    .filter((n) => /^like.*\.js$/i.test(n))
    .map((n) => join(dataDir, n));
  if (files.length === 0) throw new Error(`No like*.js found in ${dataDir}`);
  return files;
}

export interface ImportResult {
  files: number;
  parsed: number;
  inserted: number;
  skipped: number;
}

export function importArchive(input: string): ImportResult {
  const d = db();
  const files = resolveLikeFiles(input);

  const likes: ArchiveLike[] = [];
  for (const f of files) likes.push(...parseLikeJs(readFileSync(f, "utf8")));

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
