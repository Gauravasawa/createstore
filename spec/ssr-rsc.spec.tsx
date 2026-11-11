// @vitest-environment node
// Next.js Server Components. These tests load the built package with React's per-request `cache()` and
// without hooks, the way React's server build behaves. The cache is a stand-in made with AsyncLocalStorage:
// one Map per request, and no caching at all outside a request (what React does outside a render).
// It checks this package's logic against that behaviour. It does not run a real Next.js server.
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage<Map<unknown, unknown>>();
const fakeCache = (fn: () => unknown) => () => {
  const requestCache = als.getStore();
  if (!requestCache) return fn();
  if (!requestCache.has(fn)) requestCache.set(fn, fn());
  return requestCache.get(fn);
};
const request = <T,>(fn: () => T | Promise<T>) => als.run(new Map(), fn);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let createStore: typeof import('@createstore/createstore').createStore;

beforeAll(async () => {
  vi.resetModules();
  vi.doMock('react', async () => {
    const actual = await vi.importActual<Record<string, unknown>>('react');
    const server = { ...actual, useState: undefined, cache: fakeCache }; // no hooks, plus cache(): a Server Component
    return { ...server, default: server };
  });
  // The built file: the same code that ships
  ({ createStore } = (await import('../dist/esm/createStore.js')) as never);
});

describe('Server Components: one store per request', () => {
  const makeStore = () => createStore({ user: 'anonymous', cart: [] as string[] }, { name: 'rsc-shop', ssr: true });

  it('is really running as a Server Component (hooks refuse)', () => {
    const AppStore = makeStore();
    expect(() => AppStore.useGlobalState('user')).toThrow(/only works in Client Components/);
  });

  it('1 and 2: concurrent requests never see each other', async () => {
    const AppStore = makeStore();
    const users = Array.from({ length: 100 }, (_, i) => `user${i}`);
    const results = await Promise.all(
      users.map((user) =>
        request(async () => {
          AppStore.setState('user', user);
          await sleep(Math.random() * 10); // other requests run here
          AppStore.setState('cart', [...AppStore.getState('cart'), `item-of-${user}`]);
          await sleep(Math.random() * 10);
          return { user: AppStore.getState('user'), cart: AppStore.getState('cart') };
        }),
      ),
    );
    results.forEach((r, i) => expect(r).toEqual({ user: users[i], cart: [`item-of-${users[i]}`] }));
  });

  it('a new request starts from the initial state, not from the previous request', async () => {
    const AppStore = makeStore();
    await request(() => AppStore.setState('user', 'ada'));
    expect(await request(() => AppStore.getState('user'))).toBe('anonymous');
  });

  it('outside a request (a Server Action, a Route Handler) it refuses instead of sharing a store', () => {
    const AppStore = makeStore();
    expect(() => AppStore.setState('user', 'mallory')).toThrow(/outside a Server Component render/);
    expect(() => AppStore.getState('user')).toThrow(/outside a Server Component render/);
  });

  it('there, createScope() gives an isolated store', async () => {
    const AppStore = makeStore();
    const a = AppStore.createScope({ user: 'ada' });
    const b = AppStore.createScope({ user: 'grace' });
    await Promise.all([a.setState('cart', ['a']), b.setState('cart', ['b'])]);
    expect(a.getState('cart')).toEqual(['a']);
    expect(b.getState('cart')).toEqual(['b']);
  });

  it("<Root> sends this request only: its snapshot carries this request's data", async () => {
    const AppStore = makeStore();
    const [a, b] = await Promise.all([
      request(async () => {
        AppStore.setState('user', 'ada');
        await sleep(5);
        return AppStore.Root({}) as { props: { name: string; snapshot: { user: string } } };
      }),
      request(async () => {
        AppStore.setState('user', 'grace');
        await sleep(1);
        return AppStore.Root({}) as { props: { name: string; snapshot: { user: string } } };
      }),
    ]);
    expect(a.props.name).toBe('rsc-shop');
    expect(a.props.snapshot.user).toBe('ada');
    expect(b.props.snapshot.user).toBe('grace');
  });

  it('<Root> needs a store name, so the browser can find the data', () => {
    const unnamed = createStore({ n: 0 }, { ssr: true });
    expect(() => request(() => unnamed.Root({}))).toThrow(/needs the store's name/);
  });

  it('hydrate() is refused in a Server Component', () => {
    expect(() => makeStore().hydrate()).toThrow(/for the browser/);
  });
});
