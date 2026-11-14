# Documentation site

A static site, built by `build.mjs` into `site/dist` and deployed to Cloudflare Pages by `.github/workflows/docs.yml`.

| Path                | What it is                                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.html`    | The documentation page. Edit this. `%%SITE_URL%%` is replaced at build time.                                                    |
| `src/404.*`         | The not-found page.                                                                                                             |
| `vendor/`           | Third-party files served from this site (Prism, fonts), with their licences. No CDN is used at all.                             |
| `build.mjs`         | Fingerprints assets, writes `_headers` (with the Content-Security-Policy), robots, sitemap, 404, the section pages, `llms.txt`. |
| `check.mjs`         | Static checks on the build output.                                                                                              |
| `browser-check.mjs` | Loads the build in a real browser under the real headers.                                                                       |

```sh
npm run docs:build     # SITE_URL=https://your-site.pages.dev to set the address (default: localhost)
npm run docs:check
npm run docs:browser   # needs Chromium: npx playwright-core install chromium, or CHROME_PATH=<Edge or Chrome>
```

## Rules that the checks enforce

- No third-party requests of any kind, and no inline code except the two scripts and one style block that are allowed
  by exact hash. A new inline script or style block changes the hash; the build recomputes it, so editing the page
  is fine, but `'unsafe-inline'` is never allowed.
- Every asset file name contains a content hash, so it can be cached for a year.
- Preview deployments (`DOCS_ENV=preview`) are told to search engines as `noindex`.

## What the build generates for search engines, answer engines and AI agents

All of it is made from `src/index.html` by `build.mjs`, so it cannot drift from the page:

- **One page per section** (`/<section>/`): its own title, description, canonical, breadcrumb and `TechArticle` data, all
  listed in `sitemap.xml`. The one-page guide at `/` stays as it is.
- **Structured data**: a JSON-LD graph (WebSite, Person, SoftwareSourceCode, WebPage, FAQPage). The FAQ is read from the page.
- **`llms.txt`** (what to read) and **`llms-full.txt`** (all of it as Markdown; its `Link` header names the page as canonical).
- **`/.well-known/security.txt`**, `robots.txt`, `sitemap.xml` (with `lastmod`) and the social image.

## Search Console and Bing Webmaster Tools

The site cannot prove ownership by itself. In each tool choose the **HTML tag** method, copy only the token (the
`content="..."` value, not the whole tag), and save it as a repository variable under Settings, Secrets and variables,
Actions, Variables: `GOOGLE_SITE_VERIFICATION` (Search Console) and `BING_SITE_VERIFICATION` (Bing). The next Docs run adds
the tag. Then click Verify, and submit `https://<your-site>/sitemap.xml`.

## Crawler policy

Names were checked against each vendor's own documentation on 2026-11-14. Everything is allowed, by design: the docs are
MIT-licensed and meant to be found, cited and learned by assistants.

| Crawler                                        | What it does                                                                       | Policy |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- | ------ |
| OAI-SearchBot, Claude-SearchBot, PerplexityBot | Index pages for AI search and answers (they cite and link)                         | Allow  |
| ChatGPT-User, Claude-User, Perplexity-User     | Fetch a page when a person asks about it. Vendors say robots.txt may not apply     | Allow  |
| GPTBot, ClaudeBot                              | Collect content for model training                                                 | Allow  |
| Google-Extended                                | A robots.txt token only: Gemini training and grounding. No effect on Google Search | Allow  |

To opt out of training only, change the "Model training" group in `build.mjs` to a disallow rule and redeploy. A user-agent
string alone does not prove who is calling; the vendors publish IP ranges if you ever need to verify one.

## Updating a vendored file

Download the exact version, verify it against the publisher's integrity hash, replace the file, rebuild. The Prism
files in `vendor/prism` were verified against cdnjs's published SHA-512 hashes for version 1.29.0.

`src/index.html` started as a copy of `docs/createStore documentation.html` from the test bed, with the CDN links
replaced by local files, a visually-hidden CSS rule added, and the SEO tags added. This copy is now the source.
