# Documentation site

A static site, built by `build.mjs` into `site/dist` and deployed to Cloudflare Pages by `.github/workflows/docs.yml`.

| Path                | What it is                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| `src/index.html`    | The documentation page. Edit this. `%%SITE_URL%%` is replaced at build time.                        |
| `src/404.*`         | The not-found page.                                                                                 |
| `vendor/`           | Third-party files served from this site (Prism, fonts), with their licences. No CDN is used at all. |
| `build.mjs`         | Fingerprints assets, writes `_headers` (with the Content-Security-Policy), robots, sitemap, 404.    |
| `check.mjs`         | Static checks on the build output.                                                                  |
| `browser-check.mjs` | Loads the build in a real browser under the real headers.                                           |

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

## Updating a vendored file

Download the exact version, verify it against the publisher's integrity hash, replace the file, rebuild. The Prism
files in `vendor/prism` were verified against cdnjs's published SHA-512 hashes for version 1.29.0.

`src/index.html` started as a copy of `docs/createStore documentation.html` from the test bed, with the CDN links
replaced by local files, a visually-hidden CSS rule added, and the SEO tags added. This copy is now the source.
