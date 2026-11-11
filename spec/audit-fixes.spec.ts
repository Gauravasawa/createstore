// Bugs found by reading the source and probing it. Each test failed before its fix.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createStore, query } from '@createstore/createstore';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('persist: a value JSON cannot hold must not break the store', () => {
  it('a circular object in a persisted key: no throw, subscribers and computed values still update', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createStore(
      { x: {} as unknown, n: 1 },
      { name: 'unsavable', persist: true, computed: [{ tenfold: (get) => get('n') * 10 }] },
    );
    const heard: string[] = [];
    store.subscribe((e) => heard.push(e.key));

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(store.setState('x', circular)).resolves.toBeUndefined();
    expect(store.getState('x')).toBe(circular);
    expect(heard).toEqual(['x']); // before the fix: nobody was told
    expect(warn.mock.calls.flat().join(' ')).toMatch(/couldn't save "x": .*circular/);

    await store.setState('n', 2); // before the fix this threw too, and left the computed value stale
    expect(store.getState('n')).toBe(2);
    expect(store.getState('tenfold')).toBe(20);
    expect(heard).toEqual(['x', 'n']);
  });

  it('a BigInt in a persisted key is reported once, and saving resumes when the value is fixed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createStore({ big: 0 as unknown, n: 1 }, { name: 'bigint', persist: true });
    await store.setState('big', BigInt(5));
    await store.setState('n', 2);
    expect(warn.mock.calls.filter(([m]) => String(m).includes("couldn't save"))).toHaveLength(1);
    await store.setState('big', 5);
    expect(JSON.parse(localStorage.getItem('bigint:state')!).state).toEqual({ big: 5, n: 2 });
  });
});

describe('async persist: what the user changes before the saved state arrives is not lost', () => {
  it('an early change wins over older saved data, other keys load, and the result is saved', async () => {
    const memory = new Map<string, string>([
      ['early:state', JSON.stringify({ $version: 0, state: { theme: 'light', size: 5 } })],
    ]);
    const storage = {
      getItem: async (key: string) => (await sleep(30), memory.get(key) ?? null),
      setItem: async (key: string, value: string) => (await sleep(2), void memory.set(key, value)),
      removeItem: async (key: string) => void memory.delete(key),
    };
    const store = createStore({ theme: 'system', size: 0 }, { name: 'early', persist: { storage } });
    await store.setState('theme', 'dark'); // before the saved state has loaded
    await store.hydrated;
    await sleep(20);
    expect(store.getState('theme')).toBe('dark'); // before the fix: 'light', and the choice was gone
    expect(store.getState('size')).toBe(5); // saved data for keys the user did not touch still loads
    expect(JSON.parse(memory.get('early:state')!).state).toEqual({ theme: 'dark', size: 5 });
  });

  it('with no early change, saved data loads as before', async () => {
    const memory = new Map<string, string>([
      ['plain:state', JSON.stringify({ $version: 0, state: { theme: 'light' } })],
    ]);
    const storage = {
      getItem: async (key: string) => (await sleep(5), memory.get(key) ?? null),
      setItem: async (key: string, value: string) => void memory.set(key, value),
      removeItem: async (key: string) => void memory.delete(key),
    };
    const store = createStore({ theme: 'system' }, { name: 'plain', persist: { storage } });
    await store.hydrated;
    expect(store.getState('theme')).toBe('light');
  });
});

describe('named queries: a local edit while a request is in flight', () => {
  it('is not overwritten by the older response: the entry reloads instead (as inline queries already did)', async () => {
    let calls = 0;
    const store = createStore({
      user: query(
        async (id: number) => {
          const call = ++calls;
          await sleep(call === 1 ? 40 : 5);
          return { id, name: call === 1 ? 'old, from before the edit' : 'fresh' };
        },
        { initial: undefined as unknown as { id: number; name: string } },
      ),
    });
    const first = store.fetchQuery('user', 1);
    await sleep(10);
    store.setQueryData('user', { id: 1, name: 'local edit' }, 1);
    await first;
    await sleep(40);
    const now = await store.fetchQuery('user', 1);
    expect(calls).toBe(2); // the stale response was dropped and the entry loaded again
    expect(now.name).toBe('fresh');
    expect(now.name).not.toBe('old, from before the edit'); // before the fix this was shown, with no reload
  });

  it('with no request in flight, a local edit stays', async () => {
    const store = createStore({
      user: query(async (id: number) => ({ id, name: 'server' }), {
        initial: undefined as unknown as { id: number; name: string },
      }),
    });
    await store.fetchQuery('user', 1);
    store.setQueryData('user', { id: 1, name: 'edited' }, 1);
    expect((await store.fetchQuery('user', 1)).name).toBe('edited'); // fresh: no reload
  });
});
