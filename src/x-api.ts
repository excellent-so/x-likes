/**
 * Optional likes source: the X API v2 `liked_tweets` endpoint via OAuth 1.0a
 * user context. This is the "keep current" path — it pulls your recent likes
 * directly, no archive download. It requires the app to be attached to a v2
 * Project (developer portal) and a tier that permits reading likes.
 *
 * Full history still comes from the archive; the API returns recent likes only.
 */
import crypto from "node:crypto";
import { X, xConfigured } from "./config.js";
import { db } from "./db.js";

const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

function oauthHeader(method: string, url: string, params: Record<string, string>): string {
  const o: Record<string, string> = {
    oauth_consumer_key: X.apiKey,
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: X.accessToken,
    oauth_version: "1.0",
  };
  const all = { ...params, ...o };
  const pstr = Object.keys(all)
    .sort()
    .map((k) => `${enc(k)}=${enc(all[k]!)}`)
    .join("&");
  const base = [method, enc(url), enc(pstr)].join("&");
  o.oauth_signature = crypto.createHmac("sha1", `${enc(X.apiSecret)}&${enc(X.accessSecret)}`).update(base).digest("base64");
  return "OAuth " + Object.keys(o).sort().map((k) => `${enc(k)}="${enc(o[k]!)}"`).join(", ");
}

async function get(path: string, query: Record<string, string>): Promise<{ status: number; json: any; text: string }> {
  const url = `https://api.twitter.com${path}`;
  const qs = new URLSearchParams(query).toString();
  const res = await fetch(`${url}?${qs}`, { headers: { Authorization: oauthHeader("GET", url, query) } });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-json */
  }
  return { status: res.status, json, text };
}

export interface AccessResult {
  configured: boolean;
  ok: boolean;
  status: number;
  reason: string;
  hint: string;
}

/** One read-only call that reports exactly why likes reading does or doesn't work. */
export async function checkAccess(): Promise<AccessResult> {
  if (!xConfigured()) {
    return { configured: false, ok: false, status: 0, reason: "no credentials", hint: "fill in .env" };
  }
  const { status, json, text } = await get(`/2/users/${X.userId}/liked_tweets`, { max_results: "5" });
  if (status === 200) {
    return { configured: true, ok: true, status, reason: `ok — ${json?.meta?.result_count ?? 0} likes visible`, hint: "run: pnpm cli fetch-likes" };
  }
  const detail: string = json?.detail ?? json?.title ?? text.slice(0, 160);
  let hint = "";
  if (/client-not-enrolled|attached to a .*Project/i.test(detail))
    hint = "Attach the app to a v2 Project in the developer portal, then retry.";
  else if (/Usage cap|not entitled|access level|Consumer/i.test(detail))
    hint = "Your API tier can't read likes: it needs a paid tier that includes them (see the developer portal).";
  else if (status === 429) hint = "Rate limited — wait 15 minutes and retry.";
  return { configured: true, ok: false, status, reason: detail, hint };
}

export interface FetchReport {
  fetched: number;
  inserted: number;
  pages: number;
  stopped: string;
}

/**
 * Pull recent likes via the API into the `likes` table (same shape the archive
 * importer produces), so a normal `pnpm hydrate` + `pnpm enrich` finishes them.
 */
export async function fetchLikes(opts: { max?: number; onPage?: (n: number, total: number) => void } = {}): Promise<FetchReport> {
  if (!xConfigured()) throw new Error("X API not configured — fill in .env");
  const max = opts.max ?? 200;
  const report: FetchReport = { fetched: 0, inserted: 0, pages: 0, stopped: "done" };

  const collected: { id: string; text: string }[] = [];
  let token: string | undefined;
  while (collected.length < max) {
    const query: Record<string, string> = {
      max_results: String(Math.min(100, max - collected.length)),
      "tweet.fields": "created_at",
    };
    if (token) query.pagination_token = token;
    const { status, json, text } = await get(`/2/users/${X.userId}/liked_tweets`, query);
    report.pages++;
    if (status === 429) {
      report.stopped = "rate-limited (retry in ~15m)";
      break;
    }
    if (status !== 200) throw new Error(`X API ${status}: ${json?.detail ?? text.slice(0, 160)}`);
    for (const t of json?.data ?? []) collected.push({ id: t.id, text: t.text ?? "" });
    opts.onPage?.(report.pages, collected.length);
    token = json?.meta?.next_token;
    if (!token) {
      report.stopped = "no more pages";
      break;
    }
  }
  report.fetched = collected.length;

  // Assign liked_order so newest (first fetched) sorts first, ahead of existing.
  const d = db();
  const min = (d.prepare(`SELECT MIN(liked_order) AS m FROM likes`).get() as { m: number | null }).m ?? 0;
  const insert = d.prepare(
    `INSERT INTO likes (tweet_id, archive_text, expanded_url, liked_order)
     VALUES (@id, @text, @url, @order) ON CONFLICT(tweet_id) DO NOTHING`
  );
  const ensureState = d.prepare(
    `INSERT INTO hydration_state (tweet_id, status) VALUES (?, 'pending') ON CONFLICT(tweet_id) DO NOTHING`
  );
  const tx = d.transaction(() => {
    collected.forEach((t, i) => {
      const info = insert.run({
        id: t.id,
        text: t.text,
        url: `https://x.com/i/web/status/${t.id}`,
        order: min - (collected.length - i),
      });
      if (info.changes > 0) {
        report.inserted++;
        ensureState.run(t.id);
      }
    });
  });
  tx();
  return report;
}
