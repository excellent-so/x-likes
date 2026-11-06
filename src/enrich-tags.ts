import { AiSetupError, generateTags } from "./ai.js";
import { db } from "./db.js";
import { attachTag, buildDoc, eachWithWorkers, markStage, reindexAll, selectPending, type PendingOpts } from "./enrichment.js";

export interface TagReport {
  attempted: number;
  ok: number;
  skip: number;
  error: number;
  cost: number;
  distinctTags: number;
}

async function processTweet(tweetId: string): Promise<{ status: "ok" | "skip" | "error"; cost: number }> {
  const d = db();
  const doc = buildDoc(tweetId);
  if (doc.replace(/\s/g, "").length < 8) {
    markStage(d, tweetId, "tags", { status: "skip" });
    return { status: "skip", cost: 0 };
  }
  try {
    const r = await generateTags(doc);
    const tx = d.transaction(() => {
      // Replace this tweet's machine tags so re-runs don't accumulate stale ones.
      d.prepare(`DELETE FROM like_tags WHERE tweet_id = ? AND source = 'llm'`).run(tweetId);
      for (const topic of r.topics) attachTag(d, tweetId, topic, "topic");
      for (const e of r.entities) attachTag(d, tweetId, e.name, e.kind);
      markStage(d, tweetId, "tags", { status: "ok", cost: r.cost, model: r.model });
    });
    tx();
    reindexAll(tweetId);
    return { status: "ok", cost: r.cost };
  } catch (e) {
    if (e instanceof AiSetupError) throw e; // not this like's fault: stop, and leave it pending
    markStage(d, tweetId, "tags", { status: "error", error: (e as Error).message });
    return { status: "error", cost: 0 };
  }
}

export async function enrichTags(
  opts: PendingOpts & { concurrency?: number; onProgress?: (d: number, t: number) => void } = {}
): Promise<TagReport> {
  const ids = selectPending("tags", ``, `1`, opts);
  const report: TagReport = { attempted: ids.length, ok: 0, skip: 0, error: 0, cost: 0, distinctTags: 0 };
  let done = 0;
  await eachWithWorkers(ids, opts.concurrency ?? 3, async (id) => {
    const r = await processTweet(id);
    report[r.status]++;
    report.cost += r.cost;
    done++;
    opts.onProgress?.(done, ids.length);
  });
  report.distinctTags = (db().prepare(`SELECT COUNT(*) n FROM tags`).get() as { n: number }).n;
  return report;
}
