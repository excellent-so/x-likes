import "./env.js"; // first: later imports read .env settings when they load
import { aiProvider, embedProvider } from "./ai.js";
import { enrichArticles } from "./enrich-articles.js";
import { enrichEmbeddings } from "./enrich-embed.js";
import { enrichTags } from "./enrich-tags.js";
import { enrichVision } from "./enrich-vision.js";
import { hydratePending } from "./hydrate.js";
import { importArchive } from "./import-archive.js";
import { importWebExport } from "./import-web-export.js";
import { generateMockArchive } from "./mock-archive.js";
import { listTags, stats } from "./search.js";
import { serve } from "./server.js";
import { checkAccess, fetchLikes } from "./x-api.js";

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function flag(rest: string[], name: string): string | undefined {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
}
function limitOf(rest: string[]): number | undefined {
  const v = flag(rest, "--limit");
  return v ? Number(v) : undefined;
}

function printStats(): void {
  const s = stats();
  console.log(`
  Likes imported : ${fmt(s.likes)}
  Hydrated       : ${fmt(s.hydrated)}
  Deleted/gone   : ${fmt(s.gone)}
  Pending        : ${fmt(s.pending)}
  With images    : ${fmt(s.withImages)}  (${fmt(s.mediaFiles)} files)
  With links     : ${fmt(s.withLinks)}`);
  const tags = listTags(8);
  if (tags.length) console.log(`  Top tags       : ${tags.map((t) => `${t.label} (${t.count})`).join(", ")}`);
  console.log("");
}

function progressBar(done: number, total: number, label = "working"): void {
  const pct = total ? Math.round((done / total) * 100) : 100;
  const width = 26;
  const filled = Math.round((pct / 100) * width);
  process.stdout.write(
    `\r  ${label.padEnd(9)} [${"#".repeat(filled)}${"-".repeat(width - filled)}] ${pct}%  ${fmt(done)}/${fmt(total)}   `
  );
  if (done >= total) process.stdout.write("\n");
}

interface EnrichOpts {
  limit?: number;
  retryErrors?: boolean;
}

/** Run the four enrichment stages in dependency order (articles+vision → tags → embed). */
async function enrichAll(opts: EnrichOpts): Promise<void> {
  console.log(`\n  Enriching (vision/tags: ${aiProvider()}, embeddings: ${embedProvider()})\n`);

  const art = await enrichArticles({ ...opts, onProgress: (d, t) => progressBar(d, t, "articles") });
  console.log(`  articles : ${fmt(art.ok)} ok · ${fmt(art.skip)} no-link · ${fmt(art.error)} failed → ${fmt(art.articles)} stored`);

  const vis = await enrichVision({ ...opts, onProgress: (d, t) => progressBar(d, t, "images") });
  console.log(`  images   : ${fmt(vis.ok)} ok · ${fmt(vis.skip)} none · ${fmt(vis.error)} failed → ${fmt(vis.images)} analyzed  ($${vis.cost.toFixed(4)})`);

  const tag = await enrichTags({ ...opts, onProgress: (d, t) => progressBar(d, t, "tags") });
  console.log(`  tags     : ${fmt(tag.ok)} ok · ${fmt(tag.skip)} empty · ${fmt(tag.error)} failed → ${fmt(tag.distinctTags)} distinct  ($${tag.cost.toFixed(4)})`);

  const emb = await enrichEmbeddings({ ...opts, onProgress: (d, t) => progressBar(d, t, "embed") });
  console.log(`  embed    : ${fmt(emb.ok)} ok · ${fmt(emb.skip)} empty · ${fmt(emb.error)} failed  (${emb.model})`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts: EnrichOpts = { limit: limitOf(rest), retryErrors: rest.includes("--retry-errors") };

  switch (cmd) {
    case "import": {
      const input = rest.find((a) => !a.startsWith("--"));
      if (!input) {
        console.error("Usage: pnpm ingest <archive.zip | unzipped-archive-dir | data/like.js>");
        process.exit(1);
      }
      console.log(`\n  Importing likes from ${input} ...`);
      const r = importArchive(input);
      console.log(`  Parsed ${fmt(r.parsed)} from ${r.files} file(s) → ${fmt(r.inserted)} new, ${fmt(r.skipped)} known.`);
      printStats();
      break;
    }

    case "ingest-export": {
      const input = rest.find((a) => !a.startsWith("--"));
      if (!input) {
        console.error("Usage: pnpm ingest-export <likes-export.json>  (from the twitter-web-exporter userscript)");
        process.exit(1);
      }
      console.log(`\n  Importing likes from web-export ${input} ...\n`);
      const r = await importWebExport(input, { onProgress: (d, t) => progressBar(d, t, "hydrate") });
      console.log(
        `\n  ${fmt(r.records)} record(s) → ${fmt(r.inserted)} new: ${fmt(r.hydrated)} fully hydrated from the export, ${fmt(r.pending)} pending.` +
          (r.failed ? `  (${fmt(r.failed)} media/persist failures)` : "")
      );
      console.log(`  Next:  pnpm hydrate   (finishes any pending)   &&   pnpm enrich\n`);
      break;
    }

    case "hydrate": {
      console.log(`\n  Fetching tweet content + downloading media ...\n`);
      const r = await hydratePending({ limit: opts.limit, retryErrors: opts.retryErrors, onProgress: (d, t) => progressBar(d, t, "hydrate") });
      console.log(`\n  ${fmt(r.ok)} hydrated · ${fmt(r.gone)} unavailable · ${fmt(r.error)} errored (of ${fmt(r.attempted)}).`);
      printStats();
      break;
    }

    case "enrich:articles": {
      const r = await enrichArticles({ ...opts, onProgress: (d, t) => progressBar(d, t, "articles") });
      console.log(`\n  ${fmt(r.ok)} ok · ${fmt(r.skip)} no-link · ${fmt(r.error)} failed → ${fmt(r.articles)} article(s) stored.\n`);
      break;
    }
    case "enrich:images": {
      const r = await enrichVision({ ...opts, onProgress: (d, t) => progressBar(d, t, "images") });
      console.log(`\n  ${fmt(r.ok)} ok · ${fmt(r.images)} images analyzed · $${r.cost.toFixed(4)} (${aiProvider()}).\n`);
      break;
    }
    case "enrich:tags": {
      const r = await enrichTags({ ...opts, onProgress: (d, t) => progressBar(d, t, "tags") });
      console.log(`\n  ${fmt(r.ok)} ok · ${fmt(r.distinctTags)} distinct tags · $${r.cost.toFixed(4)} (${aiProvider()}).\n`);
      break;
    }
    case "enrich:embed": {
      const r = await enrichEmbeddings({ ...opts, onProgress: (d, t) => progressBar(d, t, "embed") });
      console.log(`\n  ${fmt(r.ok)} embedded · ${fmt(r.skip)} empty · ${fmt(r.error)} failed (${r.model}).\n`);
      break;
    }
    case "enrich": {
      await enrichAll(opts);
      printStats();
      break;
    }

    case "update": {
      const input = rest.find((a) => !a.startsWith("--"));
      if (input) {
        console.log(`\n  Importing new likes from ${input} ...`);
        const r = importArchive(input);
        console.log(`  ${fmt(r.inserted)} new like(s).`);
      }
      console.log(`\n  Hydrating pending likes ...\n`);
      const h = await hydratePending({ retryErrors: true, onProgress: (d, t) => progressBar(d, t, "hydrate") });
      console.log(`\n  ${fmt(h.ok)} hydrated · ${fmt(h.gone)} gone · ${fmt(h.error)} errored.`);
      await enrichAll({ retryErrors: true });
      printStats();
      break;
    }

    case "mock-archive": {
      const dir = rest.find((a) => !a.startsWith("--")) ?? "./mock-archive";
      const r = generateMockArchive(dir);
      console.log(`\n  Wrote a mock Twitter archive (${fmt(r.likes)} likes) to ${r.dir}`);
      console.log(`\n  Run the full pipeline against it (offline):`);
      console.log(`    export XLIKES_DATA_DIR=./data-mock`);
      console.log(`    export XLIKES_MOCK_HYDRATION=${r.hydrationFile}`);
      console.log(`    pnpm ingest ${r.dir}`);
      console.log(`    pnpm hydrate`);
      console.log(`    pnpm enrich`);
      console.log(`    pnpm serve\n`);
      break;
    }

    case "x-check": {
      const r = await checkAccess();
      console.log(`\n  X API credentials: ${r.configured ? "loaded from .env" : "NOT set (fill in .env)"}`);
      console.log(`  liked_tweets → HTTP ${r.status}  ${r.ok ? "✅" : "❌"}  ${r.reason}`);
      if (r.hint) console.log(`  → ${r.hint}`);
      console.log("");
      break;
    }

    case "fetch-likes": {
      console.log(`\n  Fetching recent likes via the X API ...\n`);
      const r = await fetchLikes({
        max: opts.limit ?? 200,
        onPage: (n, total) => process.stdout.write(`\r  page ${n} · ${fmt(total)} likes  `),
      });
      console.log(`\n\n  ${fmt(r.inserted)} new like(s) added (${fmt(r.fetched)} fetched · ${r.pages} page(s) · ${r.stopped}).`);
      console.log(`  Next:  pnpm hydrate && pnpm enrich\n`);
      break;
    }

    case "stats":
      printStats();
      break;

    case "serve": {
      const p = flag(rest, "--port");
      serve(p ? Number(p) : undefined);
      break;
    }

    default:
      console.log(`
  x-likes — a searchable local second brain of your Twitter/X likes.

  Setup / update:
    pnpm ingest  <archive.zip|dir|like.js>   Import likes from your X data archive
    pnpm ingest-export <export.json>         Import a twitter-web-exporter likes JSON (no API)
    pnpm hydrate [--limit N]                 Fetch tweet text + download images
    pnpm enrich  [--limit N]                 Articles + image OCR + tags + embeddings
    pnpm refresh [archive]                   Import (optional) → hydrate → enrich, all pending

  Enrichment stages (run individually if you like):
    pnpm cli enrich:articles   pnpm cli enrich:images
    pnpm cli enrich:tags       pnpm cli enrich:embed

  Keep current via the X API (optional, needs .env + app in a v2 Project):
    pnpm cli x-check                         Check whether the API can read your likes
    pnpm cli fetch-likes [--limit N]         Pull recent likes via the API (then hydrate + enrich)

  Use it:
    pnpm serve   [--port N]                  Local web app (default :4321)
    pnpm mcp                                 MCP server for the Claude CLI
    pnpm stats                               What's in the database

  Try it with no real data:
    pnpm cli mock-archive ./mock-archive     Generate a realistic offline archive
`);
  }
}

main().catch((e) => {
  console.error("\n  Error:", e instanceof Error ? e.stack ?? e.message : e, "\n");
  process.exit(1);
});
