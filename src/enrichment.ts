import type { Database } from "better-sqlite3";
import { db, reindex, reindexEnriched } from "./db.js";

export type Stage = "article" | "vision" | "tags" | "embed";
export const MAX_ATTEMPTS = 4;

export interface StageResult {
  status: "ok" | "skip" | "gone" | "error";
  error?: string;
  cost?: number;
  model?: string;
}

/** Record the outcome of one stage for one tweet (idempotent upsert). */
export function markStage(d: Database, tweetId: string, stage: Stage, r: StageResult): void {
  d.prepare(
    `INSERT INTO enrichment_state (tweet_id, stage, status, attempts, cost_usd, model, last_error, updated_at)
     VALUES (@tweet_id, @stage, @status, 1, @cost, @model, @error, datetime('now'))
     ON CONFLICT(tweet_id, stage) DO UPDATE SET
       status=excluded.status,
       attempts=enrichment_state.attempts + 1,
       cost_usd=enrichment_state.cost_usd + excluded.cost_usd,
       model=excluded.model,
       last_error=excluded.last_error,
       updated_at=datetime('now')`
  ).run({
    tweet_id: tweetId,
    stage,
    status: r.status,
    cost: r.cost ?? 0,
    model: r.model ?? null,
    error: r.error ?? null,
  });
}

export interface PendingOpts {
  limit?: number;
  retryErrors?: boolean;
}

/**
 * Tweet ids that still need `stage` run: hydrated OK, matching the stage's
 * eligibility, and not yet terminal for that stage (pending / never-tried, or
 * an errored row under the attempt cap when retrying).
 */
export function selectPending(
  stage: Stage,
  eligibleJoin: string,
  eligibleWhere: string,
  opts: PendingOpts = {}
): string[] {
  const d = db();
  const retry = opts.retryErrors ? `OR (es.status='error' AND es.attempts < ${MAX_ATTEMPTS})` : "";
  const rows = d
    .prepare(
      `SELECT l.tweet_id AS tweet_id
       FROM likes l
       JOIN hydration_state hs ON hs.tweet_id = l.tweet_id AND hs.status = 'ok'
       ${eligibleJoin}
       LEFT JOIN enrichment_state es ON es.tweet_id = l.tweet_id AND es.stage = @stage
       WHERE (${eligibleWhere})
         AND (es.tweet_id IS NULL OR es.status = 'pending' ${retry})
       GROUP BY l.tweet_id
       ORDER BY l.liked_order ASC
       ${opts.limit ? "LIMIT @limit" : ""}`
    )
    .all({ stage, limit: opts.limit ?? null }) as { tweet_id: string }[];
  return rows.map((r) => r.tweet_id);
}

/** The reasons a stage has failed, most common first: what the CLI prints under a stage with failures. */
export function stageErrors(stage: Stage, limit = 2): { error: string; n: number }[] {
  return db()
    .prepare(
      `SELECT COALESCE(last_error, 'unknown error') AS error, COUNT(*) AS n FROM enrichment_state
       WHERE stage = ? AND status = 'error' GROUP BY 1 ORDER BY n DESC, error LIMIT ?`
    )
    .all(stage, limit) as { error: string; n: number }[];
}

/** Run `work` over ids on `concurrency` workers. The first error thrown stops them all and is rethrown. */
export async function eachWithWorkers(
  ids: string[],
  concurrency: number,
  work: (id: string) => Promise<void>
): Promise<void> {
  let cursor = 0;
  let failure: { e: unknown } | null = null;
  async function worker() {
    while (cursor < ids.length && !failure) {
      const id = ids[cursor++]!;
      try {
        await work(id);
      } catch (e) {
        failure ??= { e };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), ids.length) }, worker));
  if (failure) throw (failure as { e: unknown }).e;
}

/**
 * The composite "document" for a like — tweet text + linked-article title/excerpt
 * + image OCR/caption — used as the input to tagging and embeddings.
 */
export function buildDoc(tweetId: string): string {
  const d = db();
  const base = d
    .prepare(
      `SELECT COALESCE(t.text, l.archive_text, '') AS text,
              t.author_name AS author
       FROM likes l LEFT JOIN tweets t ON t.tweet_id = l.tweet_id
       WHERE l.tweet_id = ?`
    )
    .get(tweetId) as { text: string; author: string | null } | undefined;

  const parts: string[] = [];
  if (base?.author) parts.push(`By ${base.author}.`);
  if (base?.text) parts.push(base.text);

  for (const a of d
    .prepare(`SELECT title, excerpt, text FROM article_extracts WHERE tweet_id = ?`)
    .all(tweetId) as { title: string | null; excerpt: string | null; text: string | null }[]) {
    if (a.title) parts.push(`Article: ${a.title}.`);
    if (a.excerpt) parts.push(a.excerpt);
    else if (a.text) parts.push(a.text.slice(0, 1200));
  }

  for (const v of d
    .prepare(`SELECT caption, ocr_text FROM media_vision WHERE tweet_id = ?`)
    .all(tweetId) as { caption: string | null; ocr_text: string | null }[]) {
    if (v.caption) parts.push(`Image: ${v.caption}`);
    if (v.ocr_text) parts.push(`Image text: ${v.ocr_text}`);
  }

  return parts.join("\n").replace(/\s+\n/g, "\n").trim();
}

/** Refresh both FTS surfaces (base + enriched) for a tweet after enrichment. */
export function reindexAll(tweetId: string): void {
  const d = db();
  reindex(d, tweetId);
  reindexEnriched(d, tweetId);
}

/** Normalize a free-text tag into a slug + display label. */
export function slugifyTag(raw: string): { slug: string; label: string } {
  const label = raw.trim().replace(/\s+/g, " ");
  const slug = label
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return { slug, label };
}

/** Upsert a tag and attach it to a tweet. */
export function attachTag(
  d: Database,
  tweetId: string,
  raw: string,
  kind = "topic",
  score?: number,
  source = "llm"
): void {
  const { slug, label } = slugifyTag(raw);
  if (!slug) return;
  d.prepare(`INSERT INTO tags (slug, label, kind) VALUES (?, ?, ?) ON CONFLICT(slug) DO NOTHING`).run(
    slug,
    label,
    kind
  );
  const tag = d.prepare(`SELECT id FROM tags WHERE slug = ?`).get(slug) as { id: number };
  d.prepare(
    `INSERT INTO like_tags (tweet_id, tag_id, source, score) VALUES (?, ?, ?, ?)
     ON CONFLICT(tweet_id, tag_id) DO UPDATE SET score=excluded.score`
  ).run(tweetId, tag.id, source, score ?? null);
}
