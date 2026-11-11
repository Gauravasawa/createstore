// Server-rendered pages in the browser (jsdom): hydration, mismatches, refresh, client navigation, concurrent rendering.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement as h, act, StrictMode, startTransition, useDeferredValue } from 'react';
import { renderToString } from 'react-dom/server';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { createStore, query } from '@createstore/createstore';
import { ClientRoot } from '../dist/esm/client-root.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let n = 0;
const uniqueName = () => `ssr-browser-${++n}`; // a store name per test: the browser keeps stores by name
const container = () => {
  const el = document.createElement('div');
  document.body.append(el);
  return el;
};
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

// The page the server would send: HTML for the app, and the data tag after it
function serverPage<S extends { createScope: any; Root: any }>(store: S, initial: object, App: () => any) {
  const scope = store.createScope(initial);
  return { html: renderToString(h(store.Root, { scope }, h(App))), tag: scope.toScript() as string };
}

describe('5: hydrating a server snapshot', () => {
  it('the browser starts from the server data, React reports no mismatch, and the data tag is removed', async () => {
    const store = createStore({ user: 'anonymous', cart: ['x'] }, { name: uniqueName(), ssr: true });
    const App = () => h('p', null, `${store.useGlobalState('user')[0]}|${store.useGlobalState('cart')[0].join(',')}`);
    const { html, tag } = serverPage(store, { user: 'ada', cart: ['a', 'b'] }, App);
    const el = container();
    el.innerHTML = html;
    document.body.insertAdjacentHTML('beforeend', tag);

    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const recoverable = vi.fn();
    let root!: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(el, h(store.Root, { scope: store.hydrate() }, h(App)), { onRecoverableError: recoverable });
    });

    expect(el.textContent).toBe('ada|a,b');
    expect(store.getState('user')).toBe('ada'); // the app's store was filled
    expect(errors).not.toHaveBeenCalled();
    expect(recoverable).not.toHaveBeenCalled(); // no hydration mismatch
    expect(
      document.getElementById(
        `createstore:${
          store
            .createScope()
            .toScript()
            .match(/createstore:([^"]+)/)![1]
        }`,
      ),
    ).toBeNull();
    await act(async () => root.unmount());
  });

  it('after hydration the page is live: a change re-renders from the browser store', async () => {
    const store = createStore({ count: 0 }, { name: uniqueName(), ssr: true });
    const App = () => {
      const [count, setCount] = store.useGlobalState('count');
      return h('button', { onClick: () => setCount((c: number) => c + 1) }, String(count));
    };
    const { html, tag } = serverPage(store, { count: 5 }, App);
    const el = container();
    el.innerHTML = html;
    document.body.insertAdjacentHTML('beforeend', tag);
    let root!: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(el, h(store.Root, { scope: store.hydrate() }, h(App)));
    });
    await act(async () => el.querySelector('button')!.click());
    expect(el.textContent).toBe('6');
    await act(async () => root.unmount());
  });
});

describe('6: hydration mismatches and bad data', () => {
  it('a snapshot from another app version is ignored with a warning (an old cached page after a deploy)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createStore({ user: 'anonymous' }, { name: uniqueName(), ssr: { version: 2 } });
    store.hydrate({ $version: 1, user: 'old-page' } as never);
    expect(store.getState('user')).toBe('anonymous');
    expect(warn.mock.calls.flat().join(' ')).toMatch(/ignored a snapshot made for version 1/);
  });

  it('a missing data tag warns, and the app starts from its initial state', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createStore({ user: 'anonymous' }, { name: uniqueName(), ssr: true });
    store.hydrate();
    expect(store.getState('user')).toBe('anonymous');
    expect(warn.mock.calls.flat().join(' ')).toMatch(/found no data tag/);
  });

  it('a data tag that is not valid JSON warns and is ignored', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const name = uniqueName();
    const store = createStore({ user: 'anonymous' }, { name, ssr: true });
    document.body.insertAdjacentHTML(
      'beforeend',
      `<script type="application/json" id="createstore:${name}">{not json</script>`,
    );
    store.hydrate();
    expect(store.getState('user')).toBe('anonymous');
    expect(warn.mock.calls.flat().join(' ')).toMatch(/not valid JSON/);
  });

  it('user-written HTML with the same id (a bio, a comment) can never be read as server data', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const name = uniqueName();
    const store = createStore({ user: 'anonymous' }, { name, ssr: true });
    const real = store.createScope({ user: 'ada' }).toScript();
    // user content first (a div, then a script), the real tag last, as toScript() puts it after the page
    document.body.insertAdjacentHTML('beforeend', `<div id="createstore:${name}">{"user":"evil-div"}</div>`);
    document.body.insertAdjacentHTML('beforeend', real);
    store.hydrate();
    expect(store.getState('user')).toBe('ada');
  });

  it('a server snapshot that does not match the HTML recovers: React re-renders on the client and nothing throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = createStore({ user: 'anonymous' }, { name: uniqueName(), ssr: true });
    const App = () => h('p', null, store.useGlobalState('user')[0]);
    const { html } = serverPage(store, { user: 'ada' }, App); // server HTML says "ada", but the tag never arrives
    const el = container();
    el.innerHTML = html;
    const recoverable = vi.fn();
    let root!: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(el, h(store.Root, { scope: store.hydrate() }, h(App)), { onRecoverableError: recoverable });
    });
    expect(el.textContent).toBe('anonymous'); // the browser's truth wins, no crash
    expect(recoverable).toHaveBeenCalled(); // and React says there was a mismatch
    await act(async () => root.unmount());
  });

  it('unknown keys in a snapshot are ignored, not added to the store', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createStore({ user: 'anonymous' }, { name: uniqueName(), ssr: true });
    store.hydrate({ user: 'ada', __proto__: { x: 1 }, removedKey: 1 } as never);
    expect(store.getState('user')).toBe('ada');
    expect(store.getState('removedKey' as never)).toBeUndefined();
  });
});

describe('7: browser refresh', () => {
  it('hydrating again (a remount, StrictMode, hot reload) never overwrites what the user changed', async () => {
    const store = createStore({ user: 'anonymous' }, { name: uniqueName(), ssr: true });
    store.hydrate({ user: 'ada' } as never);
    await store.setState('user', 'changed-by-user');
    store.hydrate({ user: 'ada' } as never);
    store.hydrate();
    expect(store.getState('user')).toBe('changed-by-user');
  });

  it('works under StrictMode (renders twice)', async () => {
    const store = createStore({ user: 'anonymous' }, { name: uniqueName(), ssr: true });
    const App = () => h('p', null, store.useGlobalState('user')[0]);
    const { html, tag } = serverPage(store, { user: 'ada' }, App);
    const el = container();
    el.innerHTML = html;
    document.body.insertAdjacentHTML('beforeend', tag);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    let root!: ReturnType<typeof hydrateRoot>;
    await act(async () => {
      root = hydrateRoot(el, h(StrictMode, null, h(store.Root, { scope: store.hydrate() }, h(App))));
    });
    expect(el.textContent).toBe('ada');
    expect(errors).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("a real refresh (a fresh module, a fresh page) takes the new data, never the old page's", async () => {
    const name = uniqueName();
    const first = createStore({ user: 'anonymous' }, { name, ssr: true });
    first.hydrate({ user: 'page-one' } as never);

    vi.resetModules(); // what a refresh does: the page's JavaScript starts over
    const fresh = await import('../dist/esm/createStore.js');
    const second = (fresh as any).createStore({ user: 'anonymous' }, { name, ssr: true });
    second.hydrate({ user: 'page-two' });
    expect(second.getState('user')).toBe('page-two');
  });
});

describe('4: client-side navigation between pages (Next.js App Router)', () => {
  it('a new page merges its server data and keeps what the user changed', async () => {
    const name = uniqueName();
    let serverPosts: string[] = [];
    const store = createStore(
      { theme: 'light', posts: query(async () => serverPosts, { initial: [] as string[], staleTime: 60_000 }) },
      { name, ssr: true },
    );
    const Page = () => {
      const [theme] = store.useGlobalState('theme');
      const [posts] = store.useGlobalState('posts');
      return h('p', null, `${theme}|${(posts as string[]).join(',')}`);
    };
    // What the server would send for a page: a request's store, its data loaded, then its snapshot
    const snapshotWith = async (posts: string[]) => {
      serverPosts = posts;
      const scope = store.createScope({ theme: 'light' });
      await scope.fetchQuery('posts');
      return scope.snapshot();
    };
    const el = container();
    const root = createRoot(el);
    const page = (snapshot: unknown) => h(ClientRoot as never, { name, snapshot }, h(Page));

    await act(async () => root.render(page(await snapshotWith(['page-1']))));
    expect(el.textContent).toBe('light|page-1');

    await act(async () => {
      await store.setState('theme', 'dark'); // the user changes a preference
    });
    expect(el.textContent).toBe('dark|page-1');

    // navigating: the server sends the next page's snapshot (it still says theme "light")
    await act(async () => root.render(page(await snapshotWith(['page-2']))));
    expect(el.textContent).toBe('dark|page-2'); // new server data in, the user's change kept
    await act(async () => root.unmount());
  });

  it('a snapshot made for another version is not merged into the store', async () => {
    const name = uniqueName();
    const store = createStore(
      { theme: 'light', posts: query(async () => ['x'], { initial: [] as string[] }) },
      { name, ssr: { version: 2 } },
    );
    const Page = () => h('p', null, (store.useGlobalState('posts')[0] as string[]).join(','));
    const el = container();
    const root = createRoot(el);
    await act(async () =>
      root.render(h(ClientRoot as never, { name, snapshot: { $version: 2, posts: ['v2'] } }, h(Page))),
    );
    await act(async () =>
      root.render(h(ClientRoot as never, { name, snapshot: { $version: 1, posts: ['old'] } }, h(Page))),
    );
    expect(el.textContent).toBe('v2');
    await act(async () => root.unmount());
  });
});

describe('9: concurrent React rendering', () => {
  it('components reading one key never show different values in the same commit (no tearing)', async () => {
    const store = createStore({ n: 0 });
    const A = () => h('i', { id: 'a' }, String(store.useGlobalState('n')[0]));
    const Slow = () => {
      const deferred = useDeferredValue(store.useGlobalState('n')[0]);
      return h('u', { id: 'd' }, String(deferred));
    };
    const B = () => h('b', { id: 'b' }, String(store.useGlobalState('n')[0]));
    const el = container();
    const root = createRoot(el);
    await act(async () => root.render(h('div', null, h(A), h(B), h(Slow))));
    for (let i = 1; i <= 60; i++) {
      await act(async () => {
        startTransition(() => void store.setState('n', i)); // a low-priority update...
        if (i % 3 === 0) void store.setState('n', -i); // ...and an urgent one in the same tick
      });
      // useSyncExternalStore: A and B always agree (the deferred one may lag, never mix with them)
      expect(el.querySelector('#a')!.textContent).toBe(el.querySelector('#b')!.textContent);
    }
    await act(async () => root.unmount());
  });

  it('100 rapid updates end on the last value in every component', async () => {
    const store = createStore({ n: 0 });
    const A = () => h('i', { id: 'a' }, String(store.useGlobalState('n')[0]));
    const B = () => h('b', { id: 'b' }, String(store.useGlobalState('n')[0]));
    const el = container();
    const root = createRoot(el);
    await act(async () => root.render(h('div', null, h(A), h(B))));
    await act(async () => {
      for (let i = 1; i <= 100; i++) startTransition(() => void store.setState('n', i));
    });
    expect(el.querySelector('#a')!.textContent).toBe('100');
    expect(el.querySelector('#b')!.textContent).toBe('100');
    await act(async () => root.unmount());
  });
});
