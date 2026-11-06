import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { db, DB_PATH, MEDIA_DIR } from "./db.js";
import { getLikeFull, listTags, relatedTo, searchHybrid, stats, type SearchParams } from "./search.js";

const WEB_DIR = resolve(fileURLToPath(new URL("../web", import.meta.url)));
// Downscaled grid thumbnails live beside the originals; generated on first
// request, cached to disk forever. The grid decodes these (~10-30 KB webp)
// instead of full-res originals (up to 800 KB) — the big scroll-speed win.
const THUMB_DIR = resolve(MEDIA_DIR, "..", "media-thumbs");
const THUMB_WIDTH = 640;
// Videos aren't downloaded during hydration (only their poster frame is), so the
// mp4 lives at twimg. We proxy + cache it locally on first play: playback is then
// same-origin (no hotlink/CORS/Referer surprises) and the clip is archived to
// disk for good — the same second-brain permanence the images already have.
const VIDEO_DIR = resolve(MEDIA_DIR, "..", "media-video");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(res: import("node:http").ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(s);
}

/** Serve a file from a root, guarding against path traversal. */
function sendFile(
  res: import("node:http").ServerResponse,
  root: string,
  relPath: string,
  cache = "no-cache"
): boolean {
  const full = normalize(join(root, relPath));
  if (!full.startsWith(root) || !existsSync(full) || !statSync(full).isFile()) return false;
  res.writeHead(200, {
    "Content-Type": MIME[extname(full).toLowerCase()] ?? "application/octet-stream",
    "Content-Length": statSync(full).size,
    "Cache-Control": cache,
  });
  createReadStream(full).pipe(res);
  return true;
}

/** Serve a downscaled webp thumbnail of a media image, generating + caching it
 *  on first request. Aspect ratio is preserved (no rotate) so it matches the
 *  dimensions the client reserved. Falls back to the original on any failure. */
async function sendThumb(res: import("node:http").ServerResponse, relPath: string): Promise<void> {
  const orig = normalize(join(MEDIA_DIR, relPath));
  if (!orig.startsWith(MEDIA_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  const cache = normalize(join(THUMB_DIR, relPath)) + ".webp";
  try {
    if (!existsSync(cache)) {
      if (!existsSync(orig) || !statSync(orig).isFile()) {
        res.writeHead(404).end("not found");
        return;
      }
      mkdirSync(dirname(cache), { recursive: true });
      await sharp(orig).resize({ width: THUMB_WIDTH, withoutEnlargement: true }).webp({ quality: 74 }).toFile(cache);
    }
    res.writeHead(200, {
      "Content-Type": "image/webp",
      "Content-Length": statSync(cache).size,
      "Cache-Control": "public, max-age=86400",
    });
    createReadStream(cache).pipe(res);
  } catch {
    // sharp choked (odd format, corrupt file) → serve the original untouched.
    if (!sendFile(res, MEDIA_DIR, relPath, "public, max-age=86400")) res.writeHead(404).end("not found");
  }
}

/** Stream a local file to the client with HTTP Range support (so `<video>` can
 *  seek without downloading the whole clip). */
function sendFileRange(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  file: string,
  type: string
): void {
  const size = statSync(file).size;
  const range = req.headers.range;
  const base = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "public, max-age=604800" };
  const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
  if (m) {
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : size - 1;
    if (Number.isNaN(start)) start = 0;
    if (Number.isNaN(end) || end >= size) end = size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
      return;
    }
    res.writeHead(206, { ...base, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...base, "Content-Length": size });
  createReadStream(file).pipe(res);
}

/** Proxy + cache a liked tweet's video. The mp4 url must already exist in the
 *  media table (so this is never an open proxy — only URLs we saved are fetched).
 *  Downloads once to `media-video/`, then serves locally with Range; on a fetch
 *  failure it redirects to the source so playback still has a chance. */
async function sendVideo(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  srcUrl: string
): Promise<void> {
  let u: URL;
  try {
    u = new URL(srcUrl);
  } catch {
    res.writeHead(400).end("bad url");
    return;
  }
  // Only proxy hosts/urls we actually stored — no SSRF surface.
  const known = db().prepare("SELECT 1 FROM media WHERE video_url = ? LIMIT 1").get(srcUrl);
  if (!known || u.protocol !== "https:") {
    res.writeHead(404).end("unknown video");
    return;
  }
  const cache = normalize(join(VIDEO_DIR, u.hostname, u.pathname));
  if (!cache.startsWith(VIDEO_DIR) || !/\.mp4$/i.test(cache)) {
    res.writeHead(400).end("bad path");
    return;
  }
  if (!existsSync(cache)) {
    try {
      mkdirSync(dirname(cache), { recursive: true });
      const r = await fetch(srcUrl, { headers: { "User-Agent": "Mozilla/5.0", Referer: "https://twitter.com/" } });
      if (!r.ok || !r.body) throw new Error(`upstream ${r.status}`);
      const tmp = `${cache}.part`;
      await pipeline(Readable.fromWeb(r.body as any), createWriteStream(tmp));
      renameSync(tmp, cache);
    } catch {
      // Couldn't cache it — let the browser try the source directly.
      res.writeHead(302, { Location: srcUrl }).end();
      return;
    }
  }
  sendFileRange(req, res, cache, "video/mp4");
}

// The app answers only on this machine: it listens on the loopback address, and it refuses requests whose Host
// isn't a local name, so a web page you visit can't reach it through a DNS-rebinding trick.
const HOST = "127.0.0.1";
const LOCAL_NAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The port to listen on: --port, else PORT, else 4321. */
function portFrom(flag: number | undefined): number {
  if (flag !== undefined) return flag;
  const env = process.env.PORT;
  if (env === undefined || env === "") return 4321;
  const n = Number(env);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`PORT must be a whole number from 1 to 65535, not "${env}".`);
  return n;
}

export function serve(portFlag?: number): void {
  const port = portFrom(portFlag);
  const server = createServer(async (req, res) => {
    const host = (req.headers.host ?? "").toLowerCase().replace(/:\d+$/, "");
    if (!LOCAL_NAMES.has(host)) return void res.writeHead(403, { "Content-Type": "text/plain" }).end("x-likes only answers on localhost");
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const path = decodeURIComponent(url.pathname);

    // --- API ---
    if (path === "/api/search") {
      const p = url.searchParams;
      const params: SearchParams = {
        q: p.get("q") ?? undefined,
        author: p.get("author") ?? undefined,
        tag: p.get("tag") ?? undefined,
        hasImage: p.get("hasImage") === "1",
        hasLink: p.get("hasLink") === "1",
        sort: (p.get("sort") as SearchParams["sort"]) ?? "newest",
        limit: p.get("limit") ? Number(p.get("limit")) : undefined,
        offset: p.get("offset") ? Number(p.get("offset")) : undefined,
      };
      try {
        return sendJson(res, 200, await searchHybrid(params));
      } catch (e) {
        return sendJson(res, 400, { error: (e as Error).message });
      }
    }

    if (path === "/api/tags") {
      return sendJson(res, 200, { tags: listTags(120) });
    }

    if (path === "/api/stats") {
      return sendJson(res, 200, stats());
    }

    // Full enriched record for the detail lightbox (articles, vision, all tags).
    if (path === "/api/like") {
      const id = url.searchParams.get("id");
      if (!id) return sendJson(res, 400, { error: "id required" });
      const full = getLikeFull(id);
      return full ? sendJson(res, 200, full) : sendJson(res, 404, { error: "not found" });
    }

    // Related likes for the detail lightbox (embedding neighborhood or shared tags).
    if (path === "/api/related") {
      const id = url.searchParams.get("id");
      if (!id) return sendJson(res, 400, { error: "id required" });
      return sendJson(res, 200, { results: relatedTo(id, 8) });
    }

    // --- Grid thumbnails (downscaled webp, generated on demand) ---
    if (path.startsWith("/thumb/")) {
      await sendThumb(res, path.slice("/thumb/".length));
      return;
    }

    // --- Video (proxied + cached from source on first play, then served local) ---
    if (path === "/video") {
      const src = url.searchParams.get("u");
      if (!src) return void res.writeHead(400).end("u required");
      await sendVideo(req, res, src);
      return;
    }

    // --- Downloaded media (full resolution — used by the detail lightbox) ---
    if (path.startsWith("/media/")) {
      if (sendFile(res, MEDIA_DIR, path.slice("/media/".length), "public, max-age=86400")) return;
      res.writeHead(404).end("not found");
      return;
    }

    // --- Static web UI ---
    const rel = path === "/" ? "index.html" : path.replace(/^\//, "");
    if (sendFile(res, WEB_DIR, rel)) return;

    res.writeHead(404, { "Content-Type": "text/plain" }).end("not found");
  });

  server.on("error", (e: NodeJS.ErrnoException) => {
    console.error(
      e.code === "EADDRINUSE"
        ? `\n  Port ${port} is already in use. Stop whatever is using it, or pick another port: pnpm serve --port ${port === 65535 ? 4322 : port + 1}\n`
        : `\n  Error: the web app couldn't start: ${e.message}\n`
    );
    process.exit(1);
  });

  server.listen(port, HOST, () => {
    console.log(`\n  x-likes → http://localhost:${port}\n`);
    console.log(`  data:  ${DB_PATH}`);
    console.log(`  media: ${MEDIA_DIR}\n`);
  });
}
