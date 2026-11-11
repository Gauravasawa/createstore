// Third batch: the gaps listed in "not tested": several tabs writing at once, `set.<key>(value)`, `getState()` with no
// key, what a shared store does when its module is re-evaluated (hot reload), big state, and paged-query freshness.
// "Tabs" are several stores with the same name in one page: they talk over the same BroadcastChannel a second tab would.
import { createStore, query } from '@createstore/createstore';

type Test = [name: string, run: () => Promise<string | void>];

function expect(cond: unknown, detail: string): asserts cond {
  if (!cond) throw new Error(detail);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const uid = () => Math.random().toString(36).slice(2, 8);
const time = async (fn: () => unknown) => {
  const t = performance.now();
  await fn();
  return performance.now() - t;
};

/** n stores that behave like n open tabs of one app */
function tabs<S extends Record<string, unknown>>(n: number, initial: S, extra: object = {}) {
  const name = `selftest-tabs-${uid()}`;
  const list = Array.from({ length: n }, () => createStore(initial, { name, syncTabs: true, ...extra }));
  return { list, close: () => list.forEach((s) => s.destroy()) };
}

export const gapTests: Test[] = [
  /* ---------- several tabs, simultaneous writes ---------- */
  ['syncTabs, 5 tabs: one tab changes a key, all the others follow', async () => {
    const t = tabs(5, { v: 'start' });
    try {
      await t.list[2].setState('v', 'from-2');
      await sleep(80);
      const got = t.list.map((s) => s.getState('v'));
      expect(got.every((v) => v === 'from-2'), `values: ${got.join()}`);
    } finally { t.close(); }
  }],

  ['syncTabs, 5 tabs: a change that hops tab 0 → 4 → 1 reaches everyone each time', async () => {
    const t = tabs(5, { v: 'start' });
    try {
      for (const [i, value] of [[0, 'a'], [4, 'b'], [1, 'c']] as const) {
        await t.list[i].setState('v', value);
        await sleep(60);
        const got = t.list.map((s) => s.getState('v'));
        expect(got.every((v) => v === value), `after tab ${i} wrote "${value}": ${got.join()}`);
      }
    } finally { t.close(); }
  }],

  ['syncTabs, 5 tabs write the same key in the same tick: every tab ends on the same value (30 rounds)', async () => {
    const t = tabs(5, { v: 'start' });
    const winners = new Map<string, number>();
    try {
      for (let round = 0; round < 30; round++) {
        const order = [0, 1, 2, 3, 4].sort(() => Math.random() - 0.5);
        for (const i of order) void t.list[i].setState('v', `r${round}-tab${i}`);
        await sleep(70);
        const got = t.list.map((s) => s.getState('v'));
        expect(new Set(got).size === 1, `round ${round}: tabs disagree: ${got.join(' | ')}`);
        winners.set(got[0] as string, (winners.get(got[0] as string) ?? 0) + 1);
      }
      return `always agreed; ${new Set([...winners.keys()].map((k) => k.split('-')[1])).size} different tabs won across rounds`;
    } finally { t.close(); }
  }],

  ['syncTabs: a tab that has seen a newer change wins over its own older write (later write beats earlier)', async () => {
    const t = tabs(3, { v: 'start' });
    try {
      await t.list[0].setState('v', 'first');
      await sleep(60);
      await t.list[1].setState('v', 'second');
      await sleep(60);
      await t.list[0].setState('v', 'third');
      await sleep(60);
      const got = t.list.map((s) => s.getState('v'));
      expect(got.every((v) => v === 'third'), `values: ${got.join()}`);
    } finally { t.close(); }
  }],

  ['syncTabs: simultaneous writes to different keys both survive', async () => {
    const t = tabs(4, { a: 0, b: 0, c: 0, d: 0 });
    try {
      void t.list[0].setState('a', 1);
      void t.list[1].setState('b', 2);
      void t.list[2].setState('c', 3);
      void t.list[3].setState('d', 4);
      await sleep(80);
      for (const [i, s] of t.list.entries()) {
        const got = `${s.getState('a')}${s.getState('b')}${s.getState('c')}${s.getState('d')}`;
        expect(got === '1234', `tab ${i} has ${got}, expected 1234`);
      }
    } finally { t.close(); }
  }],

  ['syncTabs: two tabs adding to the same list at once keeps only one of the additions (whole-value, last writer wins)', async () => {
    const t = tabs(2, { list: [] as string[] });
    try {
      void t.list[0].setState('list', (l) => [...l, 'from-0']);
      void t.list[1].setState('list', (l) => [...l, 'from-1']);
      await sleep(80);
      const a = t.list[0].getState('list');
      const b = t.list[1].getState('list');
      expect(JSON.stringify(a) === JSON.stringify(b), `tabs disagree: ${a.join()} vs ${b.join()}`);
      return `both tabs end with [${a.join()}]: ${a.length === 1 ? 'one addition was lost (expected for last-writer-wins)' : 'both kept'}`;
    } finally { t.close(); }
  }],

  ['syncTabs: emit({ broadcast }) reaches every other tab once, not the sender', async () => {
    const name = `selftest-ev-${uid()}`;
    const list = Array.from({ length: 4 }, () => createStore({ x: 0 }, { name, syncTabs: true, events: undefined as never }));
    const hits = list.map(() => 0);
    try {
      list.forEach((s, i) => (s as unknown as { on: (e: string, f: () => void) => void }).on('ping', () => { hits[i]++; }));
      (list[1] as unknown as { emit: (e: string, p: unknown, o: object) => void }).emit('ping', 1, { broadcast: true });
      await sleep(80);
      expect(hits.join() === '1,1,1,1', `hits per tab: ${hits.join()}`);
    } finally { list.forEach((s) => s.destroy()); }
  }],

  ['syncTabs + validate: a bad value from another tab is refused in every tab', async () => {
    const name = `selftest-val-${uid()}`;
    const make = () => createStore({ n: 1 }, { name, syncTabs: true, validate: (k, v) => k !== 'n' || typeof v === 'number' });
    const [a, b, c] = [make(), make(), make()];
    try {
      const ch = new BroadcastChannel(`createStore:${name}`);
      ch.postMessage({ type: 'state', stamp: [9999, 'zzz'], values: { n: 'not a number' } });
      await sleep(80);
      ch.close();
      expect([a, b, c].every((s) => s.getState('n') === 1), `values: ${[a, b, c].map((s) => String(s.getState('n'))).join()}`);
    } finally { [a, b, c].forEach((s) => s.destroy()); }
  }],

  /* ---------- the forms the app doesn't use ---------- */
  ['store.set.<key>(value): plain value, updater, and with a failing server call it rolls back', async () => {
    const s = createStore({ n: 1, name: 'a' });
    await s.set.n(5);
    expect(s.getState('n') === 5, `after set.n(5): ${s.getState('n')}`);
    await s.set.n((c) => c + 1);
    expect(s.getState('n') === 6, `after updater: ${s.getState('n')}`);
    await s.set.n(99, () => { throw new Error('503'); }).catch(() => {});
    expect(s.getState('n') === 6, `a failed server call should roll back to 6, got ${s.getState('n')}`);
    await s.set.name('b', () => Promise.resolve());
    expect(s.getState('name') === 'b', 'a successful server call keeps the value');
  }],

  ['getState() with no key: every value, computed ones included, as a copy of the moment', async () => {
    const s = createStore({ a: 1, b: 2 }, { computed: [{ sum: (get) => get('a') + get('b') }] });
    const all = s.getState();
    expect(all.a === 1 && all.b === 2, `got ${JSON.stringify(all)}`);
    expect(all.sum === 3, `computed value missing: ${JSON.stringify(all)}`);
    await s.setState('a', 10);
    expect(all.a === 1, 'an earlier result must not change when the store does');
    expect(s.getState().sum === 12, `after change: ${JSON.stringify(s.getState())}`);
  }],

  ['getState() is not affected by a caller mutating the returned object', async () => {
    const s = createStore({ a: 1 });
    const all = s.getState() as { a: number };
    try { all.a = 99; } catch { /* a frozen object is fine too */ }
    expect(s.getState('a') === 1, `the store changed to ${s.getState('a')}`);
  }],

  /* ---------- hot reload of the module that creates a shared store ---------- */
  ['shared: true, module evaluated again (hot reload): the first instance is kept, the new definition is ignored', async () => {
    const name = `selftest-hmr-${uid()}`;
    const first = createStore({ a: 0 }, { name, shared: true });
    await first.setState('a', 5);
    const second = createStore({ a: 0, b: 'new key' }, { name, shared: true, computed: [{ double: (get) => get('a') * 2 }] });
    expect(first === second, 'a second createStore with the same name should return the same instance');
    expect(second.getState('a') === 5, `state is kept across the re-evaluation: ${second.getState('a')}`);
    const hasNewKey = (second.getState() as Record<string, unknown>).b !== undefined;
    const hasNewComputed = (second.getState() as Record<string, unknown>).double !== undefined;
    first.destroy();
    delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for(`createStore:${name}`)];
    return `state kept; new key available: ${hasNewKey}; new computed value available: ${hasNewComputed} (the library warns once: reload the page after editing the store)`;
  }],

  ['shared: true, after destroy(): a new createStore builds a fresh store again?', async () => {
    const name = `selftest-hmr2-${uid()}`;
    const first = createStore({ a: 0 }, { name, shared: true });
    first.destroy();
    const second = createStore({ a: 0 }, { name, shared: true });
    const same = first === second;
    let works = true;
    try { await second.setState('a', 1); } catch { works = false; }
    const value = works ? second.getState('a') : undefined;
    delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for(`createStore:${name}`)];
    second.destroy();
    return `same instance: ${same}; setState works: ${works}; value: ${String(value)}${same && !works ? ' — a destroyed shared store is handed back (dev hot reload that calls destroy() would break the app)' : ''}`;
  }],

  /* ---------- paged queries and freshness ---------- */
  ['paged query: a stale entry is fetched again when asked for (staleTime is honoured)', async () => {
    let calls = 0;
    const list = query(async (page: number, _p: { q: string }, _signal: AbortSignal) => { calls++; return { items: [page], nextPage: null as number | null }; },
      { pages: { first: 1, next: (last: { nextPage: number | null }) => last.nextPage }, staleTime: 10 } as never);
    const s = createStore({ list } as never) as unknown as { fetchQuery: (q: string, p: unknown, force?: boolean) => Promise<unknown>; destroy: () => void };
    await s.fetchQuery('list', { q: 'a' });
    await sleep(60); // well past staleTime: 10
    await s.fetchQuery('list', { q: 'a' });
    const forced = calls;
    await s.fetchQuery('list', { q: 'a' }, true);
    s.destroy();
    expect(forced === 2, `a second call 60 ms later (staleTime 10) should refetch: ${forced} request(s)`);
    expect(calls === forced + 1, 'force should still refetch');
    await sleep(0);
    return `requests after two calls 60 ms apart (staleTime 10 ms): ${forced}`;
  }],

  ['paged query restored from the offline copy is fetched again when it is stale', async () => {
    const name = `selftest-paged-${uid()}`;
    let calls = 0;
    const make = () => {
      const list = query(async (page: number, _p: { q: string }, _s: AbortSignal) => { calls++; return { items: [page], nextPage: null as number | null }; },
        { pages: { first: 1, next: (last: { nextPage: number | null }) => last.nextPage }, staleTime: 10 } as never);
      return createStore({ list } as never, { name, offline: true }) as unknown as { fetchQuery: (q: string, p: unknown) => Promise<unknown>; destroy: () => void };
    };
    const one = make();
    await one.fetchQuery('list', { q: 'a' });
    await sleep(40);
    one.destroy();
    const before = calls;
    const two = make(); // the page was reloaded: the saved copy is restored
    await two.fetchQuery('list', { q: 'a' });
    const after = calls;
    two.destroy();
    localStorage.removeItem(`${name}:queries`);
    localStorage.removeItem(`${name}:inline`);
    expect(after === before + 1, `a restored copy older than staleTime should be refetched: requests ${before} → ${after}`);
    return `requests before reload ${before}, after asking again on the restored copy ${after}`;
  }],

  /* ---------- big state ---------- */
  ['100,000 items in one key: replace, append (key action), read, computed, snapshot, JSON', async () => {
    const N = 100_000;
    const items = Array.from({ length: N }, (_, i) => ({ id: i, name: `item ${i}`, done: i % 3 === 0 }));
    let computedRuns = 0;
    const s = createStore({ items: [] as typeof items, other: 0 }, {
      keyActions: { items: { add: (l: typeof items, x: (typeof items)[number]) => [...l, x] } },
      computed: [{ doneCount: (get) => { computedRuns++; return get('items').filter((i) => i.done).length; } }],
    });
    const out: string[] = [];
    out.push(`replace ${(await time(() => s.setState('items', items))).toFixed(0)} ms`);
    out.push(`computed (first read) ${(await time(() => s.getState('doneCount'))).toFixed(0)} ms`);
    const runs = computedRuns;
    for (let i = 0; i < 50; i++) { await s.setState('other', i); s.getState('doneCount'); }
    expect(computedRuns === runs, `an unrelated key change re-ran the computed value ${computedRuns - runs} times`);
    out.push(`50 unrelated writes: computed re-ran ${computedRuns - runs}×`);
    out.push(`append 20× ${(await time(async () => { for (let i = 0; i < 20; i++) await s.set.items.add({ id: N + i, name: 'x', done: false }); })).toFixed(0)} ms`);
    out.push(`getState('items') 1,000× ${(await time(() => { for (let i = 0; i < 1000; i++) s.getState('items'); })).toFixed(1)} ms`);
    out.push(`getState() all 100× ${(await time(() => { for (let i = 0; i < 100; i++) s.getState(); })).toFixed(1)} ms`);
    let json = '';
    out.push(`snapshot + JSON ${(await time(() => { json = JSON.stringify(s.snapshot()); })).toFixed(0)} ms (${(json.length / 1e6).toFixed(1)} MB)`);
    expect(s.getState('items').length === N + 20, `lost items: ${s.getState('items').length}`);
    return out.join(' · ');
  }],

  ['100,000 items persisted: one write after the debounce, and a new store loads it back', async () => {
    const N = 100_000;
    const mem = new Map<string, string>();
    let writes = 0;
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { writes++; mem.set(k, v); } };
    const name = `selftest-big-${uid()}`;
    const one = createStore({ items: [] as number[], tick: 0 }, { name, persist: { storage, debounce: 50 } });
    await one.hydrated;
    await one.setState('items', Array.from({ length: N }, (_, i) => i));
    for (let i = 0; i < 20; i++) await one.setState('tick', i);
    await sleep(120);
    const size = (mem.get(`${name}:state`) ?? '').length;
    expect(writes >= 1 && writes <= 3, `expected 1-3 writes for 21 quick changes, got ${writes}`);
    const loadMs = await time(async () => {
      const two = createStore({ items: [] as number[], tick: 0 }, { name, persist: { storage, debounce: 50 } });
      await two.hydrated;
      expect(two.getState('items').length === N, `loaded ${two.getState('items').length} items`);
      two.destroy();
    });
    one.destroy();
    return `${writes} write(s) of ${(size / 1e6).toFixed(2)} MB, load ${loadMs.toFixed(0)} ms`;
  }],

  ['20,000 cached query entries: fetch, read, release by gcTime', async () => {
    const q = query(async (id: number) => ({ id, text: 'x'.repeat(30) }), { gcTime: 50 });
    const s = createStore({ q });
    const fetchMs = await time(() => Promise.all(Array.from({ length: 20_000 }, (_, i) => s.fetchQuery('q', i))));
    const readMs = await time(async () => { for (let i = 0; i < 20_000; i++) await s.fetchQuery('q', i); });
    const snapBefore = JSON.stringify(s.snapshot()).length;
    await sleep(300);
    const snapAfter = JSON.stringify(s.snapshot()).length;
    s.destroy();
    expect(snapAfter < snapBefore, `entries were not released: ${snapBefore} → ${snapAfter} characters`);
    return `fetch ${fetchMs.toFixed(0)} ms · 20,000 cache hits ${readMs.toFixed(0)} ms · snapshot ${(snapBefore / 1e6).toFixed(1)} MB → ${(snapAfter / 1e6).toFixed(2)} MB after gcTime`;
  }],
];
