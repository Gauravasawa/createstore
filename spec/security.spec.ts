// Hostile input through every entry where the library ingests data it did not write itself:
// saved storage, other tabs, server snapshots, query params and store keys. None may touch Object.prototype.
import { afterEach, describe, expect, it } from 'vitest';
import { createStore, query } from '@createstore/createstore';

const uid = () => Math.random().toString(36).slice(2, 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// JSON.parse makes "__proto__" an OWN property: the shape a real attacker's payload has
const hostile = (json: string) => JSON.parse(json);
const memory = (text: string | null) => ({ getItem: () => text, setItem: () => {} });

afterEach(() => {
  expect(({} as Record<string, unknown>).polluted, 'Object.prototype was polluted').toBeUndefined();
  expect(Object.keys(Object.prototype)).toEqual([]);
});

describe('prototype pollution', () => {
  const PAYLOAD = '"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},"evil":1';

  it('saved state, legacy format', async () => {
    const s = createStore({ n: 0 }, { name: `p-${uid()}`, persist: { storage: memory(`{${PAYLOAD},"n":5}`) } });
    await s.hydrated;
    expect(s.getState('n')).toBe(5);
    expect((s.getState() as Record<string, unknown>).evil).toBeUndefined();
  });

  it('saved state, versioned format', async () => {
    const s = createStore(
      { n: 0 },
      { name: `p-${uid()}`, persist: { storage: memory(`{"$version":0,"state":{${PAYLOAD},"n":6}}`) } },
    );
    await s.hydrated;
    expect(s.getState('n')).toBe(6);
  });

  it('saved state that is not JSON, or not an object, is ignored', async () => {
    for (const text of ['{not json', '42', 'null', '"__proto__"', '[]']) {
      const s = createStore({ n: 1 }, { name: `p-${uid()}`, persist: { storage: memory(text) } });
      await s.hydrated;
      expect(s.getState('n')).toBe(1);
    }
  });

  it('a message from another tab', async () => {
    const name = `p-${uid()}`;
    const s = createStore({ n: 1 }, { name, syncTabs: true });
    const ch = new BroadcastChannel(`createStore:${name}`);
    ch.postMessage({ type: 'state', stamp: [9999, 'zzz'], values: hostile(`{${PAYLOAD},"n":2}`) });
    await sleep(80);
    ch.close();
    expect(s.getState('n')).toBe(2); // the legitimate part still applies
    expect((s.getState() as Record<string, unknown>).evil).toBeUndefined();
    s.destroy();
  });

  it('a malformed message from another tab does nothing', async () => {
    const name = `p-${uid()}`;
    const s = createStore({ n: 1 }, { name, syncTabs: true });
    const ch = new BroadcastChannel(`createStore:${name}`);
    for (const bad of [null, 42, 'x', [], {}, { type: 'state' }, { type: 'state', values: 'x' }, { type: 'nope' }])
      ch.postMessage(bad);
    await sleep(80);
    ch.close();
    expect(s.getState('n')).toBe(1);
    s.destroy();
  });

  it("createScope refuses keys the store does not have (the server's own data is strict)", () => {
    const store = createStore({ n: 0 }, { name: `p-${uid()}`, ssr: true });
    expect(() => store.createScope(hostile(`{${PAYLOAD},"n":3}`))).toThrow(/not in the store/);
    expect(store.createScope(hostile('{"n":3,"$queries":{"__proto__":{"polluted":"yes"}}}')).getState('n')).toBe(3);
  });

  it('hydrate (the browser reading a server snapshot) keeps known keys and ignores the rest', () => {
    const store = createStore({ n: 0 }, { name: `p-${uid()}`, ssr: true });
    store.hydrate(hostile(`{${PAYLOAD},"n":4,"$queries":{"__proto__":{"polluted":"yes"}},"$ages":{"__proto__":1}}`));
    expect(store.getState('n')).toBe(4);
    expect((store.getState() as Record<string, unknown>).evil).toBeUndefined();
  });

  it('query params that look like pollution are just params', async () => {
    const s = createStore({ q: query(async (p: unknown) => p) });
    const out = await s.fetchQuery('q', hostile('{"__proto__":{"polluted":"yes"},"a":1}'));
    expect(out).toBeDefined();
  });

  it('initial state with a "__proto__" key', () => {
    expect(() => createStore(hostile(`{${PAYLOAD},"a":1}`))).not.toThrow();
  });
});

describe('store keys that are not state', () => {
  type Loose = { getState: (k: string) => unknown; setState: (k: string, v: unknown) => unknown };
  const NAMES = ['__proto__', 'constructor', 'prototype', 'toString', 'hasOwnProperty', 'valueOf'];

  it('setState refuses names inherited from Object.prototype', () => {
    const s = createStore({ a: 1 }) as unknown as Loose;
    for (const k of NAMES) expect(() => s.setState(k, 1), k).toThrow(/not in the store/);
  });

  // KNOWN ISSUE (src/createStore.ts:1442, `const state = { ...def.values }` is a normal object): getState('__proto__')
  // returns Object.prototype itself, and 'constructor' / 'toString' return the built-in functions. An app that passes a
  // user-controlled key to getState and then mutates the result pollutes every object. it.fails passes while the bug
  // exists and starts FAILING when it is fixed: then change it.fails to it.
  it.fails('getState returns undefined for names inherited from Object.prototype', () => {
    const s = createStore({ a: 1 }) as unknown as Loose;
    for (const k of NAMES) expect(s.getState(k), k).toBeUndefined();
  });
});

describe('data it must refuse', () => {
  it('validate() can reject values from storage and from other tabs', async () => {
    const validate = (k: string, v: unknown) => k !== 'n' || typeof v === 'number';
    const s = createStore(
      { n: 1 },
      { name: `p-${uid()}`, validate, persist: { storage: memory('{"n":"<img src=x onerror=alert(1)>"}') } },
    );
    await s.hydrated;
    expect(s.getState('n')).toBe(1);
  });
});
