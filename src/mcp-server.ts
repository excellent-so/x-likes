/**
 * MCP server — the "second brain" interface.
 *
 * Exposes your liked-tweet knowledgebase to any MCP client (the Claude CLI,
 * Claude Desktop) as a set of read tools so Claude can search your saved
 * resources and pull the right one on demand. It opens the same SQLite DB the
 * web app uses (honoring XLIKES_DATA_DIR), and reuses src/search.ts.
 *
 * Register with the Claude CLI:
 *   claude mcp add x-likes -- pnpm --dir /path/to/x-likes mcp
 *
 * Everything here is read-only. Anything written to stdout must be JSON-RPC, so
 * all logging goes to stderr.
 */
import "./env.js"; // first: db.ts reads XLIKES_DATA_DIR when it loads
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DB_PATH } from "./db.js";
import {
  getLikeFull,
  likesByTag,
  listTags,
  relatedTo,
  search,
  searchHybrid,
  stats,
  type FullLike,
  type ResultTweet,
} from "./search.js";

/** Compact a full record into a token-frugal shape for search hits. */
function brief(t: ResultTweet, snippet = 240) {
  const text = (t.text ?? "").replace(/\s+/g, " ").trim();
  return {
    id: t.tweet_id,
    who: t.author_handle ? `@${t.author_handle}` : "(archived)",
    name: t.author_name ?? undefined,
    when: t.created_at ?? undefined,
    text: text.length > snippet ? text.slice(0, snippet) + "…" : text,
    url: t.url ?? undefined,
    tags: t.tags?.length ? t.tags.map((x) => x.label) : undefined,
    images: t.media.length || undefined,
    article: t.article_count ? true : undefined,
    links: t.links.length ? t.links.map((l) => l.url) : undefined,
    status: t.hydration === "ok" ? undefined : t.hydration, // only note the unusual
  };
}

/** Full record for like_get — text, links, image OCR/captions, article text, tags. */
function full(t: FullLike) {
  return {
    id: t.tweet_id,
    author: t.author_handle ? `@${t.author_handle}` : null,
    author_name: t.author_name,
    liked_position: t.liked_order,
    date: t.created_at,
    url: t.url,
    text: t.text,
    favorites: t.favorite_count,
    hydration: t.hydration,
    tags: t.tags.map((x) => x.label),
    links: t.links,
    media: t.media.map((m) => {
      const v = t.vision.find((x) => x.remote_url === m.remote_url);
      return {
        kind: m.kind,
        alt: m.alt || undefined,
        caption: v?.caption || undefined,
        ocr_text: v?.ocr_text || undefined,
        local_path: m.local_path || undefined,
        remote_url: m.remote_url,
        video_url: m.video_url || undefined,
      };
    }),
    articles: t.articles.map((a) => ({
      url: a.final_url || a.url,
      title: a.title,
      site: a.site_name,
      excerpt: a.excerpt,
      words: a.word_count,
      text: a.text ? a.text.slice(0, 4000) + (a.text.length > 4000 ? "…" : "") : null,
    })),
  };
}

function text(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

const server = new McpServer({ name: "x-likes", version: "0.1.0" });

server.registerTool(
  "likes_search",
  {
    title: "Search liked tweets",
    description:
      "Hybrid semantic + keyword search across the user's Twitter/X likes — tweet text, author, links, " +
      "tags, the full text of linked articles, and text read out of images (OCR). This is the primary way " +
      "to find saved resources: bookmarks the user kept about projects, tools, papers, and ideas. Results " +
      "default to newest first (by the tweet's own date); pass sort:'relevance' to rank by meaning " +
      "(embeddings fused with keywords) so related concepts surface even without exact word matches. " +
      "Filter by author, tag, or to only likes with an image or an external link. " +
      "Returns compact hits; call like_get with an id for the full record incl. article text + OCR.",
    inputSchema: {
      q: z.string().optional().describe("what you're looking for; natural language works (semantic search)"),
      author: z.string().optional().describe("only likes from this @handle"),
      tag: z.string().optional().describe("only likes with this tag slug (see list_tags)"),
      has_image: z.boolean().optional().describe("only likes that include an image"),
      has_link: z.boolean().optional().describe("only likes with an external link"),
      sort: z.enum(["relevance", "liked", "newest", "oldest"]).optional().describe("default 'newest' (by tweet date); 'relevance' = best semantic/keyword match, 'liked' = most recently liked, 'oldest' = oldest tweet first"),
      limit: z.number().int().min(1).max(50).optional().describe("default 10"),
      offset: z.number().int().min(0).optional(),
    },
  },
  async (a) => {
    const limit = a.limit ?? 10;
    const res = await searchHybrid({
      q: a.q,
      author: a.author,
      tag: a.tag,
      hasImage: a.has_image,
      hasLink: a.has_link,
      sort: a.sort ?? "newest",
      limit,
      offset: a.offset ?? 0,
    });
    return text({
      total: res.total,
      ranking: res.mode, // hybrid | semantic | keyword | browse
      showing: res.results.length,
      offset: a.offset ?? 0,
      hits: res.results.map((t) => brief(t)),
    });
  }
);

server.registerTool(
  "like_get",
  {
    title: "Get one liked tweet in full",
    description:
      "Return the complete record for a single like by tweet id: full text, author, date, all external links, " +
      "and every image (with the local file path on disk and the original URL). Use after likes_search to open a result.",
    inputSchema: { id: z.string().describe("the tweet id from a search hit") },
  },
  async (a) => {
    const t = getLikeFull(a.id);
    if (!t) return text({ error: `no like with id ${a.id}` });
    return text(full(t));
  }
);

server.registerTool(
  "read_article",
  {
    title: "Read the article behind a like",
    description:
      "Return the full extracted text of the article(s) linked from a liked tweet — the context behind the " +
      "bookmark. Use when a search hit references an article and you need to actually read it to answer.",
    inputSchema: { id: z.string().describe("the tweet id") },
  },
  async (a) => {
    const t = getLikeFull(a.id);
    if (!t) return text({ error: `no like with id ${a.id}` });
    if (!t.articles.length) return text({ id: a.id, articles: [], note: "no linked article was extracted for this like" });
    return text({
      id: a.id,
      articles: t.articles.map((x) => ({ url: x.final_url || x.url, title: x.title, site: x.site_name, words: x.word_count, text: x.text })),
    });
  }
);

server.registerTool(
  "list_tags",
  {
    title: "List the tag vocabulary",
    description:
      "The topical tags and named entities derived across the whole library, with how many likes carry each. " +
      "Use to discover themes, then likes_search with a tag to drill in.",
    inputSchema: { limit: z.number().int().min(1).max(200).optional().describe("default 60") },
  },
  async (a) => text({ tags: listTags(a.limit ?? 60) })
);

server.registerTool(
  "likes_by_tag",
  {
    title: "Likes with a tag",
    description: "Every like carrying a given tag slug (from list_tags).",
    inputSchema: {
      tag: z.string().describe("the tag slug"),
      limit: z.number().int().min(1).max(50).optional(),
    },
  },
  async (a) => {
    const hits = likesByTag(a.tag, a.limit ?? 25);
    return text({ tag: a.tag, total: hits.length, hits: hits.map((t) => brief(t)) });
  }
);

server.registerTool(
  "related_to",
  {
    title: "Find related likes",
    description:
      "Given one like, return others that are semantically related (by embedding neighborhood, falling back " +
      "to shared tags). Use to expand from one saved resource to everything nearby in the user's interests.",
    inputSchema: {
      id: z.string().describe("the tweet id to find neighbors of"),
      limit: z.number().int().min(1).max(30).optional().describe("default 10"),
    },
  },
  async (a) => {
    const hits = relatedTo(a.id, a.limit ?? 10);
    return text({ id: a.id, related: hits.map((t) => brief(t)) });
  }
);

server.registerTool(
  "likes_recent",
  {
    title: "Most recently liked",
    description: "The user's most recent likes, newest first by liked order. Good for 'what did I just save?'.",
    inputSchema: { limit: z.number().int().min(1).max(50).optional().describe("default 15") },
  },
  async (a) => {
    const res = search({ sort: "liked", limit: a.limit ?? 15 });
    return text({ total: res.total, hits: res.results.map((t) => brief(t)) });
  }
);

server.registerTool(
  "likes_by_author",
  {
    title: "All likes from an author",
    description: "Every like the user saved from a given @handle.",
    inputSchema: {
      author: z.string().describe("the @handle (with or without @)"),
      limit: z.number().int().min(1).max(50).optional(),
    },
  },
  async (a) => {
    const res = search({ author: a.author, sort: "liked", limit: a.limit ?? 25 });
    return text({ author: a.author, total: res.total, hits: res.results.map((t) => brief(t)) });
  }
);

server.registerTool(
  "list_authors",
  {
    title: "Top saved authors",
    description:
      "The accounts the user has liked most — the closest thing to a topic index until tags land. " +
      "Use to discover whose content the user saves, then likes_by_author to drill in.",
    inputSchema: {},
  },
  async () => text({ authors: stats().topAuthors })
);

server.registerTool(
  "likes_stats",
  {
    title: "Knowledgebase overview",
    description: "Counts for the whole store: total likes, how many are fetched, how many have images or links.",
    inputSchema: {},
  },
  async () => {
    const s = stats();
    return text({
      likes: s.likes,
      fetched: s.hydrated,
      unavailable: s.gone,
      pending: s.pending,
      with_images: s.withImages,
      with_links: s.withLinks,
      images_on_disk: s.mediaFiles,
    });
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[x-likes mcp] serving ${DB_PATH}`);
}

main().catch((e) => {
  console.error("[x-likes mcp] fatal:", e);
  process.exit(1);
});
