<img src="docs/mark.svg" width="40" height="40" alt="">

# x-likes

A local, searchable archive of your X likes. It reads the likes from your X data archive into a SQLite file on
your machine, fetches each tweet's text and images, and then enriches every like: the full text of any linked
article, a caption and OCR for every image, and topic tags. You search it by keyword or by meaning in a local web
app, and an MCP server lets Claude search it for you.

Docs and how to use it: https://playbook.excellent.so/x-likes

<img width="700" alt="The x-likes web app on its demo data: a search field above a grid of liked posts, some with images" src="./web/screenshot.png" />

The screenshot shows the built-in demo data.

## What it does

Each stage is incremental: it keeps its own state for every like, so running it again only does new work.

1. **Ingest.** Parse `like.js` from your X data archive: the id, text and link of every like you have made.
2. **Hydrate.** Fetch each tweet from X's public embed endpoint (`cdn.syndication.twimg.com`, no login) for the
   author, full text and links, and download its images. A deleted tweet keeps the text your archive captured.
3. **Enrich.**
   - Articles: fetch each page the tweet links to and keep its readable text (Mozilla Readability). The links come
     expanded from the tweet's data, not as `t.co`. A dead link (404 or 410) is noted and not retried.
   - Images: a caption, the text in the image (OCR) and labels, from Claude or from an offline mock (see
     [Image text and tags](#image-text-and-tags-claude-or-the-offline-mock)).
   - Tags: topic tags and named entities from the tweet, article and image text.
   - Embeddings: a 384-dimension vector for each like, from a MiniLM model that runs on your machine.
4. **Search.** A local web app and an MCP server over the same database, with filters for tag, author, images and
   links.

## Requirements

- Node 22 or later (tested on 22 and 24).
- pnpm 11. The version is pinned in `package.json` (`packageManager`), so with Corepack enabled
  (`corepack enable`) `pnpm` runs that version.
- `unzip`, to read your X archive straight from its `.zip` (macOS and most Linux have it). Without it, unzip the
  archive yourself and pass the folder.

```sh
git clone https://github.com/excellent-so/x-likes.git
cd x-likes
pnpm install
```

The install compiles nothing: SQLite, sharp and the embedding runtime come prebuilt, so it needs no C++ toolchain or
Python. (On a platform better-sqlite3 has no binary for, set `better-sqlite3: true` under `allowBuilds` in
`pnpm-workspace.yaml` to build it from source.) The first `pnpm enrich` downloads the embedding model (about 23 MB)
once. x-likes is tested on macOS and Linux.

## Try the demo

No account, key or archive needed. This writes 14 sample likes in the format of X's export, with placeholder
images and local article pages, and runs the whole pipeline on them. The tweets and images come from local files;
the network is used only for the one-time model download and for the 3 web links some samples carry. One of those
is made up, so the articles line reports 1 dead link.

```sh
pnpm cli mock-archive ./mock-archive     # a sample archive in X's export format
export XLIKES_DATA_DIR=./data-mock
export XLIKES_MOCK_HYDRATION=./mock-archive/mock-hydrated.json
pnpm ingest ./mock-archive
pnpm hydrate
pnpm enrich
pnpm serve                                # http://localhost:4321
```

Then search for *programs that function with no network*. The default sort (Newest) matches words, and no like
has all of them, so the app offers **Search by meaning**. Choose it (or open Filter and pick Best match) and the
tweet about local-first software comes first, although its text has none of those words. Search for *fts5* and the
SQLite tweet comes up from the text in its screenshot: open it to see "Text in the image".

The two `export` lines stay set in that terminal. Open a new one (or run
`unset XLIKES_DATA_DIR XLIKES_MOCK_HYDRATION`) before you use your real likes.

## Use it with your real likes

1. On X, open Settings, then Your account, then Download an archive of your data. It can take a day or more to
   arrive, as a `.zip`.
2. Then:

```sh
pnpm ingest ~/Downloads/twitter-2026-xxxx.zip   # reads the .zip directly
pnpm hydrate                                     # tweet text and images (resumable)
pnpm enrich                                      # articles, OCR, tags, embeddings
pnpm serve                                       # http://localhost:4321
```

To keep current, request a fresh archive later and run `pnpm refresh <archive>`: it imports only the new likes,
then hydrates and enriches them.

**Without the archive or the API.** The open-source
[twitter-web-exporter](https://github.com/prinsss/twitter-web-exporter) userscript exports your likes to JSON from
your own browser session, with no API keys. Then:

```sh
pnpm ingest-export ~/Downloads/twitter-likes.json   # the export already holds each tweet in full
pnpm enrich
```

In the exporter, turn on **Include all metadata** before you export: only the metadata carries each tweet's links,
so without it x-likes gets the text, author and media but no articles. Importing is idempotent, so re-export and
re-import whenever you like to pick up new likes. `docs/X-API.md` compares the archive, the API and the
open-source tools.

Each enrichment stage also runs on its own, and each takes `--limit N` (the next N likes) and `--retry-errors`
(also try again the likes that failed, up to 4 tries each). `pnpm stats` says what's in the database:

```sh
pnpm cli enrich:articles   pnpm cli enrich:images
pnpm cli enrich:tags       pnpm cli enrich:embed
pnpm stats
```

`pnpm cli` with no command lists every command. When a stage has failures, it prints the reason under its line.

## Image text and tags: Claude or the offline mock

Real OCR needs an Anthropic API key. With `ANTHROPIC_API_KEY` set, in your shell or in `.env`, `pnpm enrich` sends
each downloaded image and its tweet's text to Claude for a caption, the text in the image and labels, and sends
each like's tweet, article and image text to Claude for tags. JPEG, PNG, GIF and WebP go as they are; anything else
(an SVG, an AVIF, an image over 3.75 MB) is converted to a PNG first.

If Claude refuses the key, the model or the account's credit, `pnpm enrich` stops at the first request and says
what to fix. Nothing is marked failed: run it again once it's fixed and it picks up where it stopped.

To see real OCR on the demo, read its images with Claude in a second demo store. It's 7 images, about a cent:

```sh
export XLIKES_DATA_DIR=./data-claude XLIKES_MOCK_HYDRATION=./mock-archive/mock-hydrated.json
pnpm ingest ./mock-archive && pnpm hydrate
ANTHROPIC_API_KEY=sk-ant-... pnpm cli enrich:images
pnpm serve       # open the agent-loop like: "Text in the image" is what Claude read
```

Without a key, both stages use an offline mock. Image captions come from the image's alt text or the tweet's text,
and the mock reads no text out of real photos or screenshots. It does read the text written into the demo's SVG
placeholder images, which is how OCR search works in the demo. Mock tags are the most frequent words plus the
@handles, #hashtags and GitHub repos in the text.

| Variable | What it does | Default |
|---|---|---|
| `ANTHROPIC_API_KEY` | Turns on Claude for image captions, OCR and tags | unset: the offline mock |
| `XLIKES_AI_PROVIDER` | Forces `anthropic` or `mock` | `anthropic` when a key is set, else `mock` |
| `XLIKES_AI_MODEL` | The Claude model | `claude-haiku-4-5-20251001` |
| `XLIKES_EMBED_PROVIDER` | `local` (MiniLM on your machine) or `mock` | `local` |
| `XLIKES_DATA_DIR` | Where the database and media live | `./data` |
| `XLIKES_MOCK_HYDRATION` | A JSON file of tweets to hydrate from instead of X (the demo's `mock-hydrated.json`) | unset |
| `XLIKES_PRICE_IN`, `XLIKES_PRICE_OUT` | Dollars per million input and output tokens, for the cost estimate | `1` and `5` |
| `PORT` | The web app's port (`pnpm serve --port N` works too) | `4321` |
| `XLIKES_DEBUG` | Set to `1` to print the stack trace with an error | unset |

Any of these can go in `.env` at the project root (`.env` is git-ignored). A variable set in your shell wins over
the file.

## Providers and cost

| Stage | Default | With `ANTHROPIC_API_KEY` | Cost |
|---|---|---|---|
| Embeddings | MiniLM on your machine | the same | free |
| Image captions and OCR | offline mock | Claude | your Anthropic API usage |
| Tags and entities | offline mock | Claude | your Anthropic API usage |
| Articles | Readability, run locally on each fetched page | the same | free |

Enrichment records an estimated `cost_usd` for each like and stage in the `enrichment_state` table, and
`pnpm enrich` prints each stage's estimate. Every stage takes `--limit N`, so you can check quality and cost on a
small batch before you run the whole archive.

## Keep current with the X API (optional)

`src/x-api.ts` pulls your recent likes from the X API (`GET /2/users/:id/liked_tweets`, signed with OAuth 1.0a
user context). The API returns recent likes only; your full history still comes from the archive. It needs an app
attached to a v2 Project in the X developer portal and an access tier that includes reading likes, which the Free
tier generally does not.

Copy `.env.example` to `.env` and fill in:

| Variable | Used for |
|---|---|
| `X_API_KEY`, `X_API_KEY_SECRET` | The app's consumer key and secret |
| `X_ACCESS_TOKEN`, `X_ACCESS_TOKEN_SECRET` | Your user access token and secret |
| `X_USER_ID` | Your numeric user id. If it's unset, x-likes uses the part of `X_ACCESS_TOKEN` before the first `-` |

`X_BEARER_TOKEN` is read but not used for likes, because that endpoint refuses app-only auth. `X_CLIENT_ID` and
`X_CLIENT_SECRET` are in `.env.example` for OAuth 2.0, which nothing uses yet.

```sh
pnpm cli x-check                # one read-only call: says whether your likes can be read, and if not, why
pnpm cli fetch-likes            # pull recent likes (200 by default; --limit N for more)
pnpm hydrate && pnpm enrich
```

`docs/X-API.md` has the developer portal steps and the errors `x-check` explains.

## Use it from Claude (MCP)

The MCP server gives Claude Code, or Claude Desktop, read-only tools over the database the web app uses. Register
it at user scope, with `/path/to/x-likes` replaced by where you cloned this repo:

```sh
claude mcp add x-likes --scope user -- node /path/to/x-likes/node_modules/tsx/dist/cli.mjs /path/to/x-likes/src/mcp-server.ts
claude mcp get x-likes              # check that it connects
claude mcp remove x-likes -s user   # to undo
```

It starts the server with Node rather than `pnpm --dir /path/to/x-likes mcp`. Claude starts servers from your
project's folder, and there Corepack picks the pnpm version for that folder, not x-likes', so the pnpm form can
fail to connect. `pnpm mcp` from inside the x-likes folder starts the same server by hand.

To use a different data folder, add `-e XLIKES_DATA_DIR=/absolute/path/to/data` before the `--`.

The tools Claude can call:

| Tool | What it does |
|---|---|
| `likes_search` | Search by keyword, or by meaning with `sort: "relevance"`; filters for author, tag, has-image, has-link |
| `like_get` | The full record: text, links, image OCR and captions, extracted article text, tags |
| `read_article` | The full extracted text of the article or articles behind a like |
| `list_tags` | The tag and entity vocabulary, with counts |
| `likes_by_tag` | Every like that carries a tag |
| `related_to` | Likes related to one like, by embedding neighbours, then shared tags |
| `likes_recent`, `likes_by_author`, `list_authors`, `likes_stats` | Browsing and an overview |

Things to ask: *"search my likes for local-first sync"*, *"what have I saved about LLM agents? Read me the article
behind the top one"*, *"what's related to that SQLite thread?"* Replies are kept small: snippets, ids, file paths
and URLs, and never image data.

## The web app

- `pnpm serve` opens it at http://localhost:4321. It answers only on this machine, not to others on your network.
- Every like has its own link, `/?id=<tweet id>`, the same id the MCP tools use. A like's detail shows its linked
  article, its tags, the text read out of each image ("Text in the image") and each image's caption, and related
  likes.
- Press `/` to search. In an open like, the left and right arrow keys step through the results and Esc closes it.
- It's light by default; the Dark button switches to dark, and the page remembers your choice.
- Its look is `@excellent-so/kit` 0.2.1 (MIT), copied into `web/kit/`.

## Search

Best match (`sort: "relevance"`) fuses two rankings with reciprocal-rank fusion: keyword search (BM25 over the
tweet text and the article, OCR and tag text) and embedding similarity. Before enrichment, or without embeddings,
it falls back to keyword search. The other sorts (Newest, Oldest, Recently liked) match keywords and order the
results by date.

## Where things live

```
data/likes.db        SQLite: likes, tweets, media, links, articles, media_vision,
                     tags and like_tags, embeddings, the *_state tables, FTS indexes
data/media/          downloaded images (<id>/<n>.*, avatars/<handle>.*)
data/media-thumbs/   grid thumbnails, made the first time each is shown
data/media-video/    videos, saved the first time each is played
src/                 ingest, hydrate, enrich-{articles,vision,tags,embed}, ai, search, server, mcp-server
src/mock-archive.ts  the demo archive generator
web/                 the web app (no build step); web/kit/ holds @excellent-so/kit
```

The database and media under `data/` are git-ignored, so your likes and images never get committed. x-likes writes
nowhere else, apart from the embedding model, which is cached inside `node_modules/@xenova/transformers/.cache/`.
It reads a `.zip` archive in place, without extracting it.

## Privacy and the network

Your likes stay in a SQLite file on your machine, and the web app answers only on this machine. x-likes goes online
for these, and nothing else:

| What | Where | When |
|---|---|---|
| Each liked tweet's text, author and links (only its id is sent) | `cdn.syndication.twimg.com` | `pnpm hydrate` |
| The tweet's images, avatar, and a video when you first play it | `pbs.twimg.com`, `video.twimg.com` | `pnpm hydrate`, `pnpm serve` |
| Each page a like links to | that page's site | `pnpm enrich` (articles) |
| The embedding model, once | `huggingface.co` | the first `pnpm enrich` |
| Each image and the tweet, article and image text, for captions, OCR and tags | `api.anthropic.com` | `pnpm enrich`, only with `ANTHROPIC_API_KEY` |
| Your recent likes, with your X keys | `api.twitter.com` | `pnpm cli x-check` and `fetch-likes` only |

The mock providers and the embeddings make no network calls. There is no telemetry.

## Uninstall

Delete the folder you cloned: the code, `node_modules` (with the cached model) and your `data/` all live there.
If you registered the MCP server, run `claude mcp remove x-likes -s user`. pnpm keeps a shared package store
(`pnpm store path` shows where); `pnpm store prune` clears what nothing uses any more.

## Tests

`pnpm test` runs the suite against a temporary database built from the demo archive and the fixtures, and
`pnpm typecheck` runs the TypeScript compiler. The suite never calls Claude or the X API: the Claude tests run
against a local stand-in. It does use the network for the embedding model (once) and a few public web pages.
CI runs both on Node 22 and 24 (`.github/workflows/test.yml`). `CONTRIBUTING.md` says how to send a change, and
`SECURITY.md` how to report a vulnerability.

## License

MIT, in `LICENSE`. The kit in `web/kit/` is MIT too (`web/kit/LICENSE`), and its Geist and Geist Mono fonts are
under the SIL Open Font License 1.1.
