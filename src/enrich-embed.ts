import { embed, packVec } from "./ai.js";
import { db } from "./db.js";
import { buildDoc, markStage, selectPending, type PendingOpts } from "./enrichment.js";

export interface EmbedReport {
  attempted: number;
  ok: number;
  skip: number;
  error: number;
  model: string;
}

const BATCH = 32;

export async function enrichEmbeddings(
  opts: PendingOpts & { onProgress?: (d: number, t: number) => void } = {}
): Promise<EmbedReport> {
  const d = db();
  const ids = selectPending("embed", ``, `1`, opts);
  const report: EmbedReport = { attempted: ids.length, ok: 0, skip: 0, error: 0, model: "" };

  const ins = d.prepare(
    `INSERT INTO embeddings (tweet_id, dim, vec, model, updated_at)
     VALUES (@tweet_id, @dim, @vec, @model, datetime('now'))
     ON CONFLICT(tweet_id) DO UPDATE SET
       dim=excluded.dim, vec=excluded.vec, model=excluded.model, updated_at=datetime('now')`
  );

  let done = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const docs = chunk.map((id) => ({ id, doc: buildDoc(id) }));
    const embeddable = docs.filter((x) => x.doc.replace(/\s/g, "").length >= 8);
    for (const empty of docs.filter((x) => x.doc.replace(/\s/g, "").length < 8)) {
      markStage(d, empty.id, "embed", { status: "skip" });
      report.skip++;
      done++;
      opts.onProgress?.(done, ids.length);
    }
    if (embeddable.length) {
      try {
        const { vectors, model, dim } = await embed(embeddable.map((x) => x.doc));
        report.model = model;
        const tx = d.transaction(() => {
          embeddable.forEach((x, k) => {
            const v = vectors[k]!;
            ins.run({ tweet_id: x.id, dim, vec: packVec(v), model });
            markStage(d, x.id, "embed", { status: "ok", model });
          });
        });
        tx();
        report.ok += embeddable.length;
      } catch (e) {
        for (const x of embeddable) markStage(d, x.id, "embed", { status: "error", error: (e as Error).message });
        report.error += embeddable.length;
      }
      done += embeddable.length;
      opts.onProgress?.(done, ids.length);
    }
  }
  return report;
}
