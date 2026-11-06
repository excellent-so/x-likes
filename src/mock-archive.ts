/**
 * Generate a self-contained mock Twitter/X data archive that mimics what the
 * real "Download an archive of your data" produces — a `data/like.js` in the
 * exact `window.YTD.like.partN = [...]` format — plus everything needed to run
 * the FULL pipeline offline:
 *   - mock-hydrated.json : rich per-tweet data the mock hydration source serves
 *   - media/*.svg        : placeholder images, some "screenshots" with real text (OCR)
 *   - articles/*.html    : local article fixtures the article stage extracts
 *
 * The likes are a coherent set of tech/project bookmarks so tagging, embeddings,
 * and semantic search all have meaningful signal to work with.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

interface MediaSpec {
  type: "photo" | "screenshot" | "video";
  alt: string;
  /** Lines of text baked into a "screenshot" SVG — becomes OCR text. */
  lines?: string[];
  color?: string;
}
interface Spec {
  id: string;
  handle: string;
  name: string;
  text: string;
  created_at: string;
  favorites: number;
  article?: { file: string; title: string; site: string; paras: string[] };
  extLinks?: { url: string; display: string }[];
  media?: MediaSpec[];
  deleted?: boolean; // in like.js but absent from hydration → exercises the "gone" path
}

const SPECS: Spec[] = [
  {
    id: "1500000000000000001",
    handle: "smallcelltech",
    name: "Local-First Weekly",
    text: "Local-first software: your data lives on your device, syncs peer-to-peer, and keeps working offline. CRDTs make the merge conflict-free. This is the future of apps.",
    created_at: "2023-01-12T15:04:05.000Z",
    favorites: 4213,
    article: {
      file: "local-first.html",
      title: "Local-first software: you own your data, in spite of the cloud",
      site: "inkandswitch.com",
      paras: [
        "We believe in a future where the software you use every day treats you as the owner of your own data. Local-first software keeps the primary copy of the data on your own device, so the app keeps working whether or not you have a network connection.",
        "The cloud gave us collaboration and convenience, but it took away ownership and longevity. Local-first ideals ask for both: real-time collaboration and the guarantee that your work outlives any particular company or server.",
        "Conflict-free replicated data types (CRDTs) are the key enabling technology. They let multiple replicas be edited independently and merged automatically, without a central coordinator and without conflicts.",
      ],
    },
    media: [{ type: "photo", alt: "Diagram of devices syncing peer to peer", color: "#1d4ed8" }],
  },
  {
    id: "1500000000000000002",
    handle: "sqlite_wisdom",
    name: "SQLite Facts",
    text: "SQLite full-text search with FTS5 is criminally underrated. bm25 ranking, prefix queries, and it's all in a single file. You do not need Elasticsearch for a few million rows.",
    created_at: "2023-02-20T11:22:33.000Z",
    favorites: 8890,
    media: [
      {
        type: "screenshot",
        alt: "Terminal showing an FTS5 query",
        lines: [
          "CREATE VIRTUAL TABLE docs USING fts5(title, body);",
          "SELECT rowid, bm25(docs) AS rank",
          "  FROM docs WHERE docs MATCH 'local first'",
          "  ORDER BY rank LIMIT 10;",
        ],
      },
    ],
  },
  {
    id: "1500000000000000003",
    handle: "rustlang_daily",
    name: "Rust Daily",
    text: "Ownership and borrowing eliminate whole classes of bugs at compile time. No garbage collector, no data races. Rust is how you write fast software you can trust.",
    created_at: "2023-03-05T09:00:00.000Z",
    favorites: 6120,
    extLinks: [{ url: "https://doc.rust-lang.org/book/", display: "doc.rust-lang.org/book" }],
  },
  {
    id: "1500000000000000004",
    handle: "agentbuilder",
    name: "Ada — building agents",
    text: "Spent the weekend building an LLM agent that plans, calls tools, and verifies its own output before shipping. The trick is a tight verify loop, not a bigger model.",
    created_at: "2023-04-18T18:45:00.000Z",
    favorites: 15300,
    article: {
      file: "agent-loops.html",
      title: "The agent loop: plan, act, verify, repeat",
      site: "example.dev",
      paras: [
        "An agent is not a single prompt. It is a loop: perceive the state, plan a next action, execute a tool, observe the result, and decide whether the goal is met. The quality of the loop matters more than the raw capability of the model.",
        "Verification is the part most people skip. Before an agent marks work done, a separate check — ideally a different model or a deterministic test — should confirm the output actually satisfies the goal. Self-verification alone is unreliable.",
        "Budgets and guardrails keep loops safe. Cap the number of steps, cap spend, and make every tool call go through a permission layer that can deny destructive actions.",
      ],
    },
    media: [
      {
        type: "screenshot",
        alt: "Pseudo-code of an agent loop",
        lines: [
          "while not done:",
          "    plan = model.plan(state)",
          "    result = tools.run(plan.action)",
          "    state = observe(result)",
          "    done = verifier.check(state, goal)",
        ],
      },
    ],
  },
  {
    id: "1500000000000000005",
    handle: "typed_notes",
    name: "Typed Notes",
    text: "Discriminated unions + exhaustive switch = your compiler catches the case you forgot. Model your state as data and let the types do the work.",
    created_at: "2023-05-30T14:15:00.000Z",
    favorites: 9021,
    media: [
      {
        type: "screenshot",
        alt: "TypeScript discriminated union example",
        lines: [
          "type State =",
          "  | { kind: 'loading' }",
          "  | { kind: 'error'; message: string }",
          "  | { kind: 'ready'; data: Item[] };",
        ],
      },
    ],
  },
  {
    id: "1500000000000000006",
    handle: "designdept",
    name: "Design Systems Club",
    text: "A design system is not a component library. It is a set of shared decisions — spacing scale, type ramp, color roles — encoded so every screen is consistent by default.",
    created_at: "2023-06-11T08:30:00.000Z",
    favorites: 3340,
    media: [{ type: "photo", alt: "A grid of UI components on a dark background", color: "#0f766e" }],
  },
  {
    id: "1500000000000000007",
    handle: "tiny_web_tools",
    name: "Tiny Web Tools",
    text: "New project: pipe your SQLite database straight into a searchable web UI. Everything static, everything local. datasette-style. github.com/mock/datasette-lite",
    created_at: "2023-07-02T20:10:00.000Z",
    favorites: 12400,
    extLinks: [{ url: "https://github.com/mock/datasette-lite", display: "github.com/mock/datasette-lite" }],
  },
  {
    id: "1500000000000000008",
    handle: "embeddings_io",
    name: "Vector Search Notes",
    text: "You can do semantic search on-device: a 384-dim MiniLM embedding per document, cosine similarity in a loop. For a few thousand docs you do not need a vector database.",
    created_at: "2023-08-14T13:05:00.000Z",
    favorites: 5567,
    article: {
      file: "on-device-vectors.html",
      title: "On-device semantic search with tiny embedding models",
      site: "vectors.example",
      paras: [
        "Semantic search used to require a hosted embedding API and a dedicated vector database. Neither is necessary for personal-scale collections. A small sentence-transformer that runs locally produces 384-dimensional vectors in milliseconds.",
        "With a few thousand documents, brute-force cosine similarity over normalized vectors is faster than the network round-trip a hosted service would cost. Store the vectors as float32 blobs and iterate.",
        "Hybrid retrieval — fusing keyword BM25 with vector similarity via reciprocal rank fusion — beats either signal alone, especially for short queries where exact terms matter.",
      ],
    },
  },
  {
    id: "1500000000000000009",
    handle: "keyboardmaxxing",
    name: "Ergo Keebs",
    text: "Split ergonomic keyboards changed my wrists. Columnar stagger, thumb clusters, and QMK for layers. Worth the two-week adaptation curve.",
    created_at: "2023-09-09T17:25:00.000Z",
    favorites: 2210,
    media: [{ type: "photo", alt: "A split mechanical keyboard on a wooden desk", color: "#7c2d12" }],
  },
  {
    id: "1500000000000000010",
    handle: "launch_notes",
    name: "Launch Notes",
    text: "Reusable boosters landing back on the pad still looks like science fiction every single time. Video from tonight's launch.",
    created_at: "2023-10-21T02:40:00.000Z",
    favorites: 44010,
    media: [{ type: "video", alt: "A rocket booster landing at night", color: "#111827" }],
  },
  {
    id: "1500000000000000011",
    handle: "papers_daily",
    name: "arXiv Digest",
    text: "Attention Is All You Need — the transformer paper that started it all. Self-attention replaced recurrence and the field never looked back. A must-read.",
    created_at: "2023-11-03T10:00:00.000Z",
    favorites: 18800,
    extLinks: [{ url: "https://arxiv.org/abs/1706.03762", display: "arxiv.org/abs/1706.03762" }],
  },
  {
    id: "1500000000000000012",
    handle: "pourover_daily",
    name: "Pourover Daily",
    text: "Water temperature matters more than grind size for pourover. 96°C, 60g/L, and a slow bloom. Simple.",
    created_at: "2023-12-15T07:12:00.000Z",
    favorites: 1780,
  },
  {
    id: "1500000000000000013",
    handle: "mcp_dev",
    name: "MCP Notes",
    text: "The Model Context Protocol lets any tool expose resources and tools to an LLM over stdio or HTTP. Wire your own data in and the model can query it directly.",
    created_at: "2024-01-08T16:35:00.000Z",
    favorites: 7650,
    article: {
      file: "mcp-intro.html",
      title: "Giving your assistant a memory with the Model Context Protocol",
      site: "protocol.example",
      paras: [
        "The Model Context Protocol standardizes how an application exposes context to a language model. A server advertises tools and resources; a client — the model's host — calls them on demand during a conversation.",
        "This turns any local dataset into a queryable memory. Point a small MCP server at your notes, your bookmarks, or your database, and the assistant can search and cite them without the data ever leaving your machine.",
        "Because transport is stdio or HTTP and payloads are plain JSON, servers are tiny and composable. A read-only server over a SQLite file is a few dozen lines.",
      ],
    },
  },
  {
    id: "1500000000000000014",
    handle: "gone_account",
    name: "Deleted",
    text: "This tweet was liked but has since been deleted — it should show as unavailable, keeping only the archived text.",
    created_at: "2024-02-01T00:00:00.000Z",
    favorites: 0,
    deleted: true,
  },
];

function screenshotSvg(lines: string[]): string {
  const rows = lines
    .map(
      (l, i) =>
        `<text x="28" y="${64 + i * 34}" font-family="ui-monospace, Menlo, monospace" font-size="20" fill="#e6edf3">${escapeXml(
          l
        )}</text>`
    )
    .join("\n  ");
  const h = 90 + lines.length * 34;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="${h}" viewBox="0 0 760 ${h}">
  <rect width="760" height="${h}" rx="12" fill="#0d1117"/>
  <circle cx="24" cy="22" r="6" fill="#ff5f56"/><circle cx="44" cy="22" r="6" fill="#ffbd2e"/><circle cx="64" cy="22" r="6" fill="#27c93f"/>
  ${rows}
</svg>`;
}

function photoSvg(alt: string, color: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="440" viewBox="0 0 760 440">
  <rect width="760" height="440" fill="${color}"/>
  <rect width="760" height="440" fill="url(#g)"/>
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#ffffff" stop-opacity="0.14"/><stop offset="1" stop-color="#000000" stop-opacity="0.3"/>
  </linearGradient></defs>
  <text x="50%" y="50%" text-anchor="middle" font-family="-apple-system, sans-serif" font-size="22" fill="#ffffff" opacity="0.85">${escapeXml(
    alt
  )}</text>
</svg>`;
}

function articleHtml(title: string, site: string, paras: string[]): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${escapeXml(title)}</title>
<meta property="og:site_name" content="${escapeXml(site)}">
<meta property="og:image" content="https://example.com/lead.jpg">
</head><body>
<article><h1>${escapeXml(title)}</h1>
${paras.map((p) => `<p>${escapeXml(p)}</p>`).join("\n")}
</article></body></html>`;
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
}

export function generateMockArchive(root: string): { likes: number; dir: string; hydrationFile: string } {
  const dir = resolve(root);
  const dataDir = join(dir, "data");
  const mediaDir = join(dir, "media");
  const artDir = join(dir, "articles");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(mediaDir, { recursive: true });
  mkdirSync(artDir, { recursive: true });

  const likeEntries: string[] = [];
  const hydrated: Record<string, unknown> = {};

  for (const s of SPECS) {
    const links: { url: string; display_url: string }[] = [];
    if (s.article) {
      const p = join(artDir, s.article.file);
      writeFileSync(p, articleHtml(s.article.title, s.article.site, s.article.paras));
      links.push({ url: pathToFileURL(p).href, display_url: s.article.site });
    }
    for (const l of s.extLinks ?? []) links.push({ url: l.url, display_url: l.display });

    const expandedUrl = `https://twitter.com/${s.handle}/status/${s.id}`;
    likeEntries.push(
      JSON.stringify({ like: { tweetId: s.id, fullText: s.text, expandedUrl } }, null, 2)
    );
    if (s.deleted) continue; // present in like.js but not hydrated → "gone"

    const media = (s.media ?? []).map((m, i) => {
      const fname = `${s.id}-${i}.svg`;
      const svg = m.type === "screenshot" ? screenshotSvg(m.lines ?? []) : photoSvg(m.alt, m.color ?? "#334155");
      writeFileSync(join(mediaDir, fname), svg);
      return {
        kind: m.type === "video" ? "video" : m.type === "screenshot" ? "photo" : "photo",
        remote_url: pathToFileURL(join(mediaDir, fname)).href,
        video_url: m.type === "video" ? "https://video.example/mock.mp4" : undefined,
        width: 760,
        height: 440,
        alt: m.alt,
      };
    });

    hydrated[s.id] = {
      tweet_id: s.id,
      author_name: s.name,
      author_handle: s.handle,
      author_avatar_url: null,
      text: s.text,
      created_at: s.created_at,
      lang: "en",
      url: `https://x.com/${s.handle}/status/${s.id}`,
      quoted_tweet_id: null,
      quoted_text: null,
      quoted_handle: null,
      favorite_count: s.favorites,
      is_reply: false,
      possibly_sensitive: false,
      media,
      links,
      raw: { mock: true },
    };
  }

  const likeJs = `window.YTD.like.part0 = [\n${likeEntries.join(",\n")}\n]\n`;
  writeFileSync(join(dataDir, "like.js"), likeJs);
  writeFileSync(
    join(dataDir, "account.js"),
    `window.YTD.account.part0 = [\n${JSON.stringify(
      { account: { username: "mock_user", accountId: "999999", createdVia: "web", createdAt: "2011-01-01T00:00:00.000Z" } },
      null,
      2
    )}\n]\n`
  );
  const hydrationFile = join(dir, "mock-hydrated.json");
  writeFileSync(hydrationFile, JSON.stringify(hydrated, null, 2));

  return { likes: SPECS.length, dir, hydrationFile };
}
