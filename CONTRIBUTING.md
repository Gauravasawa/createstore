# Contributing

Thanks for helping. This file covers what you need to open a pull request that gets merged.

## Set up

You need Node 22.14 or newer (the repository's `.nvmrc` says `22`) and npm.

```sh
git clone https://github.com/Gauravasawa/createstore.git
cd createstore
npm ci
npm run verify
```

`npm run verify` is the same gate CI runs: lint, formatting, types, build, export checks, all tests, publint and
arethetypeswrong. If it passes locally, CI will almost certainly pass.

## Make a change

1. Branch from `main`.
2. Write the code **and a test** for it. Tests live in `spec/` (Vitest) and `test/` (Node's test runner).
3. Run `npm run verify`.
4. Open a pull request against `main` and fill in the template.

## Commit messages

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org). The type decides the version
number, because releases are automatic (see [RELEASING.md](./RELEASING.md)):

| Type                                                     | Effect        |
| -------------------------------------------------------- | ------------- |
| `feat:`                                                  | minor release |
| `fix:`, `perf:`, `revert:`, `docs(README):`              | patch release |
| `feat!:` or a `BREAKING CHANGE:` footer                  | major release |
| `docs:`, `refactor:`, `test:`, `build:`, `ci:`, `chore:` | no release    |

A git hook checks the message when you commit, and CI checks every commit in a pull request. Squash-merge titles
must follow the same rule.

## Ground rules

- **No runtime dependencies.** The package ships with none, on purpose (security and size). A pull request that adds
  one will be declined unless it removes a bigger problem.
- **Keep it small.** The bundle has a size budget that CI enforces.
- **Never commit secrets.** There are no npm tokens in this project. If you think you need one, ask first.
- **Security problems are not issues.** See [SECURITY.md](./SECURITY.md).
- Changes under `.github/`, `scripts/` and the release configuration need the owner's review (see CODEOWNERS).

## Questions

Use GitHub Discussions if they are enabled on the repository, otherwise open an issue with the question template.

By contributing you agree that your work is released under the [MIT license](./LICENSE) and that you follow the
[Code of Conduct](./CODE_OF_CONDUCT.md).
