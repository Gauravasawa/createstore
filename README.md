# @createstore/createstore

Global state that works like `useState`, shared by every component. No provider, no reducers, no action types.

```sh
npm install @createstore/createstore
```

Requires React 19 or newer. Works in the browser, in Node, and with Next.js Server Components.

## Quick start

```tsx
import { createStore } from '@createstore/createstore';

const store = createStore({ count: 0 });

function Counter() {
  const [count, setCount] = store.useGlobalState('count');
  return <button onClick={() => setCount((c) => c + 1)}>{count}</button>;
}
```

Every component that reads `'count'` re-renders when any of them changes it. Outside React, use
`store.getState('count')` and `store.setState('count', 2)`.

Everything else stays off until you use it: computed values, server data with `query()`, persistence, offline
support, undo/redo, tab sync, events and server rendering.

## Package

- ESM and CommonJS builds with TypeScript types, `"sideEffects": false`, so unused code is tree-shaken.
- Published with [npm provenance](https://docs.npmjs.com/generating-provenance-statements).
- Versioned with [semantic versioning](https://semver.org); see [CHANGELOG.md](./CHANGELOG.md) once a release exists.

## Links

- [GitHub repository](https://github.com/Gauravasawa/createstore): source code, issues and releases
- [npm package](https://www.npmjs.com/package/@createstore/createstore)
- [Documentation](https://createstore-docs.pages.dev)
- [Report a bug or request a feature](https://github.com/Gauravasawa/createstore/issues/new/choose)
- [Security policy](https://github.com/Gauravasawa/createstore/security/policy)

## License

[MIT](./LICENSE)
