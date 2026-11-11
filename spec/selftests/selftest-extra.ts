// Second batch of in-browser checks: saving callbacks, session storage, the offline queue and size limit,
// retry delays and concurrent requests. Same rules as selftest.ts: every test uses its own throwaway store.
import { createStore, query } from '@createstore/createstore';

type Test = [name: string, run: () => Promise<string | void>];

function expect(cond: unknown, detail: string): asserts cond {
  if (!cond) throw new Error(detail);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pretend the browser is offline/online (navigator.onLine can't be assigned, but it can be shadowed) */
function fakeOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value });
}
function restoreOnline() {
  delete (navigator as unknown as Record<string, unknown>).onLine;
}
function spyWarn() {
  const original = console.warn;
  const calls: string[] = [];
  console.warn = (...args: unknown[]) => { calls.push(args.map(String).join(' ')); };
  return { calls, restore: () => { console.warn = original; } };
}

export const extraTests: Test[] = [
  ['onSaveStart runs before the save, then onSaveSuccess or onSaveError', async () => {
    const order: string[] = [];
    let fail = false;
    const s = createStore({ n: 0 }, {
      keyActions: { n: { inc: { run: (c: number) => c + 1, save: async () => { order.push('save'); await sleep(10); if (fail) throw new Error('x'); } } } },
      onSaveStart: (k, a) => order.push(`start:${k}.${a}`),
      onSaveSuccess: (k, a) => order.push(`ok:${k}.${a}`),
      onSaveError: (k, a) => order.push(`err:${k}.${a}`),
    });
    await s.set.n.inc();
    fail = true;
    await s.set.n.inc().catch(() => {});
    const got = order.join(' ');
    expect(got === 'start:n.inc save ok:n.inc start:n.inc save err:n.inc', `order was: ${got}`);
    return got;
  }],

  ['persist "session": saved in sessionStorage, not localStorage', async () => {
    const name = `selftest-session-${Math.random().toString(36).slice(2, 7)}`;
    const a = createStore({ compact: false }, { name, persist: 'session' });
    await a.hydrated;
    await a.setState('compact', true);
    await sleep(30);
    const inSession = sessionStorage.getItem(`${name}:state`);
    const inLocal = localStorage.getItem(`${name}:state`);
    expect(inSession && inSession.includes('true'), `nothing in sessionStorage under "${name}"`);
    expect(inLocal === null, 'it must not touch localStorage');
    const b = createStore({ compact: false }, { name, persist: 'session' });
    await b.hydrated;
    expect(b.getState('compact') === true, 'a new store in the same tab should load it');
    sessionStorage.removeItem(`${name}:state`);
  }],

  ['offline.maxSize: a copy bigger than the limit is not saved, and the library warns once', async () => {
    const name = `selftest-offline-${Math.random().toString(36).slice(2, 7)}`;
    const big = query(async (_: undefined) => 'x'.repeat(5000));
    const small = query(async (_: undefined) => 'ok');
    const s = createStore({ big, small }, { name, offline: { maxSize: 1000 } });
    const warn = spyWarn();
    try {
      await s.fetchQuery('small', undefined);
      await sleep(20);
      const afterSmall = localStorage.getItem(`${name}:inline`);
      await s.fetchQuery('big', undefined);
      await sleep(20);
      const afterBig = localStorage.getItem(`${name}:inline`);
      expect(afterSmall !== null, 'the small copy should be saved');
      expect(afterBig === null, 'once the total is over maxSize the saved copy must be dropped, not kept stale');
      expect(warn.calls.some((c) => c.includes('offline.maxSize')), `expected a maxSize warning, got ${JSON.stringify(warn.calls)}`);
      return `warnings: ${warn.calls.length}`;
    } finally {
      warn.restore();
      localStorage.removeItem(`${name}:inline`);
      s.destroy();
    }
  }],

  ['whenOnline: several tasks wait offline, then run in order when back online; one failing does not stop the rest', async () => {
    const s = createStore({ a: 0 }, { name: 'selftest-queue' });
    const ran: string[] = [];
    fakeOnline(false);
    try {
      const p1 = s.whenOnline(async () => { ran.push('one'); return 1; });
      const p2 = s.whenOnline(async () => { ran.push('two'); throw new Error('boom'); });
      const p3 = s.whenOnline(() => { ran.push('three'); return 3; });
      await sleep(30);
      expect(ran.length === 0, `nothing may run while offline, ran: ${ran.join()}`);
      fakeOnline(true);
      window.dispatchEvent(new Event('online'));
      const [r1, r2, r3] = await Promise.allSettled([p1, p2, p3]);
      expect(ran.join() === 'one,two,three', `order was ${ran.join()}`);
      expect(r1.status === 'fulfilled' && r1.value === 1, 'first should resolve with 1');
      expect(r2.status === 'rejected', 'second should reject with its own error');
      expect(r3.status === 'fulfilled' && r3.value === 3, 'third should still run and resolve with 3');
      return `ran: ${ran.join(' → ')}`;
    } finally {
      restoreOnline();
      s.destroy();
    }
  }],

  ['whenOnline after destroy() rejects', async () => {
    const s = createStore({ a: 0 }, { name: 'selftest-queue-destroy' });
    s.destroy();
    let rejected = false;
    await s.whenOnline(() => 1).catch(() => { rejected = true; });
    expect(rejected, 'should reject');
  }],

  ['retryDelay as a function: gets the attempt number and sets the wait', async () => {
    const attempts: number[] = [];
    const stamps: number[] = [];
    const flaky = query(async (_: undefined) => {
      stamps.push(performance.now());
      if (stamps.length < 3) throw new Error('flaky');
      return 'fine';
    }, { retry: 3, retryDelay: (attempt: number) => { attempts.push(attempt); return 40 * attempt; } });
    const s = createStore({ flaky });
    const value = await s.fetchQuery('flaky', undefined);
    expect(value === 'fine', `got ${String(value)}`);
    expect(attempts.length === 2, `retryDelay should be asked twice, was asked ${attempts.length} times: ${attempts.join()}`);
    const gap1 = stamps[1] - stamps[0];
    const gap2 = stamps[2] - stamps[1];
    expect(gap1 >= 35 && gap2 >= 75, `gaps should be ≥40ms and ≥80ms, got ${Math.round(gap1)}ms and ${Math.round(gap2)}ms`);
    return `asked with ${attempts.join(', ')}; waited ${Math.round(gap1)}ms then ${Math.round(gap2)}ms`;
  }],

  ['concurrency: ten fetchQuery calls for one key make one request', async () => {
    let calls = 0;
    const slow = query(async (id: number) => { calls++; await sleep(30); return id * 2; });
    const s = createStore({ slow });
    const all = await Promise.all(Array.from({ length: 10 }, () => s.fetchQuery('slow', 21)));
    expect(calls === 1, `expected 1 request, got ${calls}`);
    expect(all.every((v) => v === 42), 'every caller should get 42');
  }],

  ['concurrency: different params fetch in parallel and stay separate', async () => {
    let running = 0;
    let peak = 0;
    const slow = query(async (id: number) => { running++; peak = Math.max(peak, running); await sleep(30); running--; return id; });
    const s = createStore({ slow });
    const got = await Promise.all([1, 2, 3, 4].map((i) => s.fetchQuery('slow', i)));
    expect(got.join() === '1,2,3,4', `got ${got.join()}`);
    expect(peak === 4, `expected 4 at once, saw ${peak}`);
  }],

  ['concurrency: an invalidate during a request makes one more request, and the newer answer wins', async () => {
    let n = 0;
    const counter = query(async (_: undefined) => { const mine = ++n; await sleep(30); return mine; });
    const s = createStore({ counter });
    const first = s.fetchQuery('counter', undefined);
    await sleep(5);
    await s.invalidate('counter');
    await first.catch(() => {});
    await sleep(80);
    const latest = await s.fetchQuery('counter', undefined);
    expect(n >= 2, `expected a second request, got ${n}`);
    expect(latest === n, `the stored value should be the newest answer (${n}), got ${latest}`);
    return `requests: ${n}, value: ${latest}`;
  }],

  ['concurrency: setQueryData while a fetch is running (which value is kept?)', async () => {
    const slow = query(async (_: undefined) => { await sleep(60); return 'from-server'; });
    const s = createStore({ slow });
    const pending = s.fetchQuery('slow', undefined, true);
    await sleep(10);
    s.setQueryData('slow', () => 'typed-by-user', undefined);
    await pending.catch(() => {});
    await sleep(20);
    const now = await s.fetchQuery('slow', undefined);
    return `after a fetch started before setQueryData, the value is "${now}"`;
  }],

  ['concurrency: 200 setState calls in a row all land, in order', async () => {
    const s = createStore({ log: [] as number[] });
    await Promise.all(Array.from({ length: 200 }, (_, i) => s.setState('log', (l) => [...l, i])));
    const log = s.getState('log');
    expect(log.length === 200, `expected 200 entries, got ${log.length}`);
    expect(log.every((v, i) => v === i), 'entries are out of order');
  }],

  ['concurrency: two failing saves at once roll back to the value before either', async () => {
    const s = createStore({ n: 0 }, {
      keyActions: { n: { inc: { run: (c: number) => c + 1, save: async () => { await sleep(20); throw new Error('no'); } } } },
    });
    await Promise.allSettled([s.set.n.inc(), s.set.n.inc()]);
    expect(s.getState('n') === 0, `expected 0 after both fail, got ${s.getState('n')}`);
  }],

  ['concurrency: abort() cancels a request that is waiting to retry', async () => {
    let calls = 0;
    const down = query(async (_: undefined, signal: AbortSignal) => { calls++; if (signal.aborted) throw new Error('aborted'); throw new Error('down'); }, { retry: 5, retryDelay: () => 200 });
    const s = createStore({ down });
    const p = s.fetchQuery('down', undefined).catch((e) => e);
    await sleep(60);
    s.abort('down');
    const result = await Promise.race([p, sleep(700).then(() => 'still running after 700ms')]);
    expect(result !== 'still running after 700ms', 'abort() should end the retry loop');
    expect(calls <= 2, `no more requests after abort, saw ${calls}`);
    return `requests before abort: ${calls}`;
  }],
];
