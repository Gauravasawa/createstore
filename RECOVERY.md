# Recovery runbook

What to do when something goes wrong with the package, the account or the documentation site. Each section says how to
notice it, how to stop the damage, and how to fix it. Work top to bottom; do the first steps even if you are unsure.

**Two facts that shape everything:**

- npm versions are permanent. A published version can be hidden or deprecated, never replaced. The fix for every bad
  release is a **new, higher** version.
- There is no npm token to steal. Publishing works only from `release.yml` through trusted publishing. So most
  incidents are about the GitHub account and workflow, not about a secret.

Commands marked "needs 2FA" ask for your security key in the browser.

## 1. A bad release (broken, but not malicious)

**Notice:** the Post-release check fails, or an issue reports a broken install.

1. Point `latest` back at the last good version (needs 2FA):
   `npm dist-tag add @createstore/createstore@<good> latest`
2. Warn people who already installed it:
   `npm deprecate @createstore/createstore@<bad> "Broken: use <good> or >=<fixed>"`
3. Fix on `main` with a `fix:` commit. The pipeline publishes the next patch.
4. Check it: Actions, **Post-release check**, Run workflow.

Do not `npm unpublish`. It breaks everyone who depends on that version.

## 2. A corrupted or tampered package

**Notice:** the tarball contents differ from the repository, `npm audit signatures` fails, or provenance is missing.

1. Treat it as a security incident: do steps 1 and 2 of section 1 at once.
2. Compare the published file list with the build: `npm view @createstore/createstore@<v> dist.integrity` against a
   fresh `npm pack` of the release tag.
3. If the package is **malicious**, not just broken: report it to npm (`npm.help` or the package page, "Report
   malware"). npm can remove it, which `npm deprecate` cannot do.
4. Work out how it happened (sections 4 and 5), fix that **before** publishing again, then release a new version.

## 3. A leaked or compromised token

There is **no npm token**. The secrets that exist are the Cloudflare ones (the `docs` environment) and the automatic
`GITHUB_TOKEN`, which expires when the job ends. For a leaked Cloudflare token see section 8.

If someone made an npm token anyway: npmjs.com, avatar, **Access Tokens**, revoke it. Then confirm the package's
**Publishing access** setting still says "Require two-factor authentication and disallow bypass 2fa tokens".

## 4. A compromised maintainer account (GitHub or npm)

Assume the attacker can publish until you prove otherwise.

1. **Lock the door first.** npm: Trusted Publisher settings, **delete** the GitHub Actions publisher. Nobody can now
   publish by any route. (The setting needs 2FA, which the attacker should not have.)
2. **Secure the accounts.** Change the passwords, revoke all sessions and tokens, check the list of security keys and
   remove any you do not recognise, and generate new recovery codes. Do this on GitHub **and** npm.
3. **Look for damage.** GitHub: Settings, **Security log**. npm: the package's version list and your npm account
   activity. Check for new releases, new collaborators, changed workflow files, new deploy keys, changed Actions secrets.
4. **Clean up.** Deprecate or hide bad versions (section 1), delete unknown tags and branches, revert malicious commits.
   Rotate the Cloudflare token (section 8).
5. **Re-open.** Re-add the Trusted Publisher only when the repository is clean. Publish a fix release.
6. **Tell people.** Publish a GitHub security advisory describing the affected versions.

If you are locked out of npm entirely, contact npm support. Keep your recovery codes offline.

## 5. A broken documentation deployment

**Notice:** the site is down, blank, or shows old or wrong content.

1. Fastest fix: Cloudflare dashboard, **Workers & Pages**, the project, **Deployments**, pick the last good
   deployment, **Rollback to this deployment**.
2. Then fix the cause on `main`. The `Docs` workflow redeploys on every change to `site/`.
3. If the workflow itself fails, open the **Docs** run. The build job runs the security, link and real-browser checks,
   and a failure there blocks the deploy by design. Fix what it names.
4. If Cloudflare is down, check cloudflarestatus.com and wait. The npm package does not depend on the site.

## 6. A registry outage

**Notice:** `npm publish` or the Release job fails with a 5xx or network error. See also the table in
[RELEASING.md](./RELEASING.md#when-a-release-goes-wrong).

1. Check status.npmjs.org. Do nothing until it recovers; retries during an outage make a half-state more likely.
2. If the job failed **before** the tag was pushed, re-run the workflow.
3. If the tag exists but the package does not: roll forward. Push any `fix:` commit and the next release publishes the
   next version. The old tag stays as a git-only tag.
4. Consumers are not affected beyond not being able to install new versions. Cached installs keep working.

## 7. An accidental unpublish

1. Do not try to publish the same version again: npm never allows a name and version to be reused.
2. Release a new version: push a `fix:` commit. If the whole package vanished, the Trusted Publisher may need to be
   set up again after the package is restored or recreated (section 4, step 5).
3. If you need the name or a version restored, contact npm support, and say that you own the package.
4. Update the `latest` tag and deprecate the gap if needed (section 1).

## 8. Leaked secrets

First, **revoke or rotate the secret**. Deleting it from git history is not a fix, because it was visible the moment it
was pushed and may already be copied.

- **Cloudflare API token:** dashboard, My Profile, API Tokens, **Roll** or delete it, create a new one with only
  "Account, Cloudflare Pages, Edit", and update the `CLOUDFLARE_API_TOKEN` secret in the `docs` environment.
- **Account ID:** not a secret. No action.
- **A GitHub or npm token** that someone created: revoke it in that service's settings.
- **Anything else:** revoke at the issuer, then replace it.

Then find out where it leaked: the `Secret scan` job (gitleaks) in Security shows the commit. Rewriting history
(`git filter-repo`) is optional cleanup after the rotation, never a substitute for it.

## After any incident

- Write down what happened, what you did, and what would have stopped it. Put the lesson into a check or a setting.
- Run the **Post-release check** workflow, and open the latest **CI** and **Security** runs to confirm green.
