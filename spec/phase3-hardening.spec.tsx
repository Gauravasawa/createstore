// Phase 3 of the audit roadmap: library hardening (F-301 to F-306, F-701) and performance (F-601, F-602, F-604).
// Each block tests the change, its edges, and what must stay exactly as it was.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore, query } from '@createstore/createstore';
import { __mergeSnapshot } from '../dist/esm/createStore.js';

const uid = () => Math.random().toString(36).slice(2, 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise<void>((r) => queueMicrotask(r));
type Loose = Record<string, any>;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  localStorage.clear();
  sessionStorage.clear();
  document.body.innerHTML = '';
});
const quietConsole = () => ({
  warn: vi.spyOn(console, 'warn').mockImplementation(() => {}),
  error: vi.spyOn(console, 'error').mockImplementation(() => {}),
});
// Collects onError calls
const collector = () => {
  const calls: { error: Error; info: Loose }[] = [];
  return { calls, onError: (error: Error, info: Loose) => void calls.push({ error, info }) };
};

/* ---------- F-301: reads use the store's own keys only ---------- */
describe('F-301: names inherited from Object.prototype read as undefined', () => {
  const NAMES = [
    '__proto__',
    'constructor',
    'toString',
    'hasOwnProperty',
    'valueOf',
    'isPrototypeOf',
    '__defineGetter__',
  ];

  it('getState reads them as undefined, like any unknown name', () => {
    const s = createStore({ a: 1 }, { name: `p-${uid()}` }) as Loose;
    for (const k of NAMES) expect(s.getState(k), k).toBeUndefined();
    expect(s.getState('nope')).toBeUndefined(); // unchanged: an unknown name
  });

  it('a computed value reading one of them fails the same way as reading any unknown name (unchanged)', () => {
    for (const k of [...NAMES, 'nope']) {
      const s = createStore({ a: 1 }, { name: `p-${uid()}`, computed: [{ probe: (get: any) => get(k) }] }) as Loose;
      expect(() => s.getState('probe'), k).toThrow(`computed "probe" reads "${k}", which is not in the store.`);
    }
  });

  it('real keys still read, including state keys that share a name with an Object.prototype member', () => {
    quietConsole(); // "toString is also the name of a store method" warns, as before
    const s = createStore({ a: 1, toString: 'mine', constructor: 7 } as never, { name: `p-${uid()}` }) as Loose;
    expect(s.getState('a')).toBe(1);
    expect(s.getState('toString')).toBe('mine');
    expect(s.getState('constructor')).toBe(7);
    expect(s.getState().a).toBe(1);
  });

  it('computed keys and query keys still read through the same path', async () => {
    const s = createStore(
      { n: 2, q: query(async () => 'loaded', { initial: 'none' }) },
      { name: `p-${uid()}`, computed: [{ double: (get: any) => get('n') * 2 }] },
    ) as Loose;
    expect(s.getState('double')).toBe(4);
    expect(s.getState('q')).toBe('none');
    await s.fetchQuery('q');
    expect(s.getState('q')).toBe('loaded');
  });

  it('mutating what getState returned for "__proto__" can no longer pollute Object.prototype', () => {
    const s = createStore({ a: 1 }, { name: `p-${uid()}` }) as Loose;
    const got = s.getState('__proto__');
    expect(got).toBeUndefined();
    expect(({} as Loose).polluted).toBeUndefined();
  });
});

/* ---------- F-302: the query-key limits cover buffers and key names ---------- */
describe('F-302: query params limits apply to buffers, typed arrays and object key names', () => {
  const store = () =>
    createStore({ q: query(async (_p: unknown) => 'ok', { initial: '' }) }, { name: `k-${uid()}` }) as Loose;
  const tooLarge = /Query params are too large \(more than 10,000 values\)/;
  const tooLong = /Query params are too large \(more than 1,000,000 characters\)/;

  it('an ArrayBuffer: 9,999 bytes is fine, 10,000 is too many (the buffer itself counts as one value)', async () => {
    const s = store();
    await expect(s.fetchQuery('q', new ArrayBuffer(9_999))).resolves.toBe('ok');
    await expect(Promise.resolve().then(() => s.fetchQuery('q', new ArrayBuffer(10_000)))).rejects.toThrow(tooLarge);
  });

  it('typed arrays and DataView count bytes, not elements', async () => {
    const s = store();
    await expect(s.fetchQuery('q', new Uint8Array(9_999))).resolves.toBe('ok');
    for (const big of [
      new Uint8Array(10_000),
      new Float64Array(1_250),
      new Int32Array(2_500),
      new DataView(new ArrayBuffer(10_000)),
    ])
      await expect(Promise.resolve().then(() => s.fetchQuery('q', big))).rejects.toThrow(tooLarge);
    // a small view over a big buffer counts only its own bytes
    await expect(s.fetchQuery('q', new Uint8Array(new ArrayBuffer(1_000_000), 10, 100))).resolves.toBe('ok');
  });

  it('a plain ArrayBuffer nested inside params counts with the rest', async () => {
    const s = store();
    const params = { list: Array.from({ length: 5_000 }, (_, i) => i), bytes: new ArrayBuffer(6_000) };
    await expect(Promise.resolve().then(() => s.fetchQuery('q', params))).rejects.toThrow(tooLarge);
    // two buffers that each fit but together don't
    await expect(
      Promise.resolve().then(() => s.fetchQuery('q', [new ArrayBuffer(6_000), new ArrayBuffer(6_000)])),
    ).rejects.toThrow(tooLarge);
  });

  it('a buffer nested inside params counts with the rest', async () => {
    const s = store();
    const params = { list: Array.from({ length: 5_000 }, (_, i) => i), bytes: new Uint8Array(6_000) };
    await expect(Promise.resolve().then(() => s.fetchQuery('q', params))).rejects.toThrow(tooLarge);
  });

  it('object key names count toward the character limit: one huge key, and many keys that add up', async () => {
    const s = store();
    await expect(Promise.resolve().then(() => s.fetchQuery('q', { ['k'.repeat(1_000_001)]: 1 }))).rejects.toThrow(
      tooLong,
    );
    const many = Object.fromEntries(Array.from({ length: 1_001 }, (_, i) => [`${i}`.padStart(1_000, 'x'), 1]));
    await expect(Promise.resolve().then(() => s.fetchQuery('q', many))).rejects.toThrow(tooLong);
    // keys and string values together
    const mixed = { ['a'.repeat(600_000)]: 'b'.repeat(400_001) };
    await expect(Promise.resolve().then(() => s.fetchQuery('q', mixed))).rejects.toThrow(tooLong);
  });

  it('ordinary params are unaffected: the same params give the same cache entry, different ones a different entry', async () => {
    let calls = 0;
    const s = createStore(
      { q: query(async (p: unknown) => (calls++, JSON.stringify(p)), { initial: '', staleTime: 60_000 }) },
      { name: `k-${uid()}` },
    ) as Loose;
    await s.fetchQuery('q', { b: 2, a: 1, bytes: new Uint8Array([1, 2]) });
    await s.fetchQuery('q', { a: 1, b: 2, bytes: new Uint8Array([1, 2]) }); // same key: no new call
    expect(calls).toBe(1);
    await s.fetchQuery('q', { a: 1, b: 2, bytes: new Uint8Array([1, 3]) });
    expect(calls).toBe(2);
    await s.fetchQuery('q', { ['k'.repeat(999_000)]: 1 }); // long, but under the limit
    expect(calls).toBe(3);
  });
});

/* ---------- F-303: persist: { rescue: false } ---------- */
describe('F-303: the rescue copy of async storage can be turned off', () => {
  // An async adapter whose writes never finish: the page is "closed" while one is in flight
  const hangingStorage = () => ({
    getItem: async () => null,
    setItem: () => new Promise<void>(() => {}),
    removeItem: async () => {},
  });
  const closeThePage = () => window.dispatchEvent(new Event('pagehide'));

  it('default: a write still in flight at page close is copied to localStorage', async () => {
    const name = `r-${uid()}`;
    const s = createStore({ token: '' }, { name, persist: { storage: hangingStorage() } }) as Loose;
    await s.hydrated;
    s.setState('token', 'secret');
    closeThePage();
    expect(localStorage.getItem(`${name}:state:rescue`)).toContain('secret');
    s.destroy();
  });

  it('rescue: false: nothing is written to localStorage, on page hide, on visibility change or on destroy', async () => {
    const name = `r-${uid()}`;
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const s = createStore({ token: '' }, { name, persist: { storage: hangingStorage(), rescue: false } }) as Loose;
    await s.hydrated;
    s.setState('token', 'secret');
    closeThePage();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    s.destroy();
    delete (document as Loose).visibilityState;
    expect(localStorage.getItem(`${name}:state:rescue`)).toBeNull();
    expect(setItem.mock.calls.filter(([k]) => String(k).includes(name))).toEqual([]);
  });

  it('rescue: true is the same as leaving it out; rescue has no effect with synchronous storage', async () => {
    const a = `r-${uid()}`;
    const s = createStore({ token: '' }, { name: a, persist: { storage: hangingStorage(), rescue: true } }) as Loose;
    await s.hydrated;
    s.setState('token', 'x');
    closeThePage();
    expect(localStorage.getItem(`${a}:state:rescue`)).toContain('"x"');
    s.destroy();
    const b = `r-${uid()}`;
    const sync = createStore({ token: '' }, { name: b, persist: { rescue: false } }) as Loose;
    sync.setState('token', 'y');
    expect(localStorage.getItem(`${b}:state`)).toContain('"y"'); // localStorage itself still saves
    sync.destroy();
  });

  it('a rescue copy left by an earlier visit is still read and removed with rescue: false (no copy stays behind)', async () => {
    const name = `r-${uid()}`;
    localStorage.setItem(
      `${name}:state:rescue`,
      JSON.stringify({ $version: 0, $saved: Date.now(), state: { token: 'old' } }),
    );
    const s = createStore(
      { token: '' },
      { name, persist: { storage: { getItem: async () => null, setItem: async () => {} }, rescue: false } },
    ) as Loose;
    await s.hydrated;
    expect(localStorage.getItem(`${name}:state:rescue`)).toBeNull();
    s.destroy();
  });
});

/* ---------- F-304: cross-tab clock ceiling ---------- */
describe('F-304: a cross-tab stamp past half the safe-integer range is ignored', () => {
  const MAX_STAMP = Math.floor(Number.MAX_SAFE_INTEGER / 2);
  const post = async (name: string, stamp: unknown, values: object) => {
    const ch = new BroadcastChannel(`createStore:${name}`);
    ch.postMessage({ type: 'state', stamp, values });
    await sleep(60);
    ch.close();
  };

  it('MAX_SAFE_INTEGER and anything past the ceiling are ignored; the ceiling itself is accepted', async () => {
    const name = `c-${uid()}`;
    const s = createStore({ n: 0 }, { name, syncTabs: true }) as Loose;
    await post(name, [Number.MAX_SAFE_INTEGER, 'evil'], { n: 1 });
    await post(name, [MAX_STAMP + 1, 'evil'], { n: 2 });
    expect(s.getState('n')).toBe(0);
    await post(name, [MAX_STAMP, 'zz'], { n: 3 });
    expect(s.getState('n')).toBe(3);
    s.destroy();
  });

  it('after a hostile stamp, two real tabs still sync both ways', async () => {
    const name = `c-${uid()}`;
    const A = createStore({ n: 0 }, { name, syncTabs: true }) as Loose;
    const B = createStore({ n: 0 }, { name, syncTabs: true }) as Loose;
    await post(name, [Number.MAX_SAFE_INTEGER, 'evil'], { n: 99 });
    A.setState('n', 1);
    await sleep(60);
    expect(B.getState('n')).toBe(1);
    B.setState('n', 2);
    await sleep(60);
    expect(A.getState('n')).toBe(2);
    A.destroy();
    B.destroy();
  });

  it('a stamp at the ceiling is accepted, and the tabs keep syncing past it (their writes are one step ahead)', async () => {
    const name = `c-${uid()}`;
    const A = createStore({ n: 0 }, { name, syncTabs: true }) as Loose;
    const B = createStore({ n: 0 }, { name, syncTabs: true }) as Loose;
    await post(name, [MAX_STAMP, 'zz'], { n: 5 });
    expect([A.getState('n'), B.getState('n')]).toEqual([5, 5]);
    for (let i = 6; i < 16; i++) {
      (i % 2 ? A : B).setState('n', i);
      await sleep(30);
      expect([A.getState('n'), B.getState('n')], `write ${i}`).toEqual([i, i]);
    }
    A.destroy();
    B.destroy();
  });

  it('past the ceiling, a hostile stamp can only be one million ahead of the clock, so the range cannot be used up', async () => {
    const name = `c-${uid()}`;
    const s = createStore({ n: 0 }, { name, syncTabs: true }) as Loose;
    await post(name, [MAX_STAMP, 'a'], { n: 1 }); // clock is now MAX_STAMP
    await post(name, [MAX_STAMP + 1_000_001, 'b'], { n: 2 }); // too far ahead
    expect(s.getState('n')).toBe(1);
    await post(name, [MAX_STAMP + 1_000_000, 'c'], { n: 3 }); // exactly one step: accepted
    expect(s.getState('n')).toBe(3);
    await post(name, [Number.MAX_SAFE_INTEGER, 'd'], { n: 4 }); // still far beyond
    expect(s.getState('n')).toBe(3);
    // using up the rest of the range would take (MAX_SAFE_INTEGER - MAX_STAMP) / 1,000,000 messages
    expect((Number.MAX_SAFE_INTEGER - MAX_STAMP) / 1_000_000).toBeGreaterThan(4e9);
    s.destroy();
  });

  it('known limit: a tab opened after such an attack ignores the attacked tabs until they reload (before: every tab stopped)', async () => {
    const name = `c-${uid()}`;
    const A = createStore({ n: 0 }, { name, syncTabs: true }) as Loose;
    await post(name, [MAX_STAMP, 'evil'], { n: 1 });
    A.setState('n', 2); // stamp MAX_STAMP + 1
    await sleep(30);
    const late = createStore({ n: 0 }, { name, syncTabs: true }) as Loose; // its clock starts at 0
    A.setState('n', 3);
    await sleep(60);
    expect(late.getState('n')).toBe(0);
    late.setState('n', 4); // and the late tab's writes lose to A's far higher stamps for n
    await sleep(60);
    expect(A.getState('n')).toBe(3);
    A.destroy();
    late.destroy();
  });
});

/* ---------- F-306: development warning when outside data isn't validated ---------- */
describe('F-306: a development-only warning when persist, syncTabs or offline run without validate', () => {
  const warningsAbout = (warn: ReturnType<typeof vi.spyOn>) =>
    warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('nothing checks its type'));

  it('warns once per store name, listing the features that load outside data', () => {
    const { warn } = quietConsole();
    const name = `v-${uid()}`;
    createStore({ a: 1 }, { name, persist: true, syncTabs: true, offline: true });
    createStore({ a: 1 }, { name, persist: true, syncTabs: true, offline: true }); // same store again (hot reload)
    const found = warningsAbout(warn);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain(`[${name}] persist, syncTabs, offline load data this store didn't write`);
    expect(found[0]).toContain('Add validate: (key, value, from) => boolean');
    expect(found[0]).toContain('Shown in development only.');
  });

  it('names just the feature used, with singular grammar', () => {
    const { warn } = quietConsole();
    const name = `v-${uid()}`;
    createStore({ a: 1 }, { name, syncTabs: true });
    expect(warningsAbout(warn)[0]).toContain(`[${name}] syncTabs loads data this store didn't write`);
  });

  it('no warning with validate, without those features, or in a production build', () => {
    const { warn } = quietConsole();
    createStore({ a: 1 }, { name: `v-${uid()}`, persist: true, validate: () => true });
    createStore({ a: 1 }, { name: `v-${uid()}`, history: true });
    createStore({ a: 1 }, { name: `v-${uid()}`, persist: false, syncTabs: false, offline: false });
    vi.stubEnv('NODE_ENV', 'production');
    createStore({ a: 1 }, { name: `v-${uid()}`, persist: true });
    expect(warningsAbout(warn)).toEqual([]);
  });

  it('a page with no process object (plain browser ESM, no bundler) counts as production: no warning, no crash', () => {
    const { warn } = quietConsole();
    vi.stubGlobal('process', undefined);
    expect(() => createStore({ a: 1 }, { name: `v-${uid()}`, persist: true })).not.toThrow();
    vi.unstubAllGlobals();
    expect(warningsAbout(warn)).toEqual([]);
  });

  it('on the server (no window) there is no warning: persist and syncTabs do nothing there', async () => {
    const { spawnSync } = await import('node:child_process');
    const code = `import { createStore } from '@createstore/createstore';
      const seen = []; console.warn = (m) => seen.push(String(m));
      createStore({ a: 1 }, { name: 'srv', persist: true, syncTabs: true });
      process.stdout.write(JSON.stringify(seen.filter((m) => m.includes('nothing checks its type'))));`;
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'development' },
    });
    expect(out.stderr).toBe('');
    expect(out.stdout).toBe('[]');
  });
});

/* ---------- F-701: onError ---------- */
describe('F-701: onError receives runtime failures instead of the console', () => {
  const failingStorage = (error = new Error('QuotaExceededError: full')) => ({
    getItem: () => null,
    setItem: () => {
      throw error;
    },
  });

  it('a failed write: one onError call (Error with the console message, original as cause), nothing on the console', () => {
    const c = quietConsole();
    const { calls, onError } = collector();
    const original = new Error('QuotaExceededError: full');
    const name = `e-${uid()}`;
    const s = createStore(
      { n: 0 },
      { name, persist: { storage: failingStorage(original) }, validate: () => true, onError },
    ) as Loose;
    s.setState('n', 1);
    s.setState('n', 2); // reported once, as before
    expect(calls).toHaveLength(1);
    expect(calls[0].error).toBeInstanceOf(Error);
    expect(calls[0].error.message).toBe(
      `[${name}] couldn't save the state: QuotaExceededError: full. The store keeps working in memory, but nothing more is saved until writing works again (is the storage full or blocked?).`,
    );
    expect(calls[0].error.cause).toBe(original);
    expect(calls[0].info).toEqual({ store: name, source: 'storage' });
    expect('key' in calls[0].info).toBe(false);
    expect(c.warn).not.toHaveBeenCalled();
    expect(c.error).not.toHaveBeenCalled();
  });

  it('without onError the console line is exactly the same text, and only the message (no extra argument)', () => {
    const c = quietConsole();
    const name = `e-${uid()}`;
    const s = createStore({ n: 0 }, { name, persist: { storage: failingStorage() }, validate: () => true }) as Loose;
    s.setState('n', 1);
    expect(c.warn).toHaveBeenCalledTimes(1);
    expect(c.warn.mock.calls[0]).toEqual([
      `[${name}] couldn't save the state: QuotaExceededError: full. The store keeps working in memory, but nothing more is saved until writing works again (is the storage full or blocked?).`,
    ]);
  });

  it('storage that is unavailable, unreadable saved state, a version without migrate, a throwing migrate', () => {
    const c = quietConsole();
    const { calls, onError } = collector();
    // unavailable
    vi.stubGlobal('sessionStorage', null);
    const n1 = `e-${uid()}`;
    createStore({ n: 0 }, { name: n1, persist: 'session', validate: () => true, onError });
    vi.unstubAllGlobals();
    // unreadable
    const n2 = `e-${uid()}`;
    localStorage.setItem(`${n2}:state`, '{not json');
    createStore({ n: 0 }, { name: n2, persist: true, validate: () => true, onError });
    // old version, no migrate
    const n3 = `e-${uid()}`;
    localStorage.setItem(`${n3}:state`, JSON.stringify({ $version: 1, state: { n: 5 } }));
    createStore({ n: 0 }, { name: n3, persist: { version: 2 }, validate: () => true, onError });
    // migrate throws
    const n4 = `e-${uid()}`;
    const boom = new Error('bad migrate');
    localStorage.setItem(`${n4}:state`, JSON.stringify({ $version: 1, state: { n: 5 } }));
    createStore(
      { n: 0 },
      {
        name: n4,
        persist: {
          version: 2,
          migrate: () => {
            throw boom;
          },
        },
        validate: () => true,
        onError,
      },
    );

    expect(calls.map((x) => [x.info.store, x.info.source])).toEqual([
      [n1, 'storage'],
      [n2, 'storage'],
      [n3, 'storage'],
      [n4, 'storage'],
    ]);
    expect(calls[0].error.message).toContain("persist is on, but the browser's storage isn't available");
    expect(calls[1].error.message).toContain("the saved state couldn't be read");
    expect(calls[2].error.message).toContain('dropped saved state from version 1');
    expect(calls[3].error.message).toBe(`[${n4}] persist.migrate threw; starting from the initial state:`);
    expect(calls[3].error.cause).toBe(boom);
    expect(c.warn).not.toHaveBeenCalled();
    expect(c.error).not.toHaveBeenCalled();
  });

  it('without onError, a failure with no underlying error prints the message alone (no trailing undefined argument)', () => {
    const c = quietConsole();
    const name = `e-${uid()}`;
    localStorage.setItem(`${name}:state`, '{not json');
    createStore({ n: 0 }, { name, persist: true, validate: () => true });
    const offline = createStore(
      { q: query(async () => 'x'.repeat(100), { initial: '' }) },
      { name: `${name}-o`, offline: { maxSize: 10 }, validate: () => true },
    ) as Loose;
    return offline.fetchQuery('q').then(async () => {
      await sleep(0);
      // toStrictEqual: [message] and [message, undefined] differ (a browser would print "undefined")
      expect(c.warn.mock.calls.map((x) => x.length)).toStrictEqual([1, 1]);
      expect(c.warn.mock.calls[0]).toStrictEqual([expect.stringContaining("the saved state couldn't be read")]);
      expect(c.warn.mock.calls[1]).toStrictEqual([expect.stringContaining('more than offline.maxSize')]);
    });
  });

  it('console.error cases keep console.error without onError (level and both arguments unchanged)', () => {
    const c = quietConsole();
    const name = `e-${uid()}`;
    const boom = new Error('bad migrate');
    localStorage.setItem(`${name}:state`, JSON.stringify({ $version: 1, state: { n: 5 } }));
    createStore(
      { n: 0 },
      {
        name,
        persist: {
          version: 2,
          migrate: () => {
            throw boom;
          },
        },
        validate: () => true,
      },
    );
    expect(c.error.mock.calls).toEqual([[`[${name}] persist.migrate threw; starting from the initial state:`, boom]]);
    expect(c.warn).not.toHaveBeenCalled();
  });

  it('a value that cannot be saved (BigInt) reports the key', () => {
    quietConsole();
    const { calls, onError } = collector();
    const name = `e-${uid()}`;
    const s = createStore(
      { big: 0 as unknown, ok: 1 },
      { name, persist: true, validate: () => true, onError },
    ) as Loose;
    s.setState('big', 10n);
    expect(calls).toHaveLength(1);
    expect(calls[0].info).toEqual({ store: name, source: 'storage', key: 'big' });
    expect(calls[0].error.cause).toBeInstanceOf(TypeError);
  });

  it('async storage that fails to load', async () => {
    quietConsole();
    const { calls, onError } = collector();
    const failure = new Error('IndexedDB is gone');
    const name = `e-${uid()}`;
    const s = createStore(
      { n: 0 },
      {
        name,
        persist: { storage: { getItem: () => Promise.reject(failure), setItem: async () => {} } },
        validate: () => true,
        onError,
      },
    ) as Loose;
    await s.hydrated;
    expect(calls).toHaveLength(1);
    expect(calls[0].info.source).toBe('storage');
    expect(calls[0].error.cause).toBe(failure);
  });

  it('validate rejecting a value reports the key and source "validate"', () => {
    quietConsole();
    const { calls, onError } = collector();
    const name = `e-${uid()}`;
    localStorage.setItem(`${name}:state`, JSON.stringify({ $version: 0, state: { n: 'not a number' } }));
    const s = createStore(
      { n: 0 },
      { name, persist: true, validate: (_k, v) => typeof v === 'number', onError },
    ) as Loose;
    expect(s.getState('n')).toBe(0);
    expect(calls.map((x) => x.info)).toEqual([{ store: name, source: 'validate', key: 'n' }]);
  });

  it('a listener that throws: source "listener", the thrown error as cause, the store keeps working', () => {
    const c = quietConsole();
    const { calls, onError } = collector();
    const s = createStore({ n: 0 }, { name: `e-${uid()}`, onError }) as Loose;
    const thrown = new Error('listener bug');
    s.subscribe(() => {
      throw thrown;
    });
    s.setState('n', 1);
    s.setState('n', 2);
    expect(s.getState('n')).toBe(2);
    expect(calls).toHaveLength(2); // every throw, as the console did
    expect(calls[0].info.source).toBe('listener');
    expect(calls[0].error.cause).toBe(thrown);
    expect(c.error).not.toHaveBeenCalled();
  });

  it('a change that cannot reach other tabs: source "sync"', async () => {
    quietConsole();
    const { calls, onError } = collector();
    const s = createStore(
      { fn: null as unknown },
      { name: `e-${uid()}`, syncTabs: true, validate: () => true, onError },
    ) as Loose;
    s.setState('fn', { run: () => 1 }); // an object holding a function can't be sent to other tabs
    await sleep(20);
    expect(calls).toHaveLength(1);
    expect(calls[0].info.source).toBe('sync');
    s.destroy();
  });

  it('the offline copy: too large, and a failed write, both source "offline"', async () => {
    quietConsole();
    const { calls, onError } = collector();
    const s = createStore(
      { big: query(async () => 'x'.repeat(200), { initial: '' }) },
      { name: `e-${uid()}`, offline: { maxSize: 50 }, validate: () => true, onError },
    ) as Loose;
    await s.fetchQuery('big');
    await sleep(0);
    expect(calls.map((x) => x.info.source)).toEqual(['offline']);
    expect(calls[0].error.message).toContain('more than offline.maxSize');

    const { calls: calls2, onError: onError2 } = collector();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('full');
    });
    const t = createStore(
      { list: query(async (_p: number) => [1], { initial: [] as number[] }) },
      { name: `e-${uid()}`, offline: true, validate: () => true, onError: onError2 },
    ) as Loose;
    await t.fetchQuery('list', 1);
    await sleep(0);
    expect(calls2.map((x) => x.info.source)).toEqual(['offline']);
    expect(calls2[0].error.message).toContain("couldn't save the offline copy of server data");
  });

  it('a query that fails after its retries: reported with the key; without onError nothing goes to the console (as before)', async () => {
    const c = quietConsole();
    const { calls, onError } = collector();
    const down = new Error('server down');
    const name = `e-${uid()}`;
    const s = createStore(
      {
        plain: query(
          async () => {
            throw down;
          },
          { retry: 1, retryDelay: 1 },
        ),
        byId: query(
          async (_id: number) => {
            throw down;
          },
          { retry: 0 },
        ),
      },
      { name, onError },
    ) as Loose;
    await expect(s.fetchQuery('plain')).rejects.toBe(down);
    await expect(s.fetchQuery('byId', 7)).rejects.toBe(down);
    expect(calls.map((x) => x.info)).toEqual([
      { store: name, source: 'query', key: 'plain' },
      { store: name, source: 'query', key: 'byId' },
    ]);
    expect(calls[0].error.message).toBe(`[${name}] couldn't load "plain": server down`);
    expect(calls[1].error.message).toBe(`[${name}] couldn't load "byId": server down`);
    expect(calls[0].error.cause).toBe(down);

    const quiet = createStore(
      {
        q: query(
          async () => {
            throw down;
          },
          { retry: 0 },
        ),
      },
      { name: `e-${uid()}` },
    ) as Loose;
    await expect(quiet.fetchQuery('q')).rejects.toBe(down);
    expect(c.warn).not.toHaveBeenCalled();
    expect(c.error).not.toHaveBeenCalled();
  });

  it('a cancelled query is not a failure: nothing is reported', async () => {
    const { calls, onError } = collector();
    const s = createStore(
      {
        q: query(
          (_p: number, signal: AbortSignal) =>
            new Promise((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
          { retry: 0 },
        ),
      },
      { name: `e-${uid()}`, onError },
    ) as Loose;
    const p = s.fetchQuery('q', 1).catch(() => {});
    s.abort('q');
    await p;
    await sleep(0);
    expect(calls).toEqual([]);
  });

  it('server data tags: missing, unreadable, another version, unknown keys: source "hydrate"', () => {
    quietConsole();
    const { calls, onError } = collector();
    const a = `h-${uid()}`;
    (createStore({ user: '' }, { name: a, ssr: true, onError }) as Loose).hydrate();
    const b = `h-${uid()}`;
    document.body.insertAdjacentHTML(
      'beforeend',
      `<script type="application/json" id="createstore:${b}">{bad</script>`,
    );
    (createStore({ user: '' }, { name: b, ssr: true, onError }) as Loose).hydrate();
    const c2 = `h-${uid()}`;
    (createStore({ user: '' }, { name: c2, ssr: { version: 2 }, onError }) as Loose).hydrate({
      $version: 1,
      user: 'x',
    });
    const d = `h-${uid()}`;
    (createStore({ user: '' }, { name: d, ssr: true, onError }) as Loose).hydrate({ user: 'x', gone: 1 });
    expect(calls.map((x) => [x.info.store, x.info.source])).toEqual([
      [a, 'hydrate'],
      [b, 'hydrate'],
      [c2, 'hydrate'],
      [d, 'hydrate'],
    ]);
    expect(calls[0].error.message).toContain('found no data tag');
    expect(calls[1].error.message).toContain('not valid JSON');
    expect(calls[2].error.message).toContain('made for version 1');
    expect(calls[3].error.message).toContain('"gone": not in the store');
  });

  it('an onError that throws is logged to the console and does not break the store', () => {
    const c = quietConsole();
    const bad = new Error('tracker down');
    const s = createStore(
      { n: 0 },
      {
        name: 'tracked',
        onError: () => {
          throw bad;
        },
      },
    ) as Loose;
    s.subscribe(() => {
      throw new Error('listener');
    });
    expect(() => s.setState('n', 1)).not.toThrow();
    expect(s.getState('n')).toBe(1);
    expect(c.error.mock.calls).toEqual([['[tracked] onError threw:', bad]]);
  });

  it('developer mistakes still warn on the console, even with onError', () => {
    const c = quietConsole();
    const { calls, onError } = collector();
    const name = `e-${uid()}`;
    const s = createStore({ n: 0 }, { name, onError, persits: true } as never) as Loose; // a typo in an option
    s.destroy();
    s.setState('n', 1); // used after destroy
    expect(calls).toEqual([]);
    const messages = c.warn.mock.calls.map((x) => String(x[0]));
    expect(messages.some((m) => m.includes('has no option "persits"'))).toBe(true);
    expect(messages.some((m) => m.includes('after destroy()'))).toBe(true);
  });
});

/* ---------- F-601: the offline cache is written once per tick ---------- */
describe('F-601: offline cache writes are batched per tick', () => {
  const writesTo = (spy: ReturnType<typeof vi.spyOn>, key: string) => spy.mock.calls.filter(([k]) => k === key).length;

  it('20 entry changes in one tick: exactly one write', async () => {
    const name = `o-${uid()}`;
    const s = createStore({ item: query(async (id: number) => id, { initial: 0 }) }, { name, offline: true }) as Loose;
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    for (let i = 0; i < 20; i++) s.setQueryData('item', i * 10, i);
    expect(writesTo(setItem, `${name}:queries`)).toBe(0); // not yet: at the end of the tick
    await tick();
    expect(writesTo(setItem, `${name}:queries`)).toBe(1);
    expect(Object.keys(JSON.parse(localStorage.getItem(`${name}:queries`)!))).toHaveLength(20);
    s.destroy();
  });

  it('loading 20 entries at once: one write per tick (fetching, then loaded), not one per status change, and complete', async () => {
    const name = `o-${uid()}`;
    const s = createStore(
      { item: query(async (id: number) => ({ id }), { initial: null as unknown }) },
      { name, offline: true },
    ) as Loose;
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    await Promise.all(Array.from({ length: 20 }, (_, i) => s.fetchQuery('item', i)));
    await tick();
    expect(writesTo(setItem, `${name}:queries`)).toBeLessThanOrEqual(2); // was 40: two status changes per entry
    const saved = JSON.parse(localStorage.getItem(`${name}:queries`)!);
    expect(Object.keys(saved)).toHaveLength(20);
    expect(
      Object.values(saved)
        .map((e: any) => e.data.id)
        .sort((a: number, b: number) => a - b),
    ).toEqual(Array.from({ length: 20 }, (_, i) => i));
    s.destroy();
  });

  it('the batched write lands before the next task: a reload in the next task finds the data', async () => {
    const name = `o-${uid()}`;
    const s = createStore(
      { item: query(async (id: number) => `v${id}`, { initial: '' }) },
      { name, offline: true },
    ) as Loose;
    await s.fetchQuery('item', 1);
    await sleep(0); // the next task
    s.destroy();
    expect(localStorage.getItem(`${name}:queries`)).toContain('"v1"');
    // the reloaded page serves it from the offline copy without a request
    let calls = 0;
    const again = createStore(
      { item: query(async (id: number) => (calls++, `fresh${id}`), { initial: '', staleTime: 60_000 }) },
      { name, offline: true },
    ) as Loose;
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    expect(await again.fetchQuery('item', 1)).toBe('v1');
    expect(calls).toBe(0);
    again.destroy();
  });

  it('reset() clears the per-user copy at once, without waiting for the batch (sign-out)', async () => {
    const name = `o-${uid()}`;
    const s = createStore(
      { item: query(async (id: number) => `secret${id}`, { initial: '' }) },
      { name, offline: true },
    ) as Loose;
    await s.fetchQuery('item', 1);
    await tick();
    expect(localStorage.getItem(`${name}:queries`)).toContain('secret1');
    s.reset();
    expect(localStorage.getItem(`${name}:queries`)).toBe('{}'); // synchronously
    await tick();
    expect(localStorage.getItem(`${name}:queries`)).toBe('{}'); // and no late write brings it back
    s.destroy();
  });

  it('a store destroyed right after a load still writes what it loaded (as it did before)', async () => {
    const name = `o-${uid()}`;
    const s = createStore(
      { item: query(async (id: number) => `v${id}`, { initial: '' }) },
      { name, offline: true },
    ) as Loose;
    const p = s.fetchQuery('item', 3);
    await p;
    s.destroy();
    await tick();
    expect(localStorage.getItem(`${name}:queries`)).toContain('"v3"');
  });

  it('no offline option: nothing is written and nothing is queued', async () => {
    const name = `o-${uid()}`;
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const s = createStore({ item: query(async (id: number) => id, { initial: 0 }) }, { name }) as Loose;
    await s.fetchQuery('item', 1);
    await tick();
    expect(setItem.mock.calls.filter(([k]) => String(k).startsWith(name))).toEqual([]);
    s.destroy();
  });
});

/* ---------- F-602: destroy() leaves the by-name registry ---------- */
describe('F-602: a destroyed store leaves the by-name registry', () => {
  it('server data merged by name no longer reaches a destroyed store', async () => {
    const name = `d-${uid()}`;
    const s = createStore({ user: query(async () => 'x', { initial: 'none' }) }, { name, ssr: true }) as Loose;
    __mergeSnapshot(name, { user: 'first' });
    expect(s.getState('user')).toBe('first'); // registered while alive
    s.destroy();
    __mergeSnapshot(name, { user: 'after' });
    expect(s.getState('user')).toBe('first');
  });

  it('destroying an older store with the same name leaves the newer one registered', () => {
    const name = `d-${uid()}`;
    const older = createStore({ user: query(async () => 'x', { initial: 'none' }) }, { name, ssr: true }) as Loose;
    const newer = createStore({ user: query(async () => 'x', { initial: 'none' }) }, { name, ssr: true }) as Loose;
    older.destroy();
    __mergeSnapshot(name, { user: 'to-newer' });
    expect(newer.getState('user')).toBe('to-newer');
    newer.destroy();
  });

  it('a scope destroyed does not remove the app store it came from', () => {
    const name = `d-${uid()}`;
    const app = createStore({ user: query(async () => 'x', { initial: 'none' }) }, { name, ssr: true }) as Loose;
    app.createScope({}).destroy();
    __mergeSnapshot(name, { user: 'still-app' });
    expect(app.getState('user')).toBe('still-app');
    app.destroy();
  });
});

/* ---------- F-604: history keeps the last `limit` steps without copying the list ---------- */
describe('F-604: history steps', () => {
  // The previous implementation, as a model: past = [...past, step].slice(-limit)
  const model = (limit: number, steps: number) => {
    let past: number[] = [];
    for (let i = 0; i < steps; i++) past = [...past, i].slice(-limit);
    return past.length;
  };

  for (const limit of [1, 2, 3, 7, 100])
    it(`limit ${limit}: undo depth matches the previous implementation after 1 to 250 changes`, () => {
      const s = createStore({ n: 0 }, { name: `h-${uid()}`, history: { limit } }) as Loose;
      for (let i = 1; i <= 250; i++) {
        s.setState('n', i);
        expect(s.getHistory().position, `${limit}/${i}`).toBe(model(limit, i));
      }
      // undo walks back exactly `limit` steps, to the oldest kept value
      for (let i = 0; i < limit; i++) s.undo();
      expect(s.getHistory().canUndo).toBe(false);
      expect(s.getState('n')).toBe(250 - limit);
    });

  for (const limit of [2.5, -1, 0.5, Infinity])
    it(`unusual limit ${limit} behaves exactly as before`, () => {
      const s = createStore({ n: 0 }, { name: `h-${uid()}`, history: { limit } }) as Loose;
      for (let i = 1; i <= 12; i++) {
        s.setState('n', i);
        expect(s.getHistory().position, `${limit}/${i}`).toBe(model(limit, i));
      }
    });

  it('undo, redo and new changes after undo interleave as before (random sequence against a model)', () => {
    let seed = 7;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (const limit of [1, 3, 10]) {
      const s = createStore({ n: 0 }, { name: `h-${uid()}`, history: { limit } }) as Loose;
      let past: number[] = [];
      let future: number[] = [];
      let value = 0;
      for (let i = 1; i <= 400; i++) {
        const r = rand();
        if (r < 0.2 && past.length) {
          s.undo();
          future = [value, ...future];
          value = past[past.length - 1];
          past = past.slice(0, -1);
        } else if (r < 0.35 && future.length) {
          s.redo();
          past = [...past, value].slice(-limit);
          value = future[0];
          future = future.slice(1);
        } else {
          s.setState('n', i);
          past = [...past, value].slice(-limit);
          future = [];
          value = i;
        }
        expect(s.getState('n'), `${limit}/${i}`).toBe(value);
        expect(s.getHistory().position, `${limit}/${i}`).toBe(past.length);
        expect(s.getHistory().length, `${limit}/${i}`).toBe(past.length + 1 + future.length);
      }
    }
  });
});
