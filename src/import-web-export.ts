/**
 * Import a likes export from the open-source userscript
 * `prinsss/twitter-web-exporter` (or any similar JSON dump of tweets).
 *
 * The exporter captures X's own GraphQL responses, so each record already
 * carries the full tweet — author, text, media, links. We therefore FULLY
 * hydrate from the file (reusing hydrate's persist path to download media and
 * write tweets/media/links), with no syndication round-trip. Records that lack
 * the rich fields are inserted as bare likes and left for `pnpm hydrate`.
 *
 * The normalizer is deliberately tolerant: it accepts a top-level array or an
 * object wrapper, and each record in either flattened form or raw GraphQL
 * (`legacy` / `core.user_results…`) shape. The exporter's own JSON is the
 * flattened form (id, full_text, screen_name, name, profile_image_url, media
 * with thumbnail/original), plus the raw GraphQL tweet under `metadata` when
 * "Include all metadata" is on: only that carries the tweet's links.
 */
import { existsSync, readFileSync } from "node:fs";
import { db } from "./db.js";
import { persistTweet } from "./hydrate.js";
import type { SynMedia, SynTweet } from "./syndication.js";

function first<T>(...vals: (T | undefined | null)[]): T | undefined {
  for (const v of vals) if (v !== undefined && v !== null && v !== "") return v;
  return undefined;
}
function toIso(s: unknown): string | null {
  if (typeof s !== "string" || !s) return null;
  const d = new Date(s);
  return isNaN(+d) ? s : d.toISOString();
}

function mapMedia(arr: any): SynMedia[] {
  if (!Array.isArray(arr)) return [];
  const out: SynMedia[] = [];
  for (const m of arr) {
    if (typeof m === "string") {
      out.push({ kind: "photo", remote_url: m });
      continue;
    }
    if (!m) continue;
    const kind: SynMedia["kind"] =
      m.type === "video" ? "video" : m.type === "animated_gif" ? "animated_gif" : "photo";
    // NOTE: never use m.url — in GraphQL that's the t.co link, not the image.
    // For a video the exporter's `original` is the mp4 itself, so the poster comes from `thumbnail` (asked for at
    // full size rather than the 150 px thumb).
    const poster = typeof m.thumbnail === "string" ? m.thumbnail.replace(/([?&])name=thumb(&|$)/, "$1").replace(/[?&]$/, "") : undefined;
    const remote =
      kind === "photo"
        ? first<string>(m.media_url_https, m.media_url, m.src, m.original, m.thumbnail)
        : first<string>(m.media_url_https, m.media_url, m.src, poster);
    if (!remote) continue;
    let video_url: string | undefined;
    if (kind !== "photo") {
      const variants: any[] = m.video_info?.variants ?? m.variants ?? [];
      const mp4 = variants
        .filter((v) => v && v.url && (v.content_type === "video/mp4" || /\.mp4/.test(v.url)))
        .sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
      video_url = mp4[0]?.url ?? m.video_url ?? (/\.mp4(\?|$)/.test(m.original ?? "") ? m.original : undefined);
    }
    out.push({
      kind,
      remote_url: remote,
      video_url,
      width: m.original_info?.width ?? m.width,
      height: m.original_info?.height ?? m.height,
      alt: m.ext_alt_text ?? m.alt ?? undefined,
    });
  }
  return out;
}

function mapLinks(arr: any): { url: string; display_url: string | null }[] {
  if (!Array.isArray(arr)) return [];
  const out: { url: string; display_url: string | null }[] = [];
  const seen = new Set<string>();
  for (const u of arr) {
    const url = typeof u === "string" ? u : first<string>(u?.expanded_url, u?.url, u?.expanded);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, display_url: typeof u === "string" ? null : u?.display_url ?? null });
  }
  return out;
}

interface Normalized {
  id: string;
  text: string | null;
  expandedUrl: string | null;
  syn: SynTweet | null; // present when the record is rich enough to fully hydrate
}

function normalize(item: any): Normalized | null {
  if (!item || typeof item !== "object") return null;
  // twitter-web-exporter keeps the raw GraphQL tweet under `metadata` when "Include all metadata" is on.
  const G = item.metadata && typeof item.metadata === "object" ? item.metadata : null;
  const L = item.legacy ?? G?.legacy ?? item; // GraphQL nests content under `legacy`
  const R = (item.core ?? G?.core)?.user_results?.result; // the author, in GraphQL
  // X moved screen_name and name from `result.legacy` to `result.core`; read both.
  const u = { ...(R?.legacy ?? item.user?.legacy ?? item.user ?? item.author ?? {}), ...(R?.core ?? {}) };

  const id = first<string>(item.rest_id, item.id_str, L.id_str, item.id, item.tweet_id, item.tweetId);
  if (!id) return null;
  const idStr = String(id);
  const text = first<string>(
    item.note_tweet?.note_tweet_results?.result?.text,
    G?.note_tweet?.note_tweet_results?.result?.text,
    item.full_text, // the exporter's full_text is already the whole long-form text
    L.full_text,
    item.text,
    L.text
  ) ?? null;
  const handle = first<string>(u.screen_name, item.screen_name, item.username, item.user_screen_name);
  const name = first<string>(u.name, item.name, item.user_name, item.author_name);
  const expandedUrl =
    first<string>(item.url, item.tweet_url) ??
    (handle ? `https://x.com/${handle}/status/${idStr}` : `https://x.com/i/web/status/${idStr}`);

  // Rich enough to hydrate directly?
  const syn: SynTweet | null = handle
    ? {
        tweet_id: idStr,
        author_name: name ?? null,
        author_handle: handle,
        author_avatar_url:
          first<string>(
            R?.avatar?.image_url,
            u.profile_image_url_https,
            item.profile_image_url_https,
            item.profile_image_url,
            item.avatar
          ) ?? null,
        text,
        created_at: toIso(first(L.created_at, item.created_at)),
        lang: first<string>(L.lang, item.lang) ?? null,
        url: expandedUrl,
        quoted_tweet_id: first<string>(item.quoted_status_id_str, L.quoted_status_id_str) ?? null,
        quoted_text: null,
        quoted_handle: null,
        favorite_count:
          Number(first(L.favorite_count, item.favorite_count, item.favorites, item.like_count)) || null,
        is_reply: Boolean(first(L.in_reply_to_screen_name, item.in_reply_to_screen_name)),
        possibly_sensitive: Boolean(first(L.possibly_sensitive, item.possibly_sensitive)),
        media: mapMedia(
          first(L.extended_entities?.media, item.extended_entities?.media, L.entities?.media, item.media, item.photos)
        ),
        links: mapLinks(first(L.entities?.urls, item.entities?.urls, item.urls)),
        raw: item,
      }
    : null;

  return { id: idStr, text, expandedUrl, syn };
}

export interface WebExportReport {
  records: number;
  inserted: number;
  hydrated: number;
  pending: number;
  failed: number;
}

export async function importWebExport(
  path: string,
  opts: { concurrency?: number; onProgress?: (d: number, t: number) => void } = {}
): Promise<WebExportReport> {
  if (!existsSync(path)) throw new Error(`File not found: ${path}`);
  let parsed: any;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`${path} isn't valid JSON (${(e as Error).message}). Export your likes from twitter-web-exporter as JSON.`);
  }
  const items: any[] = Array.isArray(parsed)
    ? parsed
    : parsed.data ?? parsed.tweets ?? parsed.likes ?? parsed.results ?? parsed.records ?? [];
  if (!Array.isArray(items)) throw new Error(`Could not find a list of tweets in ${path}. Is it a twitter-web-exporter JSON export?`);

  const d = db();
  const insertLike = d.prepare(
    `INSERT INTO likes (tweet_id, archive_text, expanded_url, liked_order)
     VALUES (@id, @text, @url, @order) ON CONFLICT(tweet_id) DO NOTHING`
  );
  const ensureState = d.prepare(
    `INSERT INTO hydration_state (tweet_id, status) VALUES (?, 'pending') ON CONFLICT(tweet_id) DO NOTHING`
  );

  const report: WebExportReport = { records: items.length, inserted: 0, hydrated: 0, pending: 0, failed: 0 };
  const min = (d.prepare(`SELECT MIN(liked_order) AS m FROM likes`).get() as { m: number | null }).m ?? 0;
  const toPersist: SynTweet[] = [];

  const tx = d.transaction(() => {
    items.forEach((item, i) => {
      const n = normalize(item);
      if (!n) return;
      const info = insertLike.run({ id: n.id, text: n.text, url: n.expandedUrl, order: min - (items.length - i) });
      ensureState.run(n.id);
      if (info.changes > 0) {
        report.inserted++;
        if (n.syn) toPersist.push(n.syn);
        else report.pending++;
      }
    });
  });
  tx();

  // Fully hydrate the rich records (downloads media, writes tweets/media/links).
  let cursor = 0;
  let done = 0;
  const concurrency = Math.max(1, opts.concurrency ?? 5);
  async function worker() {
    while (cursor < toPersist.length) {
      const syn = toPersist[cursor++]!;
      try {
        await persistTweet(syn);
        report.hydrated++;
      } catch {
        report.failed++;
        report.pending++; // leave it for `pnpm hydrate`
      }
      done++;
      opts.onProgress?.(done, toPersist.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, toPersist.length) }, worker));
  return report;
}
