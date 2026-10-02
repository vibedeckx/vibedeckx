# vibedeckx-docs

Public user documentation, deployed to https://docs.vibedeckx.dev (Fumadocs on Next.js, static export).

```bash
pnpm --filter vibedeckx-docs dev     # http://localhost:3002
pnpm --filter vibedeckx-docs build   # static site in apps/docs/out
```

Pages live in `content/docs/` — the directory tree is the URL structure, and `meta.json` files order the sidebar.
Every page is also published as Markdown (`/llms.mdx/<slug>/content.md`), plus `/llms.txt` and `/llms-full.txt` for agents.

This is **not** the repo-root `docs/` folder: that one holds internal design notes and is never published.
