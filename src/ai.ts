/**
 * Pluggable intelligence for the enrichment stages.
 *
 *   describeImage()  — caption + OCR + labels for an image
 *   generateTags()   — topical tags + named entities for a composite document
 *   embed()          — 384-dim sentence embeddings
 *
 * Every capability has an offline, deterministic "mock" provider so the entire
 * pipeline builds and runs with no API key and no cost, plus a real provider:
 *   vision/tags → Anthropic (Claude) when XLIKES_AI_PROVIDER=anthropic or an
 *                 ANTHROPIC_API_KEY is present.
 *   embed       → local MiniLM (Transformers.js) — free, private, on-device.
 */
import { readFileSync } from "node:fs";
import { extname } from "node:path";

const AI_PROVIDER =
  process.env.XLIKES_AI_PROVIDER ??
  (process.env.ANTHROPIC_API_KEY ? "anthropic" : "mock");
const EMBED_PROVIDER = process.env.XLIKES_EMBED_PROVIDER ?? "local";
const AI_MODEL = process.env.XLIKES_AI_MODEL ?? "claude-haiku-4-5-20251001";
const EMBED_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBED_DIM = 384;

export function aiProvider(): string {
  return AI_PROVIDER;
}
export function embedProvider(): string {
  return EMBED_PROVIDER;
}

// Rough per-1M-token prices (USD) for cost attribution; override via env.
const PRICE_IN = Number(process.env.XLIKES_PRICE_IN ?? 1) / 1_000_000;
const PRICE_OUT = Number(process.env.XLIKES_PRICE_OUT ?? 5) / 1_000_000;

// Claude reads JPEG, PNG, GIF and WebP up to 5 MB once base64-encoded, so about 3.75 MB of file.
const MAX_IMAGE_BYTES = Math.floor((5 * 1024 * 1024 * 3) / 4);
const MAX_IMAGE_EDGE = 1568; // Claude scales anything larger down to this anyway

/**
 * A problem with the Claude setup (the key, the model, the credit balance) rather than with one like. The stages
 * stop at the first one, leave every unread like pending, and the CLI prints this message, which says what to fix.
 */
export class AiSetupError extends Error {}

/** Throw an AiSetupError when XLIKES_AI_PROVIDER or XLIKES_EMBED_PROVIDER isn't one x-likes knows. */
export function checkProviders(): void {
  if (AI_PROVIDER !== "anthropic" && AI_PROVIDER !== "mock")
    throw new AiSetupError(`XLIKES_AI_PROVIDER must be "anthropic" or "mock", not "${AI_PROVIDER}".`);
  if (EMBED_PROVIDER !== "local" && EMBED_PROVIDER !== "mock")
    throw new AiSetupError(`XLIKES_EMBED_PROVIDER must be "local" or "mock", not "${EMBED_PROVIDER}".`);
}

/** Turn an error from the Anthropic SDK into an AiSetupError when it is about the setup, not the request. */
function setupProblem(e: unknown): AiSetupError | null {
  const err = e as { status?: number; message?: string } | null;
  const status = err?.status;
  const msg = String(err?.message ?? e);
  if (status === 401)
    return new AiSetupError("Claude rejected the API key (401). Check ANTHROPIC_API_KEY, in your shell or in .env.");
  if (status === 403)
    return new AiSetupError("The API key isn't allowed to use this model (403). Check the key in the Anthropic Console.");
  if (status === 404)
    return new AiSetupError(`Claude can't find the model "${AI_MODEL}" for this key (404). Check XLIKES_AI_MODEL.`);
  if (status === 402 || (status === 400 && /credit balance/i.test(msg)))
    return new AiSetupError(`Anthropic refused for billing (${status}): check your plan and credit in the Anthropic Console.`);
  if (status === undefined && /authentication method|api.?key/i.test(msg))
    return new AiSetupError("XLIKES_AI_PROVIDER is anthropic, but ANTHROPIC_API_KEY is not set.");
  return null;
}

/** The file's real image type, from its first bytes (a saved file's extension can be wrong). */
function sniffMime(b: Buffer): string | null {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && b.readUInt32BE(0) === 0x89504e47) return "image/png";
  if (b.length > 6 && b.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  if (b.length > 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

/**
 * The image as Claude accepts it. A JPEG, PNG, GIF or WebP small enough goes as it is. Anything else (the demo's
 * SVG placeholders, AVIF, a file too large) is converted with sharp to a PNG at most 1568 px on its long edge, or
 * to a JPEG if the PNG is still too large.
 */
export async function imageForClaude(path: string): Promise<{ mime: string; data: Buffer }> {
  const buf = readFileSync(path);
  const mime = sniffMime(buf);
  if (mime && buf.length <= MAX_IMAGE_BYTES) return { mime, data: buf };
  const { default: sharp } = await import("sharp");
  const resized = () =>
    sharp(buf, { animated: false }).resize({
      width: MAX_IMAGE_EDGE,
      height: MAX_IMAGE_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    });
  const png = await resized().png().toBuffer();
  if (png.length <= MAX_IMAGE_BYTES) return { mime: "image/png", data: png };
  return { mime: "image/jpeg", data: await resized().jpeg({ quality: 85 }).toBuffer() };
}

// ── shared types ──────────────────────────────────────────────────────────────
export interface VisionResult {
  caption: string | null;
  ocr_text: string | null;
  labels: string | null;
  model: string;
  cost: number;
}
export interface ImageContext {
  alt?: string | null;
  tweetText?: string | null;
  author?: string | null;
}
export interface Entity {
  name: string;
  kind: "person" | "org" | "product" | "repo" | "paper" | "topic";
}
export interface TagResult {
  topics: string[];
  entities: Entity[];
  model: string;
  cost: number;
}

// ── Anthropic client (lazy) ───────────────────────────────────────────────────
let _anthropic: any = null;
async function anthropic(): Promise<any> {
  if (_anthropic) return _anthropic;
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  _anthropic = new Anthropic();
  return _anthropic;
}

/** One Messages API call, with setup problems (key, model, credit) raised as an AiSetupError. */
async function ask(params: Record<string, unknown>): Promise<any> {
  try {
    return await (await anthropic()).messages.create(params);
  } catch (e) {
    throw setupProblem(e) ?? e;
  }
}

function textFrom(msg: any): string {
  const block = (msg?.content ?? []).find((b: any) => b.type === "text");
  return block?.text ?? "";
}
function costFrom(msg: any): number {
  const u = msg?.usage ?? {};
  return (u.input_tokens ?? 0) * PRICE_IN + (u.output_tokens ?? 0) * PRICE_OUT;
}
/** Extract the first JSON object/array from a model reply. */
function parseJson<T>(s: string, fallback: T): T {
  const m = s.match(/[[{][\s\S]*[\]}]/);
  if (!m) return fallback;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return fallback;
  }
}

// ── describeImage ─────────────────────────────────────────────────────────────
export async function describeImage(imagePath: string, ctx: ImageContext = {}): Promise<VisionResult> {
  checkProviders();
  if (AI_PROVIDER === "anthropic") return describeImageAnthropic(imagePath, ctx);
  return describeImageMock(imagePath, ctx);
}

async function describeImageAnthropic(imagePath: string, ctx: ImageContext): Promise<VisionResult> {
  const { mime, data } = await imageForClaude(imagePath);
  const prompt =
    `Describe this image from a saved tweet.` +
    (ctx.tweetText ? ` Tweet text: "${ctx.tweetText}".` : "") +
    ` Reply with ONLY JSON: {"caption": "one or two sentences", "ocr_text": "ALL text visible in the image, verbatim, or empty string", "labels": ["3-6", "topic", "words"]}.`;
  const msg = await ask({
    model: AI_MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mime, data: data.toString("base64") } },
          { type: "text", text: prompt },
        ],
      },
    ],
  });
  const j = parseJson<{ caption?: string; ocr_text?: string; labels?: string[] }>(textFrom(msg), {});
  return {
    caption: j.caption ?? null,
    ocr_text: j.ocr_text ? j.ocr_text.trim() : null,
    labels: j.labels?.length ? j.labels.join(", ") : null,
    model: AI_MODEL,
    cost: costFrom(msg),
  };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Offline mock: reads embedded <text> from SVG placeholders as OCR; otherwise
 *  captions from context. Deterministic, free, good enough to exercise search. */
function describeImageMock(imagePath: string, ctx: ImageContext): VisionResult {
  let ocr: string | null = null;
  if (extname(imagePath).toLowerCase() === ".svg") {
    try {
      const svg = readFileSync(imagePath, "utf8");
      const texts = [...svg.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map((m) =>
        decodeEntities((m[1] ?? "").replace(/<[^>]+>/g, "")).trim()
      );
      const joined = texts.filter(Boolean).join("\n").trim();
      ocr = joined || null;
    } catch {
      /* ignore */
    }
  }
  const caption =
    ctx.alt?.trim() ||
    (ocr ? `Screenshot: ${(ocr.split("\n")[0] ?? "").slice(0, 80)}` : null) ||
    (ctx.tweetText ? `Image accompanying: ${ctx.tweetText.slice(0, 60)}` : "An image from a saved tweet");
  return { caption, ocr_text: ocr, labels: null, model: "mock-vision", cost: 0 };
}

// ── generateTags ──────────────────────────────────────────────────────────────
export async function generateTags(doc: string): Promise<TagResult> {
  checkProviders();
  if (!doc.trim()) return { topics: [], entities: [], model: "empty", cost: 0 };
  if (AI_PROVIDER === "anthropic") return generateTagsAnthropic(doc);
  return generateTagsMock(doc);
}

async function generateTagsAnthropic(doc: string): Promise<TagResult> {
  const prompt =
    `You tag saved bookmarks for a personal knowledge base. From the text below, extract:\n` +
    `- 3 to 7 lowercase topical tags (short noun phrases, reusable across bookmarks)\n` +
    `- named entities: people, orgs, products, github repos, papers.\n` +
    `Reply with ONLY JSON: {"topics":["..."],"entities":[{"name":"...","kind":"person|org|product|repo|paper"}]}\n\n` +
    `TEXT:\n${doc.slice(0, 6000)}`;
  const msg = await ask({
    model: AI_MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });
  const j = parseJson<{ topics?: string[]; entities?: Entity[] }>(textFrom(msg), {});
  return {
    topics: (j.topics ?? []).filter(Boolean).slice(0, 8),
    entities: (j.entities ?? []).filter((e) => e && e.name),
    model: AI_MODEL,
    cost: costFrom(msg),
  };
}

const STOP = new Set(
  ("a an the and or but of to in on for with at by from is are was were be been being this that these those " +
    "it its as we you they he she his her their our your my me i so if then than out up down over under just " +
    "not no yes do does did has have had will would can could should about into via more most very can't im " +
    "there here what when where who why how which while also new get got make made use using used one two " +
    "image images text screenshot article apos amp quot lt gt your you're every single still")
    .split(" ")
);

/** Offline mock: frequency keywords + @handles/#tags/github repos as entities. */
function generateTagsMock(doc: string): TagResult {
  const entities: Entity[] = [];
  const seen = new Set<string>();
  const add = (name: string, kind: Entity["kind"]) => {
    const k = name.toLowerCase();
    if (name && !seen.has(k)) {
      seen.add(k);
      entities.push({ name, kind });
    }
  };
  for (const m of doc.matchAll(/@(\w{2,15})/g)) add("@" + m[1]!, "person");
  for (const m of doc.matchAll(/github\.com\/([\w.-]+\/[\w.-]+)/g)) add(m[1]!, "repo");
  for (const m of doc.matchAll(/#(\w{2,30})/g)) add(m[1]!, "topic");

  const freq = new Map<string, number>();
  for (const w of doc.toLowerCase().match(/[a-z][a-z0-9+#.-]{2,}/g) ?? []) {
    const t = w.replace(/[.\-]+$/, "");
    if (t.length < 3 || STOP.has(t)) continue;
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }
  const topics = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([t]) => t);
  return { topics, entities: entities.slice(0, 8), model: "mock-tags", cost: 0 };
}

// ── embeddings ────────────────────────────────────────────────────────────────
let _extractor: any = null;
async function extractor(): Promise<any> {
  if (_extractor) return _extractor;
  const { pipeline, env } = await import("@xenova/transformers");
  env.allowLocalModels = false; // fetch from the hub, cache locally
  _extractor = await pipeline("feature-extraction", EMBED_MODEL);
  return _extractor;
}

export interface EmbedResult {
  vectors: Float32Array[];
  model: string;
  dim: number;
}

export async function embed(texts: string[]): Promise<EmbedResult> {
  checkProviders();
  if (texts.length === 0) return { vectors: [], model: EMBED_PROVIDER, dim: EMBED_DIM };
  if (EMBED_PROVIDER === "mock") {
    return { vectors: texts.map(mockEmbed), model: "mock-embed", dim: EMBED_DIM };
  }
  const ex = await extractor();
  const out = await ex(
    texts.map((t) => t.slice(0, 4000)),
    { pooling: "mean", normalize: true }
  );
  const list = out.tolist() as number[][];
  return { vectors: list.map((v) => Float32Array.from(v)), model: EMBED_MODEL, dim: EMBED_DIM };
}

/** Deterministic hashed bag-of-words embedding — a signal-bearing fallback. */
function mockEmbed(text: string): Float32Array {
  const v = new Float32Array(EMBED_DIM);
  for (const w of text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []) {
    let h = 2166136261;
    for (let i = 0; i < w.length; i++) {
      h ^= w.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const idx = Math.abs(h) % EMBED_DIM;
    v[idx] = (v[idx] ?? 0) + 1;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < v.length; i++) v[i] = (v[i] ?? 0) / norm;
  return v;
}

// ── vector (de)serialization ──────────────────────────────────────────────────
export function packVec(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
export function unpackVec(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
export function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot; // vectors are unit-normalized, so dot == cosine
}
