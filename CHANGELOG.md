# Changelog

## [1.2.0](https://github.com/Gauravasawa/createstore/compare/v1.1.3...v1.2.0) (2026-11-18)

### Features

* add onError and persist.rescue, and harden reads, query keys and tab sync ([f6faf9f](https://github.com/Gauravasawa/createstore/commit/f6faf9f550dbb18ac719aa085fe248c18dc95f93))

### Documentation

* fix search results showing undefined and build the search index from the page ([13febb4](https://github.com/Gauravasawa/createstore/commit/13febb4b4b94df3e2a68a29cd983cea3fd4b2c71))
* record why the minimatch alert can't be fixed yet ([d0feea8](https://github.com/Gauravasawa/createstore/commit/d0feea877c9e764a538366b6a2b9ad9dcd173fae)), closes [#2](https://github.com/Gauravasawa/createstore/issues/2)

### Refactoring

* type the store's internal values in one place ([7e0067a](https://github.com/Gauravasawa/createstore/commit/7e0067a3f8b8ee8844068d5bcec0042d65490eb4))

### Build System

* eslint 10, stricter TypeScript, type-aware lint, a coverage floor and an import-cycle test ([b4c11e9](https://github.com/Gauravasawa/createstore/commit/b4c11e9f2108ccdfffb7acd0e1304d4c093acb48))

## [1.1.3](https://github.com/Gauravasawa/createstore/compare/v1.1.2...v1.1.3) (2026-11-17)

### Bug Fixes

* keep other tabs' saved changes, warn on storage failures, replay offline tasks in order ([e0aaf7a](https://github.com/Gauravasawa/createstore/commit/e0aaf7ab7197a80ad2d3cf8a76b0107a9db09da7))
* render key-form components once on hydration when the value matches the server ([1316968](https://github.com/Gauravasawa/createstore/commit/13169680ab9b7fe1b062ec861c8b239f37a0fd32))
* report real createStore options and surface errors thrown by pages.next() ([85ceee9](https://github.com/Gauravasawa/createstore/commit/85ceee9be0d3fda31b26cad136f06d6447b91371))

### Documentation

* **README:** add the re-render benchmark against Zustand and React Context ([2b5d12f](https://github.com/Gauravasawa/createstore/commit/2b5d12ff7633c60184fd127bf5f3df8257300d34))

## [1.1.2](https://github.com/Gauravasawa/createstore/compare/v1.1.1...v1.1.2) (2026-11-15)

### Bug Fixes

* **types:** type earlier computed values inside later layers instead of any ([e81eb82](https://github.com/Gauravasawa/createstore/commit/e81eb829c806a70cf0e479d235f384056be0595a))

### Documentation

* add SEO, answer-engine and AI-agent optimisation to the docs site ([c91c026](https://github.com/Gauravasawa/createstore/commit/c91c0263e5f915cb10743da19f9c1823aed901dc))
* per-section pages, speed and layout fixes, crawler policy, security.txt ([2445639](https://github.com/Gauravasawa/createstore/commit/24456393b5e7bcb8affea1a7ca9ed698b1c30a8e))
* serve security.txt from /security.txt, Cloudflare skips dot-folders ([753ff17](https://github.com/Gauravasawa/createstore/commit/753ff17c1a8cd1684c68db70a4f0afa5d7f6c276))

## [1.1.1](https://github.com/Gauravasawa/createstore/compare/v1.1.0...v1.1.1) (2026-11-11)

### Bug Fixes

* persisting an unsavable value no longer breaks the store ([a900078](https://github.com/Gauravasawa/createstore/commit/a9000786aedf52c8a87772be219a4e4f2ec0b8fe))

## [1.1.0](https://github.com/Gauravasawa/createstore/compare/v1.0.0...v1.1.0) (2026-11-11)

### Features

* warn about unknown options and unnamed persisted stores, clearer errors ([5a30e4c](https://github.com/Gauravasawa/createstore/commit/5a30e4c1ecffbdbf5d2f1e2bfb58528d11544e08))

### Bug Fixes

* remove per-store window listeners that kept stores alive ([8029281](https://github.com/Gauravasawa/createstore/commit/80292814dcfc482cfdc796a4fc16d3c754e061e7))

### Documentation

* link the docs site to GitHub and npm ([15ad590](https://github.com/Gauravasawa/createstore/commit/15ad590a08c415e5a66dbfa744fda2d1a2880897))
* state the React 19 requirement consistently ([d8f1797](https://github.com/Gauravasawa/createstore/commit/d8f17970b4ad61101cf68811ca12472c4717cb2a))

## 1.0.0 (2026-11-11)

### Documentation

* add contributor files, recovery runbook, post-release check and final audit ([f4ad890](https://github.com/Gauravasawa/createstore/commit/f4ad8909e5eed6ac8659034f006867289521228a))
* **README:** add shared todos example ([4c3c97a](https://github.com/Gauravasawa/createstore/commit/4c3c97a6f8152696270a0e1f57a3b49371ed0e98))
