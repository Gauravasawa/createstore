# Changelog

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
