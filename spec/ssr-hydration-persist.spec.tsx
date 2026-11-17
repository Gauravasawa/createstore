// Hydration when the browser has saved state (persist) or other tabs (syncTabs). The server can't see localStorage,
// so it renders the initial values. The first client render must render the same thing, or React reports a
// mismatch. The saved values must then appear right after hydration. Each test checks four things:
// no console error, no onRecoverableError (React's mismatch report), what the first client render showed, and
// what the page ends on.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h, act, StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { hydrateRoot } from 'react-dom/client';
import { createStore, query } from '@createstore/createstore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const uid = () => Math.random().toString(36).slice(2, 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  localStorage.clear();
});

// What a previous visit left in localStorage: a store with the same name, changed, then gone
function previousVisit(
  name: string,
  initial: Record<string, unknown>,
  changes: Record<string, unknown>,
  options: object = {},
) {
  const before = createStore(initial, { name, persist: true, ...options }) as any;
  for (const [k, v] of Object.entries(changes)) before.setState(k, v);
  before.destroy();
  expect(localStorage.getItem(`${name}:state`)).not.toBeNull();
}

// Hydrate `html` with `app`, recording what every render showed. Returns the checks every test makes.
async function hydrate(html: string, app: () => any, options: { strict?: boolean } = {}) {
  const el = document.createElement('div');
  document.body.append(el);
  el.innerHTML = html;
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const recoverable = vi.fn();
  let root!: ReturnType<typeof hydrateRoot>;
  const tree = options.strict ? h(StrictMode, null, h(app)) : h(app);
  await act(async () => {
    root = hydrateRoot(el, tree, { onRecoverableError: recoverable });
  });
  await act(async () => sleep(0));
  return { el, errors, recoverable, unmount: () => act(async () => root.unmount()) };
}

describe('persist (localStorage) and hydration: the server never sees saved state', () => {
  it('saved values: hydration matches the server HTML (initial values), then the saved values show, with no mismatch', async () => {
    const name = `hyd-${uid()}`;
    const initial = { theme: 'light', count: 0 };
    const App0 = (s: any) => () => h('p', null, `${s.useGlobalState('theme')[0]}|${s.useGlobalState('count')[0]}`);

    // the server: no saved state exists there, so it renders the initial values
    const server = createStore(initial, { name: `${name}-server` });
    const html = renderToString(h(App0(server)));
    expect(html).toBe('<p>light|0</p>');

    previousVisit(name, initial, { theme: 'dark', count: 7 });
    const store = createStore(initial, { name, persist: true }) as any;
    expect(store.getState('theme')).toBe('dark'); // loaded synchronously, before any render

    const seen: string[] = [];
    const App = () => {
      const text = `${store.useGlobalState('theme')[0]}|${store.useGlobalState('count')[0]}`;
      seen.push(text);
      return h('p', null, text);
    };
    const r = await hydrate(html, App);
    expect(r.recoverable).not.toHaveBeenCalled();
    expect(r.errors).not.toHaveBeenCalled();
    expect(seen[0]).toBe('light|0'); // the hydration render: what the server rendered
    expect(seen.at(-1)).toBe('dark|7'); // then the saved values
    expect(r.el.textContent).toBe('dark|7');
    store.destroy();
    await r.unmount();
  });

  it('no saved state: hydration matches and every form renders exactly once', async () => {
    const name = `hyd-${uid()}`;
    const store = createStore({ theme: 'light' }, { name, persist: true }) as any;
    let keyForm = 0;
    let selectorForms = 0;
    const KeyForm = () => {
      keyForm++;
      return h('b', null, store.useGlobalState('theme')[0]);
    };
    const Selectors = () => {
      selectorForms++;
      return h(
        'i',
        null,
        `${store.useGlobalState('theme', (t: string) => t)}${store.useGlobalState(({ theme }: any) => theme)}`,
      );
    };
    const r = await hydrate('<b>light</b><i>lightlight</i>', () => [h(KeyForm, { key: 1 }), h(Selectors, { key: 2 })]);
    expect(r.recoverable).not.toHaveBeenCalled();
    expect(r.errors).not.toHaveBeenCalled();
    expect(selectorForms).toBe(1);
    expect(keyForm).toBe(1); // the client snapshot starts from the hydration cell, so React doesn't render again
    store.destroy();
    await r.unmount();
  });

  it('saved state equal to the initial values: hydration is clean and the selector form renders only once', async () => {
    const name = `hyd-${uid()}`;
    const before = createStore({ theme: 'light', n: 0 }, { name, persist: true }) as any;
    before.setState('n', 1);
    before.setState('n', 0); // saved state now equals the initial values
    before.destroy();
    expect(localStorage.getItem(`${name}:state`)).toContain('"n":0');
    const store = createStore({ theme: 'light', n: 0 }, { name, persist: true }) as any;
    let renders = 0;
    const App = () => {
      renders++;
      return h(
        'p',
        null,
        store.useGlobalState(({ theme, n }: any) => `${theme}${n}`),
      );
    };
    const r = await hydrate('<p>light0</p>', App);
    expect(r.recoverable).not.toHaveBeenCalled();
    expect(renders).toBe(1);
    store.destroy();
    await r.unmount();
  });

  it('every way of reading hydrates cleanly: key form, key selector, store selector, a computed key built on a saved key', async () => {
    const name = `hyd-${uid()}`;
    const initial = { user: { name: 'guest', tags: [] as string[] }, count: 0 };
    const opts = { computed: [{ doubled: (get: any) => get('count') * 2 }] };
    previousVisit(name, initial, { user: { name: 'ada', tags: ['x'] }, count: 21 });
    const store = createStore(initial, { name, persist: true, ...opts } as never) as any;
    const seen: string[] = [];
    const App = () => {
      const [user] = store.useGlobalState('user');
      const userName = store.useGlobalState('user', (u: any) => u.name);
      const both = store.useGlobalState(({ count, user: u }: any) => `${u.tags.length}/${count}`);
      const [doubled] = store.useGlobalState('doubled');
      const text = `${user.name}|${userName}|${both}|${doubled}`;
      seen.push(text);
      return h('p', null, text);
    };
    const r = await hydrate('<p>guest|guest|0/0|0</p>', App);
    expect(r.recoverable).not.toHaveBeenCalled();
    expect(r.errors).not.toHaveBeenCalled();
    expect(seen[0]).toBe('guest|guest|0/0|0');
    expect(r.el.textContent).toBe('ada|ada|1/21|42');
    store.destroy();
    await r.unmount();
  });

  it('persist.keys: only the saved keys change after hydration, the others keep their initial values', async () => {
    const name = `hyd-${uid()}`;
    const initial = { theme: 'light', draft: '' };
    previousVisit(name, initial, { theme: 'dark', draft: 'unsaved' }, { persist: { keys: ['theme'] } });
    const store = createStore(initial, { name, persist: { keys: ['theme'] } }) as any;
    const App = () => h('p', null, `${store.useGlobalState('theme')[0]}|${store.useGlobalState('draft')[0]}`);
    const r = await hydrate('<p>light|</p>', App);
    expect(r.recoverable).not.toHaveBeenCalled();
    expect(r.el.textContent).toBe('dark|');
    store.destroy();
    await r.unmount();
  });

  it('under StrictMode (double renders and effects) it still hydrates cleanly and ends on the saved values', async () => {
    const name = `hyd-${uid()}`;
    previousVisit(name, { theme: 'light' }, { theme: 'dark' });
    const store = createStore({ theme: 'light' }, { name, persist: true }) as any;
    const App = () => h('p', null, store.useGlobalState('theme')[0]);
    const r = await hydrate('<p>light</p>', App, { strict: true });
    expect(r.recoverable).not.toHaveBeenCalled();
    expect(r.errors).not.toHaveBeenCalled();
    expect(r.el.textContent).toBe('dark');
    store.destroy();
    await r.unmount();
  });

  it('unreadable saved state: hydration is clean, the initial values stay, and there is a warning instead of a crash', async () => {
    const name = `hyd-${uid()}`;
    localStorage.setItem(`${name}:state`, '{not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createStore({ theme: 'light' }, { name, persist: true }) as any;
    const App = () => h('p', null, store.useGlobalState('theme')[0]);
    const r = await hydrate('<p>light</p>', App);
    expect(r.recoverable).not.toHaveBeenCalled();
    expect(r.el.textContent).toBe('light');
    expect(warn).toHaveBeenCalled();
    store.destroy();
    await r.unmount();
  });

  it('async storage (an adapter returning promises): hydration is clean, the saved values show once they load', async () => {
    const name = `hyd-${uid()}`;
    const data = new Map<string, string>();
    let release!: () => void;
    const loaded = new Promise<void>((r) => (release = r));
    const storage = {
      getItem: async (k: string) => {
        await loaded;
        return data.get(k) ?? null;
      },
      setItem: async (k: string, v: string) => void data.set(k, v),
      removeItem: async (k: string) => void data.delete(k),
    };
    previousVisit(name, { theme: 'light' }, { theme: 'dark' }); // the real saved format, written by the library
    data.set(`${name}:state`, localStorage.getItem(`${name}:state`)!);
    localStorage.clear();
    const store = createStore({ theme: 'light' }, { name, persist: { storage } }) as any;
    const seen: string[] = [];
    const App = () => {
      const t = store.useGlobalState('theme')[0];
      seen.push(t);
      return h('p', null, t);
    };
    const r = await hydrate('<p>light</p>', App);
    expect(r.recoverable).not.toHaveBeenCalled();
    expect(r.el.textContent).toBe('light'); // not loaded yet
    await act(async () => {
      release();
      await store.hydrated;
      await sleep(0);
    });
    expect(r.el.textContent).toBe('dark');
    expect(seen[0]).toBe('light');
    store.destroy();
    await r.unmount();
  });
});

describe('renders during hydration: the key form renders once when nothing changed, and is never stale', () => {
  // One key-form reader per setup, hydrated over matching HTML. `renders` is exact: one hydration render,
  // plus one more only when the client value really differs from the server's.
  async function hydrateCounting(store: any, key: string, html: string, wrap?: (child: any) => any) {
    let renders = 0;
    const shown: string[] = [];
    const Reader = () => {
      renders++;
      const v = String(store.useGlobalState(key)[0]);
      shown.push(v);
      return h('b', null, v);
    };
    const r = await hydrate(html, wrap ? () => wrap(h(Reader)) : Reader);
    return { ...r, renders: () => renders, shown };
  }

  const setups: [string, (name: string) => any][] = [
    ['no options', (name) => createStore({ k: 'v' }, { name })],
    ['persist', (name) => createStore({ k: 'v' }, { name, persist: true })],
    ['persist: session', (name) => createStore({ k: 'v' }, { name, persist: 'session' })],
    ['syncTabs', (name) => createStore({ k: 'v' }, { name, syncTabs: true })],
    ['history', (name) => createStore({ k: 'v' }, { name, history: true })],
    [
      'persist + syncTabs + history',
      (name) => createStore({ k: 'v' }, { name, persist: true, syncTabs: true, history: true }),
    ],
  ];
  for (const [label, make] of setups)
    it(`${label}: one render, no mismatch, and later changes still show`, async () => {
      const store = make(`hyd-${uid()}`);
      const r = await hydrateCounting(store, 'k', '<b>v</b>');
      expect(r.recoverable).not.toHaveBeenCalled();
      expect(r.errors).not.toHaveBeenCalled();
      expect(r.renders()).toBe(1);
      // the reused cell must not freeze the value: a change after hydration renders it
      await act(async () => store.setState('k', 'w'));
      expect(r.el.textContent).toBe('w');
      expect(r.renders()).toBe(2);
      await act(async () => store.setState('k', 'v')); // and back to the value the hydration cell held
      expect(r.el.textContent).toBe('v');
      expect(r.renders()).toBe(3);
      store.destroy();
      await r.unmount();
    });

  it('a value that differs from the server (saved state) still renders twice: hydration, then the real value', async () => {
    const name = `hyd-${uid()}`;
    previousVisit(name, { k: 'v' }, { k: 'saved' });
    const store = createStore({ k: 'v' }, { name, persist: true }) as any;
    const r = await hydrateCounting(store, 'k', '<b>v</b>');
    expect(r.recoverable).not.toHaveBeenCalled();
    expect(r.shown).toEqual(['v', 'saved']);
    expect(r.renders()).toBe(2);
    store.destroy();
    await r.unmount();
  });

  it('a value changed between store creation and hydration renders twice and ends on the new value', async () => {
    const store = createStore({ k: 'v' }, { name: `hyd-${uid()}` }) as any;
    store.setState('k', 'early');
    const r = await hydrateCounting(store, 'k', '<b>v</b>');
    expect(r.recoverable).not.toHaveBeenCalled();
    expect(r.shown).toEqual(['v', 'early']);
    store.destroy();
    await r.unmount();
  });

  it('a computed key: one render when unchanged, and it follows its input afterwards', async () => {
    const store = createStore({ n: 2 }, { name: `hyd-${uid()}`, computed: [{ double: (get) => get('n') * 2 }] }) as any;
    const r = await hydrateCounting(store, 'double', '<b>4</b>');
    expect(r.recoverable).not.toHaveBeenCalled();
    expect(r.renders()).toBe(1);
    await act(async () => store.setState('n', 5));
    expect(r.el.textContent).toBe('10');
    store.destroy();
    await r.unmount();
  });

  it('ssr: true with a data tag: the scope is hydrated in one render per reader', async () => {
    const store = createStore({ user: 'anonymous', theme: 'light' }, { name: `hyd-${uid()}`, ssr: true }) as any;
    const counts = { user: 0, theme: 0 };
    const User = () => {
      counts.user++;
      return h('b', null, store.useGlobalState('user')[0]);
    };
    const Theme = () => {
      counts.theme++;
      return h('i', null, store.useGlobalState('theme')[0]);
    };
    const scope = store.createScope({ user: 'ada' });
    const html = renderToString(h(store.Root, { scope }, h(User), h(Theme)));
    Object.assign(counts, { user: 0, theme: 0 }); // count browser renders only, not the server render above
    document.body.insertAdjacentHTML('beforeend', scope.toScript());
    const r = await hydrate(html, () => h(store.Root, { scope: store.hydrate() }, h(User), h(Theme)));
    expect(r.recoverable).not.toHaveBeenCalled();
    expect(r.errors).not.toHaveBeenCalled();
    expect(r.el.textContent).toBe('adalight');
    expect(counts).toEqual({ user: 1, theme: 1 });
    await act(async () => store.setState('user', 'grace'));
    expect(r.el.textContent).toBe('gracelight');
    expect(counts).toEqual({ user: 2, theme: 1 }); // isolation holds after hydration too
    await r.unmount();
  });

  it('a query the server did not load: hydrates as loading (what the server rendered), then shows the data', async () => {
    let release!: (v: string[]) => void;
    const store = createStore(
      { todos: query(() => new Promise<string[]>((r) => (release = r)), { initial: [] as string[] }) },
      { name: `hyd-${uid()}`, ssr: true },
    ) as any;
    const seen: string[] = [];
    const Todos = () => {
      const [todos, , status] = store.useGlobalState('todos');
      const text = `${status.state}:${(todos as string[]).join(',')}`;
      seen.push(text);
      return h('b', null, text);
    };
    const scope = store.createScope({});
    const html = renderToString(h(store.Root, { scope }, h(Todos)));
    document.body.insertAdjacentHTML('beforeend', scope.toScript());
    const r = await hydrate(html, () => h(store.Root, { scope: store.hydrate() }, h(Todos)));
    expect(r.recoverable).not.toHaveBeenCalled();
    expect(r.errors).not.toHaveBeenCalled();
    expect(seen[0]).toBe(html.replace(/<[^>]+>/g, '')); // the hydration render matched the server text
    await act(async () => {
      release(['a', 'b']);
      await sleep(10);
    });
    expect(r.el.textContent).toBe('ready:a,b');
    await r.unmount();
  });

  it('a query the server did load: hydrates in one render with the data, and refetches still update it', async () => {
    let answer = ['a'];
    const store = createStore(
      { todos: query(async () => answer, { initial: [] as string[], staleTime: 60_000 }) },
      { name: `hyd-${uid()}`, ssr: true },
    ) as any;
    let renders = 0;
    const Todos = () => {
      renders++;
      return h('b', null, (store.useGlobalState('todos')[0] as string[]).join(','));
    };
    const scope = store.createScope({});
    await scope.fetchQuery('todos');
    // jsdom counts as a browser, where the server snapshot is the initial value, so write the server's HTML out
    const html = '<b>a</b>';
    document.body.insertAdjacentHTML('beforeend', scope.toScript());
    const r = await hydrate(html, () => h(store.Root, { scope: store.hydrate() }, h(Todos)));
    expect(r.recoverable).not.toHaveBeenCalled();
    expect(r.errors).not.toHaveBeenCalled();
    expect(renders).toBe(1);
    answer = ['a', 'b'];
    await act(async () => {
      await store.fetchQuery('todos', undefined, true);
      await sleep(10);
    });
    expect(r.el.textContent).toBe('a,b');
    await r.unmount();
  });

  it('StrictMode: no mismatch, the same render count as React gives any matching hook (2), and changes show', async () => {
    const store = createStore({ k: 'v' }, { name: `hyd-${uid()}` }) as any;
    const r = await hydrateCounting(store, 'k', '<b>v</b>', (child) => h(StrictMode, null, child));
    expect(r.recoverable).not.toHaveBeenCalled();
    expect(r.errors).not.toHaveBeenCalled();
    expect(r.renders()).toBe(2); // StrictMode's double render only, no extra one
    await act(async () => store.setState('k', 'w'));
    expect(r.el.textContent).toBe('w');
    store.destroy();
    await r.unmount();
  });

  it('100 readers of 100 keys hydrate in exactly 100 renders, and one change afterwards renders exactly one', async () => {
    const init = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, i]));
    const store = createStore(init, { name: `hyd-${uid()}`, persist: true }) as any;
    let renders = 0;
    const Cell = ({ k }: { k: string }) => {
      renders++;
      return h('i', null, String(store.useGlobalState(k)[0]));
    };
    const App = () => h('div', null, ...Object.keys(init).map((k) => h(Cell, { key: k, k })));
    const html = renderToString(h(App));
    renders = 0; // count browser renders only, not the server render above
    const r = await hydrate(html, App);
    expect(r.recoverable).not.toHaveBeenCalled();
    expect(renders).toBe(100);
    renders = 0;
    await act(async () => store.setState('k42', 'changed'));
    expect(renders).toBe(1);
    expect(r.el.textContent).toContain('changed');
    store.destroy();
    await r.unmount();
  });

  it('after hydration, a component mounted later (client render) and a remount read the live value, not the hydration one', async () => {
    const store = createStore({ k: 'v' }, { name: `hyd-${uid()}` }) as any;
    const r = await hydrateCounting(store, 'k', '<b>v</b>');
    await act(async () => store.setState('k', 'live'));
    const { createRoot } = await import('react-dom/client');
    const el = document.createElement('div');
    const root = createRoot(el);
    const Late = () => h('u', null, store.useGlobalState('k')[0]);
    await act(async () => root.render(h(Late)));
    expect(el.textContent).toBe('live');
    await act(async () => root.render(h('div')));
    await act(async () => root.render(h(Late))); // remount
    expect(el.textContent).toBe('live');
    await act(async () => root.unmount());
    store.destroy();
    await r.unmount();
  });

  it('a second page hydrating the same store later (another root) still matches and renders once', async () => {
    const store = createStore({ k: 'v' }, { name: `hyd-${uid()}` }) as any;
    const first = await hydrateCounting(store, 'k', '<b>v</b>');
    const second = await hydrateCounting(store, 'k', '<b>v</b>');
    expect(first.recoverable).not.toHaveBeenCalled();
    expect(second.recoverable).not.toHaveBeenCalled();
    expect([first.renders(), second.renders()]).toEqual([1, 1]);
    store.destroy();
    await first.unmount();
    await second.unmount();
  });
});

describe('a real server render (a Node process with no window or localStorage), hydrated in the browser', () => {
  it('the HTML from Node hydrates against a browser store with saved state: no mismatch, then the saved values', async () => {
    const options = `{ name: 'real-server', persist: true, syncTabs: true, computed: [{ doubled: (get) => get('count') * 2 }] }`;
    const app = (s: string) =>
      `() => h('p', null, \`\${${s}.useGlobalState('theme')[0]}|\${${s}.useGlobalState('count')[0]}|\${${s}.useGlobalState('doubled')[0]}|\${${s}.useGlobalState(({ count }) => count + 1)}\`)`;
    const code = [
      `import { createElement as h } from 'react';`,
      `import { renderToString } from 'react-dom/server';`,
      `import { createStore } from '@createstore/createstore';`,
      `if (typeof window !== 'undefined' || typeof localStorage !== 'undefined') throw new Error('not a server');`,
      `const s = createStore({ theme: 'light', count: 0 }, ${options});`,
      `process.stdout.write(renderToString(h(${app('s')})));`,
    ].join('\n');
    const { spawnSync } = await import('node:child_process');
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: process.cwd(),
      encoding: 'utf8',
    });
    expect(out.stderr).toBe('');
    const html = out.stdout;
    expect(html).toBe('<p>light|0|0|1</p>');

    localStorage.clear();
    previousVisit('real-server', { theme: 'light', count: 0 }, { theme: 'dark', count: 5 });
    const s = createStore(
      { theme: 'light', count: 0 },
      {
        name: 'real-server',
        persist: true,
        syncTabs: true,
        computed: [{ doubled: (get) => get('count') * 2 }],
      },
    );
    const seen: string[] = [];
    const App = () => {
      const text = `${s.useGlobalState('theme')[0]}|${s.useGlobalState('count')[0]}|${s.useGlobalState('doubled')[0]}|${s.useGlobalState(({ count }) => count + 1)}`;
      seen.push(text);
      return h('p', null, text);
    };
    const r = await hydrate(html, App);
    expect(r.recoverable).not.toHaveBeenCalled();
    expect(r.errors).not.toHaveBeenCalled();
    expect(seen[0]).toBe('light|0|0|1');
    expect(r.el.textContent).toBe('dark|5|10|6');
    s.destroy();
    await r.unmount();
  });
});

describe('changes that arrive before or during hydration (other tabs, early writes)', () => {
  it('a value changed before hydrateRoot (an early setState, a message from another tab) hydrates cleanly, then shows', async () => {
    const name = `hyd-${uid()}`;
    const store = createStore({ theme: 'light' }, { name, persist: true, syncTabs: true }) as any;
    const ch = new BroadcastChannel(`createStore:${name}`);
    ch.postMessage({ type: 'state', stamp: [5, 'zz'], values: { theme: 'from-other-tab' } });
    await sleep(80);
    ch.close();
    expect(store.getState('theme')).toBe('from-other-tab');
    const App = () => h('p', null, store.useGlobalState('theme')[0]);
    const r = await hydrate('<p>light</p>', App);
    expect(r.recoverable).not.toHaveBeenCalled();
    expect(r.errors).not.toHaveBeenCalled();
    expect(r.el.textContent).toBe('from-other-tab');
    store.destroy();
    await r.unmount();
  });

  it('a message from another tab right after hydration updates the page without a mismatch', async () => {
    const name = `hyd-${uid()}`;
    previousVisit(name, { theme: 'light' }, { theme: 'dark' });
    const store = createStore({ theme: 'light' }, { name, persist: true, syncTabs: true }) as any;
    const App = () => h('p', null, store.useGlobalState('theme')[0]);
    const r = await hydrate('<p>light</p>', App);
    const ch = new BroadcastChannel(`createStore:${name}`);
    await act(async () => {
      ch.postMessage({ type: 'state', stamp: [99, 'zz'], values: { theme: 'blue' } });
      await sleep(80);
    });
    ch.close();
    expect(r.recoverable).not.toHaveBeenCalled();
    expect(r.el.textContent).toBe('blue');
    store.destroy();
    await r.unmount();
  });
});

describe('ssr: true (server data in a data tag) together with persist', () => {
  it('server data and saved data on different keys: hydration matches the server HTML, then saved values show', async () => {
    const name = `hyd-${uid()}`;
    const initial = { user: 'anonymous', theme: 'light' };
    previousVisit(name, initial, { theme: 'dark' }, { persist: { keys: ['theme'] } });
    const store = createStore(initial, { name, ssr: true, persist: { keys: ['theme'] } }) as any;
    const App = () => h('p', null, `${store.useGlobalState('user')[0]}|${store.useGlobalState('theme')[0]}`);
    // the server: a request store with the user filled in; the theme is unknown there (initial)
    const scope = store.createScope({ user: 'ada' });
    const html = renderToString(h(store.Root, { scope }, h(App)));
    expect(html).toContain('ada|light');
    document.body.insertAdjacentHTML('beforeend', scope.toScript());
    const seen: string[] = [];
    const Tracked = () => {
      const text = `${store.useGlobalState('user')[0]}|${store.useGlobalState('theme')[0]}`;
      seen.push(text);
      return h('p', null, text);
    };
    const Hydrated = () => h(store.Root, { scope: store.hydrate() }, h(Tracked));
    const r = await hydrate(html, Hydrated);
    expect(r.recoverable).not.toHaveBeenCalled();
    expect(r.errors).not.toHaveBeenCalled();
    expect(seen[0]).toBe('ada|light');
    expect(r.el.textContent).toBe('ada|dark');
    await r.unmount();
  });
});

describe('the harness can see a mismatch (so the passing tests above mean something)', () => {
  it('a component that reads localStorage during render does cause a reported mismatch', async () => {
    localStorage.setItem('raw-theme', 'dark');
    const App = () =>
      h('p', null, typeof window === 'undefined' ? 'light' : (localStorage.getItem('raw-theme') ?? 'light'));
    const r = await hydrate('<p>light</p>', App);
    expect(r.recoverable).toHaveBeenCalled();
    await r.unmount();
  });
});
