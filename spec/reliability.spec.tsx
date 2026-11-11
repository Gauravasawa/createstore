// Production reliability: Strict Mode, subscription cleanup, memory, error boundaries, and browsers that lack
// or restrict APIs (private mode, blocked storage, no BroadcastChannel).
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { Component, createElement as h, act, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import v8 from 'node:v8';
import vm from 'node:vm';
import { createStore, query } from '@createstore/createstore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

v8.setFlagsFromString('--expose-gc');
const gc: () => void = vm.runInNewContext('gc');
const collect = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise((r) => setTimeout(r, 5));
    gc();
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mount(node: ReactNode) {
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(node));
  return {
    el,
    root,
    unmount: async () => {
      await act(async () => root.unmount());
      el.remove();
    },
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('Strict Mode (double render, double effects)', () => {
  it('reads and writes correctly: one click is one change', async () => {
    const store = createStore({ n: 0 });
    const C = () => {
      const [n, setN] = store.useGlobalState('n');
      return h('button', { onClick: () => setN((x: number) => x + 1) }, String(n));
    };
    const { el, unmount } = await mount(h(StrictMode, null, h(C)));
    expect(el.textContent).toBe('0');
    await act(async () => el.querySelector('button')!.click());
    expect(el.textContent).toBe('1');
    expect(store.getState('n')).toBe(1);
    await unmount();
  });

  it('a query shown by several components makes one request, even when Strict Mode mounts twice', async () => {
    let requests = 0;
    const store = createStore({ posts: query(async () => (requests++, ['a']), { initial: [] as string[] }) });
    const C = () => h('i', null, store.useGlobalState('posts')[0].join(','));
    const { el, unmount } = await mount(h(StrictMode, null, h('div', null, h(C), h(C), h(C))));
    await act(async () => void (await sleep(20)));
    expect(requests).toBe(1);
    expect(el.textContent).toBe('aaa');
    await unmount();
  });

  it('history: undo and redo work under Strict Mode', async () => {
    const store = createStore({ n: 0 }, { history: true });
    const C = () => h('i', null, String(store.useGlobalState('n')[0]));
    const { el, unmount } = await mount(h(StrictMode, null, h(C)));
    await act(async () => void store.setState('n', 1));
    await act(async () => void store.setState('n', 2));
    await act(async () => void store.undo());
    expect(el.textContent).toBe('1');
    await act(async () => void store.redo());
    expect(el.textContent).toBe('2');
    await unmount();
  });
});

describe('subscription cleanup (exact counts of what React subscribes to)', () => {
  let live = 0;
  let made = 0;
  let lib: { createStore: typeof createStore };
  let React: typeof import('react');
  let ReactDOM: typeof import('react-dom/client');

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('react', async () => {
      const actual = await vi.importActual<typeof import('react')>('react');
      const wrapped = new WeakMap<object, (cb: () => void) => () => void>();
      const useSyncExternalStore: typeof actual.useSyncExternalStore = (subscribe, ...rest) => {
        // one wrapper per subscribe function, so React does not resubscribe on every render
        if (!wrapped.has(subscribe))
          wrapped.set(subscribe, (cb) => {
            live++;
            made++;
            const off = subscribe(cb);
            let done = false;
            return () => {
              if (!done) live--;
              done = true;
              off();
            };
          });
        return actual.useSyncExternalStore(wrapped.get(subscribe)!, ...rest);
      };
      return { ...actual, useSyncExternalStore, default: { ...actual, useSyncExternalStore } };
    });
    React = await import('react');
    ReactDOM = await import('react-dom/client');
    lib = (await import('../dist/esm/createStore.js')) as never;
  });

  const run = async (strict: boolean, count: number) => {
    const store = lib.createStore({ a: 0, b: 0 });
    const A = () => React.createElement('i', null, String(store.useGlobalState('a')[0]));
    const B = () => React.createElement('b', null, String(store.useGlobalState('b')[0]));
    const kids = Array.from({ length: count }, (_, i) => React.createElement(i % 2 ? B : A, { key: i }));
    const tree = React.createElement('div', null, ...kids);
    const el = document.createElement('div');
    const root = ReactDOM.createRoot(el);
    live = 0;
    await act(async () => root.render(strict ? React.createElement(React.StrictMode, null, tree) : tree));
    const afterMount = live;
    await act(async () => root.unmount());
    return { afterMount, afterUnmount: live };
  };

  it('every mounted component holds exactly one subscription, and unmounting releases all of them', async () => {
    const r = await run(false, 100);
    expect(r).toEqual({ afterMount: 100, afterUnmount: 0 });
  });

  it('the same under Strict Mode (its extra subscribe/unsubscribe pair does not leak)', async () => {
    const r = await run(true, 100);
    expect(r).toEqual({ afterMount: 100, afterUnmount: 0 });
  });

  it('1,000 mount and unmount cycles leave zero subscriptions behind', async () => {
    const before = made;
    for (let i = 0; i < 200; i++) await run(i % 2 === 0, 5);
    expect(live).toBe(0);
    expect(made).toBeGreaterThan(before + 900);
  });

  it('after unmounting, store changes do not render the unmounted component', async () => {
    const store = lib.createStore({ n: 0 });
    let renders = 0;
    const C = () => {
      renders++;
      return React.createElement('i', null, String(store.useGlobalState('n')[0]));
    };
    const el = document.createElement('div');
    const root = ReactDOM.createRoot(el);
    await act(async () => root.render(React.createElement(C)));
    await act(async () => root.unmount());
    const seen = renders;
    for (let i = 1; i <= 50; i++) await store.setState('n', i);
    expect(renders).toBe(seen);
  });
});

describe('memory', () => {
  it('a store nobody references is collected, including its subscribers, history and query cache', async () => {
    const refs: WeakRef<object>[] = [];
    for (let i = 0; i < 100; i++) {
      const s = createStore(
        { n: 0, q: query(async () => i, { initial: 0 }) },
        { history: true, computed: [{ double: (get) => get('n') * 2 }] },
      );
      s.subscribe(() => {});
      await s.setState('n', i);
      await s.fetchQuery('q');
      refs.push(new WeakRef(s));
    }
    await collect();
    const alive = refs.filter((r) => r.deref()).length;
    expect(alive).toBeLessThanOrEqual(2); // allow the most recent ones a stack or a closure may still hold
  });

  it('1,000 mount and unmount cycles do not grow the heap', async () => {
    const store = createStore({ n: 0 });
    const C = () => h('i', null, String(store.useGlobalState('n')[0]));
    const cycle = async () => {
      const m = await mount(h(C));
      await store.setState('n', Math.random());
      await m.unmount();
    };
    for (let i = 0; i < 200; i++) await cycle(); // warm up
    await collect();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 1000; i++) await cycle();
    await collect();
    const growthMB = (process.memoryUsage().heapUsed - before) / 1024 / 1024;
    expect(growthMB).toBeLessThan(8);
  });

  it('destroy() removes the window listeners it added', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const store = createStore({ n: 0 }, { name: 'destroy-test', persist: 'local' });
    const added = add.mock.calls.filter(([type]) => type === 'pagehide').length;
    store.destroy();
    const removed = remove.mock.calls.filter(([type]) => type === 'pagehide').length;
    expect(added).toBeGreaterThan(0);
    expect(removed).toBe(added);
  });
});

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? h('p', { id: 'fallback' }, this.state.error.message) : this.props.children;
  }
}

describe('error boundaries', () => {
  it('a selector that throws is caught by the nearest boundary, and the store is untouched', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = createStore({ user: { name: 'ada' } as { name: string } | null });
    const Name = () =>
      h(
        'i',
        null,
        store.useGlobalState('user', (u) => u!.name),
      );
    const { el, unmount } = await mount(h(Boundary, null, h(Name)));
    expect(el.textContent).toBe('ada');
    await act(async () => void store.setState('user', null)); // the selector now throws
    expect(el.querySelector('#fallback')).not.toBeNull();
    expect(store.getState('user')).toBeNull(); // the data is what was written, not lost
    await unmount();
  });

  it('after the failure the store still works for other components', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = createStore({ user: { name: 'ada' } as { name: string } | null, count: 0 });
    const Bad = () =>
      h(
        'i',
        null,
        store.useGlobalState('user', (u) => u!.name),
      );
    const Good = () => h('b', null, String(store.useGlobalState('count')[0]));
    const { el, unmount } = await mount(h('div', null, h(Boundary, null, h(Bad)), h(Good)));
    await act(async () => void store.setState('user', null));
    await act(async () => void store.setState('count', 7));
    expect(el.querySelector('#fallback')).not.toBeNull();
    expect(el.querySelector('b')!.textContent).toBe('7'); // the sibling outside the boundary is fine
    await unmount();
  });

  it('an updater that throws reaches the caller and leaves the state unchanged', async () => {
    const store = createStore({ n: 1 });
    const boom = () => {
      throw new Error('updater failed');
    };
    await expect(Promise.resolve().then(() => store.setState('n', boom))).rejects.toThrow('updater failed');
    expect(store.getState('n')).toBe(1);
    await store.setState('n', 2);
    expect(store.getState('n')).toBe(2);
  });

  it('a subscriber that throws does not stop the others or break the store', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = createStore({ n: 0 });
    const seen: number[] = [];
    store.subscribe(() => {
      throw new Error('bad listener');
    });
    store.subscribe(() => seen.push(store.getState('n')));
    await store.setState('n', 1);
    await store.setState('n', 2);
    expect(seen).toEqual([1, 2]);
  });

  it('a failing request shows as an error status, not a crash, and a later success recovers', async () => {
    let fail = true;
    const store = createStore({
      data: query(
        async () => {
          if (fail) throw new Error('server down');
          return 'ok';
        },
        { retry: 0 },
      ),
    });
    const View = () => {
      const [data, , status] = store.useGlobalState('data');
      return h('i', null, `${status.state}:${data ?? '-'}`);
    };
    const { el, unmount } = await mount(h(Boundary, null, h(View)));
    await act(async () => void (await sleep(20)));
    expect(el.querySelector('#fallback')).toBeNull(); // not thrown into the boundary
    expect(el.textContent).toBe('error:-');
    fail = false;
    await act(async () => void (await store.fetchQuery('data')));
    expect(el.textContent).toBe('ready:ok');
    await unmount();
  });

  it('a boundary that remounts its child gets a working component again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const store = createStore({ user: { name: 'ada' } as { name: string } | null });
    const Name = () =>
      h(
        'i',
        null,
        store.useGlobalState('user', (u) => u!.name),
      );
    class Resettable extends Boundary {
      reset = () => this.setState({ error: null });
      render() {
        return this.state.error ? h('button', { onClick: this.reset }, 'retry') : this.props.children;
      }
    }
    const { el, unmount } = await mount(h(Resettable, null, h(Name)));
    await act(async () => void store.setState('user', null));
    expect(el.querySelector('button')).not.toBeNull();
    await act(async () => void store.setState('user', { name: 'grace' }));
    await act(async () => el.querySelector('button')!.click());
    expect(el.textContent).toBe('grace');
    await unmount();
  });
});

describe('browsers that lack or restrict APIs', () => {
  it('no BroadcastChannel (old browsers): syncTabs does nothing, nothing throws', async () => {
    const original = (window as any).BroadcastChannel;
    delete (window as any).BroadcastChannel;
    try {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const store = createStore({ n: 0 }, { name: 'no-bc', syncTabs: true });
      await store.setState('n', 1);
      expect(store.getState('n')).toBe(1);
    } finally {
      (window as any).BroadcastChannel = original;
    }
  });

  it('storage that refuses writes (private mode, quota exceeded): the app keeps working in memory', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    const store = createStore({ n: 0 }, { name: 'quota', persist: 'local' });
    await store.hydrated;
    await store.setState('n', 5);
    store.destroy(); // flushes the save, which fails
    expect(store.getState('n')).toBe(5);
  });

  it('storage that refuses reads (blocked cookies, some embedded browsers): starts from the initial state', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Access is denied.', 'SecurityError');
    });
    const store = createStore({ n: 3 }, { name: 'blocked', persist: 'local' });
    await store.hydrated;
    expect(store.getState('n')).toBe(3);
  });

  it('corrupt saved data does not crash the app', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    localStorage.setItem('corrupt', '{this is not json');
    const store = createStore({ n: 3 }, { name: 'corrupt', persist: 'local' });
    await store.hydrated;
    expect(store.getState('n')).toBe(3);
  });
});
