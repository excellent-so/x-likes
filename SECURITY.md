# Security Policy

## Supported versions

The latest commit on `main` of https://github.com/excellent-so/x-likes is the only supported version. Fixes are
not backported.

## Reporting a vulnerability

Please report vulnerabilities privately to **matt@excellent.so** rather than opening a public issue. Include a
description of the issue and how to reproduce it if you can. You should get a reply within a few business days.

There is no bug bounty program.

## What x-likes protects

- Your likes, images and keys stay on your machine: the database and media in `data/`, the keys in `.env`.
- The web app (`pnpm serve`) listens on 127.0.0.1 only and refuses requests whose Host isn't a local name, so
  neither another machine on your network nor a web page you visit can read it.
- Its media and video routes serve only files under the data folder and videos already saved in the database, so
  they can't be used to read other files or as an open proxy.
- The MCP server is read-only and talks only over stdio.
- README, "Privacy and the network", lists every host x-likes contacts and when.
