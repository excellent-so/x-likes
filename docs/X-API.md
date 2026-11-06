# Getting your likes: the X API (optional path)

x-likes has **two** ways to pull your likes. You do **not** need the API — the
archive is the recommended route.

| Method | Gets | Cost | Notes |
|---|---|---|---|
| **Data archive** (default) | your **entire** like history | free | ~24h to download; re-run `pnpm refresh` to catch up |
| **X API** (this doc) | **recent** likes only | a paid tier that includes reading likes | good for automatic incremental updates |

The API path exists for "keep current automatically." For a one-time or
occasional catch-up, the archive is simpler and complete.

## Why the API is fiddly

Since 2023, reading likes (`GET /2/users/:id/liked_tweets`) requires **all** of:

1. An app **attached to a v2 Project** (not a legacy standalone app).
2. **User-context** auth (OAuth 1.0a with your access token, or OAuth 2.0 PKCE)
   — the app-only Bearer token is *not* accepted for this endpoint.
3. An **access tier** that includes likes reads. The **Free** tier generally
   does **not**; the paid tiers do, with rate limits. Check the developer
   portal for current prices and limits. x-likes asks for 100 likes per page.

x-likes already handles #2 (OAuth 1.0a signing). #1 and #3 are account/portal
settings only you can change.

## Setup

1. Copy `.env.example` to `.env` and fill in your keys. `.env` is
   git-ignored.

2. In the developer portal (<https://developer.x.com/en/portal/dashboard>):
   - Open (or create) a **Project**.
   - Attach your app to it. **Gotcha:** legacy standalone apps often *cannot* be
     moved into a Project — if so, create a **new App inside the Project**. That
     issues **new keys**; paste them into `.env` (edit the file directly).

3. Verify:

   ```sh
   pnpm cli x-check
   ```

   It makes one read-only call and tells you exactly what's wrong or that you're
   good to go.

4. Once green:

   ```sh
   pnpm cli fetch-likes            # pulls recent likes into the DB (default 200)
   pnpm cli fetch-likes --limit 1000
   pnpm hydrate                     # tweet text + images
   pnpm enrich                      # articles + OCR + tags + embeddings
   ```

   `fetch-likes` is idempotent — re-run it anytime to pick up new likes; already
   known ones are skipped.

## Troubleshooting (`x-check` output)

| HTTP / message | Meaning | Fix |
|---|---|---|
| `403 client-not-enrolled` / "attached to a Project" | App isn't in a v2 Project | Attach it (or make a new app inside a Project) |
| `403` "Unsupported Authentication … App-Only forbidden" | Used the Bearer instead of user context | (x-likes uses OAuth 1.0a already) |
| `403` "not entitled" / "access level" / "Usage cap" | Tier can't read likes | Move to a paid tier that includes likes |
| `429` | Rate limited | Wait ~15 min |
| `200` | Works | `pnpm cli fetch-likes` |

## `.env` keys

```
X_API_KEY, X_API_KEY_SECRET          # consumer key/secret (OAuth 1.0a)
X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET # your user tokens (OAuth 1.0a user context)
X_BEARER_TOKEN                        # app-only (not used for likes; kept for other calls)
X_CLIENT_ID, X_CLIENT_SECRET          # OAuth 2.0 (unused by the current path)
X_USER_ID                             # numeric id; defaults to the access-token prefix
```

## Security

- `.env` is git-ignored — keys never get committed.
- If keys are ever exposed (e.g. pasted into a chat), regenerate them in the
  portal and update `.env`. Rotating tokens does not change the Project/tier
  situation.

## Open-source alternatives (no API, no paid tier)

If the API tier wall blocks you, there's a whole class of open-source tools that
skip the official API entirely. **The key fact:** none of them use a magic free
API — they all reuse *your own logged-in session* against X's **internal
GraphQL** (the same endpoints the website itself calls). They differ only in
*how* they get that session, which trades off automation vs. ban risk. All are
against X's ToS to some degree; for exporting *your own* data the risk is low,
but automated cloud scraping gets flagged fast.

Two tiers:

**A. In-browser export (lowest risk, recommended)** — a userscript reads the
GraphQL responses your browser *already* loads as you scroll, so there's no
separate automated session to detect.

- **[prinsss/twitter-web-exporter](https://github.com/prinsss/twitter-web-exporter)**
  ⭐ — Tampermonkey/Violentmonkey userscript. Exports your **likes** (and
  bookmarks, tweets, lists…) to **JSON/CSV/HTML**, bulk-downloads images/videos
  at original size, **fully local** ("your data never leaves your computer").
  Best fit for x-likes: export likes → JSON → import.

**B. Cookie-replay scripts (more automated, higher risk, cookies expire)** — a
script reuses your browser cookies to call GraphQL headlessly.

- **[gallery-dl](https://github.com/mikf/gallery-dl)** — `gallery-dl
  --cookies-from-browser chrome "https://x.com/<you>/likes"`. Best-in-class for
  bulk-downloading the *media* of your likes.
- **[twscrape](https://github.com/vladkens/twscrape)** — actively maintained
  Python lib; multi-account rotation, rate-limit handling, `curl_cffi` TLS
  fingerprinting. Fullest automation.
- **[twikit](https://github.com/d60/twikit)** — Python; `user.get_tweets('Likes')`.
- Dead/broken since the 2023 lockdown: twint, snscrape, twitterscraper.

**Recommended pairing with x-likes — this is built and ready:**

```sh
# 1. Install the twitter-web-exporter userscript (Tampermonkey / Violentmonkey).
# 2. Open x.com, go to your Likes, scroll to load what you want, and use the
#    exporter panel to export → JSON.
# 3. Import it (fully hydrates from the file — no API, no syndication):
pnpm ingest-export ~/Downloads/twitter-likes.json
pnpm hydrate     # finishes any records the export left thin
pnpm enrich      # articles + OCR + tags + embeddings
```

`ingest-export` reads the exporter's JSON (tolerant of both flattened and raw
GraphQL shapes), inserts the likes, and — because the export already contains
the full tweet — writes author/text/media/links directly and downloads the
images, marking them hydrated. It's idempotent, so re-import a fresh export
anytime to pick up new likes. Optionally pair with `gallery-dl` for bulk media.

This is the free, no-credentials, low-risk, **incremental** update path — the
natural home for the "continuously updated" goal without paying for API access.

See also `README.md` (archive path).
