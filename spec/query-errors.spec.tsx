// A paged query's pages.next() is the caller's code. If it throws on a response (an unexpected shape is enough),
// the query must end in an error state like any other failed request, never stay "loading" forever.
import { describe, it, expect } from 'vitest';
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore, query } from '@createstore/createstore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Status = {
  state: string;
  error: unknown;
  fetching: boolean;
  isFetchingNextPage: boolean;
  hasNextPage: boolean;
  fetchNextPage: () => Promise<void>;
  refetch: () => Promise<void>;
};
type Seen = { pages: { items: number[] }[]; st: Status };

/** A 3-page feed. `next` throws while `broken.on` is true, for the pages listed in `broken.at` (default: every page). */
function feedStore(opts: { refresh?: 'first' | 'loaded' } = {}) {
  const broken = { on: true, at: null as number | null };
  const store = createStore({
    feed: query(async (page: number) => ({ items: [page], nextPage: page < 3 ? page + 1 : null }), {
      pages: {
        first: 1,
        next: (last: { items: number[]; nextPage: number | null }) => {
          if (broken.on && (broken.at === null || broken.at === last.items[0])) throw new Error('bad shape');
          return last.nextPage;
        },
        ...(opts.refresh ? { refresh: opts.refresh } : {}),
      },
    } as never),
  } as never) as any;
  return { store, broken };
}

async function mount(store: any, key = 'feed') {
  const seen: { current: Seen | null } = { current: null };
  const C = () => {
    const [pages, , st] = store.useGlobalState(key);
    seen.current = { pages, st };
    return h('i', null, st.state);
  };
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(h(C)));
  return { seen, unmount: () => act(async () => root.unmount()) };
}
const waitFor = async (cond: () => boolean, ms = 1500) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
};

describe('paged query: pages.next() that throws', () => {
  it('on the first response: the hook reaches an error state instead of loading forever', async () => {
    const { store } = feedStore();
    const view = await mount(store);
    await waitFor(() => view.seen.current?.st.state !== 'loading');
    const { st } = view.seen.current!;
    expect(st.state).toBe('error');
    expect((st.error as Error).message).toBe('bad shape');
    expect(st.fetching).toBe(false);
    await view.unmount();
  });

  it('and the query recovers: once the response is handled, refetch() loads the data', async () => {
    const { store, broken } = feedStore();
    const view = await mount(store);
    await waitFor(() => view.seen.current?.st.state === 'error');
    broken.on = false;
    await act(async () => {
      await view.seen.current!.st.refetch();
    });
    await waitFor(() => view.seen.current?.st.state === 'ready');
    expect(view.seen.current!.st.state).toBe('ready');
    expect(view.seen.current!.pages.map((p) => p.items[0])).toEqual([1]);
    expect(view.seen.current!.st.error).toBeNull();
    await view.unmount();
  });

  it('on a later page: the pages already loaded are kept and "loading more" stops', async () => {
    const { store, broken } = feedStore();
    broken.on = false;
    const view = await mount(store);
    await waitFor(() => view.seen.current?.st.state === 'ready');
    expect(view.seen.current!.st.hasNextPage).toBe(true);
    broken.on = true; // page 2's response is the one whose next() throws
    broken.at = 2;
    await act(async () => {
      await view.seen.current!.st.fetchNextPage();
    });
    await waitFor(() => !view.seen.current!.st.isFetchingNextPage);
    const { pages, st } = view.seen.current!;
    expect(st.isFetchingNextPage).toBe(false);
    expect(st.fetching).toBe(false);
    expect((st.error as Error)?.message).toBe('bad shape');
    expect(pages.map((p) => p.items[0])).toEqual([1]); // page 1 is still shown
    await view.unmount();
  });

  it('through fetchQuery(): the promise rejects with the thrown error, and the next call is not stuck on the failed one', async () => {
    const { store, broken } = feedStore();
    await expect(store.fetchQuery('feed')).rejects.toThrow('bad shape');
    broken.on = false;
    const data = await store.fetchQuery('feed');
    expect(data.pages.map((p: { items: number[] }) => p.items[0])).toEqual([1]);
  });

  it('with refresh: "loaded": an error while refetching the loaded pages is reported too', async () => {
    const { store, broken } = feedStore({ refresh: 'loaded' });
    broken.on = false;
    const view = await mount(store);
    await waitFor(() => view.seen.current?.st.state === 'ready');
    await act(async () => {
      await view.seen.current!.st.fetchNextPage();
    });
    await waitFor(() => view.seen.current!.pages.length === 2);
    broken.on = true;
    broken.at = null;
    await act(async () => {
      await view.seen.current!.st.refetch().catch(() => {});
    });
    await waitFor(() => !view.seen.current!.st.fetching);
    expect(view.seen.current!.st.fetching).toBe(false);
    expect((view.seen.current!.st.error as Error)?.message).toBe('bad shape');
    await view.unmount();
  });

  it('control: a healthy paged query still loads every page', async () => {
    const { store, broken } = feedStore();
    broken.on = false;
    const view = await mount(store);
    await waitFor(() => view.seen.current?.st.state === 'ready');
    for (let i = 0; i < 2; i++) {
      await act(async () => {
        await view.seen.current!.st.fetchNextPage();
      });
      await waitFor(() => view.seen.current!.pages.length === i + 2);
    }
    expect(view.seen.current!.pages.map((p) => p.items[0])).toEqual([1, 2, 3]);
    expect(view.seen.current!.st.hasNextPage).toBe(false);
    expect(view.seen.current!.st.error).toBeNull();
    await view.unmount();
  });

  it('seeded random scenarios: never stuck loading, and the pages and error always match a simple model', async () => {
    const rng = (a: number) => () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const R = rng(20241115);
    let checked = 0;
    for (let scenario = 0; scenario < 40; scenario++) {
      const total = 2 + Math.floor(R() * 4); // 2..5 pages exist
      const throwAt = R() < 0.25 ? 0 : 1 + Math.floor(R() * total); // 0 = next() never throws; else it throws on that page's response
      const store = createStore({
        feed: query(async (page: number) => ({ items: [page], nextPage: page < total ? page + 1 : null }), {
          pages: {
            first: 1,
            next: (last: { items: number[]; nextPage: number | null }) => {
              if (last.items[0] === throwAt) throw new Error(`bad page ${throwAt}`);
              return last.nextPage;
            },
          },
        } as never),
      } as never) as any;
      const view = await mount(store);
      // model: pages loaded so far, and whether the last operation failed
      let loaded = 0;
      let failed = false;
      const idle = () =>
        !view.seen.current!.st.fetching &&
        !view.seen.current!.st.isFetchingNextPage &&
        view.seen.current!.st.state !== 'loading';
      await waitFor(idle);
      expect(idle(), `scenario ${scenario}: first load never finished (total ${total}, throwAt ${throwAt})`).toBe(true);
      if (throwAt === 1) {
        failed = true;
      } else {
        loaded = 1;
      }
      const check = (op: string) => {
        const { pages, st } = view.seen.current!;
        const where = `scenario ${scenario} (total ${total}, throwAt ${throwAt}) after ${op}`;
        expect(st.fetching || st.isFetchingNextPage, `${where}: stuck fetching`).toBe(false);
        expect(pages.length, `${where}: pages shown`).toBe(loaded);
        expect(st.error != null, `${where}: error state`).toBe(failed);
        if (failed) expect((st.error as Error).message).toBe(`bad page ${throwAt}`);
        checked++;
      };
      check('first load');
      for (let op = 0; op < 5; op++) {
        if (R() < 0.7) {
          if (!view.seen.current!.st.hasNextPage && !failed) continue; // nothing more to load
          await act(async () => {
            await view.seen.current!.st.fetchNextPage();
          });
          await waitFor(idle);
          const next = loaded + 1;
          if (loaded > 0 && next <= total) {
            if (next === throwAt) failed = true;
            else {
              loaded = next;
              failed = false;
            }
          }
          check(`fetchNextPage (page ${next})`);
        }
      }
      await view.unmount();
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('control: an ordinary query whose fetch rejects still ends in an error state', async () => {
    const store = createStore({
      q: query(
        async () => {
          throw new Error('server said no');
        },
        { retry: 0 } as never,
      ),
    } as never) as any;
    const view = await mount(store, 'q');
    await waitFor(() => view.seen.current?.st.state === 'error');
    expect((view.seen.current!.st.error as Error).message).toBe('server said no');
    await view.unmount();
  });
});
