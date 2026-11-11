# Setup checklist (do these once, in order)

Everything here is a click or a copy-paste. Nothing needs you to understand the code. If a screen looks different from
what is described, the names have probably moved: look for the same words, and tell Claude what you see.

**Golden rule:** never paste a token or password into a chat, a file or a commit. Tokens only go into the GitHub
"secret" boxes described below.

## Part A: put the project on GitHub

1. **Open the project folder in VS Code.** File, Open Folder, and choose `C:\project\createstore`. It must be that
   exact folder, not a parent of it.
2. **Open Source Control:** the branch icon in the left bar, or press `Ctrl+Shift+G`. You will see a long list of
   changed files.
3. **Stage everything:** hover over "Changes" and click the `+`.
4. **Write the commit message exactly like this** in the box, then click **Commit**:
   `chore: initial commit`
   The project checks that commit messages start with a type such as `feat:`, `fix:` or `chore:`. Any other message is
   rejected, which is normal. A check also runs the linter first; it takes a few seconds.
5. **Publish:** click **Publish Branch**. Choose the name `createstore` (exactly) and pick **Public**. Public is
   required for the free security scanning.
6. When it finishes, open `https://github.com/Gauravasawa/createstore` in your browser. If your GitHub username is not
   `Gauravasawa`, stop and tell Claude: some files contain that name.
7. Click the **Actions** tab. The **CI** workflow should be running. Wait for it. If any job is red, send Claude the
   name of the job.

## Part B: Cloudflare

You already have the account. In the Cloudflare dashboard (`dash.cloudflare.com`):

8. **Choose the project name** you want for the website address. The address will be
   `https://<name>.pages.dev`. Example: `createstore-docs` gives `https://createstore-docs.pages.dev`.
   Write it down; it is used three times below.
9. **Build the site once on your computer.** In VS Code open the terminal (Terminal menu, New Terminal) and run, replacing the name:
   ```powershell
   $env:SITE_URL = "https://createstore-docs.pages.dev"; npm run docs:build
   ```
   This creates the folder `site/dist`.
10. **Create the Pages project:** left menu **Workers & Pages**, **Create application**, the **Pages** tab, then
    **Upload assets** (also called Direct Upload). Enter your project name, create it, and drag the whole
    `site\dist` folder onto the page, then **Deploy**. The site is now live at `https://<name>.pages.dev`.
11. **Copy your Account ID.** It is on the right side of the **Workers & Pages** overview page. Keep it for step 14.
12. **Create the deploy token.** Top-right profile icon, **My Profile**, **API Tokens**, **Create Token**,
    **Create Custom Token**. Set:
    - Name: `github-docs-deploy`
    - Permissions: **Account**, **Cloudflare Pages**, **Edit** (only this one line)
    - Account Resources: **Include**, your account
    - TTL (expiry): pick a date about 6 to 12 months away and put a reminder in your calendar.

    Click **Continue to summary**, **Create Token**, and **copy the token now**: it is shown only once.

## Part C: connect GitHub and Cloudflare

On `https://github.com/Gauravasawa/createstore`:

13. **Settings**, **Environments**, **New environment**. Create two, named exactly `docs` and `release`.
14. Open the **docs** environment. Under **Environment secrets** add two secrets:
    - `CLOUDFLARE_API_TOKEN`: the token from step 12
    - `CLOUDFLARE_ACCOUNT_ID`: the ID from step 11

    Optional but recommended: tick **Required reviewers** and add yourself, so each deploy waits for your click.

15. **Settings**, **Secrets and variables**, **Actions**, the **Variables** tab, **New repository variable**. Add two:
    - `CLOUDFLARE_PROJECT`: your project name (for example `createstore-docs`)
    - `DOCS_URL`: your address with no slash at the end (for example `https://createstore-docs.pages.dev`)
16. **Test the deploy:** **Actions** tab, **Docs** (left list), **Run workflow**, **Run workflow**. When it is green,
    open the run and read the "Documentation deployed" summary for the address.

## Part D: protect the repository (5 minutes)

On GitHub, **Settings**:

17. **Code security**: switch on Dependabot alerts, Dependabot security updates, secret scanning and push protection.
18. **Actions, General**: set "Workflow permissions" to **Read repository contents**, and untick "Allow GitHub Actions
    to create and approve pull requests".
19. The full list, including branch protection, is in `.github/security-controls.md`. Do branch protection after the
    first release works, because the release bot needs to be allowed to push.

## Part E: the npm package (last, when everything above is green)

20. Follow `RELEASING.md`, section "One-time setup", from step 4. The `release` environment from step 13 is the one
    it refers to.

## If something goes wrong

- **A red job on GitHub:** open it, copy the last 20 lines of the red step, and send them to Claude.
- **A rejected commit:** read the message; the usual cause is a commit message not starting with `feat:`, `fix:`,
  `docs:` or `chore:`.
- **A token was pasted somewhere by mistake:** treat it as stolen. Delete it in Cloudflare (My Profile, API Tokens)
  and create a new one.
