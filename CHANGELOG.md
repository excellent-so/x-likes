# Changelog

## Unreleased

- A like's detail view in the web app shows what the image reading found: under "Text in the image", the text read
  out of each image, and under "Caption", its caption, with your search terms marked. Both were stored and searched,
  but the app never showed them.
- `pnpm serve` listens on this machine only (127.0.0.1). It listened on every network interface, so anyone on the
  same Wi-Fi could browse your likes at your machine's address. It also refuses requests whose Host isn't a local
  name, so a web page can't reach it through DNS rebinding.
- `pnpm serve` on a port that's already in use says so in one line and suggests `--port`, instead of a stack trace.
- `pnpm ingest-export` reads twitter-web-exporter's own JSON fully: the avatar (`profile_image_url`), a video's
  poster and mp4 (the poster was the mp4 itself, so it showed as a broken image), the full text of long posts, and,
  when the export includes metadata, each tweet's links (and so its articles). It also reads X's newer GraphQL
  author shape. A missing or malformed file gets one plain sentence.
- Real OCR works on every image. With `ANTHROPIC_API_KEY` set, the image stage skipped any image that wasn't a
  JPEG, PNG, GIF or WebP by name (all of the demo's images, which are SVG) and marked it done with nothing read, so
  it was never tried again. Images are now sent by their real type, read from the file, and anything Claude can't
  take (SVG, AVIF, a file over its size limit) is converted to PNG first.
- A Claude key that's wrong, missing or out of credit, or an unknown model, stops `pnpm enrich` at the first
  request with one sentence that says what to fix, and leaves every like it hadn't read pending, so the next run
  picks them up. Before, the tags stage marked every like failed (using up one of its four tries), printed no
  reason, exited 0, and the embeddings went on without the tags. An unknown `XLIKES_AI_PROVIDER` or
  `XLIKES_EMBED_PROVIDER` is an error too, rather than quietly falling back to the mock.
- Mistakes get one plain sentence and exit 1, never a stack trace: an unknown command (it printed the help and
  exited 0), `--limit` or `--port` that isn't a whole number (`--limit 1O` used to run the whole archive), a missing
  archive, a `like.js` in the wrong format, a file that isn't a zip, a missing `unzip`, a data folder that can't be
  created, and `fetch-likes` without X keys. `pnpm cli x-check` exits 1 when the check fails. Set `XLIKES_DEBUG=1`
  to see the stack.
- When a stage has failures, `pnpm enrich` and the `enrich:` commands print why under it (the most common errors).
- A link that's dead (404 or 410) counts as a dead link rather than a failure, and isn't retried. The demo's
  made-up GitHub link made every demo run report "1 failed".
- `pnpm ingest <archive.zip>` reads `like.js` straight out of the zip, so it no longer leaves a copy of your likes in
  the temp folder.
- `pnpm stats` on an empty store says how to import likes.
- The README registers the MCP server with Node. Its `pnpm --dir /path/to/x-likes mcp` form fails to connect when
  pnpm comes from Corepack, because Claude starts it from your project's folder. The README also gains a table of
  what goes over the network, an uninstall section and a real-OCR check on the demo; CONTRIBUTING.md and
  SECURITY.md are new.
- CI: `.github/workflows/test.yml` installs, type-checks and runs the tests on Node 22 and 24 on every push and pull
  request.
- x-likes installs and runs on Node 24. better-sqlite3 is now 13, which ships prebuilt binaries for Node 22 and
  later, so `pnpm install` no longer tries to compile SQLite on Node 24 (and fails where there is no working C++
  toolchain). Its no-op build step is skipped too, so the install needs no Python and doesn't fetch Node's headers.
- One copy of sharp. The embedding library asked for sharp 0.32, so `pnpm enrich` and `pnpm serve` loaded two
  copies of libvips, and macOS printed a warning about duplicate classes and possible crashes. An override in
  `pnpm-workspace.yaml` points it at the app's sharp 0.35, and `pnpm install` no longer downloads libvips from
  GitHub.

## 0.1.1

- x-likes has its own mark, a heart: in the web app's top bar, left of the name, as the favicon (it follows the
  OS theme), and at the top of the README (`docs/mark.svg`). It replaces the plain ring.
- The web app's kit in `web/kit/` is now `@excellent-so/kit` 0.2.1 (MIT), which adds the `.ex-mark` slot.
- The public home is https://github.com/excellent-so/x-likes: `homepage`, `repository` and `bugs` in
  `package.json`, and a clone line in the README.
- Four of the demo archive's sample authors used the handles of real accounts. They now have made-up ones.
- `web/screenshot.png` shows the new top bar, on the demo data.
