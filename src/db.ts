import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(__dirname, "..");
export const DATA_DIR = process.env.XLIKES_DATA_DIR
  ? resolve(process.env.XLIKES_DATA_DIR)
  : join(PROJECT_ROOT, "data");
export const DB_PATH = join(DATA_DIR, "likes.db");
export const MEDIA_DIR = join(DATA_DIR, "media");

let _db: Database.Database | null = null;

/** Open (and migrate) the singleton database. */
export function db(): Database.Database {
  if (_db) return _db;
  try {
    mkdirSync(MEDIA_DIR, { recursive: true });
  } catch (e) {
    throw new Error(`x-likes can't create its data folder ${DATA_DIR} (${(e as NodeJS.ErrnoException).code}). Check XLIKES_DATA_DIR.`);
  }
  const database = new Database(DB_PATH);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");
  migrate(database);
  _db = database;
  return database;
}

/**
 * Idempotent schema. Everything is additive so re-importing a fresh archive
 * only ever adds rows — the core requirement for a continuously-updated store.
 */
function migrate(d: Database.Database): void {
  d.exec(`
    -- One row per liked tweet, straight from the archive's like.js.
    CREATE TABLE IF NOT EXISTS likes (
      tweet_id      TEXT PRIMARY KEY,
      archive_text  TEXT,                       -- fullText as stored in the archive
      expanded_url  TEXT,                        -- link to the tweet on x.com
      liked_order   INTEGER,                     -- position in the archive (newest first = 0)
      imported_at   TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Rich data pulled from the public embed endpoint. Absent until hydrated.
    CREATE TABLE IF NOT EXISTS tweets (
      tweet_id        TEXT PRIMARY KEY REFERENCES likes(tweet_id) ON DELETE CASCADE,
      author_name     TEXT,
      author_handle   TEXT,
      author_avatar   TEXT,                      -- local path under media/
      author_avatar_url TEXT,
      text            TEXT,                        -- full, link-expanded text
      created_at      TEXT,                        -- ISO 8601 of the tweet itself
      lang            TEXT,
      url             TEXT,                        -- canonical x.com/<handle>/status/<id>
      quoted_tweet_id TEXT,
      quoted_text     TEXT,
      quoted_handle   TEXT,
      favorite_count  INTEGER,
      is_reply        INTEGER NOT NULL DEFAULT 0,
      possibly_sensitive INTEGER NOT NULL DEFAULT 0,
      raw_json        TEXT,                        -- full response, kept for future re-parsing
      hydrated_at     TEXT
    );

    -- Downloaded photos / video posters / gif posters.
    CREATE TABLE IF NOT EXISTS media (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tweet_id    TEXT NOT NULL REFERENCES likes(tweet_id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,                   -- photo | video | animated_gif
      remote_url  TEXT NOT NULL,                   -- source image (poster for video/gif)
      local_path  TEXT,                            -- path under media/, null if download failed
      video_url   TEXT,                            -- best playable variant for video/gif
      width       INTEGER,
      height      INTEGER,
      alt         TEXT,
      UNIQUE(tweet_id, remote_url)
    );

    -- Every external link found in a liked tweet (expanded, not t.co).
    CREATE TABLE IF NOT EXISTS links (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      tweet_id     TEXT NOT NULL REFERENCES likes(tweet_id) ON DELETE CASCADE,
      url          TEXT NOT NULL,
      display_url  TEXT,
      UNIQUE(tweet_id, url)
    );

    -- Tracks hydration attempts so we can retry failures without re-doing work.
    CREATE TABLE IF NOT EXISTS hydration_state (
      tweet_id    TEXT PRIMARY KEY REFERENCES likes(tweet_id) ON DELETE CASCADE,
      status      TEXT NOT NULL DEFAULT 'pending', -- pending | ok | gone | error
      attempts    INTEGER NOT NULL DEFAULT 0,
      last_error  TEXT,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_likes_order ON likes(liked_order);
    CREATE INDEX IF NOT EXISTS idx_tweets_handle ON tweets(author_handle);
    CREATE INDEX IF NOT EXISTS idx_tweets_created ON tweets(created_at);
    CREATE INDEX IF NOT EXISTS idx_media_tweet ON media(tweet_id);
    CREATE INDEX IF NOT EXISTS idx_links_tweet ON links(tweet_id);
    CREATE INDEX IF NOT EXISTS idx_hydration_status ON hydration_state(status);

    -- Full-text search over everything we know about a like. Rebuilt per-tweet
    -- on hydrate; seeded with archive text on import so search works pre-hydrate.
    CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
      tweet_id UNINDEXED,
      text,
      author,
      handle,
      links,
      alt,
      tokenize = 'porter unicode61'
    );

    -- ── Enrichment layers (Phases 2–5). All additive. ──────────────────────────

    -- Per-stage progress, mirroring hydration_state: one row per (tweet, stage)
    -- so each enrichment stage re-runs independently on new/failed work.
    CREATE TABLE IF NOT EXISTS enrichment_state (
      tweet_id   TEXT NOT NULL REFERENCES likes(tweet_id) ON DELETE CASCADE,
      stage      TEXT NOT NULL,                     -- article | vision | tags | embed
      status     TEXT NOT NULL DEFAULT 'pending',   -- pending | ok | skip | gone | error
      attempts   INTEGER NOT NULL DEFAULT 0,
      cost_usd   REAL NOT NULL DEFAULT 0,
      model      TEXT,
      last_error TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tweet_id, stage)
    );
    CREATE INDEX IF NOT EXISTS idx_enrich_stage_status ON enrichment_state(stage, status);

    -- Full readable text of a linked article, one row per resolved link.
    CREATE TABLE IF NOT EXISTS article_extracts (
      tweet_id   TEXT NOT NULL REFERENCES likes(tweet_id) ON DELETE CASCADE,
      url        TEXT NOT NULL,                     -- the links.url this came from
      final_url  TEXT,                              -- after redirects
      title      TEXT, byline TEXT, site_name TEXT, excerpt TEXT,
      text       TEXT,
      lead_image TEXT,
      word_count INTEGER,
      lang       TEXT,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tweet_id, url)
    );
    CREATE INDEX IF NOT EXISTS idx_article_tweet ON article_extracts(tweet_id);

    -- Image understanding. Separate from media (hydrate rebuilds media on re-run);
    -- keyed by the stable remote_url so descriptions survive re-hydration.
    CREATE TABLE IF NOT EXISTS media_vision (
      tweet_id   TEXT NOT NULL REFERENCES likes(tweet_id) ON DELETE CASCADE,
      remote_url TEXT NOT NULL,
      caption    TEXT,                              -- 1–2 sentence description
      ocr_text   TEXT,                              -- text transcribed from the image
      labels     TEXT,                              -- comma-separated objects/topics
      model      TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (tweet_id, remote_url)
    );
    CREATE INDEX IF NOT EXISTS idx_vision_tweet ON media_vision(tweet_id);

    -- Topical tag vocabulary + polymorphic join (the browsable index of the brain).
    CREATE TABLE IF NOT EXISTS tags (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      slug   TEXT NOT NULL UNIQUE,                  -- normalized: 'llm-agents'
      label  TEXT NOT NULL,                         -- display form
      kind   TEXT NOT NULL DEFAULT 'topic',         -- topic | person | org | product | repo | paper
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS like_tags (
      tweet_id TEXT NOT NULL REFERENCES likes(tweet_id) ON DELETE CASCADE,
      tag_id   INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      source   TEXT NOT NULL DEFAULT 'llm',
      score    REAL,
      PRIMARY KEY (tweet_id, tag_id)
    );
    CREATE INDEX IF NOT EXISTS idx_like_tags_tag ON like_tags(tag_id);

    -- Semantic index: 384-dim unit-normalized MiniLM vectors as Float32 BLOBs.
    -- Brute-force cosine KNN in JS — robust, no native extension, fine to a few thousand.
    CREATE TABLE IF NOT EXISTS embeddings (
      tweet_id   TEXT PRIMARY KEY REFERENCES likes(tweet_id) ON DELETE CASCADE,
      dim        INTEGER NOT NULL,
      vec        BLOB NOT NULL,
      model      TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Keyword surface over enrichment; base 'search' fts stays untouched so
    -- keyword search degrades gracefully before/without enrichment.
    CREATE VIRTUAL TABLE IF NOT EXISTS enriched_fts USING fts5(
      tweet_id UNINDEXED,
      tags,
      article,
      ocr,
      caption,
      tokenize = 'porter unicode61'
    );
  `);
}

/** Rebuild the enriched-FTS row for a tweet from its article/vision/tag rows. */
export function reindexEnriched(d: Database.Database, tweetId: string): void {
  const row = d
    .prepare(
      `SELECT
         (SELECT group_concat(t.label, ' ')
            FROM like_tags lt JOIN tags t ON t.id = lt.tag_id
            WHERE lt.tweet_id = @id)                              AS tags,
         (SELECT group_concat(COALESCE(title,'') || ' ' || COALESCE(text,''), ' ')
            FROM article_extracts WHERE tweet_id = @id)           AS article,
         (SELECT group_concat(COALESCE(ocr_text,''), ' ')
            FROM media_vision WHERE tweet_id = @id)               AS ocr,
         (SELECT group_concat(COALESCE(caption,'') || ' ' || COALESCE(labels,''), ' ')
            FROM media_vision WHERE tweet_id = @id)               AS caption`
    )
    .get({ id: tweetId }) as { tags: string | null; article: string | null; ocr: string | null; caption: string | null };
  d.prepare(`DELETE FROM enriched_fts WHERE tweet_id = ?`).run(tweetId);
  if (!row || (!row.tags && !row.article && !row.ocr && !row.caption)) return;
  d.prepare(
    `INSERT INTO enriched_fts (tweet_id, tags, article, ocr, caption)
     VALUES (@id, @tags, @article, @ocr, @caption)`
  ).run({
    id: tweetId,
    tags: row.tags ?? "",
    article: row.article ?? "",
    ocr: row.ocr ?? "",
    caption: row.caption ?? "",
  });
}

/** Upsert the FTS row for a tweet from whatever we currently know. */
export function reindex(d: Database.Database, tweetId: string): void {
  const row = d
    .prepare(
      `SELECT
         l.tweet_id                                   AS tweet_id,
         COALESCE(t.text, l.archive_text, '')         AS text,
         COALESCE(t.author_name, '')                  AS author,
         COALESCE(t.author_handle, '')                AS handle,
         (SELECT group_concat(url, ' ')  FROM links WHERE tweet_id = l.tweet_id) AS links,
         (SELECT group_concat(alt, ' ')  FROM media WHERE tweet_id = l.tweet_id) AS alt
       FROM likes l
       LEFT JOIN tweets t ON t.tweet_id = l.tweet_id
       WHERE l.tweet_id = ?`
    )
    .get(tweetId) as
    | { tweet_id: string; text: string; author: string; handle: string; links: string | null; alt: string | null }
    | undefined;
  if (!row) return;
  d.prepare(`DELETE FROM search WHERE tweet_id = ?`).run(tweetId);
  d.prepare(
    `INSERT INTO search (tweet_id, text, author, handle, links, alt)
     VALUES (@tweet_id, @text, @author, @handle, @links, @alt)`
  ).run({
    tweet_id: row.tweet_id,
    text: row.text,
    author: row.author,
    handle: row.handle,
    links: row.links ?? "",
    alt: row.alt ?? "",
  });
}
