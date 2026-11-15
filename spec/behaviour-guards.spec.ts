// Behaviour that worked but that no test checked: in the audit's mutation run, each of these could be broken without
// any test failing. One test per guard.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore, query } from '@createstore/createstore';

const uid = () => Math.random().toString(36).slice(2, 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
afterEach(() => vi.restoreAllMocks());

describe('update-loop guard', () => {
  it('a listener that keeps updating the key it listens to stops after 100 nested updates, is reported once, and the store still works', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = createStore({ n: 0 }, { name: `loop-${uid()}` });
    let calls = 0;
    const off = s.subscribe((e) => {
      calls++;
      s.setState('n', (e.next as number) + 1);
    });
    s.setState('n', 1);
    expect(calls).toBe(100);
    expect(s.getState('n')).toBe(100);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0].join(' '))).toMatch(/update loop: 100 updates happened inside each other/);
    off();
    s.setState('n', 0);
    expect(s.getState('n')).toBe(0);
  });
});

describe('cross-tab messages', () => {
  it('a stamp that is not a safe, non-negative integer pair is ignored', async () => {
    const name = `stamp-${uid()}`;
    const s = createStore({ n: 1 }, { name, syncTabs: true });
    const ch = new BroadcastChannel(`createStore:${name}`);
    for (const stamp of [
      [1.5, 't'],
      [-1, 't'],
      [1e300, 't'],
      [Number.MAX_SAFE_INTEGER + 2, 't'],
      ['5', 't'],
      [5, 7],
      [5],
      [5, 't', 'x'],
      'x',
      null,
    ])
      ch.postMessage({ type: 'state', stamp, values: { n: 99 } });
    await sleep(80);
    expect(s.getState('n')).toBe(1);
    ch.postMessage({ type: 'state', stamp: [5, 't'], values: { n: 2 } }); // and a valid one still applies
    await sleep(80);
    ch.close();
    expect(s.getState('n')).toBe(2);
    s.destroy();
  });

  it('syncTabs.exclude: an excluded key sent by another tab is ignored, the others apply', async () => {
    const name = `excl-${uid()}`;
    const s = createStore({ n: 1, token: 'mine' }, { name, syncTabs: { exclude: ['token'] } });
    const ch = new BroadcastChannel(`createStore:${name}`);
    ch.postMessage({ type: 'state', stamp: [5, 'zz'], values: { token: 'evil', n: 2 } });
    await sleep(80);
    ch.close();
    expect(s.getState('token')).toBe('mine');
    expect(s.getState('n')).toBe(2);
    s.destroy();
  });

  it('syncTabs.keys: a key outside the list is ignored', async () => {
    const name = `keys-${uid()}`;
    const s = createStore({ n: 1, token: 'mine' }, { name, syncTabs: { keys: ['n'] } });
    const ch = new BroadcastChannel(`createStore:${name}`);
    ch.postMessage({ type: 'state', stamp: [5, 'zz'], values: { token: 'evil', n: 3 } });
    await sleep(80);
    ch.close();
    expect([s.getState('token'), s.getState('n')]).toEqual(['mine', 3]);
    s.destroy();
  });

  it('a change received from another tab is never sent on again (no echo between tabs)', async () => {
    const name = `echo-${uid()}`;
    const A = createStore({ n: 0 }, { name, syncTabs: true });
    const B = createStore({ n: 0 }, { name, syncTabs: true });
    const listener = new BroadcastChannel(`createStore:${name}`);
    const seen: unknown[] = [];
    listener.onmessage = (e) => {
      if ((e.data as { type?: string })?.type === 'state') seen.push(e.data);
    };
    A.setState('n', 1);
    await sleep(120);
    listener.close();
    expect(B.getState('n')).toBe(1);
    expect(seen).toHaveLength(1); // A's message only; B applied it without re-broadcasting
    A.destroy();
    B.destroy();
  });
});

describe('the single change path ignores keys the store does not have', () => {
  it('Redux DevTools time travel with an unknown key: known keys apply, the unknown one never enters the state', () => {
    let listener: ((m: unknown) => void) | undefined;
    const ext = {
      connect: () => ({
        init() {},
        send() {},
        subscribe: (l: (m: unknown) => void) => {
          listener = l;
          return () => {};
        },
      }),
    };
    (window as any).__REDUX_DEVTOOLS_EXTENSION__ = ext;
    try {
      const s = createStore({ n: 0 }, { name: `dev-${uid()}`, devtools: true });
      expect(listener).toBeTypeOf('function');
      listener!({ type: 'DISPATCH', payload: { type: 'JUMP_TO_STATE' }, state: JSON.stringify({ n: 5, nope: 1 }) });
      expect(s.getState('n')).toBe(5);
      expect(Object.keys(s.getState() as object)).toEqual(['n']);
      s.destroy();
    } finally {
      delete (window as any).__REDUX_DEVTOOLS_EXTENSION__;
    }
  });
});

describe('query defaults and limits', () => {
  it('query params with far more than 10,000 values are rejected; small ones are fine', async () => {
    const s = createStore({ q: query(async (p: unknown) => p) } as never) as any;
    await expect(
      s.fetchQuery(
        'q',
        Array.from({ length: 20_000 }, (_, i) => i),
      ),
    ).rejects.toThrow(/too large \(more than 10,000 values\)/);
    await expect(
      s.fetchQuery(
        'q',
        Array.from({ length: 100 }, (_, i) => i),
      ),
    ).resolves.toHaveLength(100);
  });

  it('a failing query is tried 3 times by default (2 retries)', async () => {
    let calls = 0;
    const s = createStore({
      q: query(
        async () => {
          calls++;
          throw new Error('down');
        },
        { retryDelay: () => 1 } as never,
      ),
    } as never) as any;
    await expect(s.fetchQuery('q', 1)).rejects.toThrow('down');
    expect(calls).toBe(3);
  });
});

describe('history limit', () => {
  it('history: { limit: 3 } keeps exactly 3 undo steps', () => {
    const s = createStore({ n: 0 }, { name: `hist-${uid()}`, history: { limit: 3 } });
    for (let i = 1; i <= 6; i++) s.setState('n', i);
    let undos = 0;
    while (s.getHistory().canUndo && undos < 10) {
      s.undo();
      undos++;
    }
    expect(undos).toBe(3);
    expect(s.getState('n')).toBe(3);
  });
});
