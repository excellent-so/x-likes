import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import { db } from "./db.js";
import { eachWithWorkers, markStage, reindexAll, selectPending, type PendingOpts } from "./enrichment.js";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const TIMEOUT_MS = 15000;

/** Links we should not treat as articles (self-links, raw media). */
function isArticleUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).host.replace(/^www\./, "");
  } catch {
    return false;
  }
  if (/(^|\.)(twitter\.com|x\.com|t\.co|pic\.twitter\.com)$/.test(host)) return false;
  if (/\.(jpg|jpeg|png|gif|webp|mp4|mov|mp3|zip|dmg)(\?|$)/i.test(url)) return false;
  return true;
}

interface Fetched {
  html: string;
  finalUrl: string;
}

async function fetchHtml(url: string): Promise<Fetched> {
  // Local fixtures (used by the mock archive) are read straight off disk.
  if (url.startsWith("file://")) {
    return { html: readFileSync(fileURLToPath(url), "utf8"), finalUrl: url };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml" },
    });
    if (!res.ok) throw new Error(`http ${res.status}`);
    const ct = res.headers.get("content-type") ?? "";
    if (!/text\/html|xml/.test(ct)) throw new Error(`not html (${ct.split(";")[0]})`);
    return { html: await res.text(), finalUrl: res.url || url };
  } finally {
    clearTimeout(timer);
  }
}

interface Extracted {
  title: string | null;
  byline: string | null;
  siteName: string | null;
  excerpt: string | null;
  text: string | null;
  leadImage: string | null;
  wordCount: number;
  lang: string | null;
}

function extract(html: string, finalUrl: string): Extracted | null {
  const vc = new VirtualConsole(); // swallow the page's console noise
  const dom = new JSDOM(html, { url: finalUrl, virtualConsole: vc });
  const doc = dom.window.document;
  const leadImage =
    doc.querySelector('meta[property="og:image"]')?.getAttribute("content") ??
    doc.querySelector('meta[name="twitter:image"]')?.getAttribute("content") ??
    null;
  const lang = doc.documentElement.getAttribute("lang");
  const art = new Readability(doc).parse();
  if (!art || !art.textContent || art.textContent.trim().length < 200) return null;
  const text = art.textContent.replace(/\n{3,}/g, "\n\n").trim();
  return {
    title: art.title ?? null,
    byline: art.byline ?? null,
    siteName: art.siteName ?? null,
    excerpt: art.excerpt ?? null,
    text,
    leadImage,
    wordCount: text.split(/\s+/).length,
    lang: art.lang ?? lang ?? null,
  };
}

export interface ArticleReport {
  attempted: number;
  ok: number;
  skip: number;
  /** every link is dead (404 or 410): nothing to retry */
  gone: number;
  error: number;
  articles: number;
}

const DEAD = /^http (404|410)$/;

async function processTweet(tweetId: string): Promise<"ok" | "skip" | "gone" | "error"> {
  const d = db();
  const links = (
    d.prepare(`SELECT url FROM links WHERE tweet_id = ?`).all(tweetId) as { url: string }[]
  )
    .map((r) => r.url)
    .filter(isArticleUrl);

  if (links.length === 0) {
    markStage(d, tweetId, "article", { status: "skip" });
    return "skip";
  }

  let got = 0;
  let dead = 0;
  let lastErr = "";
  const ins = d.prepare(
    `INSERT INTO article_extracts
       (tweet_id, url, final_url, title, byline, site_name, excerpt, text, lead_image, word_count, lang)
     VALUES (@tweet_id, @url, @final_url, @title, @byline, @site_name, @excerpt, @text, @lead_image, @word_count, @lang)
     ON CONFLICT(tweet_id, url) DO UPDATE SET
       final_url=excluded.final_url, title=excluded.title, byline=excluded.byline,
       site_name=excluded.site_name, excerpt=excluded.excerpt, text=excluded.text,
       lead_image=excluded.lead_image, word_count=excluded.word_count, lang=excluded.lang,
       fetched_at=datetime('now')`
  );

  for (const url of links) {
    try {
      const { html, finalUrl } = await fetchHtml(url);
      const ex = extract(html, finalUrl);
      if (!ex) {
        lastErr = "no readable content";
        continue;
      }
      ins.run({
        tweet_id: tweetId,
        url,
        final_url: finalUrl,
        title: ex.title,
        byline: ex.byline,
        site_name: ex.siteName,
        excerpt: ex.excerpt,
        text: ex.text,
        lead_image: ex.leadImage,
        word_count: ex.wordCount,
        lang: ex.lang,
      });
      got++;
    } catch (e) {
      lastErr = (e as Error).message;
      if (DEAD.test(lastErr)) dead++;
    }
  }

  if (got > 0) {
    markStage(d, tweetId, "article", { status: "ok" });
    reindexAll(tweetId);
    return "ok";
  }
  if (dead === links.length) {
    markStage(d, tweetId, "article", { status: "gone", error: lastErr });
    return "gone";
  }
  markStage(d, tweetId, "article", { status: "error", error: lastErr || "fetch failed" });
  return "error";
}

export async function enrichArticles(
  opts: PendingOpts & { concurrency?: number; onProgress?: (d: number, t: number) => void } = {}
): Promise<ArticleReport> {
  const ids = selectPending(
    "article",
    `JOIN links k ON k.tweet_id = l.tweet_id`,
    `1`,
    opts
  );
  const report: ArticleReport = { attempted: ids.length, ok: 0, skip: 0, gone: 0, error: 0, articles: 0 };
  let done = 0;
  await eachWithWorkers(ids, opts.concurrency ?? 4, async (id) => {
    report[await processTweet(id)]++;
    done++;
    opts.onProgress?.(done, ids.length);
  });
  report.articles = (db().prepare(`SELECT COUNT(*) n FROM article_extracts`).get() as { n: number }).n;
  return report;
}
