# Contributing

MIT project: by contributing you agree your changes are offered under the same MIT license (inbound = outbound;
no CLA required).

## What's welcome

- Bug fixes, especially for real archives and exports that x-likes reads wrong
- Documentation improvements
- Small, focused improvements with a clear use case

For a larger feature or a change to the schema, open an issue first so we can agree the direction before you
spend time on a pull request.

## Getting the code

```sh
git clone https://github.com/excellent-so/x-likes.git
cd x-likes
corepack enable    # runs the pnpm version pinned in package.json
pnpm install
```

Node 22 or later. The install compiles nothing.

## Before submitting

```sh
pnpm typecheck
pnpm test
```

Expected: `N passed, 0 failed`. The suite builds a temporary database from the demo archive and the fixtures, and
deletes it afterwards; it never touches `data/`, and never calls Claude or the X API. It does download the
embedding model once and fetch a few public web pages. CI runs the same two commands on Node 22 and 24.

Try your change against the demo as well (README, "Try the demo"), and for the web app, in a browser in light and
dark and at a phone's width.

- Never commit anything from `data/`, an X archive, or `.env`. They are git-ignored; keep them that way.
- Add a test for a bug you fix, where a test makes sense.
- Add a line for any change a user would notice to the top section of `CHANGELOG.md`.
- Keep pull requests focused: one logical change each.
