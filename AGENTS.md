# Notes for AI coding agents

Read this before changing the repository. Humans: [CONTRIBUTING.md](./CONTRIBUTING.md) is the same story with more words.

## What this is

`@createstore/createstore`: global state for React with the `useState` API. One source file holds the library
([src/createStore.ts](./src/createStore.ts), with two small files for React and `'use client'`). The documentation site
is in [site/](./site), the tests in [spec/](./spec) and [test/](./test).

## Commands

```sh
npm ci
npm run verify          # lint, format, types, build, exports, all tests, publint, arethetypeswrong: the CI gate
npm run test:unit       # vitest (spec/)
npm run test:browsers   # real Chromium, Firefox and WebKit (needs: npx playwright-core install chromium firefox webkit)
npm run docs:build && npm run docs:check   # the docs site, and its security, SEO and agent-readability checks
```

Tests import the **built** package (`dist/`), so run `npm run build` first. On Windows, run vitest from PowerShell or
cmd, not Git Bash.

## Rules

- **Commits are Conventional Commits and decide the version**: `feat:` minor, `fix:`/`perf:`/`docs(README):` patch,
  `feat!:` major, everything else no release. Releases are automatic from `main`; never edit `version` in
  `package.json` or `CHANGELOG.md` by hand.
- **No runtime dependencies**, ever. No npm token anywhere: publishing uses trusted publishing from `release.yml`.
- **Add a test with every change.** A bug fix gets a test that fails without the fix.
- **Do not hand-edit generated files**: `site/dist/`, `dist/`, `llms.txt`, `llms-full.txt`, `sitemap.xml`, the JSON-LD.
  They come from `site/build.mjs`, which reads the page itself so they cannot drift.
- Changes under `.github/`, `scripts/` and the release config need the owner's review (CODEOWNERS).
- Prettier formats everything (`npx prettier --write <file>`); ESLint must pass with zero warnings.

## Where things are

| Need                                                   | Look at                                                                                      |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Subscriptions, computed, queries, persistence, offline | `src/createStore.ts` (sections are headed with `/* ---------- ... ---------- */`)            |
| SSR and Server Components                              | `serverComponentStore` and `build()` in `src/createStore.ts`, `spec/ssr-*.spec.tsx`          |
| Known weaknesses                                       | [.github/source-audit.md](./.github/source-audit.md)                                         |
| Security model                                         | [.github/security-controls.md](./.github/security-controls.md), [SECURITY.md](./SECURITY.md) |
| Release and recovery                                   | [RELEASING.md](./RELEASING.md), [RECOVERY.md](./RECOVERY.md)                                 |
| Docs content                                           | `site/src/index.html` (one page); then `npm run docs:build`                                  |

## For agents that only use the library

Read [llms.txt](https://createstore-docs.pages.dev/llms.txt) for a map, or
[llms-full.txt](https://createstore-docs.pages.dev/llms-full.txt) for the whole documentation as Markdown.
