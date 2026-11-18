// persist without syncTabs, with several tabs; what the developer hears when saving fails or saved data is unreadable;
// and the page-hide flush and rescue-copy rules. "Tabs" are stores with the same name sharing this page's localStorage.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '@createstore/createstore';

const uid = () => Math.random().toString(36).slice(2, 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const saved = (name: string) =>
  JSON.parse(localStorage.getItem(`${name}:state`)!) as { $version: number; state: Record<string, unknown> };
const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('persist with several tabs and no syncTabs: no lost updates', () => {
  it('two tabs change different keys: both changes are saved and a new tab loads both', () => {
    quiet();
    const name = `tabs-${uid()}`;
    const A = createStore({ x: 0, y: 0 }, { name, persist: true });
    const B = createStore({ x: 0, y: 0 }, { name, persist: true });
    A.setState('x', 1);
    B.setState('y', 2);
    expect(saved(name).state).toEqual({ x: 1, y: 2 });
    const C = createStore({ x: 0, y: 0 }, { name, persist: true });
    expect([C.getState('x'), C.getState('y')]).toEqual([1, 2]);
  });

  it('a tab never writes back its stale copy of a key it did not change, also on later saves', () => {
    quiet();
    const name = `tabs-${uid()}`;
    const A = createStore({ x: 0, y: 0 }, { name, persist: true });
    const B = createStore({ x: 0, y: 0 }, { name, persist: true }); // B's memory keeps x = 0
    A.setState('x', 1);
    B.setState('y', 2);
    B.setState('y', 3); // second save from B: still must not bring x back to 0
    B.setState('y', 4);
    expect(saved(name).state).toEqual({ x: 1, y: 4 });
  });

  it('the same key changed in two tabs: the last save wins', () => {
    quiet();
    const name = `tabs-${uid()}`;
    const A = createStore({ x: 0 }, { name, persist: true });
    const B = createStore({ x: 0 }, { name, persist: true });
    A.setState('x', 1);
    B.setState('x', 2);
    expect(saved(name).state.x).toBe(2);
    A.setState('x', 3);
    expect(saved(name).state.x).toBe(3);
  });

  it('with persist.debounce, another tab saving in between is kept too', async () => {
    quiet();
    const name = `tabs-${uid()}`;
    const A = createStore({ x: 0, y: 0 }, { name, persist: { debounce: 30 } });
    const B = createStore({ x: 0, y: 0 }, { name, persist: true });
    A.setState('x', 1); // pending in A
    B.setState('y', 2); // saved now by B
    await sleep(60); // A's debounced save runs
    expect(saved(name).state).toEqual({ x: 1, y: 2 });
  });

  it('one tab alone writes exactly the same text as before (no change in a single tab)', () => {
    const name = `one-${uid()}`;
    const s = createStore({ a: 1, list: [1, 2], nested: { k: 'v' } }, { name, persist: true });
    s.setState('a', 2);
    expect(localStorage.getItem(`${name}:state`)).toBe(
      JSON.stringify({ $version: 0, state: { a: 2, list: [1, 2], nested: { k: 'v' } } }),
    );
    s.setState('list', [3]);
    expect(localStorage.getItem(`${name}:state`)).toBe(
      JSON.stringify({ $version: 0, state: { a: 2, list: [3], nested: { k: 'v' } } }),
    );
  });

  it('a blob saved by another tab with a different persist.version is not merged (as before, this tab writes its own)', () => {
    quiet();
    const name = `ver-${uid()}`;
    const A = createStore({ x: 0, y: 0 }, { name, persist: { version: 1 } });
    localStorage.setItem(`${name}:state`, JSON.stringify({ $version: 2, state: { x: 9, y: 9 } }));
    A.setState('x', 1);
    expect(saved(name)).toEqual({ $version: 1, state: { x: 1, y: 0 } });
  });

  it('async storage keeps its behaviour: no extra reads on save (the whole state is written)', async () => {
    let reads = 0;
    const writes: string[] = [];
    const adapter = {
      getItem: async () => {
        reads++;
        return null;
      },
      setItem: async (_k: string, v: string) => {
        writes.push(v);
      },
      removeItem: async () => {},
    };
    const s = createStore({ x: 0, y: 0 }, { name: `async-${uid()}`, persist: { storage: adapter } });
    await s.hydrated;
    s.setState('x', 1);
    s.setState('y', 2);
    await sleep(10);
    expect(reads).toBe(1); // only the initial load
    expect(JSON.parse(writes.at(-1)!).state).toEqual({ x: 1, y: 2 });
  });

  it('seeded random edits in 3 tabs on 4 keys: the saved state always equals the last value written to each key', () => {
    quiet();
    const rng = (a: number) => () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const R = rng(4242);
    for (let run = 0; run < 25; run++) {
      const name = `rand-${run}-${uid()}`;
      const init = { a: 0, b: 0, c: 0, d: 0 };
      const tabs = [0, 1, 2].map(() => createStore({ ...init }, { name, persist: true }));
      const expected: Record<string, number> = { ...init };
      for (let op = 0; op < 30; op++) {
        const tab = tabs[Math.floor(R() * 3)];
        const key = (['a', 'b', 'c', 'd'] as const)[Math.floor(R() * 4)];
        const value = run * 1000 + op + 1;
        tab.setState(key, value);
        expected[key] = value;
        expect(saved(name).state, `run ${run}, after op ${op}`).toEqual(expected);
      }
      const fresh = createStore({ ...init }, { name, persist: true });
      expect({
        a: fresh.getState('a'),
        b: fresh.getState('b'),
        c: fresh.getState('c'),
        d: fresh.getState('d'),
      }).toEqual(expected);
    }
  });

  it('with syncTabs as well, tabs still converge (unchanged)', async () => {
    quiet();
    const name = `sync-${uid()}`;
    const A = createStore({ x: 0, y: 0 }, { name, persist: true, syncTabs: true });
    const B = createStore({ x: 0, y: 0 }, { name, persist: true, syncTabs: true });
    A.setState('x', 1);
    B.setState('y', 2);
    await sleep(80);
    expect([A.getState('y'), B.getState('x')]).toEqual([2, 1]);
    expect(saved(name).state).toEqual({ x: 1, y: 2 });
    A.destroy();
    B.destroy();
  });
});

describe('when saving fails, the developer is told once', () => {
  it('a storage whose setItem throws (quota full): one warning, the store keeps working', () => {
    const warn = quiet();
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
      },
      removeItem: () => {},
    };
    const s = createStore({ n: 0 }, { name: `full-${uid()}`, persist: { storage: full } });
    s.setState('n', 1);
    s.setState('n', 2);
    expect(s.getState('n')).toBe(2);
    const msgs = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("couldn't save the state"));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatch(/quota has been exceeded.*keeps working in memory/);
  });

  it('an async storage whose write rejects: one warning', async () => {
    const warn = quiet();
    const failing = {
      getItem: async () => null,
      setItem: async () => {
        throw new Error('disk error');
      },
      removeItem: async () => {},
    };
    const s = createStore({ n: 0 }, { name: `asyncfail-${uid()}`, persist: { storage: failing } });
    await s.hydrated;
    s.setState('n', 1);
    s.setState('n', 2);
    await sleep(10);
    expect(
      warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("couldn't save the state: disk error")),
    ).toHaveLength(1);
  });

  it('storage that is not available at all (blocked): one warning at creation', () => {
    const warn = quiet();
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('access denied');
      },
    });
    try {
      const s = createStore({ n: 0 }, { name: `blocked-${uid()}`, persist: true });
      s.setState('n', 1);
      expect(s.getState('n')).toBe(1);
    } finally {
      Object.defineProperty(window, 'localStorage', original);
    }
    expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("storage isn't available"))).toHaveLength(
      1,
    );
  });

  it('a failing write of the offline copy of server data: one warning', async () => {
    const warn = quiet();
    const { query } = await import('@createstore/createstore');
    const s = createStore({ q: query(async (id: number) => ({ id })) } as never, {
      name: `offfail-${uid()}`,
      offline: true,
    }) as any;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    await s.fetchQuery('q', 1);
    await s.fetchQuery('q', 2);
    expect(
      warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("couldn't save the offline copy")),
    ).toHaveLength(1);
  });

  it('a normal save produces no warning', () => {
    const warn = quiet();
    // validate is set so the development-only "nothing checks the type" warning stays out of this test
    const s = createStore({ n: 0 }, { name: `ok-${uid()}`, persist: true, validate: () => true });
    s.setState('n', 1);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('unreadable saved state is reported, not dropped silently', () => {
  it('truncated JSON: one warning, initial values are used, and the next save replaces it with valid JSON', () => {
    const warn = quiet();
    const name = `corrupt-${uid()}`;
    localStorage.setItem(`${name}:state`, '{"$version":0,"state":{"n":42');
    const s = createStore({ n: 0 }, { name, persist: true });
    expect(s.getState('n')).toBe(0);
    expect(
      warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("saved state couldn't be read")),
    ).toHaveLength(1);
    s.setState('n', 1);
    expect(saved(name)).toEqual({ $version: 0, state: { n: 1 } });
  });

  it('valid JSON that is not an object: reported the same way', () => {
    const warn = quiet();
    const name = `notobj-${uid()}`;
    localStorage.setItem(`${name}:state`, '42');
    createStore({ n: 0 }, { name, persist: true });
    expect(warn.mock.calls.map((c) => String(c[0])).join(' ')).toMatch(/couldn't be read \(it is not an object\)/);
  });

  it('readable saved state loads without a warning', () => {
    const warn = quiet();
    const name = `fine-${uid()}`;
    localStorage.setItem(`${name}:state`, JSON.stringify({ $version: 0, state: { n: 5 } }));
    const s = createStore({ n: 0 }, { name, persist: true, validate: () => true }); // validate: see above
    expect(s.getState('n')).toBe(5);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('page hide and the rescue copy (behaviour that existed but was untested)', () => {
  it('a debounced save is written as soon as the page is hidden', () => {
    const name = `hide-${uid()}`;
    const s = createStore({ n: 0 }, { name, persist: { debounce: 60_000 } });
    s.setState('n', 7);
    expect(localStorage.getItem(`${name}:state`)).toBeNull(); // still waiting for the debounce
    window.dispatchEvent(new Event('pagehide'));
    expect(saved(name).state.n).toBe(7);
  });

  it('async storage: a NEWER rescue copy in localStorage wins and is removed', async () => {
    const name = `rescue-${uid()}`;
    const stored = JSON.stringify({ $version: 0, $saved: 1000, state: { n: 1 } });
    localStorage.setItem(`${name}:state:rescue`, JSON.stringify({ $version: 0, $saved: 2000, state: { n: 2 } }));
    const adapter = { getItem: async () => stored, setItem: async () => {}, removeItem: async () => {} };
    const s = createStore({ n: 0 }, { name, persist: { storage: adapter } });
    await s.hydrated;
    expect(s.getState('n')).toBe(2);
    expect(localStorage.getItem(`${name}:state:rescue`)).toBeNull();
  });

  it('async storage: an OLDER rescue copy loses to what the storage committed', async () => {
    const name = `rescue-${uid()}`;
    const stored = JSON.stringify({ $version: 0, $saved: 2000, state: { n: 1 } });
    localStorage.setItem(`${name}:state:rescue`, JSON.stringify({ $version: 0, $saved: 500, state: { n: 2 } }));
    const adapter = { getItem: async () => stored, setItem: async () => {}, removeItem: async () => {} };
    const s = createStore({ n: 0 }, { name, persist: { storage: adapter } });
    await s.hydrated;
    expect(s.getState('n')).toBe(1);
  });
});
