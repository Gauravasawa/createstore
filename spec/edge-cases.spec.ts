import { describe, it, expect } from 'vitest';
import { createStore, query, serializeSnapshot } from '@createstore/createstore';

describe('empty / undefined / null', () => {
  it('accepts an empty state', () => expect(() => createStore({})).not.toThrow());
  it('getState of an unknown key is undefined', () =>
    expect((createStore({ a: 1 }) as any).getState('zzz')).toBeUndefined());
  it('setState of an unknown key throws a clear message (synchronously, though typed as a Promise)', () => {
    expect(() => (createStore({ a: 1 }) as any).setState('zzz', 1)).toThrow(/not in the store/);
  });
  it('stores undefined and null as given', async () => {
    const s = createStore({ a: 1 as number | null | undefined });
    await s.setState('a', undefined);
    expect(s.getState('a')).toBeUndefined();
    await s.setState('a', null);
    expect(s.getState('a')).toBeNull();
  });
});

describe('malformed input', () => {
  it('query() rejects a non-function', () => expect(() => (query as any)('x')).toThrow(/must be a function/));
  it('query() rejects an unknown option', () =>
    expect(() => query(async () => 1, { bogus: 1 } as any)).toThrow(/no option "bogus"/));
  it('paged query needs pages.first', () =>
    expect(() => query(async () => 1, { pages: { next: () => null } } as any)).toThrow(/needs first/));
  it('circular query params are refused, not cached', async () => {
    const s = createStore({ q: query(async (_p: unknown) => 1) });
    const o: Record<string, unknown> = {};
    o.o = o;
    await expect(s.fetchQuery('q', o)).rejects.toThrow(/circular/);
  });
  it('fetchQuery of an unknown query names it', async () => {
    await expect((createStore({ a: 1 }) as any).fetchQuery('nope')).rejects.toThrow(/"nope" is not in the store/);
  });
  it('serializeSnapshot escapes everything that could end a <script> tag', () => {
    const sep = String.fromCharCode(0x2028) + String.fromCharCode(0x2029) + '&';
    const out = serializeSnapshot({ a: '</script><!--', b: sep });
    expect(
      /[<>&]/.test(out) || out.includes(String.fromCharCode(0x2028)) || out.includes(String.fromCharCode(0x2029)),
    ).toBe(false);
    expect(JSON.parse(out)).toEqual({ a: '</script><!--', b: sep });
  });
});

describe('concurrency', () => {
  it('1000 concurrent updater writes lose nothing', async () => {
    const s = createStore({ n: 0 });
    await Promise.all(Array.from({ length: 1000 }, () => s.setState('n', (x) => x + 1)));
    expect(s.getState('n')).toBe(1000);
  });
  it('50 concurrent fetchQuery calls make one request', async () => {
    let calls = 0;
    const s = createStore({
      q: query(async (_p: undefined) => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return 7;
      }),
    });
    const out = await Promise.all(Array.from({ length: 50 }, () => s.fetchQuery('q')));
    expect(calls).toBe(1);
    expect(new Set(out)).toEqual(new Set([7]));
  });
});

describe('large payloads and memory pressure', () => {
  it('holds a 1,000,000-item array', async () => {
    const s = createStore({ a: [] as number[] });
    await s.setState(
      'a',
      Array.from({ length: 1e6 }, (_, i) => i),
    );
    expect(s.getState('a')).toHaveLength(1e6);
  });
  it('serializes a 5 MB string', () => expect(serializeSnapshot({ s: 'x'.repeat(5e6) }).length).toBeGreaterThan(5e6));
  it('creating and destroying 2,000 stores works', () => {
    for (let i = 0; i < 2000; i++) {
      const s = createStore({ a: i });
      s.destroy();
    }
  });
});
