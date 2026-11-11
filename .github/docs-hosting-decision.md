# Documentation hosting decision

**Decision: Cloudflare Pages, deployed from GitHub Actions with Direct Upload.** Written 2026-11-11.

Evidence is marked **[official]** when it comes from the provider's own documentation, **[3rd-party]** when it comes
only from blog posts, and **[unverified]** when I could not confirm it.

## What is being hosted

One self-contained file, `createStore documentation.html`: 400 KB (110 KB gzipped), built by `docs/build-docs.js`.
It is static, so any static host works. What decides the choice is what the page needs from the host:

- **Security headers.** The page loads 5 Prism scripts from cdnjs (no integrity hashes) and fonts from Google Fonts,
  has 2 inline scripts, and uses `innerHTML` in 3 places. A strict Content-Security-Policy and HSTS are the right
  protection, and they need a host that can set response headers.
- **Previews and versions.** Documentation changes should be reviewable before they go live, and old versions should
  stay reachable.
- **Cost and operations.** One maintainer, free tier, no servers.

## Comparison

| Criterion               | GitHub Pages                                                       | Cloudflare Pages                                                                      |
| ----------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Cost                    | Free **[official]**                                                | Free: 500 builds a month, 20,000 files, 20-minute builds **[official]**               |
| Bandwidth               | Soft limit 100 GB a month **[official]**                           | Reported unlimited **[3rd-party]**, not confirmed in the official limits text         |
| Size limits             | Site at most 1 GB, deployment at most 10 minutes **[official]**    | 20,000 files **[official]**; this site is 1 file                                      |
| Custom response headers | No documented way to set them **[official: page is silent]**       | `_headers` file: up to 100 rules, security and cache headers **[official]**           |
| Redirects               | None built in                                                      | `_redirects` file **[official]**                                                      |
| Preview deployments     | None built in                                                      | Per branch and pull request **[official]**                                            |
| Custom domain           | Yes                                                                | Yes; any DNS provider works on Pages **[official]**                                   |
| Deploy credential       | GitHub OIDC, no stored secret                                      | An API token plus account ID stored as a secret (I did not look for a keyless option) |
| Speed                   | GitHub's CDN                                                       | Cloudflare's global network; headers allow long-lived caching of fingerprinted files  |
| Simplicity              | Simplest: one workflow, no extra account                           | One more account and one more secret to set up                                        |
| Usage restrictions      | Not for commerce or SaaS; one user site per account **[official]** | None relevant to documentation                                                        |

## Why Cloudflare Pages

1. **Headers.** It is the one thing GitHub Pages cannot give this page. With `_headers` we can ship a strict CSP,
   HSTS, `X-Content-Type-Options`, `Referrer-Policy` and sensible `Cache-Control`, which matches the security posture
   of the rest of the project.
2. **Preview deployments** make documentation changes reviewable before they are live.
3. **Direct Upload from our own CI.** The site is built and checked in GitHub Actions, then uploaded with
   `wrangler pages deploy`. Cloudflare never builds our code, so no build environment, git access or extra
   permissions are handed to it.

## The cost, stated plainly

GitHub Pages deploys with GitHub's own OIDC identity and stores nothing. Cloudflare needs an API token. To keep this
consistent with the "no long-lived credentials" rule:

- Create a token scoped to **one account, Cloudflare Pages: Edit only**, nothing else.
- Store it as a secret on the GitHub environment `docs`, not as a repository secret, and give that environment a
  required reviewer and a branch restriction.
- Rotate it on a schedule (a calendar reminder is enough) and revoke it the moment it might be exposed.

## Pages or Workers Static Assets?

Cloudflare also offers Workers with Static Assets. Their documentation says it has "a distinctly broader set of
features" than Pages **[official]**, and several blog posts claim Cloudflare now recommends it for new projects and
that Pages is deprecated **[3rd-party]**. I found no official deprecation notice or recommendation in the Cloudflare
pages I read, so I treat the claim as unconfirmed.

Pages is still the right choice for a one-file static site today: simpler, supports any DNS provider, and previews
are automatic. Workers Static Assets needs the domain's nameservers on Cloudflare for custom domains **[official]**,
and needs explicit configuration for 404 handling and previews **[official]**.

To keep a later move cheap: put all behaviour in `_headers` and `_redirects` (both products read them
unchanged **[official]**), add no Pages Functions, and keep the deploy step in one workflow job. Moving is then a
`wrangler.jsonc` with `assets.directory` and a change from `wrangler pages deploy` to `wrangler deploy`.

## Before the site goes live (inputs to the next phases)

1. **Self-host Prism and the fonts**, or add integrity hashes. Today a compromise of cdnjs would run attacker code in
   the documentation. Self-hosting also lets the CSP be `script-src 'self'` plus hashes for the 2 inline scripts.
2. **Review the 3 `innerHTML` uses** in the page script for untrusted input; the CSP is the second line of defence.
3. **SEO basics are missing:** canonical URL, Open Graph and Twitter tags, `robots.txt`, `sitemap.xml`, a 404 page.
4. **Versioned documentation:** publish each release under its own path (for example `/v1/`) and keep `/` as the
   latest; Pages previews cover unreleased changes.
5. **Docs are out of date with the library:** the existing checker reports `whenAborted`, the offline copy keeping
   per-user data until `reset()`, the async-storage rescue copy and the `react-bindings` file as undocumented.

## What I need from you before deploying

- A Cloudflare account (the free plan is enough), and the Pages project name you want.
- Whether you have a custom domain, and which DNS provider holds it. Without one the site lives at
  `<project>.pages.dev`.

## Sources

- [Workers static assets: compatibility with Pages](https://developers.cloudflare.com/workers/static-assets/compatibility-matrix/)
- [Migrate from Pages to Workers](https://developers.cloudflare.com/workers/static-assets/migrate-from-pages/)
- [Cloudflare Pages: `_headers`](https://developers.cloudflare.com/pages/configuration/headers/)
- [Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits)
- [GitHub Pages limits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits)
- Third-party, unconfirmed: [Cloudflare Pages vs Workers (flaviocopes.com)](https://flaviocopes.com/cloudflare-pages-vs-workers/),
  [Cloudflare Pages vs Workers in 2026 (morphllm.com)](https://www.morphllm.com/comparisons/cloudflare-pages-vs-workers)
