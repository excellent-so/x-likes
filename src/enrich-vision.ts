import { existsSync } from "node:fs";
import { join } from "node:path";
import { AiSetupError, describeImage } from "./ai.js";
import { db, MEDIA_DIR } from "./db.js";
import { eachWithWorkers, markStage, reindexAll, selectPending, type PendingOpts } from "./enrichment.js";

export interface VisionReport {
  attempted: number;
  ok: number;
  skip: number;
  error: number;
  images: number;
  cost: number;
}

interface MediaRow {
  remote_url: string;
  local_path: string | null;
  alt: string | null;
}

async function processTweet(tweetId: string): Promise<{ status: "ok" | "skip" | "error"; cost: number; images: number }> {
  const d = db();
  const ctx = d
    .prepare(
      `SELECT COALESCE(t.text, l.archive_text, '') AS text, t.author_name AS author
       FROM likes l LEFT JOIN tweets t ON t.tweet_id = l.tweet_id WHERE l.tweet_id = ?`
    )
    .get(tweetId) as { text: string; author: string | null };
  const media = d
    .prepare(`SELECT remote_url, local_path, alt FROM media WHERE tweet_id = ? AND local_path IS NOT NULL`)
    .all(tweetId) as MediaRow[];

  if (media.length === 0) {
    markStage(d, tweetId, "vision", { status: "skip" });
    return { status: "skip", cost: 0, images: 0 };
  }

  const ins = d.prepare(
    `INSERT INTO media_vision (tweet_id, remote_url, caption, ocr_text, labels, model)
     VALUES (@tweet_id, @remote_url, @caption, @ocr_text, @labels, @model)
     ON CONFLICT(tweet_id, remote_url) DO UPDATE SET
       caption=excluded.caption, ocr_text=excluded.ocr_text, labels=excluded.labels,
       model=excluded.model, created_at=datetime('now')`
  );

  let cost = 0;
  let done = 0;
  let model = "";
  let lastErr = "";
  for (const m of media) {
    const abs = join(MEDIA_DIR, m.local_path!);
    if (!existsSync(abs)) {
      lastErr = "file missing";
      continue;
    }
    try {
      const v = await describeImage(abs, { alt: m.alt, tweetText: ctx.text, author: ctx.author });
      cost += v.cost;
      model = v.model;
      ins.run({
        tweet_id: tweetId,
        remote_url: m.remote_url,
        caption: v.caption,
        ocr_text: v.ocr_text,
        labels: v.labels,
        model: v.model,
      });
      done++;
    } catch (e) {
      if (e instanceof AiSetupError) throw e; // not this like's fault: stop, and leave it pending
      lastErr = (e as Error).message;
    }
  }

  if (done > 0) {
    markStage(d, tweetId, "vision", { status: "ok", cost, model });
    reindexAll(tweetId);
    return { status: "ok", cost, images: done };
  }
  markStage(d, tweetId, "vision", { status: "error", error: lastErr || "vision failed", cost });
  return { status: "error", cost, images: 0 };
}

export async function enrichVision(
  opts: PendingOpts & { concurrency?: number; onProgress?: (d: number, t: number) => void } = {}
): Promise<VisionReport> {
  const ids = selectPending(
    "vision",
    `JOIN media m ON m.tweet_id = l.tweet_id`,
    `m.local_path IS NOT NULL`,
    opts
  );
  const report: VisionReport = { attempted: ids.length, ok: 0, skip: 0, error: 0, images: 0, cost: 0 };
  let done = 0;
  await eachWithWorkers(ids, opts.concurrency ?? 3, async (id) => {
    const r = await processTweet(id);
    report[r.status]++;
    report.images += r.images;
    report.cost += r.cost;
    done++;
    opts.onProgress?.(done, ids.length);
  });
  return report;
}
