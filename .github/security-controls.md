# Security controls

What protects this package and its releases, what each control stops, and the repository settings that cannot be
set from code and must be switched on by hand.

## Controls in the repository

| Control                                    | Where                             | Stops                                                      |
| ------------------------------------------ | --------------------------------- | ---------------------------------------------------------- |
| No runtime dependencies                    | `scripts/check-publish.mjs`       | A hijacked or typosquatted dependency reaching consumers   |
| No install-time scripts in the package     | `scripts/check-publish.mjs`       | Code running on a consumer machine at install              |
| Lockfile must be registry + sha512 only    | `scripts/check-lockfile.mjs`, CI  | Lockfile redirected to another server or a swapped package |
| `npm ci --ignore-scripts` everywhere       | all workflows                     | A dependency install script running in CI or release       |
| `npm audit` (high), `npm audit signatures` | `security.yml`, `release.yml`     | Known-vulnerable or unsigned packages                      |
| Dependency review on pull requests         | `security.yml`                    | A new vulnerable or copyleft dependency slipping in        |
| Dependabot with a 7-day cooldown           | `dependabot.yml`                  | Adopting a release minutes after an account takeover       |
| Actions pinned to commit SHAs              | all workflows, checked by zizmor  | A moved tag or a compromised action                        |
| Least-privilege tokens                     | `permissions:` in every workflow  | A compromised step writing to the repository               |
| zizmor (pedantic) and actionlint           | `security.yml`                    | Workflow injection, broad permissions, cache poisoning     |
| Untrusted text never interpolated          | PR title is passed through `env:` | Script injection from a pull request title                 |
| gitleaks over the full history             | `security.yml`                    | A committed secret, including one that was later deleted   |
| CodeQL                                     | `security.yml`                    | Vulnerabilities in the code                                |
| CODEOWNERS on build and release files      | `.github/CODEOWNERS`              | An unreviewed change to the pipeline                       |
| npm trusted publishing (OIDC), no token    | `release.yml`, `RELEASING.md`     | A stolen long-lived npm token                              |
| Provenance attestation                     | `publishConfig.provenance`        | A package that cannot be traced to this repo and workflow  |
| No dependency cache in the release job     | `release.yml`                     | A poisoned cache reaching a publish                        |
| Pre-publish gate                           | `scripts/check-publish.mjs`       | Wrong files, credentials or stale builds in the tarball    |
| Hostile-input tests                        | `spec/security.spec.ts`           | Prototype pollution through storage, tabs and snapshots    |

## Repository settings to turn on

These live on GitHub and npm, so the code above does not enforce them. Names follow the current UI and may move.

GitHub, repository settings:

- **Rulesets, `main`:** require a pull request, require the status check `CI passed`, block force pushes and
  deletion. Let the `github-actions` app bypass the pull-request rule (the release commit needs it).
- **Rulesets, tags `v*`:** restrict creation, update and deletion to the release workflow, so the tag of a published
  version can never be moved.
- **Actions, General:** default workflow permissions "Read repository contents"; untick "Allow GitHub Actions to
  create and approve pull requests"; require approval for workflows from outside collaborators; if offered, enable
  "Require actions to be pinned to a full-length commit SHA".
- **Code security:** enable Dependabot alerts and security updates, secret scanning with push protection, and
  private vulnerability reporting. The repository must be public (or have GitHub Advanced Security) for dependency
  review and CodeQL to run.
- **Environment `release`:** add yourself as a required reviewer, and limit deployment branches to `main`, `next`,
  `beta`, `alpha` and the maintenance branches.

npm, package settings (after the first release):

- **Trusted Publisher:** repository `Gauravasawa/createstore`, workflow `release.yml`, environment `release`.
- **Publishing access:** "Require two-factor authentication and disallow tokens". With trusted publishing working,
  nothing but the workflow can publish, and no token can be stolen.

Accounts: use a passkey or hardware key for 2FA on GitHub and npm, and keep the recovery codes offline.

## Threats and what is left

- **Compromised or hijacked dev dependency.** It never reaches consumers (there are no runtime dependencies).
  Install scripts are off, the lockfile pins hashes, and Dependabot waits a week. **Residual risk:** the release
  job runs dev tooling (`semantic-release`) while holding a short-lived publish credential, so a compromised dev
  dependency that runs during the release could use it. The environment's required reviewer and the pinned lockfile
  are the defence. Keep the toolchain small and read dependency updates before merging them.
- **Typosquatting.** Consumers cannot be tricked by a look-alike dependency of ours, because we have none. Our own
  name could be imitated (the unscoped `createstore` is not ours). Consider reserving look-alike names later.
- **Malicious pull request.** Workflows use `pull_request`, never `pull_request_target`. Pull requests from forks
  get a read-only token, no secrets and no OIDC. Changes to `.github/` need CODEOWNER review.
- **Stolen maintainer account.** 2FA with a passkey, no tokens to steal, a required reviewer on the release
  environment, and tag rules. Recovery steps are in [RECOVERY.md](../RECOVERY.md).
- **Consumers verifying a release.** Running `npm audit signatures` in a project that depends on this package
  confirms the registry signature and the provenance attestation.

## Known issues

- **Accepted: moderate advisories in release tooling.** `npm audit` reports moderate advisories for `glob` and
  `minimatch`, which reach the repository only through `semantic-release` (its GitHub and npm plugins). They are dev
  tooling: nothing of it ships in the package, and it runs only in the release job. npm's only offered fix is
  downgrading `semantic-release` four major versions, which is a larger risk than the advisories. Recheck when
  `semantic-release` updates those dependencies; the security gate fails on high and critical advisories only.
- **Accepted until 2026-12-18: high advisory GHSA-fc5q-39xc-vjpf in `picomatch`** (ReDoS through crafted glob
  patterns, every version up to 4.0.7, the latest). No fixed version exists yet. It is in dev tools only (vitest,
  tsup, typescript-eslint, semantic-release) and every glob pattern they receive comes from this repository. The
  exception lives in `scripts/check-audit.mjs` (`npm run audit:dev`), which the security workflow runs instead of
  `npm audit --audit-level=high`: any other high or critical advisory still fails, and this one fails again after
  its date. When picomatch ships a fix, update the lockfile and delete the exception.
- **Open, no fix possible yet: medium advisory GHSA-g3hv-75wg-m249 in `minimatch` (Dependabot alert #2).** The
  repository's own `minimatch` is 11.0.9 (fixed). The vulnerable copy, 10.2.5, is bundled inside the `npm` package
  that `@semantic-release/npm` installs, and a bundled copy can't be replaced: overrides of `minimatch`,
  `npm > minimatch` and `@semantic-release/npm > npm > minimatch` were all tested and leave it in place. Every npm
  release so far (up to 12.2.3) still bundles `minimatch ^10.2.5`, and the fix exists only in 11.0.1 and later.
  Dependabot's suggested downgrade to semantic-release 21 doesn't help either: it brings npm 9, which bundles
  `minimatch ^9.0.3`, also in the vulnerable range (7.0.0 up to 11.0.1). It runs only in the release job, on the
  `files` patterns in this repository's `package.json`. The alert stays open on purpose and closes by itself when a
  release of npm that bundles minimatch 11 reaches the lockfile; then run `npm update npm` (or wait for Dependabot).
  It doesn't fail the security workflow, which gates on high and critical advisories.
- Fixed: `getState('__proto__')` (also `'constructor'`, `'toString'` and similar) used to return `Object.prototype` or
  a built-in function. Reads now use the store's own keys only, so any name that isn't a key reads as `undefined`
  (`spec/security.spec.ts`).
