// whenOnline(): tasks that wait for the connection replay one after another, in the order they were queued, exactly
// once; a destroyed store tells their callers instead of leaving them waiting forever.
import { afterEach, describe, expect, it } from 'vitest';
import { createStore } from '@createstore/createstore';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const setOnline = (value: boolean) => Object.defineProperty(navigator, 'onLine', { value, configurable: true });
const goOnline = () => {
  setOnline(true);
  window.dispatchEvent(new Event('online'));
};
afterEach(() => setOnline(true));

describe('offline queue', () => {
  it('replays queued tasks one after another, in the order they were queued', async () => {
    setOnline(false);
    const store = createStore({ n: 0 }) as any;
    const log: string[] = [];
    const task = (id: string, ms: number) =>
      store.whenOnline(async () => {
        log.push(`start ${id}`);
        await sleep(ms);
        log.push(`end ${id}`);
        return id;
      });
    const results = Promise.all([task('create', 40), task('update', 5), task('delete', 0)]);
    goOnline();
    expect(await results).toEqual(['create', 'update', 'delete']);
    expect(log).toEqual(['start create', 'end create', 'start update', 'end update', 'start delete', 'end delete']);
    store.destroy();
  });

  it('a task that fails does not stop the ones after it, and each caller gets its own result', async () => {
    setOnline(false);
    const store = createStore({ n: 0 }) as any;
    const first = store.whenOnline(async () => {
      throw new Error('server said no');
    });
    const second = store.whenOnline(() => 'second ran');
    const firstResult = first.then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    goOnline();
    expect(await firstResult).toBe('server said no');
    expect(await second).toBe('second ran');
    store.destroy();
  });

  it('a task that throws synchronously is a normal failure for its caller', async () => {
    setOnline(false);
    const store = createStore({ n: 0 }) as any;
    const p = store
      .whenOnline(() => {
        throw new Error('sync boom');
      })
      .catch((e: Error) => e.message);
    goOnline();
    expect(await p).toBe('sync boom');
    store.destroy();
  });

  it('each queued task runs exactly once, even if "online" fires twice', async () => {
    setOnline(false);
    const store = createStore({ n: 0 }) as any;
    let runs = 0;
    const p = store.whenOnline(() => {
      runs++;
    });
    goOnline();
    goOnline();
    await p;
    await sleep(20);
    expect(runs).toBe(1);
    store.destroy();
  });

  it('destroy() while tasks wait: their promises reject with a clear error and the tasks never run', async () => {
    setOnline(false);
    const store = createStore({ n: 0 }) as any;
    let ran = false;
    const outcome = store
      .whenOnline(() => {
        ran = true;
      })
      .then(
        () => 'resolved',
        (e: Error) => e.message,
      );
    store.destroy();
    expect(await outcome).toMatch(/destroy\(\) was called while this task waited for the connection, so it never ran/);
    goOnline();
    await sleep(20);
    expect(ran).toBe(false);
  });

  it('destroy() during the replay: the running task finishes, the ones not started yet are rejected', async () => {
    setOnline(false);
    const store = createStore({ n: 0 }) as any;
    const order: string[] = [];
    const slow = store.whenOnline(async () => {
      order.push('slow start');
      await sleep(50);
      order.push('slow end');
      return 'slow done';
    });
    const later = store
      .whenOnline(() => {
        order.push('later ran');
      })
      .then(
        () => 'resolved',
        (e: Error) => e.message,
      );
    goOnline();
    await sleep(10);
    store.destroy();
    expect(await slow).toBe('slow done');
    expect(await later).toMatch(/never ran/);
    expect(order).toEqual(['slow start', 'slow end']);
  });

  it('online: the task runs right away (unchanged)', async () => {
    setOnline(true);
    const store = createStore({ n: 0 }) as any;
    expect(await store.whenOnline(() => 42)).toBe(42);
    store.destroy();
  });

  it('after destroy(), whenOnline() rejects right away (unchanged)', async () => {
    const store = createStore({ n: 0 }) as any;
    store.destroy();
    await expect(store.whenOnline(() => 1)).rejects.toThrow(/whenOnline\(\) after destroy\(\)/);
  });
});
