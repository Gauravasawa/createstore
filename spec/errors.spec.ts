// Error messages are part of the product: a mistake should say what is wrong and what to do about it.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createStore, query } from '@createstore/createstore';

afterEach(() => vi.restoreAllMocks());
const warnings = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

describe('mistakes in createStore() options', () => {
  it('a typo in an option is reported, with the list of real options, and the store still works', () => {
    const warn = warnings();
    const store = createStore({ a: 1 }, { name: 'typo-1', persits: true } as never);
    expect(warn.mock.calls[0][0]).toMatch(/no option "persits".*Options: name, persist,/);
    expect(store.getState('a')).toBe(1);
  });

  it('the same mistake is reported once, not on every createStore() call', () => {
    const warn = warnings();
    for (let i = 0; i < 5; i++) createStore({ a: 1 }, { name: 'typo-2', histroy: true } as never);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('every real option is accepted without a warning', () => {
    const warn = warnings();
    createStore(
      { a: 1 },
      {
        name: 'all-options',
        persist: false,
        syncTabs: false,
        history: false,
        devtools: false,
        shared: false,
        ssr: false,
        logger: false,
        onChange: () => {},
        offline: false,
        validate: () => true,
        computed: [{ b: (get) => get('a') + 1 }],
        keyActions: {},
        actions: () => ({}),
      },
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it('persist, syncTabs, offline or shared without a name warns: two unnamed stores would overwrite each other', () => {
    const warn = warnings();
    createStore({ a: 1 }, { persist: 'session' });
    expect(warn.mock.calls.flat().join(' ')).toMatch(/Without \{ name: '\.\.\.' \}.*overwrite each other/);
  });

  it('a named store gets no such warning', () => {
    const warn = warnings();
    createStore({ a: 1 }, { name: 'named-ok', persist: 'session', syncTabs: true });
    expect(warn).not.toHaveBeenCalled();
  });

  it('actions that is not a function says what shape it needs', () => {
    expect(() => createStore({ a: 1 }, { actions: { x: () => 1 } } as never)).toThrow(
      /actions must be a function that receives the store's api/,
    );
  });

  it('batch() without a function says how to call it', () => {
    const store = createStore({ a: 1 });
    expect(() => store.batch(1 as never)).toThrow(/batch\(\) takes a function/);
  });

  it('the removed queries option points to query()', () => {
    expect(() => createStore({ a: 1 }, { queries: {} } as never)).toThrow(
      /declare each query in the state with query\(fetch, options\)/,
    );
  });
});

describe('mistakes while using a store', () => {
  const store = createStore({ count: 0 }, { computed: [{ doubled: (get) => get('count') * 2 }], history: true });

  it.each([
    ['writing a key that does not exist', () => store.setState('nope' as never, 1), /"nope" is not in the store/],
    [
      'writing a computed key',
      () => store.setState('doubled' as never, 1),
      /computed and read-only\. Change the state keys it reads instead/,
    ],
    ['query() with a non-function', () => (query as any)('x'), /fetch must be a function that returns a promise/],
    [
      'query() with an unknown option',
      () => query(async () => 1, { bogus: 1 } as never),
      /no option "bogus"\. Options:/,
    ],
    [
      'a query option in the wrong place',
      () => query(async () => 1, { pages: { first: 1, next: () => null }, initial: [] } as never),
      /initial can't be used with pages/,
    ],
    [
      'computed values that read each other in a loop',
      () =>
        createStore({ a: 1 }, { computed: [{ x: (g: any) => g('y'), y: (g: any) => g('x') }] }).getState('x' as never),
      /depends on itself through a loop: x → y → x\. Break the loop/,
    ],
    [
      'keyActions for a key that is not there',
      () => createStore({ a: 1 }, { keyActions: { zzz: { inc: (c: number) => c } } } as never),
      /"zzz", which is not a plain or query key/,
    ],
    [
      'Root without ssr: true',
      () => createStore({ a: 1 }, { name: 'x' }).Root({ scope: null as never }),
      /needs ssr: true in createStore's options/,
    ],
    ['hydrate without ssr: true', () => createStore({ a: 1 }).hydrate(), /needs ssr: true in createStore's options/],
  ])('%s', (_what, run, message) => {
    expect(run).toThrow(message);
  });

  it('fetching a key that is not a query rejects and names it', async () => {
    await expect(store.fetchQuery('count' as never)).rejects.toThrow(/Query "count" is not in the store/);
  });

  it('snapshot() of data JSON cannot carry names the key and the fix', () => {
    const s = createStore({ when: new Date(0) }, { name: 'snap', ssr: true });
    expect(() => s.createScope().snapshot()).toThrow(
      /state key "when": when is a Date.*ssr: \{ exclude: \[\.\.\.\] \}/,
    );
  });

  it('a key named like a store method warns and says how to reach it', () => {
    const warn = warnings();
    createStore({ reset: 1 } as never, { name: 'collide' });
    expect(warn.mock.calls.flat().join(' ')).toMatch(/is also the name of a store method.*store\.set\.reset\(\.\.\.\)/);
  });

  it('every message above names what to do, not just what went wrong', () => {
    // a rough guard against a future message that only says "invalid"
    const advice =
      /(use|add|change|break|give|declare|call|pass|keep|leave|takes|needs|must|can't be used|Options:|is not in the store)/i;
    const attempts: (() => unknown)[] = [
      () => store.setState('nope' as never, 1),
      () => store.setState('doubled' as never, 1),
      () => store.batch(1 as never),
      () => createStore({ a: 1 }, { actions: 1 } as never),
    ];
    for (const attempt of attempts) {
      try {
        attempt();
      } catch (error) {
        expect((error as Error).message).toMatch(advice);
      }
    }
  });
});
