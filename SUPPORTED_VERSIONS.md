# Supported versions and versioning policy

> **Proposal.** I wrote this policy as a sensible default for a one-maintainer project. Change the numbers if you
> want to promise more or less, because people will rely on what is written here.

## Versioning

The package follows [semantic versioning](https://semver.org). The version is chosen automatically from commit
messages (see [RELEASING.md](./RELEASING.md)).

- **Patch** (`1.2.3` to `1.2.4`): bug fixes and performance work. Safe to upgrade.
- **Minor** (`1.2.x` to `1.3.0`): new features that are backwards compatible.
- **Major** (`1.x` to `2.0.0`): anything that can break existing code. Each major release comes with a migration note
  in the release notes.

The public API is what is exported from `@createstore/createstore` and documented in the README. Anything else (file
paths inside `dist`, error message wording, `console` output) can change in a minor release.

## Which versions get fixes

| Version                                | Bug fixes     | Security fixes                    |
| -------------------------------------- | ------------- | --------------------------------- |
| Latest major                           | Yes           | Yes                               |
| Previous major                         | No            | For 6 months after the next major |
| Anything older                         | No            | No                                |
| Pre-releases (`next`, `beta`, `alpha`) | No guarantees | No                                |

The first release is `1.0.0`, so for now only the latest `1.x` is supported.

## Platform support

- **Node.js:** 20 and newer (`engines` in `package.json`). CI runs Node 20, 22 and 24, plus Windows and macOS on 22.
- **React:** 19 and newer (peer dependency).
- A runtime is dropped only in a major release, announced in the release notes of the version before it.

## Roadmap

There is no committed roadmap yet. Planned work is tracked as GitHub issues with the `enhancement` label; ideas are
welcome through the feature request template.
