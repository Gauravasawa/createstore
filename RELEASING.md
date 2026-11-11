# Releasing

Releases are fully automated by [semantic-release](https://semantic-release.org) from
[Conventional Commits](https://www.conventionalcommits.org). Nobody runs `npm publish` by hand, and no npm token
is stored anywhere: the release workflow publishes through npm trusted publishing (OIDC), which also attaches
provenance.

## How a release happens

Push (or merge) to a release branch. `.github/workflows/release.yml` then runs the full `npm run verify`, the
release-rule test, and `semantic-release`, in that order. Any failure before the last step publishes nothing.

| Branch         | Version example | npm dist-tag  | Notes                                     |
| -------------- | --------------- | ------------- | ----------------------------------------- |
| `main`         | `1.2.0`         | `latest`      | Stable. Updates `CHANGELOG.md`.           |
| `next`         | `1.3.0-rc.1`    | `next`        | Release candidates.                       |
| `beta`         | `1.3.0-beta.1`  | `beta`        | No changelog commit; notes are on GitHub. |
| `alpha`        | `1.3.0-alpha.1` | `alpha`       | As `beta`.                                |
| `1.x`, `1.2.x` | `1.2.1`         | `release-1.x` | Fixes to an older line.                   |

| Commit                                                   | Release |
| -------------------------------------------------------- | ------- |
| `feat:`                                                  | minor   |
| `fix:`, `perf:`, `revert:`, `docs(README):`              | patch   |
| `feat!:` or a `BREAKING CHANGE:` footer                  | major   |
| `docs:`, `refactor:`, `test:`, `build:`, `ci:`, `chore:` | none    |
| any type with the scope `no-release`                     | none    |

The first release is `1.0.0`. To start at `0.x` instead, tag the first commit `v0.1.0` before the first run.

## One-time setup (before the first release)

1. **GitHub repo.** `package.json` points at `https://github.com/Gauravasawa/createstore`. Create the repo with that
   exact name, or change `repository`, `bugs` and `homepage` first. npm provenance refuses to publish when the repo
   in `package.json` does not match the repo that runs the workflow.
2. **Environment.** Create a GitHub environment named `release`. Optionally add required reviewers: then every
   publish needs a human click.
3. **Branch protection for `main`.** The release pushes a `chore(release)` commit (changelog + version). Allow the
   `github-actions` bot to bypass the pull-request rule for that push, or the release fails at the git step.
4. **npm account.** Enable 2FA for authorization **and** writes. The `@createstore` org must belong to the account.
5. **Bootstrap publish (once).** A trusted publisher can only be attached to a package that already exists. From a
   clean checkout, with your 2FA code, publish the placeholder version already in `package.json`:

   ```sh
   npm ci && npm run verify
   npm publish --access public --provenance=false --tag bootstrap --otp=<code>
   ```

   `--provenance=false` is required: provenance can only be generated inside CI. `--tag bootstrap` keeps the
   placeholder off `latest`, so `latest` stays empty until the first real release. `prepublishOnly` runs
   `npm run check:publish` for you and refuses to publish if any check fails; run
   `node scripts/check-publish.mjs --online` first to also ask the registry.

6. **Trusted publisher.** On npmjs.com: package `@createstore/createstore` → Settings → Trusted Publisher → GitHub
   Actions: user `Gauravasawa`, repository `createstore`, workflow `release.yml`, environment `release`.
7. **Prove it without publishing.** Actions → Release → Run workflow with `dry_run` on. It must reach "Allowed to
   push" and the npm OIDC exchange without errors.
8. After the first real release, deprecate the placeholder:
   `npm deprecate @createstore/createstore@0.0.0 "Placeholder. Use >=1.0.0"`.

Steps 5 and 6 depend on npm's current UI and rules; check them against the npm docs when you do them.

## Pre-publish checklist (automated)

`npm run check:publish` inspects the real `npm pack` output and fails the release on any of these. It runs in CI on
every pull request, in the release workflow before `semantic-release`, and as `prepublishOnly` on any `npm publish`.

- `dist/esm`, `dist/cjs` and `dist/types` exist, and are newer than `src` (no stale build).
- Every `main`, `module`, `types` and `exports` target is in the tarball; types exist for both `import` and `require`.
- Only expected files ship: `dist/*`, `LICENSE`, `README.md`, `package.json`. No `src`, tests, workflows or `.env`.
- Size budget: at most 300 kB packed, 1 MB unpacked, 40 files. Raising it is a deliberate edit to the script.
- No credentials (npm, GitHub, AWS tokens, private keys, `_authToken`) in any shipped file.
- `package.json`: scoped name, not private, MIT, `repository`/`bugs`/`homepage`, `engines`, `sideEffects`, and
  `publishConfig` with public access, the official registry and provenance on.
- With `--online`: the registry is reachable and this version is not already published.

Also gated before every publish: `npm run verify` (lint, format, types, build, exports, the unit tests, smoke tests,
publint, arethetypeswrong), the release-rule test, and an install-and-load test of the packed tarball under npm,
pnpm, yarn, bun and deno.

**Secrets.** The workflows use exactly one: the automatic `GITHUB_TOKEN`, limited to `contents: write` in the release
job and read-only elsewhere. There is **no `NPM_TOKEN`**: npm authentication is the short-lived OIDC credential
issued to this workflow, and npm authentication fails closed if trusted publishing is not set up. Do not add an npm
token as a fallback.

## When a release goes wrong

semantic-release runs in this order: analyze, notes, **prepare** (changelog, version, release commit), **tag and push**,
**publish** (npm, then GitHub release). What is left behind depends on where it stopped.

| What failed                                   | State left behind                                                            | What to do                                                                                                                                    |
| --------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Tests, lint, audit, `verify` (before release) | Nothing                                                                      | Fix and push. Safe to re-run.                                                                                                                 |
| Missing or invalid npm auth                   | Nothing (fails in `verifyConditions`)                                        | Check the trusted publisher settings; re-run the workflow.                                                                                    |
| Network or registry error before the tag      | Nothing                                                                      | Re-run the workflow.                                                                                                                          |
| `npm publish` fails (outage, 5xx, E403)       | Git tag `vX` and the release commit exist; no npm package; no GitHub release | **Roll forward**: push any `fix:` commit. The next release publishes `X+1`; `vX` stays a git-only tag. Or see "Re-publish a stuck tag" below. |
| GitHub release fails after npm succeeded      | Package and tag exist; no GitHub release page                                | Create the release page by hand from the tag, using the changelog.                                                                            |
| Same version already on npm                   | Nothing new                                                                  | npm never lets a version be reused. Roll forward.                                                                                             |

### Re-publish a stuck tag

Only when roll-forward is not acceptable. Delete the remote tag and its note, revert the release commit, then re-run:

```sh
git push origin :refs/tags/vX :refs/notes/semantic-release-vX
git revert <release-commit-sha> && git push
```

Re-run the Release workflow. Never delete a tag whose version is on npm.

## Rolling back a bad release

npm versions are immutable, and `npm unpublish` breaks everyone who already depends on the version, so do not use it.

1. **Stop the spread.** Point `latest` back at the last good version:
   `npm dist-tag add @createstore/createstore@<good> latest` (needs your 2FA).
2. **Warn installers.** `npm deprecate @createstore/createstore@<bad> "Broken: use <good> or >=<fixed>"`.
3. **Fix forward.** Revert or fix on `main` with a `fix:` commit; the pipeline publishes the patch.

Recovery from a compromised account, a corrupted package, a registry outage, a broken docs deployment and leaked
secrets is in [RECOVERY.md](./RECOVERY.md).
