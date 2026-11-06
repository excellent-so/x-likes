/**
 * Client for X's public embed endpoint (cdn.syndication.twimg.com) — the same
 * unauthenticated API that powers embedded tweets and Vercel's react-tweet.
 * It returns full tweet JSON (text, author, media, links) for public tweets
 * with no login and no API key.
 */

const FEATURES =
  "tfw_timeline_list:;tfw_follower_count_sunset:true;tfw_tweet_edit_backend:on;" +
  "tfw_refsrc_session:on;tfw_fosnr_soft_downgrade:on;tfw_show_birdwatch_pivots_enabled:on;" +
  "tfw_show_business_verified_badge:on;tfw_duplicate_scribes_to_settings:on;" +
  "tfw_use_profile_image_shape_enabled:on;tfw_show_blue_verified_badge:on;" +
  "tfw_legacy_timeline_sunset:true;tfw_show_gov_verified_badge:on;" +
  "tfw_show_business_affiliate_badge:on;tfw_tweet_edit_frontend:on";

/** Deterministic token derived from the tweet id (same algorithm as react-tweet). */
function tokenFor(id: string): string {
  return ((Number(id) / 1e15) * Math.PI)
    .toString(6 ** 2) // base 36
    .replace(/(0+|\.)/g, "");
}

export interface SynMedia {
  kind: "photo" | "video" | "animated_gif";
  remote_url: string;
  video_url?: string;
  width?: number;
  height?: number;
  alt?: string;
}

export interface SynTweet {
  tweet_id: string;
  author_name: string | null;
  author_handle: string | null;
  author_avatar_url: string | null;
  text: string | null;
  created_at: string | null;
  lang: string | null;
  url: string | null;
  quoted_tweet_id: string | null;
  quoted_text: string | null;
  quoted_handle: string | null;
  favorite_count: number | null;
  is_reply: boolean;
  possibly_sensitive: boolean;
  media: SynMedia[];
  links: { url: string; display_url: string | null }[];
  raw: unknown;
}

export type HydrateOutcome =
  | { status: "ok"; tweet: SynTweet }
  | { status: "gone" } // deleted / protected / suspended — nothing to fetch
  | { status: "error"; error: string };

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function extractMedia(raw: any): SynMedia[] {
  const out: SynMedia[] = [];
  const details: any[] = Array.isArray(raw?.mediaDetails) ? raw.mediaDetails : [];
  for (const m of details) {
    const kind: SynMedia["kind"] =
      m?.type === "video" ? "video" : m?.type === "animated_gif" ? "animated_gif" : "photo";
    let video_url: string | undefined;
    if (kind !== "photo") {
      const variants: any[] = m?.video_info?.variants ?? [];
      const mp4s = variants
        .filter((v) => v?.content_type === "video/mp4" && v?.url)
        .sort((a, b) => (b?.bitrate ?? 0) - (a?.bitrate ?? 0));
      video_url = mp4s[0]?.url;
    }
    if (m?.media_url_https) {
      out.push({
        kind,
        remote_url: m.media_url_https,
        video_url,
        width: m?.original_info?.width,
        height: m?.original_info?.height,
        alt: m?.ext_alt_text ?? undefined,
      });
    }
  }
  // Fallback for the simpler `photos` array if mediaDetails was empty.
  if (out.length === 0 && Array.isArray(raw?.photos)) {
    for (const p of raw.photos) {
      if (p?.url) out.push({ kind: "photo", remote_url: p.url, width: p?.width, height: p?.height });
    }
  }
  return out;
}

function extractLinks(raw: any): { url: string; display_url: string | null }[] {
  const urls: any[] = raw?.entities?.urls ?? [];
  const seen = new Set<string>();
  const out: { url: string; display_url: string | null }[] = [];
  for (const u of urls) {
    const url = u?.expanded_url;
    if (url && !seen.has(url)) {
      seen.add(url);
      out.push({ url, display_url: u?.display_url ?? null });
    }
  }
  return out;
}

export async function hydrateTweet(id: string, signal?: AbortSignal): Promise<HydrateOutcome> {
  const url = new URL("https://cdn.syndication.twimg.com/tweet-result");
  url.searchParams.set("id", id);
  url.searchParams.set("token", tokenFor(id));
  url.searchParams.set("lang", "en");
  url.searchParams.set("features", FEATURES);

  let res: Response;
  try {
    res = await fetch(url, {
      signal,
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
  } catch (e) {
    return { status: "error", error: `network: ${(e as Error).message}` };
  }

  // 400 (invalid id) / 403 (protected/suspended) / 404 (deleted) are all
  // permanent — no point retrying. Everything else is a transient error.
  if (res.status === 400 || res.status === 403 || res.status === 404) return { status: "gone" };
  if (!res.ok) return { status: "error", error: `http ${res.status}` };

  let raw: any;
  try {
    raw = await res.json();
  } catch {
    // A tombstone (deleted tweet) sometimes comes back as empty/HTML.
    return { status: "gone" };
  }

  if (!raw || raw.__typename === "TweetTombstone" || (!raw.text && !raw.mediaDetails)) {
    return { status: "gone" };
  }

  const tweet: SynTweet = {
    tweet_id: id,
    author_name: raw?.user?.name ?? null,
    author_handle: raw?.user?.screen_name ?? null,
    author_avatar_url: raw?.user?.profile_image_url_https ?? null,
    text: raw?.text ?? null,
    created_at: raw?.created_at ?? null,
    lang: raw?.lang ?? null,
    url:
      raw?.user?.screen_name && id
        ? `https://x.com/${raw.user.screen_name}/status/${id}`
        : null,
    quoted_tweet_id: raw?.quoted_tweet?.id_str ?? null,
    quoted_text: raw?.quoted_tweet?.text ?? null,
    quoted_handle: raw?.quoted_tweet?.user?.screen_name ?? null,
    favorite_count: typeof raw?.favorite_count === "number" ? raw.favorite_count : null,
    is_reply: Boolean(raw?.in_reply_to_screen_name),
    possibly_sensitive: Boolean(raw?.possibly_sensitive),
    media: extractMedia(raw),
    links: extractLinks(raw),
    raw,
  };
  return { status: "ok", tweet };
}
