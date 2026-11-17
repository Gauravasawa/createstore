# Re-render benchmark

createStore against Zustand and React Context, in real Chromium with React's production build. Not published with
the package.

```sh
npm run build                 # from the repository root: the benchmark uses dist/
npm install --prefix bench    # Zustand, pinned in bench/package.json
node bench/rerender.mjs       # N=5000 node bench/rerender.mjs for more components
```

Each update is wrapped in `flushSync`, so the time includes React rendering and committing. Every run also counts
renders and checks that the last value is on screen. The median of 7 alternating rounds is reported.

- **Wide**: N components, each reading its own key; one key changes per update. This is the usual app shape.
- **Narrow**: N components all reading the same key; it changes per update, so every component must re-render.

## Results

Times change from machine to machine and run to run; the ratios are what held steady. Measured with Chromium 158,
React 19.3, Zustand 5.1, over four runs at 200, 1,000 and 5,000 components.

| Scenario | createStore `useGlobalState(key)` | Zustand with a selector | Zustand without a selector | React Context       |
| -------- | --------------------------------- | ----------------------- | -------------------------- | ------------------- |
| Wide     | **fastest**, 1 render per update  | 1.6× to 4.8× slower     | 6.7× to 11.7× slower       | 3.7× to 7.8× slower |
| Narrow   | 1.3× to 1.8× slower than Zustand  | faster than createStore | about the same as with one | **fastest**         |

In the wide case only the one component that reads the changed key renders. Zustand also renders only that one, but
calls every component's selector on every change, so its cost grows with the number of components. In the narrow case
every library renders every component, and createStore's per-component hook does more work than Zustand's.
