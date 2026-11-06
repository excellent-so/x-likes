import { createWriteStream, existsSync, readFileSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { db, MEDIA_DIR, reindex } from "./db.js";
import { hydrateTweet, type HydrateOutcome, type SynMedia, type SynTweet } from "./syndication.js";

// Optional offline hydration source (the mock archive) — a JSON map of
// tweet_id → SynTweet. When XLIKES_MOCK_HYDRATION points at one, we serve from
// it instead of the network, so the whole pipeline runs with no external calls.
let _mock: Map<string, SynTweet> | null | undefined;
function mockSource(): Map<string, SynTweet> | null {
  if (_mock !== undefined) return _mock;
  const p = process.env.XLIKES_MOCK_HYDRATION;
  if (p && existsSync(p)) {
    _mock = new Map(Object.entries(JSON.parse(readFileSync(p, "utf8")) as Record<string, SynTweet>));
  } else {
    _mock = null;
  }
  return _mock;
}
async function resolveTweet(id: string): Promise<HydrateOutcome> {
  const m = mockSource();
  if (m) return m.has(id) ? { status: "ok", tweet: m.get(id)! } : { status: "gone" };
  return hydrateTweet(id);
}

const MAX_ATTEMPTS = 4;

/** Download a remote asset into media/<sub> and return its path relative to MEDIA_DIR. */
async function download(url: string, sub: string, name: string): Promise<string | null> {
  try {
    // Local file (mock archive media) — copy rather than fetch.
    if (url.startsWith("file://")) {
      const src = fileURLToPath(url);
      let ext = extname(src) || ".jpg";
      if (ext.length > 5) ext = ".jpg";
      const dir = join(MEDIA_DIR, sub);
      await mkdir(dir, { recursive: true });
      const rel = join(sub, `${name}${ext}`);
      await copyFile(src, join(MEDIA_DIR, rel));
      return rel;
    }
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok || !res.body) return null;
    let ext = extname(new URL(url).pathname) || ".jpg";
    if (ext.length > 5) ext = ".jpg";
    const dir = join(MEDIA_DIR, sub);
    await mkdir(dir, { recursive: true });
    const rel = join(sub, `${name}${ext}`);
    await pipeline(Readable.fromWeb(res.body as any), createWriteStream(join(MEDIA_DIR, rel)));
    return rel;
  } catch {
    return null;
  }
}

/** Persist one hydrated tweet: tweets row, media (with downloads), links, FTS.
 *  Exported so other sources (the web-export importer) can reuse the exact same
 *  media-download + write path. Requires the like + hydration_state rows to exist. */
export async function persistTweet(tweet: SynTweet): Promise<void> {
  const d = db();
  const id = tweet.tweet_id;

  // Avatar (best-effort, small).
  let avatarPath: string | null = null;
  if (tweet.author_avatar_url) {
    const big = tweet.author_avatar_url.replace("_normal", "_400x400");
    avatarPath = await download(big, "avatars", tweet.author_handle || id);
  }

  // Media images (posters for video/gif).
  const downloaded: (SynMedia & { local_path: string | null })[] = [];
  let idx = 0;
  for (const m of tweet.media) {
    const local = await download(m.remote_url, id, `${idx}`);
    downloaded.push({ ...m, local_path: local });
    idx++;
  }

  const tx = d.transaction(() => {
    d.prepare(
      `INSERT INTO tweets (
         tweet_id, author_name, author_handle, author_avatar, author_avatar_url,
         text, created_at, lang, url, quoted_tweet_id, quoted_text, quoted_handle,
         favorite_count, is_reply, possibly_sensitive, raw_json, hydrated_at)
       VALUES (
         @tweet_id, @author_name, @author_handle, @author_avatar, @author_avatar_url,
         @text, @created_at, @lang, @url, @quoted_tweet_id, @quoted_text, @quoted_handle,
         @favorite_count, @is_reply, @possibly_sensitive, @raw_json, datetime('now'))
       ON CONFLICT(tweet_id) DO UPDATE SET
         author_name=excluded.author_name, author_handle=excluded.author_handle,
         author_avatar=excluded.author_avatar, author_avatar_url=excluded.author_avatar_url,
         text=excluded.text, created_at=excluded.created_at, lang=excluded.lang,
         url=excluded.url, quoted_tweet_id=excluded.quoted_tweet_id,
         quoted_text=excluded.quoted_text, quoted_handle=excluded.quoted_handle,
         favorite_count=excluded.favorite_count, is_reply=excluded.is_reply,
         possibly_sensitive=excluded.possibly_sensitive, raw_json=excluded.raw_json,
         hydrated_at=datetime('now')`
    ).run({
      tweet_id: id,
      author_name: tweet.author_name,
      author_handle: tweet.author_handle,
      author_avatar: avatarPath,
      author_avatar_url: tweet.author_avatar_url,
      text: tweet.text,
      created_at: tweet.created_at,
      lang: tweet.lang,
      url: tweet.url,
      quoted_tweet_id: tweet.quoted_tweet_id,
      quoted_text: tweet.quoted_text,
      quoted_handle: tweet.quoted_handle,
      favorite_count: tweet.favorite_count,
      is_reply: tweet.is_reply ? 1 : 0,
      possibly_sensitive: tweet.possibly_sensitive ? 1 : 0,
      raw_json: JSON.stringify(tweet.raw),
    });

    d.prepare(`DELETE FROM media WHERE tweet_id = ?`).run(id);
    const insMedia = d.prepare(
      `INSERT INTO media (tweet_id, kind, remote_url, local_path, video_url, width, height, alt)
       VALUES (@tweet_id, @kind, @remote_url, @local_path, @video_url, @width, @height, @alt)
       ON CONFLICT(tweet_id, remote_url) DO NOTHING`
    );
    for (const m of downloaded) {
      insMedia.run({
        tweet_id: id,
        kind: m.kind,
        remote_url: m.remote_url,
        local_path: m.local_path,
        video_url: m.video_url ?? null,
        width: m.width ?? null,
        height: m.height ?? null,
        alt: m.alt ?? null,
      });
    }

    d.prepare(`DELETE FROM links WHERE tweet_id = ?`).run(id);
    const insLink = d.prepare(
      `INSERT INTO links (tweet_id, url, display_url) VALUES (?, ?, ?)
       ON CONFLICT(tweet_id, url) DO NOTHING`
    );
    for (const l of tweet.links) insLink.run(id, l.url, l.display_url);

    d.prepare(
      `UPDATE hydration_state SET status='ok', attempts=attempts+1, last_error=NULL,
       updated_at=datetime('now') WHERE tweet_id=?`
    ).run(id);

    reindex(d, id);
  });
  tx();
}

function markGone(id: string): void {
  db()
    .prepare(
      `UPDATE hydration_state SET status='gone', attempts=attempts+1,
       updated_at=datetime('now') WHERE tweet_id=?`
    )
    .run(id);
}

function markError(id: string, error: string): void {
  db()
    .prepare(
      `UPDATE hydration_state SET status='error', attempts=attempts+1, last_error=?,
       updated_at=datetime('now') WHERE tweet_id=?`
    )
    .run(error, id);
}

export interface HydrateOptions {
  limit?: number;
  concurrency?: number;
  retryErrors?: boolean; // also re-attempt previously errored tweets
  onProgress?: (done: number, total: number) => void;
}

export interface HydrateReport {
  attempted: number;
  ok: number;
  gone: number;
  error: number;
}

/** Hydrate all pending (and optionally errored) likes. */
export async function hydratePending(opts: HydrateOptions = {}): Promise<HydrateReport> {
  const d = db();
  const concurrency = Math.max(1, opts.concurrency ?? 5);
  const statuses = opts.retryErrors ? ["pending", "error"] : ["pending"];
  const placeholders = statuses.map(() => "?").join(",");
  const rows = d
    .prepare(
      `SELECT s.tweet_id FROM hydration_state s
       WHERE s.status IN (${placeholders}) AND s.attempts < ?
       ORDER BY (SELECT liked_order FROM likes WHERE tweet_id = s.tweet_id) ASC
       ${opts.limit ? "LIMIT ?" : ""}`
    )
    .all(...statuses, MAX_ATTEMPTS, ...(opts.limit ? [opts.limit] : [])) as { tweet_id: string }[];

  const report: HydrateReport = { attempted: rows.length, ok: 0, gone: 0, error: 0 };
  let done = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < rows.length) {
      const id = rows[cursor++]!.tweet_id;
      const outcome = await resolveTweet(id);
      if (outcome.status === "ok") {
        await persistTweet(outcome.tweet);
        report.ok++;
      } else if (outcome.status === "gone") {
        markGone(id);
        report.gone++;
      } else {
        markError(id, outcome.error);
        report.error++;
      }
      done++;
      opts.onProgress?.(done, rows.length);
      // Gentle pacing so we stay friendly to the public endpoint (skip for mock).
      if (!mockSource()) await new Promise((r) => setTimeout(r, 120 + Math.floor(Math.random() * 120)));
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  return report;
}
