/**
 * Comprehensive test suite for x-likes. Runs the whole product against a fresh
 * temporary database built from the mock archive + fixtures, then exercises
 * every ingest path, enrichment stage, search mode, the MCP server, and the web
 * server — plus idempotency and edge cases.
 *
 *   pnpm test
 *
 * Env is set here BEFORE any src module loads (dynamic imports below), so the
 * suite never touches your real data dir.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DIR = join(ROOT, `.test-data-${process.pid}`);
const ARCHIVE = join(ROOT, `.test-archive-${process.pid}`);
const DIR2 = join(ROOT, `.test-data-${process.pid}-claude`); // a second store, for the Claude provider tests

process.env.XLIKES_DATA_DIR = DIR;
process.env.XLIKES_AI_PROVIDER = "mock";
process.env.XLIKES_EMBED_PROVIDER = "local";

rmSync(DIR, { recursive: true, force: true });
rmSync(ARCHIVE, { recursive: true, force: true });
rmSync(DIR2, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true });

// ── tiny harness ──────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const failures: string[] = [];
let section = "";
function group(name: string) {
  section = name;
  console.log(`\n▸ ${name}`);
}
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    const msg = e instanceof Error ? e.message : String(e);
    failures.push(`[${section}] ${name}: ${msg}`);
    console.log(`  ✗ ${name}\n      ${msg.split("\n")[0]}`);
  }
}

// ── dynamic imports (after env is set) ────────────────────────────────────────
const { db } = await import("../src/db.js");
const { importArchive } = await import("../src/import-archive.js");
const { importWebExport } = await import("../src/import-web-export.js");
const { generateMockArchive } = await import("../src/mock-archive.js");
const { hydratePending } = await import("../src/hydrate.js");
const { enrichArticles } = await import("../src/enrich-articles.js");
const { enrichVision } = await import("../src/enrich-vision.js");
const { enrichTags } = await import("../src/enrich-tags.js");
const { enrichEmbeddings } = await import("../src/enrich-embed.js");
const search = await import("../src/search.js");
const { unpackVec } = await import("../src/ai.js");
const { xConfigured } = await import("../src/config.js");
const { visionHtml } = await import("../web/vision.js");

const NODE = process.execPath;
const TSX = join(ROOT, "node_modules/tsx/dist/cli.mjs");

// ── 1. schema / migrations ────────────────────────────────────────────────────
group("Schema & migrations");
await test("all core tables exist", () => {
  const d = db();
  const names = new Set(
    (d.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','virtual')`).all() as { name: string }[]).map((r) => r.name)
  );
  for (const t of ["likes", "tweets", "media", "links", "hydration_state", "search", "enrichment_state", "article_extracts", "media_vision", "tags", "like_tags", "embeddings", "enriched_fts"])
    assert.ok(names.has(t), `missing table: ${t}`);
});
await test("migrate() is idempotent (second open does not throw)", async () => {
  const { db: db2 } = await import("../src/db.js");
  assert.ok(db2());
});

// ── 2. archive ingest ─────────────────────────────────────────────────────────
group("Archive ingest");
await test("generate mock archive", () => {
  const r = generateMockArchive(ARCHIVE);
  assert.equal(r.likes, 14);
  process.env.XLIKES_MOCK_HYDRATION = r.hydrationFile;
  assert.ok(existsSync(r.hydrationFile));
});
await test("import archive inserts 14 likes", () => {
  const r = importArchive(ARCHIVE);
  assert.equal(r.inserted, 14);
});
await test("re-import is idempotent (0 new)", () => {
  const r = importArchive(ARCHIVE);
  assert.equal(r.inserted, 0);
});
await test("bad path throws", () => {
  assert.throws(() => importArchive(join(ARCHIVE, "does-not-exist")), /Path not found/);
});
const haveZip = (() => {
  try {
    execFileSync("zip", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
await test("a .zip archive is read in place, leaving nothing in the temp folder", () => {
  if (!haveZip) return console.log("      (no zip command here: skipped)");
  const zip = join(ROOT, `.test-archive-${process.pid}.zip`);
  try {
    execFileSync("zip", ["-qr", zip, "data"], { cwd: ARCHIVE });
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith("x-likes-")).length;
    const r = importArchive(zip);
    assert.equal(r.parsed, 14);
    assert.equal(r.inserted, 0); // already imported above
    assert.equal(readdirSync(tmpdir()).filter((n) => n.startsWith("x-likes-")).length, before);
  } finally {
    rmSync(zip, { force: true });
  }
});
await test("a file that isn't a zip gets a plain message", () => {
  if (!haveZip) return console.log("      (no zip command here: skipped)");
  const fake = join(ROOT, `.test-archive-${process.pid}-fake.zip`);
  try {
    writeFileSync(fake, "not a zip");
    assert.throws(() => importArchive(fake), /Couldn't read .* as a zip/);
  } finally {
    rmSync(fake, { force: true });
  }
});

// ── 3. hydrate (mock source) ──────────────────────────────────────────────────
group("Hydrate (offline mock source)");
await test("hydrate: 13 ok, 1 gone (deleted)", async () => {
  const r = await hydratePending({ concurrency: 8 });
  assert.equal(r.ok, 13);
  assert.equal(r.gone, 1);
});
await test("tweets + media + links populated", () => {
  const d = db();
  assert.equal((d.prepare(`SELECT COUNT(*) n FROM tweets`).get() as any).n, 13);
  assert.ok((d.prepare(`SELECT COUNT(*) n FROM media WHERE local_path IS NOT NULL`).get() as any).n >= 6);
  assert.ok((d.prepare(`SELECT COUNT(*) n FROM links`).get() as any).n >= 6);
});
await test("deleted tweet keeps archived text, marked gone", () => {
  const t = search.getLike("1500000000000000014");
  assert.ok(t);
  assert.equal(t!.hydration, "gone");
  assert.match(t!.text ?? "", /unavailable/i);
});
await test("re-hydrate finds nothing pending", async () => {
  const r = await hydratePending({});
  assert.equal(r.attempted, 0);
});

// ── 4. enrichment ─────────────────────────────────────────────────────────────
group("Enrichment");
await test("articles: >= 4 local fixtures extracted", async () => {
  const r = await enrichArticles({ concurrency: 6 });
  const n = (db().prepare(`SELECT COUNT(*) n FROM article_extracts`).get() as any).n;
  assert.ok(n >= 4, `only ${n} articles`);
  assert.ok(r.ok >= 4);
});
await test("vision: all 7 images analyzed, screenshots have OCR", async () => {
  const r = await enrichVision({ concurrency: 6 });
  assert.equal(r.images, 7);
  const ocr = (db().prepare(`SELECT COUNT(*) n FROM media_vision WHERE ocr_text IS NOT NULL AND ocr_text <> ''`).get() as any).n;
  assert.ok(ocr >= 3, `only ${ocr} OCR rows`);
});
await test("tags: vocabulary + joins created", async () => {
  await enrichTags({ concurrency: 6 });
  assert.ok((db().prepare(`SELECT COUNT(*) n FROM tags`).get() as any).n > 5);
  assert.ok((db().prepare(`SELECT COUNT(*) n FROM like_tags`).get() as any).n > 5);
});
await test("embeddings: 13 vectors, 384-dim", async () => {
  const r = await enrichEmbeddings({});
  assert.equal(r.ok, 13);
  const row = db().prepare(`SELECT dim, vec FROM embeddings LIMIT 1`).get() as { dim: number; vec: Buffer };
  assert.equal(row.dim, 384);
  assert.equal(unpackVec(row.vec).length, 384);
});
await test("enriched_fts populated", () => {
  assert.ok((db().prepare(`SELECT COUNT(*) n FROM enriched_fts`).get() as any).n > 0);
});
await test("re-enrich is idempotent (nothing re-attempted)", async () => {
  const a = await enrichArticles({});
  const v = await enrichVision({});
  const t = await enrichTags({});
  const e = await enrichEmbeddings({});
  assert.equal(a.attempted, 0);
  assert.equal(v.attempted, 0);
  assert.equal(t.attempted, 0);
  assert.equal(e.attempted, 0);
});
await test("a dead article link (404) counts as gone, not failed, and isn't retried", async () => {
  const site = await stubServer((req, res) => res.writeHead(404).end("not here"));
  const id = "1700000000000000001";
  const d = db();
  try {
    d.prepare(`INSERT INTO likes (tweet_id, archive_text, liked_order) VALUES (?, 'a dead link', 99)`).run(id);
    d.prepare(`INSERT INTO hydration_state (tweet_id, status) VALUES (?, 'ok')`).run(id);
    d.prepare(`INSERT INTO links (tweet_id, url) VALUES (?, ?)`).run(id, `${site.url}/gone`);
    const r = await enrichArticles({});
    assert.equal(r.gone, 1);
    assert.equal(r.error, 0);
    const st = d.prepare(`SELECT status FROM enrichment_state WHERE tweet_id = ? AND stage = 'article'`).get(id) as { status: string };
    assert.equal(st.status, "gone");
    assert.equal((await enrichArticles({ retryErrors: true })).attempted, 0);
  } finally {
    d.prepare(`DELETE FROM likes WHERE tweet_id = ?`).run(id);
    site.server.close();
  }
});

// ── 5. search ─────────────────────────────────────────────────────────────────
group("Search");
await test("keyword search hits base tweet text", () => {
  const r = search.search({ q: "ergonomic" });
  assert.ok(r.results.some((x) => x.author_handle === "keyboardmaxxing"));
});
await test("keyword search hits image OCR (enriched fts)", () => {
  const r = search.search({ q: "fts5" });
  assert.ok(r.results.some((x) => x.author_handle === "sqlite_wisdom"), "OCR'd FTS5 code not found");
});
await test("semantic: 'working offline' → local-first in top 2", async () => {
  const r = await search.searchHybrid({ q: "apps that keep working with no internet connection", sort: "relevance", limit: 3 });
  assert.ok(["semantic", "hybrid"].includes(r.mode));
  assert.ok(r.results.slice(0, 2).some((x) => x.author_handle === "smallcelltech"));
});
await test("hybrid mode when query has keyword overlap", async () => {
  const r = await search.searchHybrid({ q: "local-first software offline", sort: "relevance", limit: 3 });
  assert.ok(["hybrid", "semantic", "keyword"].includes(r.mode));
  assert.ok(r.total > 0);
});
await test("filter: hasImage matches media", () => {
  const r = search.search({ hasImage: true, limit: 50 });
  assert.equal(r.total, 7);
});
await test("filter: hasLink", () => {
  const r = search.search({ hasLink: true, limit: 50 });
  assert.ok(r.total >= 6);
});
await test("filter: author", () => {
  const r = search.search({ author: "rustlang_daily" });
  assert.equal(r.total, 1);
});
await test("filter: tag", () => {
  const tags = search.listTags(100);
  assert.ok(tags.length > 0);
  const r = search.search({ tag: tags[0]!.slug, limit: 50 });
  assert.equal(r.total, tags[0]!.count);
});
await test("sort newest vs oldest reverse each other", () => {
  const newest = search.search({ sort: "newest", limit: 50 }).results.filter((x) => x.created_at);
  const oldest = search.search({ sort: "oldest", limit: 50 }).results.filter((x) => x.created_at);
  assert.equal(newest[0]!.tweet_id, oldest[oldest.length - 1]!.tweet_id);
});
await test("pagination: pages don't overlap", () => {
  const p1 = search.search({ sort: "liked", limit: 5, offset: 0 }).results.map((x) => x.tweet_id);
  const p2 = search.search({ sort: "liked", limit: 5, offset: 5 }).results.map((x) => x.tweet_id);
  assert.equal(new Set([...p1, ...p2]).size, p1.length + p2.length);
});
await test("empty query = browse (all rows)", () => {
  assert.equal(search.search({ limit: 50 }).total, 14);
});
await test("no-match query returns 0", () => {
  assert.equal(search.search({ q: "zzzznotarealtokenxyzzy" }).total, 0);
});
await test("malicious query is safe (no crash, table intact)", () => {
  assert.doesNotThrow(() => search.search({ q: '"; DROP TABLE likes; --' }));
  assert.equal((db().prepare(`SELECT COUNT(*) n FROM likes`).get() as any).n, 14);
});
await test("getLikeFull returns article + vision + tags", () => {
  const full = search.getLikeFull("1500000000000000004"); // agent tweet w/ article + screenshot
  assert.ok(full);
  assert.ok(full!.articles.length >= 1);
  assert.ok(full!.vision.length >= 1);
  assert.ok(full!.tags.length >= 1);
});
await test("getLikeFull null for unknown id", () => {
  assert.equal(search.getLikeFull("0"), null);
});
await test("likesByTag returns rows", () => {
  const tag = search.listTags(1)[0]!;
  assert.ok(search.likesByTag(tag.slug, 50).length > 0);
});
await test("relatedTo returns neighbors (embedding)", () => {
  const rel = search.relatedTo("1500000000000000001", 5);
  assert.ok(rel.length > 0);
  assert.ok(!rel.some((x) => x.tweet_id === "1500000000000000001"));
});
await test("stats are coherent", () => {
  const s = search.stats();
  assert.equal(s.likes, 14);
  assert.equal(s.hydrated, 13);
  assert.equal(s.gone, 1);
  assert.equal(s.withImages, 7);
});

// ── 6. web-export ingest ──────────────────────────────────────────────────────
group("Web-export ingest (open-source path)");
await test("import flattened + graphql + bare + the exporter's own shapes", async () => {
  const r = await importWebExport(join(ROOT, "fixtures/web-export-sample.json"));
  assert.equal(r.records, 5);
  assert.equal(r.inserted, 5);
  assert.equal(r.hydrated, 4);
  assert.equal(r.pending, 1);
});
await test("exporter JSON: avatar from profile_image_url, a video's poster and mp4", () => {
  const d = db();
  const t = d.prepare(`SELECT author_handle, author_avatar_url, created_at FROM tweets WHERE tweet_id='1600000000000000004'`).get() as any;
  assert.equal(t.author_handle, "launch_desk");
  assert.equal(t.author_avatar_url, "https://pbs.twimg.com/profile_images/2/launch_desk_normal.jpg");
  assert.match(t.created_at, /^2024-05-14T10:20:30/);
  const m = d.prepare(`SELECT kind, remote_url, video_url FROM media WHERE tweet_id='1600000000000000004'`).get() as any;
  assert.equal(m.kind, "video");
  assert.equal(m.remote_url, "https://pbs.twimg.com/ext_tw_video_thumb/1600000000000000004/pu/img/poster.jpg");
  assert.match(m.video_url, /clip\.mp4/);
});
await test("exporter JSON with metadata: the tweet's links come through", () => {
  const links = db().prepare(`SELECT url FROM links WHERE tweet_id='1600000000000000005'`).all() as { url: string }[];
  assert.deepEqual(links.map((l) => l.url), ["https://ocr.example/blog/on-device-receipts"]);
});
await test("graphql date normalized to ISO", () => {
  const t = db().prepare(`SELECT created_at FROM tweets WHERE tweet_id='1600000000000000002'`).get() as { created_at: string };
  assert.match(t.created_at, /^2024-05-01T12:30:00/);
});
await test("bare record left pending", () => {
  const s = db().prepare(`SELECT status FROM hydration_state WHERE tweet_id='1600000000000000003'`).get() as { status: string };
  assert.equal(s.status, "pending");
});

// ── 7. MCP server (stdio subprocess) ──────────────────────────────────────────
group("MCP server (stdio)");
await test("initialize, tools/list (10), search, get, tags", async () => {
  const res = await mcpSession();
  assert.equal(res.tools.length, 10);
  assert.ok(res.tools.includes("likes_search") && res.tools.includes("read_article") && res.tools.includes("related_to"));
  assert.ok(res.searchHits > 0);
  assert.ok(res.getOk);
  assert.ok(res.tagsOk);
  assert.equal(res.dirtyStdout, 0);
});

// ── 8. web server (http subprocess) ───────────────────────────────────────────
group("Web server (HTTP)");
await test("endpoints, media, 404, traversal guard, cache header", async () => {
  const r = await httpSession(4399);
  assert.equal(r.index, 200);
  assert.equal(r.stats.likes, search.stats().likes); // endpoint matches direct query
  assert.ok(r.searchTotal > 0);
  assert.ok(r.tags > 0);
  assert.equal(r.mediaOk, 200);
  assert.equal(r.notFound, 404);
  assert.ok(r.traversal === 404 || r.traversal === 400, `traversal returned ${r.traversal}`);
  assert.equal(r.cssCache, "no-cache");
  assert.equal(r.visionJs, 200);
  assert.ok(r.likeOcr, "/api/like carries the image text");
});
await test("it answers only on this machine: loopback only, and local Host names only", async () => {
  const r = await httpSession(4398);
  assert.equal(r.foreignHost, 403);
  if (r.lan === null) return console.log("      (no network interface besides loopback: skipped the LAN check)");
  assert.equal(r.lan, "refused", `the LAN address ${r.lan}`);
});

// ── 9. the web app's detail view: what the image reading found ──────────────────
group("Web app detail: image text and caption");
await test("a like with a screenshot shows its text in the image and its caption", () => {
  const full = JSON.parse(JSON.stringify(search.getLikeFull("1500000000000000002")));
  const html: string = visionHtml(full);
  assert.match(html, /<dt>Text in the image<\/dt>/);
  assert.match(html, /CREATE VIRTUAL TABLE docs USING fts5/);
  assert.match(html, /<dt>Caption<\/dt>/);
  assert.match(html, /Terminal showing an FTS5 query/);
});
await test("image text is escaped, and a tweet with several images numbers them", () => {
  const html: string = visionHtml({
    media: [{ remote_url: "a" }, { remote_url: "b" }],
    vision: [
      { remote_url: "b", ocr_text: "<script>alert(1)</script>", caption: null },
      { remote_url: "a", ocr_text: "", caption: "A chart" },
    ],
  });
  assert.ok(!html.includes("<script>"));
  assert.match(html, /&lt;script&gt;/);
  assert.ok(html.indexOf("Image 1") < html.indexOf("Image 2"));
  assert.ok(html.indexOf("A chart") < html.indexOf("&lt;script&gt;"));
});
await test("nothing read, nothing shown", () => {
  assert.equal(visionHtml({ media: [{ remote_url: "a" }], vision: [{ remote_url: "a", ocr_text: null, caption: " " }] }), "");
  assert.equal(visionHtml({ media: [], vision: [] }), "");
});

// ── 10. the CLI's unhappy paths ───────────────────────────────────────────────
group("CLI: wrong input gets one plain sentence");
await test("an unknown command", async () => {
  const r = await cli(["enrich:everything"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /Unknown command "enrich:everything"/);
  assert.doesNotMatch(r.err, /\n\s+at /);
});
await test("--limit that isn't a number", async () => {
  const r = await cli(["enrich:tags", "--limit", "ten"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /--limit must be a whole number from 1 up, not "ten"/);
  assert.doesNotMatch(r.err, /\n\s+at /);
});
await test("an archive path that doesn't exist", async () => {
  const r = await cli(["import", "./no-such-archive.zip"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /Path not found: \.\/no-such-archive\.zip/);
  assert.doesNotMatch(r.err, /\n\s+at /);
});
await test("serve on a port that's in use", async () => {
  const busy = await stubServer((req, res) => res.end("busy"));
  try {
    const r = await cli(["serve", "--port", String(busy.port)]);
    assert.equal(r.code, 1);
    assert.match(r.err, new RegExp(`Port ${busy.port} is already in use`));
  } finally {
    busy.server.close();
  }
});

// ── 11. Claude for images and tags, against a local stand-in for the API ────────
group("Claude provider (a local stand-in for the API)");
const seen: { mediaType?: string }[] = [];
let apiMode: "reject-key" | "ok" = "reject-key";
const api = await stubServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = JSON.parse(body || "{}");
    const img = j.messages?.[0]?.content?.find?.((c: any) => c.type === "image");
    seen.push({ mediaType: img?.source?.media_type });
    res.setHeader("Content-Type", "application/json");
    if (apiMode === "reject-key") {
      res.writeHead(401).end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
      return;
    }
    const text = img
      ? JSON.stringify({ caption: "A terminal with code", ocr_text: "STAND-IN OCR TEXT", labels: ["code"] })
      : JSON.stringify({ topics: ["stand-in topic"], entities: [] });
    res.writeHead(200).end(
      JSON.stringify({
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: "claude-haiku-4-5-20251001",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1000, output_tokens: 50 },
      })
    );
  });
});
const claudeEnv = {
  XLIKES_DATA_DIR: DIR2,
  XLIKES_AI_PROVIDER: "anthropic",
  ANTHROPIC_API_KEY: "sk-ant-invalid",
  ANTHROPIC_BASE_URL: api.url,
};
await test("setup: a second store with the demo likes, hydrated", async () => {
  assert.equal((await cli(["import", ARCHIVE], claudeEnv)).code, 0);
  assert.equal((await cli(["hydrate"], claudeEnv)).code, 0);
});
await test("a rejected key stops the stage with one sentence and leaves every like pending", async () => {
  const r = await cli(["enrich:images"], claudeEnv);
  assert.equal(r.code, 1);
  assert.match(r.err, /Claude rejected the API key \(401\)\. Check ANTHROPIC_API_KEY/);
  assert.match(r.err, /still pending/);
  assert.doesNotMatch(r.err, /\n\s+at /);
  assert.ok(seen.length >= 1 && seen.length <= 3, `${seen.length} requests (it should stop at the first)`);
  const n = await countStage(DIR2, "vision");
  assert.equal(n, 0, `${n} likes marked for the image stage`);
  const t = await cli(["enrich:tags"], claudeEnv);
  assert.equal(t.code, 1);
  assert.equal(await countStage(DIR2, "tags"), 0);
});
await test("with a working key the same likes are read: SVG placeholders go as PNG", async () => {
  apiMode = "ok";
  seen.length = 0;
  const r = await cli(["enrich:images"], claudeEnv);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /7 ok · 0 failed · 7 images analyzed/);
  assert.ok(seen.length === 7 && seen.every((s) => s.mediaType === "image/png"), JSON.stringify(seen));
  assert.equal(await countStage(DIR2, "vision", "ok"), 7);
});
api.server.close();

// ── 12. config / .env ─────────────────────────────────────────────────────────
group("Config");
await test(".env loads (X creds present or absent, no throw)", () => {
  assert.equal(typeof xConfigured(), "boolean");
});

// ── helpers: subprocess sessions ──────────────────────────────────────────────
/** A throwaway HTTP server on a free loopback port. */
async function stubServer(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void) {
  const server: Server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { server, port, url: `http://127.0.0.1:${port}` };
}

/** Run the CLI as a user would, and collect its output and exit code. */
function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolveRun) => {
    const proc = spawn(NODE, [TSX, join(ROOT, "src/cli.ts"), ...args], { cwd: ROOT, env: { ...process.env, ...env } });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => proc.kill(), 60000);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ code, out, err });
    });
  });
}

/** How many likes have a row (optionally with this status) for a stage, in another store. */
async function countStage(dir: string, stage: string, status?: string): Promise<number> {
  const { default: Database } = await import("better-sqlite3");
  const d = new Database(join(dir, "likes.db"), { readonly: true });
  try {
    const sql = `SELECT COUNT(*) n FROM enrichment_state WHERE stage = ?${status ? " AND status = ?" : ""}`;
    return (d.prepare(sql).get(...(status ? [stage, status] : [stage])) as { n: number }).n;
  } finally {
    d.close();
  }
}

async function mcpSession(): Promise<{ tools: string[]; searchHits: number; getOk: boolean; tagsOk: boolean; dirtyStdout: number }> {
  const proc = spawn(NODE, [TSX, join(ROOT, "src/mcp-server.ts")], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  let dirty = 0;
  const pending = new Map<number, (m: any) => void>();
  proc.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        if (m.id && pending.has(m.id)) {
          pending.get(m.id)!(m);
          pending.delete(m.id);
        }
      } catch {
        dirty++;
      }
    }
  });
  proc.stderr.on("data", () => {});
  let idc = 0;
  const rpc = (method: string, params: any) =>
    new Promise<any>((res) => {
      const id = ++idc;
      pending.set(id, res);
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  const call = (name: string, args: any) => rpc("tools/call", { name, arguments: args }).then((r) => JSON.parse(r.result.content[0].text));
  try {
    await new Promise((r) => setTimeout(r, 1500));
    await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tools = (await rpc("tools/list", {})).result.tools.map((t: any) => t.name);
    const s = await call("likes_search", { q: "sqlite database", limit: 3 });
    const g = await call("like_get", { id: s.hits[0]?.id ?? "1500000000000000001" });
    const tg = await call("list_tags", { limit: 5 });
    return { tools, searchHits: s.hits.length, getOk: Boolean(g.id), tagsOk: Array.isArray(tg.tags), dirtyStdout: dirty };
  } finally {
    proc.kill();
  }
}

async function httpSession(port: number) {
  const proc = spawn(NODE, [TSX, join(ROOT, "src/cli.ts"), "serve", "--port", String(port)], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    // wait for listen
    for (let i = 0; i < 30; i++) {
      try {
        await fetch(`http://localhost:${port}/api/stats`);
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    const base = `http://localhost:${port}`;
    const index = (await fetch(base + "/")).status;
    const stats = await (await fetch(base + "/api/stats")).json();
    const searchTotal = (await (await fetch(base + "/api/search?q=agent&sort=relevance")).json()).total;
    const tags = (await (await fetch(base + "/api/tags")).json()).tags.length;
    // find a real media path
    const mediaRow = db().prepare(`SELECT local_path FROM media WHERE local_path IS NOT NULL LIMIT 1`).get() as { local_path: string } | undefined;
    const mediaOk = mediaRow ? (await fetch(base + "/media/" + mediaRow.local_path)).status : 200;
    const notFound = (await fetch(base + "/nope-nope")).status;
    const traversal = (await fetch(base + "/media/..%2f..%2fpackage.json")).status;
    const cssCache = (await fetch(base + "/styles.css")).headers.get("cache-control");
    const visionJs = (await fetch(base + "/vision.js")).status;
    const like = await (await fetch(base + "/api/like?id=1500000000000000002")).json();
    const likeOcr = like.vision?.some((v: any) => /CREATE VIRTUAL TABLE/.test(v.ocr_text ?? ""));
    // A page on another site that rebinds its name to 127.0.0.1 sends its own Host header.
    const foreignHost = await new Promise<number>((done) => {
      import("node:http").then(({ request }) =>
        request({ host: "127.0.0.1", port, path: "/api/stats", headers: { Host: `evil.example:${port}` } }, (res) => {
          res.resume();
          done(res.statusCode ?? 0);
        }).end()
      );
    });
    // What another machine on the network would see: this machine's LAN address must refuse the connection.
    const ip = Object.values(networkInterfaces()).flat().find((a) => a && a.family === "IPv4" && !a.internal)?.address;
    const lan = ip
      ? await fetch(`http://${ip}:${port}/api/stats`, { signal: AbortSignal.timeout(3000) }).then(
          (r) => `answered ${r.status}`,
          () => "refused"
        )
      : null;
    return { index, stats, searchTotal, tags, mediaOk, notFound, traversal, cssCache, visionJs, likeOcr, foreignHost, lan };
  } finally {
    proc.kill();
  }
}

// ── summary ───────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(48)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log(`\n  Failures:`);
  for (const f of failures) console.log(`   ✗ ${f}`);
}
rmSync(DIR, { recursive: true, force: true });
rmSync(ARCHIVE, { recursive: true, force: true });
rmSync(DIR2, { recursive: true, force: true });
process.exit(fail > 0 ? 1 : 0);
