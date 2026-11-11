// In-browser checks of createStore's behaviour, each on its own throwaway store (never the app's).
import { createStore, defineEvents, query, serializeSnapshot } from '@createstore/createstore';
import { extraTests } from './selftest-extra';
import { gapTests } from './selftest-gaps';

export interface TestResult { name: string; ok: boolean; detail: string; ms: number }
export type Test = [name: string, run: () => Promise<string | void>];

function expect(cond: unknown, detail: string): asserts cond {
  if (!cond) throw new Error(detail);
}
const tick = () => new Promise((r) => setTimeout(r, 0));

export const baseTests: Test[] = [
  ['setState / getState / updater function', async () => {
    const s = createStore({ count: 0 });
    await s.setState('count', 2);
    await s.setState('count', (c) => c + 1);
    expect(s.getState('count') === 3, `expected 3, got ${s.getState('count')}`);
  }],

  ['computed values, two layers', async () => {
    const s = createStore({ count: 1 }, { computed: [{ double: (get) => get('count') * 2 }, { quad: (get) => get('double') * 2 }] });
    expect(s.getState('quad') === 4, `quad should be 4, got ${s.getState('quad')}`);
    await s.setState('count', 5);
    expect(s.getState('quad') === 20, `quad should follow count: 20, got ${s.getState('quad')}`);
  }],

  ['subscribe reports changes with the key and source', async () => {
    const s = createStore({ a: 0 });
    const seen: string[] = [];
    const off = s.subscribe((e) => seen.push(`${e.key}:${e.source}`));
    await s.setState('a', 1);
    off();
    await s.setState('a', 2);
    expect(seen.length === 1 && seen[0] === 'a:local', `expected ["a:local"], got ${JSON.stringify(seen)}`);
  }],

  ['batch writes persisted state once', async () => {
    let writes = 0;
    const mem = new Map<string, string>();
    const s = createStore({ a: 0, b: 0 }, {
      name: 'selftest-batch',
      persist: { storage: { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => { writes++; mem.set(k, v); } } },
    });
    await s.hydrated;
    const before = writes;
    s.batch(() => { s.setState('a', 1); s.setState('b', 2); });
    await tick();
    expect(s.getState('a') === 1 && s.getState('b') === 2, 'both values should be set');
    expect(writes - before === 1, `expected 1 storage write for the batch, got ${writes - before}`);
    return `writes in batch: ${writes - before}`;
  }],

  ['persist saves and a new store loads it', async () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const one = createStore({ city: 'A', secret: 'x' }, { name: 'selftest-persist', persist: { storage, exclude: ['secret'] } });
    await one.hydrated;
    await one.setState('city', 'B');
    await one.setState('secret', 'y');
    const two = createStore({ city: 'A', secret: 'x' }, { name: 'selftest-persist', persist: { storage, exclude: ['secret'] } });
    await two.hydrated;
    expect(two.getState('city') === 'B', `city should load as B, got ${two.getState('city')}`);
    expect(two.getState('secret') === 'x', 'excluded key must not be saved');
  }],

  ['history: undo and redo', async () => {
    const s = createStore({ n: 0 }, { history: true });
    await s.setState('n', 1);
    await s.setState('n', 2);
    s.undo();
    expect(s.getState('n') === 1, `undo should give 1, got ${s.getState('n')}`);
    s.undo();
    expect(s.getState('n') === 0, `second undo should give 0, got ${s.getState('n')}`);
    s.redo();
    expect(s.getState('n') === 1, `redo should give 1, got ${s.getState('n')}`);
  }],

  ['key actions', async () => {
    const s = createStore({ todos: [] as string[] }, { keyActions: { todos: { add: (t: string[], x: string) => [...t, x] } } });
    await s.set.todos.add('milk');
    await s.set.todos.add('eggs');
    expect(s.getState('todos').join() === 'milk,eggs', `got ${s.getState('todos').join()}`);
  }],

  ['key action with save: success keeps, failure rolls back', async () => {
    let fail = false;
    const s = createStore({ score: 0 }, {
      keyActions: { score: { inc: { run: (c: number) => c + 1, save: async () => { if (fail) throw new Error('nope'); } } } },
    });
    await s.set.score.inc();
    expect(s.getState('score') === 1, 'successful save should keep the change');
    fail = true;
    await s.set.score.inc().catch(() => {});
    expect(s.getState('score') === 1, `failed save should roll back to 1, got ${s.getState('score')}`);
  }],

  ['setState with a failing server call rolls back', async () => {
    const s = createStore({ v: 'old' });
    await s.setState('v', 'new', () => { throw new Error('503'); }).catch(() => {});
    expect(s.getState('v') === 'old', `expected rollback to "old", got ${s.getState('v')}`);
  }],

  ['query: params are cached, force refetches', async () => {
    let calls = 0;
    const s = createStore({ user: query(async (id: number) => { calls++; return { id }; }, { staleTime: 60_000 }) });
    await s.fetchQuery('user', 1);
    await s.fetchQuery('user', 1);
    expect(calls === 1, `same params twice should fetch once, fetched ${calls}`);
    await s.fetchQuery('user', 1, true);
    expect(Number(calls) === 2, `force should fetch again, total ${calls}`);
    await s.fetchQuery('user', 2);
    expect(Number(calls) === 3, `new params should fetch, total ${calls}`);
  }],

  ['query: retries then succeeds', async () => {
    let calls = 0;
    const s = createStore({ flaky: query(async (_: number) => { if (++calls < 3) throw new Error('boom'); return 'ok'; }, { retry: 3, retryDelay: () => 5 }) });
    const data = await s.fetchQuery('flaky', 1);
    expect(data === 'ok' && calls === 3, `expected ok after 3 calls, got ${data} after ${calls}`);
  }],

  ['query: object params are keyed by value, not identity or key order', async () => {
    let calls = 0;
    const s = createStore({ list: query(async (_f: { a: number; b: number }) => { calls++; return []; }, { staleTime: 60_000 }) });
    await s.fetchQuery('list', { a: 1, b: 2 });
    await s.fetchQuery('list', { b: 2, a: 1 });
    expect(calls === 1, `reordered keys should share an entry; fetched ${calls}`);
  }],

  ['events: typed emit / on / off', async () => {
    const s = createStore({ x: 0 }, { events: defineEvents<{ hi: number }>() });
    const got: number[] = [];
    const off = s.on('hi', (n) => got.push(n));
    s.emit('hi', 1);
    off();
    s.emit('hi', 2);
    expect(got.join() === '1', `expected [1], got [${got}]`);
  }],

  ['createScope is isolated from its store', async () => {
    const s = createStore({ count: 0 });
    const scope = s.createScope({ count: 5 });
    await scope.setState('count', 6);
    expect(s.getState('count') === 0 && scope.getState('count') === 6, `store ${s.getState('count')}, scope ${scope.getState('count')}`);
  }],

  ['snapshot is JSON and serializeSnapshot is safe in <script>', async () => {
    const s = createStore({ note: '</script><b>&' });
    const text = serializeSnapshot(s.snapshot());
    expect(!/[<>&]/.test(text), `unescaped character in ${text}`);
    expect(JSON.parse(text).note === '</script><b>&', 'must round trip');
  }],

  ['reset returns state to its initial values', async () => {
    const s = createStore({ a: 1 });
    await s.setState('a', 9);
    s.reset();
    expect(s.getState('a') === 1, `got ${s.getState('a')}`);
  }],

  /* ---- The features the app's own screens don't hit directly ---- */

  ['ssr.version: a snapshot made for another version is ignored', async () => {
    const s = createStore({ a: 1 }, { name: 'selftest-ssr', ssr: { version: 2 } });
    const warn = spyWarn();
    try {
      s.hydrate({ $version: 1, a: 99 } as never);
    } finally {
      warn.restore();
    }
    expect(s.getState('a') === 1, `a should stay 1, got ${s.getState('a')}`);
    expect(warn.calls.some((m) => m.includes('version')), `expected a version warning, got ${JSON.stringify(warn.calls)}`);
  }],

  ['ssr.version: a snapshot for this version is applied', async () => {
    const s = createStore({ a: 1 }, { name: 'selftest-ssr-ok', ssr: { version: 2 } });
    s.hydrate({ $version: 2, a: 7 } as never);
    expect(s.getState('a') === 7, `got ${s.getState('a')}`);
  }],

  ['validate: a bad saved value is ignored, a good one is kept', async () => {
    const mem = new Map([['selftest-validate:state', JSON.stringify({ $version: 0, state: { n: 'not a number', ok: 3 } })]]);
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const warn = spyWarn();
    let s;
    try {
      s = createStore({ n: 0, ok: 0 }, { name: 'selftest-validate', persist: { storage }, validate: (key, value) => key !== 'n' || typeof value === 'number' });
      await s.hydrated;
    } finally {
      warn.restore();
    }
    expect(s.getState('n') === 0, `n should keep 0, got ${JSON.stringify(s.getState('n'))}`);
    expect(s.getState('ok') === 3, `ok should load 3, got ${s.getState('ok')}`);
    expect(warn.calls.some((m) => m.includes('validate()')), 'expected a validate() warning');
  }],

  ['persist.migrate: old saved data becomes the new shape and is saved again', async () => {
    const mem = new Map([['selftest-migrate:state', JSON.stringify({ $version: 1, state: { city: 'Pune' } })]]);
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const s = createStore({ city: 'A', recent: ['x'] as string[] }, {
      name: 'selftest-migrate',
      persist: { storage, version: 2, migrate: (old: Record<string, unknown>, from: number) => (from < 2 ? { ...old, recent: [] } : old) },
    });
    await s.hydrated;
    expect(s.getState('city') === 'Pune' && s.getState('recent').length === 0, `city ${s.getState('city')}, recent ${JSON.stringify(s.getState('recent'))}`);
    const saved = JSON.parse(mem.get('selftest-migrate:state')!);
    expect(saved.$version === 2, `saved again as version ${saved.$version}`);
  }],

  ['persist.migrate: data from an older version with no migrate is dropped', async () => {
    const mem = new Map([['selftest-nomigrate:state', JSON.stringify({ $version: 1, state: { city: 'Pune' } })]]);
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const warn = spyWarn();
    let s;
    try {
      s = createStore({ city: 'A' }, { name: 'selftest-nomigrate', persist: { storage, version: 2 } });
      await s.hydrated;
    } finally {
      warn.restore();
    }
    expect(s.getState('city') === 'A', `got ${s.getState('city')}`);
  }],

  ['persist.debounce: a burst of changes is written once', async () => {
    let writes = 0;
    const mem = new Map<string, string>();
    const s = createStore({ text: '' }, { name: 'selftest-debounce', persist: { storage: { getItem: () => null, setItem: (k, v) => { writes++; mem.set(k, v); } }, debounce: 80 } });
    await s.hydrated;
    const before = writes;
    for (const t of ['h', 'he', 'hel', 'hell', 'hello']) await s.setState('text', t);
    expect(writes === before, `nothing should be written during the burst, wrote ${writes - before}`);
    await sleep(250);
    expect(writes - before === 1, `expected 1 write after the pause, got ${writes - before}`);
    expect(JSON.parse(mem.get('selftest-debounce:state')!).state.text === 'hello', 'the last value should be the saved one');
  }],

  ['gcTime: an entry nobody shows is dropped, so the next read fetches again', async () => {
    let calls = 0;
    const s = createStore({ item: query(async (id: number) => { calls++; return id; }, { staleTime: 60_000, gcTime: 60 }) });
    await s.fetchQuery('item', 1);
    await s.fetchQuery('item', 1);
    expect(calls === 1, `fresh entry should be reused, fetched ${calls}`);
    await sleep(300);
    await s.fetchQuery('item', 1);
    expect(Number(calls) === 2, `after gcTime the entry should be gone and fetched again, calls = ${calls}`);
  }],

  ['abort: a running request is cancelled through its signal', async () => {
    let signal: AbortSignal | undefined;
    const s = createStore({ slow: query((_: number, sig: AbortSignal) => { signal = sig; return new Promise<string>((_ok, no) => sig.addEventListener('abort', () => no(sig.reason))); }, { retry: 0 }) });
    const pending = s.fetchQuery('slow', 1).catch((e) => e);
    await tick();
    s.abort('slow');
    const outcome = await pending;
    expect(signal?.aborted === true, 'the fetch function should see its signal aborted');
    expect(outcome !== undefined, 'the promise should settle');
  }],

  ['onChange: called for each change with key, source and values', async () => {
    const seen: string[] = [];
    const s = createStore({ a: 0 }, { onChange: (e) => seen.push(`${e.key}:${e.source}:${e.prev}->${e.next}`) });
    await s.setState('a', 5);
    expect(seen.join() === 'a:local:0->5', `got ${seen.join()}`);
  }],

  ['whenOnline: runs right away when online and returns the task result', async () => {
    const s = createStore({ a: 0 });
    const result = await s.whenOnline(() => 42);
    expect(result === 42, `got ${result}`);
  }],

  ['emit with broadcast but no syncTabs: warns that only this tab hears it', async () => {
    const s = createStore({ a: 0 }, { events: defineEvents<{ ping: number }>() });
    const warn = spyWarn();
    const got: number[] = [];
    s.on('ping', (n) => got.push(n));
    try {
      s.emit('ping', 1, { broadcast: true });
    } finally {
      warn.restore();
    }
    expect(got.join() === '1', 'this tab still gets the event');
    expect(warn.calls.some((m) => m.includes('syncTabs')), `expected a syncTabs warning, got ${JSON.stringify(warn.calls)}`);
  }],

  ['history keys: only the listed keys are undone', async () => {
    const s = createStore({ tracked: 0, other: 0 }, { history: { keys: ['tracked'] } });
    await s.setState('tracked', 1);
    await s.setState('other', 1);
    s.undo();
    expect(s.getState('tracked') === 0 && s.getState('other') === 1, `tracked ${s.getState('tracked')}, other ${s.getState('other')}`);
  }],

  ['destroy: a destroyed store stops changing', async () => {
    const s = createStore({ a: 0 });
    s.destroy();
    const warn = spyWarn();
    try {
      await s.setState('a', 1);
    } finally {
      warn.restore();
    }
    expect(s.getState('a') === 0, `got ${s.getState('a')}`);
  }],

  ['createScope: scopes do not persist', async () => {
    const mem = new Map<string, string>();
    let writes = 0;
    const s = createStore({ a: 0 }, { name: 'selftest-scope-persist', persist: { storage: { getItem: () => null, setItem: (k, v) => { writes++; mem.set(k, v); } } } });
    await s.hydrated;
    const before = writes;
    await s.createScope().setState('a', 5);
    await sleep(20);
    expect(writes === before, `a scope must not write, wrote ${writes - before}`);
  }],
];

/** Collects console.warn calls for a moment, so a check can assert what the library said */
function spyWarn() {
  const original = console.warn;
  const calls: string[] = [];
  console.warn = (...args: unknown[]) => { calls.push(args.map(String).join(' ')); };
  return { calls, restore: () => { console.warn = original; } };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const tests: Test[] = [...baseTests, ...extraTests, ...gapTests];

export async function runSelfTests(onResult: (r: TestResult) => void) {
  for (const [name, run] of tests) {
    const t = performance.now();
    try {
      const detail = (await run()) ?? '';
      onResult({ name, ok: true, detail, ms: Math.round(performance.now() - t) });
    } catch (e) {
      onResult({ name, ok: false, detail: e instanceof Error ? e.message : String(e), ms: Math.round(performance.now() - t) });
    }
  }
}
export const testCount = tests.length;
