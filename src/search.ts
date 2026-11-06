import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { cosine, embed, unpackVec } from "./ai.js";
import { db, MEDIA_DIR } from "./db.js";

// ── image dimensions (for zero-layout-shift masonry) ─────────────────────────
// Parse width/height from the file header (jpg/png/gif/webp), cached per path so
// each image is read at most once. Lets the client reserve the exact aspect box
// before the image loads — no reflow, so the grid fills in one shot instead of
// row by row as each image pops in.
const dimCache = new Map<string, { w: number; h: number }>();

/** Read only a bounded header prefix — dimensions live in the first few KB, so
 *  this avoids pulling multi-MB images fully into memory on the request path. */
function readHeader(path: string, max = 131072): Buffer {
  const fd = openSync(path, "r");
  try {
    const size = Math.min(statSync(path).size, max);
    const buf = Buffer.allocUnsafe(size);
    readSync(fd, buf, 0, size, 0);
    return buf;
  } finally {
    closeSync(fd);
  }
}

function imageDims(localPath: string): { w: number; h: number } | null {
  const cached = dimCache.get(localPath);
  if (cached) return cached;
  let dims: { w: number; h: number } | null = null;
  try {
    dims = parseDims(readHeader(join(MEDIA_DIR, localPath)));
  } catch {
    dims = null;
  }
  // Only cache successes — a file that is missing now may be downloaded later.
  if (dims) dimCache.set(localPath, dims);
  return dims;
}

function parseDims(b: Buffer): { w: number; h: number } | null {
  // PNG
  if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) {
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  }
  // GIF
  if (b.length > 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  }
  // WebP
  if (b.length > 30 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") {
    const fmt = b.toString("ascii", 12, 16);
    if (fmt === "VP8 ") return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (fmt === "VP8L") {
      const bits = b.readUInt32LE(21);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (fmt === "VP8X") {
      return { w: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), h: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
    }
  }
  // JPEG — walk the marker segments to the start-of-frame
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff) {
        o++;
        continue;
      }
      const m = b[o + 1]!;
      // 0xFF fill byte — rescan from the next byte
      if (m === 0xff) {
        o++;
        continue;
      }
      // Standalone markers carry NO length: TEM (0x01), RSTn/SOI/EOI (0xD0–0xD9)
      if (m === 0x01 || (m >= 0xd0 && m <= 0xd9)) {
        o += 2;
        continue;
      }
      // SOFn frame header holds the dimensions (excl. DHT 0xC4, JPG 0xC8, DAC 0xCC)
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { w: b.readUInt16BE(o + 7), h: b.readUInt16BE(o + 5) };
      }
      // Everything else is a length-prefixed segment; skip it
      const len = b.readUInt16BE(o + 2);
      if (len < 2) break; // malformed — bail rather than stall
      o += 2 + len;
    }
  }
  return null;
}

/** Map a raw media row to the API shape, attaching cached pixel dimensions. */
function mediaRow(m: any): ResultTweet["media"][number] {
  const d = m.local_path ? imageDims(m.local_path) : null;
  return {
    kind: m.kind,
    local_path: m.local_path,
    remote_url: m.remote_url,
    video_url: m.video_url,
    alt: m.alt,
    w: d?.w ?? null,
    h: d?.h ?? null,
  };
}

export interface SearchParams {
  q?: string;
  author?: string;
  hasImage?: boolean;
  hasLink?: boolean;
  tag?: string; // tag slug
  sort?: "liked" | "newest" | "oldest" | "relevance";
  limit?: number;
  offset?: number;
}

export interface ResultTweet {
  tweet_id: string;
  text: string | null;
  author_name: string | null;
  author_handle: string | null;
  author_avatar: string | null;
  created_at: string | null;
  url: string | null;
  expanded_url: string | null;
  favorite_count: number | null;
  liked_order: number;
  hydration: string;
  media: { kind: string; local_path: string | null; remote_url: string; video_url: string | null; alt: string | null; w: number | null; h: number | null }[];
  links: { url: string; display_url: string | null }[];
  tags?: { slug: string; label: string }[];
  article_count?: number;
}

/** Attach tags + article counts to a page of results (one batch query each). */
function attachExtras(list: ResultTweet[]): void {
  if (list.length === 0) return;
  const d = db();
  const ids = list.map((r) => r.tweet_id);
  const ph = ids.map(() => "?").join(",");
  const tags = new Map<string, { slug: string; label: string }[]>();
  for (const t of d
    .prepare(
      `SELECT lt.tweet_id, tg.slug, tg.label FROM like_tags lt
       JOIN tags tg ON tg.id = lt.tag_id WHERE lt.tweet_id IN (${ph}) ORDER BY tg.label`
    )
    .all(...ids) as any[]) {
    (tags.get(t.tweet_id) ?? tags.set(t.tweet_id, []).get(t.tweet_id)!).push({ slug: t.slug, label: t.label });
  }
  const arts = new Map<string, number>();
  for (const a of d
    .prepare(`SELECT tweet_id, COUNT(*) c FROM article_extracts WHERE tweet_id IN (${ph}) GROUP BY tweet_id`)
    .all(...ids) as any[]) {
    arts.set(a.tweet_id, a.c);
  }
  for (const r of list) {
    r.tags = tags.get(r.tweet_id) ?? [];
    r.article_count = arts.get(r.tweet_id) ?? 0;
  }
}

/** Escape a user query into a safe FTS5 MATCH expression (prefix-matched terms). */
function toMatch(q: string): string | null {
  const terms = q
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/["*]/g, ""))
    .filter(Boolean)
    .map((t) => `"${t}"*`);
  return terms.length ? terms.join(" AND ") : null;
}

export interface SearchResponse {
  total: number;
  results: ResultTweet[];
}

export function search(params: SearchParams): SearchResponse {
  const d = db();
  const where: string[] = [];
  const args: Record<string, unknown> = {};
  let joinSearch = "";
  let relevanceOrder = "";

  // Keyword match spans BOTH FTS surfaces — the base tweet text and the
  // enrichment text (tags, article bodies, image OCR/captions) — so a search
  // finds a like by anything we know about it. Rank by the best bm25 of either.
  const match = params.q ? toMatch(params.q) : null;
  if (match) {
    joinSearch = `JOIN (
        SELECT tweet_id, min(rank) AS rank FROM (
          SELECT tweet_id, bm25(search) AS rank FROM search WHERE search MATCH @match
          UNION ALL
          SELECT tweet_id, bm25(enriched_fts) AS rank FROM enriched_fts WHERE enriched_fts MATCH @match
        ) GROUP BY tweet_id
      ) fx ON fx.tweet_id = l.tweet_id`;
    args.match = match;
    relevanceOrder = "fx.rank";
  }

  if (params.author) {
    where.push(`t.author_handle = @author COLLATE NOCASE`);
    args.author = params.author.replace(/^@/, "");
  }
  if (params.hasImage) {
    where.push(`EXISTS (SELECT 1 FROM media m WHERE m.tweet_id = l.tweet_id)`);
  }
  if (params.hasLink) {
    where.push(`EXISTS (SELECT 1 FROM links k WHERE k.tweet_id = l.tweet_id)`);
  }
  if (params.tag) {
    where.push(
      `EXISTS (SELECT 1 FROM like_tags lt JOIN tags tg ON tg.id = lt.tag_id
               WHERE lt.tweet_id = l.tweet_id AND tg.slug = @tag)`
    );
    args.tag = params.tag;
  }

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  let orderSql: string;
  switch (params.sort) {
    case "newest":
      orderSql = "ORDER BY t.created_at DESC NULLS LAST, l.liked_order ASC";
      break;
    case "oldest":
      orderSql = "ORDER BY t.created_at ASC NULLS LAST, l.liked_order DESC";
      break;
    case "relevance":
      orderSql = match ? `ORDER BY ${relevanceOrder} ASC` : "ORDER BY l.liked_order ASC";
      break;
    case "liked":
    default:
      orderSql = "ORDER BY l.liked_order ASC";
  }

  // All JOINs must precede WHERE. Count needs no hydration join; rows do.
  const joins = `${joinSearch} LEFT JOIN tweets t ON t.tweet_id = l.tweet_id`;
  const countFrom = `FROM likes l ${joins} ${whereSql}`;
  const rowsFrom = `FROM likes l ${joins} LEFT JOIN hydration_state hs ON hs.tweet_id = l.tweet_id ${whereSql}`;

  const total = (
    d.prepare(`SELECT COUNT(*) AS n ${countFrom}`).get(args) as { n: number }
  ).n;

  const limit = Math.min(Math.max(params.limit ?? 30, 1), 200);
  const offset = Math.max(params.offset ?? 0, 0);

  const rows = d
    .prepare(
      `SELECT l.tweet_id, l.liked_order, l.expanded_url, l.archive_text,
              t.text, t.author_name, t.author_handle, t.author_avatar,
              t.created_at, t.url, t.favorite_count,
              COALESCE(hs.status, 'pending') AS hydration
       ${rowsFrom}
       ${orderSql}
       LIMIT @limit OFFSET @offset`
    )
    .all({ ...args, limit, offset }) as any[];

  const ids = rows.map((r) => r.tweet_id);
  const mediaByTweet = new Map<string, ResultTweet["media"]>();
  const linksByTweet = new Map<string, ResultTweet["links"]>();

  if (ids.length) {
    const ph = ids.map(() => "?").join(",");
    for (const m of d
      .prepare(`SELECT tweet_id, kind, local_path, remote_url, video_url, alt FROM media WHERE tweet_id IN (${ph})`)
      .all(...ids) as any[]) {
      const arr = mediaByTweet.get(m.tweet_id) ?? [];
      arr.push(mediaRow(m));
      mediaByTweet.set(m.tweet_id, arr);
    }
    for (const k of d
      .prepare(`SELECT tweet_id, url, display_url FROM links WHERE tweet_id IN (${ph})`)
      .all(...ids) as any[]) {
      const arr = linksByTweet.get(k.tweet_id) ?? [];
      arr.push({ url: k.url, display_url: k.display_url });
      linksByTweet.set(k.tweet_id, arr);
    }
  }

  const results: ResultTweet[] = rows.map((r) => ({
    tweet_id: r.tweet_id,
    text: r.text ?? r.archive_text ?? null,
    author_name: r.author_name ?? null,
    author_handle: r.author_handle ?? null,
    author_avatar: r.author_avatar ?? null,
    created_at: r.created_at ?? null,
    url: r.url ?? r.expanded_url ?? null,
    expanded_url: r.expanded_url ?? null,
    favorite_count: r.favorite_count ?? null,
    liked_order: r.liked_order,
    hydration: r.hydration,
    media: mediaByTweet.get(r.tweet_id) ?? [],
    links: linksByTweet.get(r.tweet_id) ?? [],
  }));

  attachExtras(results);
  return { total, results };
}

/** Fetch a single like's full record by tweet id (for MCP like_get). */
export function getLike(tweetId: string): ResultTweet | null {
  const d = db();
  const r = d
    .prepare(
      `SELECT l.tweet_id, l.liked_order, l.expanded_url, l.archive_text,
              t.text, t.author_name, t.author_handle, t.author_avatar,
              t.created_at, t.url, t.favorite_count,
              COALESCE(hs.status, 'pending') AS hydration
       FROM likes l
       LEFT JOIN tweets t ON t.tweet_id = l.tweet_id
       LEFT JOIN hydration_state hs ON hs.tweet_id = l.tweet_id
       WHERE l.tweet_id = ?`
    )
    .get(tweetId) as any;
  if (!r) return null;
  const media = (d
    .prepare(`SELECT kind, local_path, remote_url, video_url, alt FROM media WHERE tweet_id = ?`)
    .all(tweetId) as any[]).map(mediaRow);
  const links = d
    .prepare(`SELECT url, display_url FROM links WHERE tweet_id = ?`)
    .all(tweetId) as any[];
  return {
    tweet_id: r.tweet_id,
    text: r.text ?? r.archive_text ?? null,
    author_name: r.author_name ?? null,
    author_handle: r.author_handle ?? null,
    author_avatar: r.author_avatar ?? null,
    created_at: r.created_at ?? null,
    url: r.url ?? r.expanded_url ?? null,
    expanded_url: r.expanded_url ?? null,
    favorite_count: r.favorite_count ?? null,
    liked_order: r.liked_order,
    hydration: r.hydration,
    media,
    links,
  };
}

export interface Stats {
  likes: number;
  hydrated: number;
  gone: number;
  pending: number;
  errored: number;
  withImages: number;
  withLinks: number;
  mediaFiles: number;
  topAuthors: { handle: string; name: string | null; count: number }[];
}

export function stats(): Stats {
  const d = db();
  const one = (sql: string): number => (d.prepare(sql).get() as { n: number }).n;
  return {
    likes: one(`SELECT COUNT(*) n FROM likes`),
    hydrated: one(`SELECT COUNT(*) n FROM hydration_state WHERE status='ok'`),
    gone: one(`SELECT COUNT(*) n FROM hydration_state WHERE status='gone'`),
    pending: one(`SELECT COUNT(*) n FROM hydration_state WHERE status='pending'`),
    errored: one(`SELECT COUNT(*) n FROM hydration_state WHERE status='error'`),
    withImages: one(`SELECT COUNT(DISTINCT tweet_id) n FROM media`),
    withLinks: one(`SELECT COUNT(DISTINCT tweet_id) n FROM links`),
    mediaFiles: one(`SELECT COUNT(*) n FROM media WHERE local_path IS NOT NULL`),
    topAuthors: d
      .prepare(
        `SELECT author_handle handle, author_name name, COUNT(*) count
         FROM tweets WHERE author_handle IS NOT NULL
         GROUP BY author_handle COLLATE NOCASE ORDER BY count DESC LIMIT 20`
      )
      .all() as { handle: string; name: string | null; count: number }[],
  };
}

// ── shared hydration ──────────────────────────────────────────────────────────

/** Hydrate a set of tweet ids into ResultTweet[], preserving the given order. */
export function hydrateIds(ids: string[]): ResultTweet[] {
  if (ids.length === 0) return [];
  const d = db();
  const ph = ids.map(() => "?").join(",");
  const rows = d
    .prepare(
      `SELECT l.tweet_id, l.liked_order, l.expanded_url, l.archive_text,
              t.text, t.author_name, t.author_handle, t.author_avatar,
              t.created_at, t.url, t.favorite_count,
              COALESCE(hs.status,'pending') AS hydration
       FROM likes l
       LEFT JOIN tweets t ON t.tweet_id = l.tweet_id
       LEFT JOIN hydration_state hs ON hs.tweet_id = l.tweet_id
       WHERE l.tweet_id IN (${ph})`
    )
    .all(...ids) as any[];
  const media = new Map<string, ResultTweet["media"]>();
  const links = new Map<string, ResultTweet["links"]>();
  for (const m of d
    .prepare(`SELECT tweet_id, kind, local_path, remote_url, video_url, alt FROM media WHERE tweet_id IN (${ph})`)
    .all(...ids) as any[]) {
    (media.get(m.tweet_id) ?? media.set(m.tweet_id, []).get(m.tweet_id)!).push(mediaRow(m));
  }
  for (const k of d
    .prepare(`SELECT tweet_id, url, display_url FROM links WHERE tweet_id IN (${ph})`)
    .all(...ids) as any[]) {
    (links.get(k.tweet_id) ?? links.set(k.tweet_id, []).get(k.tweet_id)!).push({ url: k.url, display_url: k.display_url });
  }
  const byId = new Map<string, any>(rows.map((r) => [r.tweet_id, r]));
  const out: ResultTweet[] = ids
    .map((id) => byId.get(id))
    .filter(Boolean)
    .map((r) => ({
      tweet_id: r.tweet_id,
      text: r.text ?? r.archive_text ?? null,
      author_name: r.author_name ?? null,
      author_handle: r.author_handle ?? null,
      author_avatar: r.author_avatar ?? null,
      created_at: r.created_at ?? null,
      url: r.url ?? r.expanded_url ?? null,
      expanded_url: r.expanded_url ?? null,
      favorite_count: r.favorite_count ?? null,
      liked_order: r.liked_order,
      hydration: r.hydration,
      media: media.get(r.tweet_id) ?? [],
      links: links.get(r.tweet_id) ?? [],
    }));
  attachExtras(out);
  return out;
}

// ── hybrid (keyword + semantic) search ────────────────────────────────────────

/** Ids allowed by the non-text filters, or null when there are no such filters. */
function filterUniverse(p: SearchParams): Set<string> | null {
  const where: string[] = [];
  const args: Record<string, unknown> = {};
  if (p.author) {
    where.push(`t.author_handle = @author COLLATE NOCASE`);
    args.author = p.author.replace(/^@/, "");
  }
  if (p.hasImage) where.push(`EXISTS (SELECT 1 FROM media m WHERE m.tweet_id=l.tweet_id)`);
  if (p.hasLink) where.push(`EXISTS (SELECT 1 FROM links k WHERE k.tweet_id=l.tweet_id)`);
  if (p.tag) {
    where.push(`EXISTS (SELECT 1 FROM like_tags lt JOIN tags tg ON tg.id=lt.tag_id WHERE lt.tweet_id=l.tweet_id AND tg.slug=@tag)`);
    args.tag = p.tag;
  }
  if (where.length === 0) return null;
  const rows = db()
    .prepare(`SELECT l.tweet_id FROM likes l LEFT JOIN tweets t ON t.tweet_id=l.tweet_id WHERE ${where.join(" AND ")}`)
    .all(args) as { tweet_id: string }[];
  return new Set(rows.map((r) => r.tweet_id));
}

/** Keyword-ranked ids across both FTS surfaces (best bm25 wins). */
function keywordRankedIds(match: string, allowed: Set<string> | null): string[] {
  const rows = db()
    .prepare(
      `SELECT tweet_id, min(rank) AS rank FROM (
         SELECT tweet_id, bm25(search) AS rank FROM search WHERE search MATCH @m
         UNION ALL
         SELECT tweet_id, bm25(enriched_fts) AS rank FROM enriched_fts WHERE enriched_fts MATCH @m
       ) GROUP BY tweet_id ORDER BY rank ASC`
    )
    .all({ m: match }) as { tweet_id: string; rank: number }[];
  const ids = rows.map((r) => r.tweet_id);
  return allowed ? ids.filter((id) => allowed.has(id)) : ids;
}

/** Semantic-ranked ids by cosine to the query vector (brute force). */
function semanticRankedIds(qv: Float32Array, allowed: Set<string> | null): string[] {
  const rows = db().prepare(`SELECT tweet_id, vec FROM embeddings`).all() as { tweet_id: string; vec: Buffer }[];
  const scored: { id: string; s: number }[] = [];
  for (const r of rows) {
    if (allowed && !allowed.has(r.tweet_id)) continue;
    scored.push({ id: r.tweet_id, s: cosine(qv, unpackVec(r.vec)) });
  }
  scored.sort((a, b) => b.s - a.s);
  return scored.map((x) => x.id);
}

/** Reciprocal-rank fusion of several ranked id lists. */
function fuseRRF(lists: string[][], k = 60): string[] {
  const score = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, i) => score.set(id, (score.get(id) ?? 0) + 1 / (k + i)));
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}

/**
 * Hybrid search. With a query and existing embeddings it fuses keyword + semantic
 * ranking (so it finds likes by meaning, not just words); otherwise it falls back
 * to the plain keyword/browse search. Non-relevance sorts use the keyword path.
 */
export async function searchHybrid(params: SearchParams): Promise<SearchResponse & { mode: string }> {
  const wantsRelevance = !params.sort || params.sort === "relevance";
  if (!params.q || !wantsRelevance) return { ...search(params), mode: params.q ? "keyword" : "browse" };

  const d = db();
  const haveEmb = (d.prepare(`SELECT COUNT(*) n FROM embeddings`).get() as { n: number }).n > 0;
  const match = toMatch(params.q);
  const allowed = filterUniverse(params);

  const kw = match ? keywordRankedIds(match, allowed) : [];
  const sem = haveEmb ? semanticRankedIds(await embedQuery(params.q), allowed).slice(0, 300) : [];

  let ordered: string[];
  let mode: string;
  if (kw.length && sem.length) {
    ordered = fuseRRF([kw, sem]);
    mode = "hybrid";
  } else if (kw.length) {
    ordered = kw;
    mode = "keyword";
  } else {
    ordered = sem;
    mode = "semantic";
  }

  const limit = Math.min(Math.max(params.limit ?? 30, 1), 200);
  const offset = Math.max(params.offset ?? 0, 0);
  return { total: ordered.length, results: hydrateIds(ordered.slice(offset, offset + limit)), mode };
}

async function embedQuery(q: string): Promise<Float32Array> {
  const { vectors } = await embed([q]);
  return vectors[0]!;
}

// ── enriched single record + tag/related surfaces ─────────────────────────────

export interface FullLike extends ResultTweet {
  articles: { url: string; final_url: string | null; title: string | null; site_name: string | null; excerpt: string | null; text: string | null; word_count: number | null }[];
  vision: { remote_url: string; caption: string | null; ocr_text: string | null; labels: string | null }[];
  tags: { slug: string; label: string; kind: string }[];
}

/** A single like with all enrichment attached (for MCP like_get / read_article). */
export function getLikeFull(tweetId: string): FullLike | null {
  const base = getLike(tweetId);
  if (!base) return null;
  const d = db();
  return {
    ...base,
    articles: d
      .prepare(`SELECT url, final_url, title, site_name, excerpt, text, word_count FROM article_extracts WHERE tweet_id = ?`)
      .all(tweetId) as FullLike["articles"],
    vision: d
      .prepare(`SELECT remote_url, caption, ocr_text, labels FROM media_vision WHERE tweet_id = ?`)
      .all(tweetId) as FullLike["vision"],
    tags: d
      .prepare(`SELECT tg.slug, tg.label, tg.kind FROM like_tags lt JOIN tags tg ON tg.id = lt.tag_id WHERE lt.tweet_id = ? ORDER BY tg.kind, tg.label`)
      .all(tweetId) as FullLike["tags"],
  };
}

export interface TagCount {
  slug: string;
  label: string;
  kind: string;
  count: number;
}

export function listTags(limit = 100): TagCount[] {
  return db()
    .prepare(
      `SELECT tg.slug, tg.label, tg.kind, COUNT(*) AS count
       FROM tags tg JOIN like_tags lt ON lt.tag_id = tg.id
       GROUP BY tg.id ORDER BY count DESC, tg.label ASC LIMIT ?`
    )
    .all(limit) as TagCount[];
}

export function likesByTag(slug: string, limit = 50): ResultTweet[] {
  const ids = (
    db()
      .prepare(
        `SELECT l.tweet_id FROM likes l
         JOIN like_tags lt ON lt.tweet_id = l.tweet_id
         JOIN tags tg ON tg.id = lt.tag_id
         WHERE tg.slug = ? ORDER BY l.liked_order ASC LIMIT ?`
      )
      .all(slug, limit) as { tweet_id: string }[]
  ).map((r) => r.tweet_id);
  return hydrateIds(ids);
}

/** Related likes — by embedding neighborhood, falling back to shared tags. */
export function relatedTo(tweetId: string, limit = 10): ResultTweet[] {
  const d = db();
  const self = d.prepare(`SELECT vec FROM embeddings WHERE tweet_id = ?`).get(tweetId) as { vec: Buffer } | undefined;
  if (self) {
    const qv = unpackVec(self.vec);
    const ids = semanticRankedIds(qv, null)
      .filter((id) => id !== tweetId)
      .slice(0, limit);
    if (ids.length) return hydrateIds(ids);
  }
  const ids = (
    d
      .prepare(
        `SELECT other.tweet_id, COUNT(*) shared
         FROM like_tags mine
         JOIN like_tags other ON other.tag_id = mine.tag_id AND other.tweet_id != mine.tweet_id
         WHERE mine.tweet_id = ?
         GROUP BY other.tweet_id ORDER BY shared DESC, other.tweet_id LIMIT ?`
      )
      .all(tweetId, limit) as { tweet_id: string }[]
  ).map((r) => r.tweet_id);
  return hydrateIds(ids);
}
