# Security policy

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private reporting instead:

1. Open the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the problem, the affected version, and steps to reproduce it.

(This needs "Private vulnerability reporting" to be switched on in the repository settings. If the button is missing,
contact the maintainer [@Gauravasawa](https://github.com/Gauravasawa) through their GitHub profile.)

What to expect, as targets rather than guarantees for a one-person project:

- An acknowledgement within 3 working days.
- A first assessment within 10 working days.
- A fix released as a patch version, with credit to you if you want it, and a published advisory.

## Supported versions

See [SUPPORTED_VERSIONS.md](./SUPPORTED_VERSIONS.md). In short: fixes go to the latest release.

## How releases are protected

Releases are built and published only by a GitHub Actions workflow, through npm trusted publishing (no stored token),
with provenance. Details and the remaining risks are in [.github/security-controls.md](./.github/security-controls.md).
To check a version you installed, run `npm audit signatures` in your project.

## Scope

In scope: the published package `@createstore/createstore`, and this repository's build and release pipeline.
Out of scope: vulnerabilities in your own app, and in React or other tools you use with it.
