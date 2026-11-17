// Who re-renders when one key changes. Every component counts its own renders, so each test can say exactly which
// components rendered again and which were left alone. The promise under test: a component re-renders only when
// something it reads changes, never because another key changed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h, act, memo, startTransition, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore, query } from '@createstore/createstore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const uid = () => Math.random().toString(36).slice(2, 8);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

type Counts = Record<string, number>;
// A component that reads with `read`, shows what it read, and counts its renders under `id`
function counted(counts: Counts, id: string, read: () => unknown) {
  counts[id] = 0;
  return function Counted() {
    counts[id]++;
    const v = read();
    return h('i', { id }, typeof v === 'object' ? JSON.stringify(v) : String(v));
  };
}
async function mount(...components: (() => unknown)[]) {
  const el = document.createElement('div');
  document.body.append(el);
  const root = createRoot(el);
  await act(async () => root.render(h('div', null, ...components.map((C, i) => h(C as never, { key: i })))));
  return {
    el,
    root,
    text: (id: string) => el.querySelector(`#${id}`)!.textContent,
    unmount: () => act(async () => root.unmount()),
  };
}
// Renders since `before`, per component
const since = (counts: Counts, before: Counts) =>
  Object.fromEntries(Object.keys(counts).map((k) => [k, counts[k] - before[k]]));

describe('key form: useGlobalState(key)', () => {
  it('changing one key re-renders only the readers of that key, in both directions', async () => {
    const s = createStore({ a: 0, b: 0, c: 0 }, { name: `iso-${uid()}` });
    const n: Counts = {};
    const m = await mount(
      counted(n, 'A', () => s.useGlobalState('a')[0]),
      counted(n, 'B', () => s.useGlobalState('b')[0]),
      counted(n, 'C', () => s.useGlobalState('c')[0]),
    );
    expect(n).toEqual({ A: 1, B: 1, C: 1 });

    let before = { ...n };
    await act(async () => s.setState('b', 1));
    expect(since(n, before)).toEqual({ A: 0, B: 1, C: 0 });
    expect(m.text('B')).toBe('1');

    before = { ...n };
    await act(async () => s.setState('a', 1));
    expect(since(n, before)).toEqual({ A: 1, B: 0, C: 0 });

    // 50 changes to b: A and C are never touched
    before = { ...n };
    for (let i = 2; i < 52; i++) await act(async () => s.setState('b', i));
    expect(since(n, before)).toEqual({ A: 0, B: 50, C: 0 });
    expect(m.text('B')).toBe('51');
    await m.unmount();
  });

  it('every way of writing a key re-renders only its readers: setter, updater function, set.key, actions, setState with an object', async () => {
    const s = createStore({ a: 0, b: 0 }, {
      name: `iso-${uid()}`,
      actions: (set: any) => ({ bumpB: () => set.b((x: number) => x + 1) }),
    } as never) as any;
    const n: Counts = {};
    let setB!: (v: unknown) => void;
    const m = await mount(
      counted(n, 'A', () => s.useGlobalState('a')[0]),
      counted(n, 'B', () => {
        const [b, set] = s.useGlobalState('b');
        setB = set;
        return b;
      }),
    );
    const writes: [string, () => unknown][] = [
      ['setter with a value', () => setB(10)],
      ['setter with an updater', () => setB((x: number) => x + 1)],
      ['setState(key, value)', () => s.setState('b', 20)],
      ['setState(key, updater)', () => s.setState('b', (x: number) => x + 1)],
      ['set.b(value)', () => s.set.b(30)],
      ['an action', () => s.actions.bumpB()],
    ];
    for (const [how, write] of writes) {
      const before = { ...n };
      await act(async () => {
        await write();
      });
      expect([how, since(n, before)]).toEqual([how, { A: 0, B: 1 }]);
    }
    expect(m.text('B')).toBe('31');
    await m.unmount();
  });

  it('writing the same value again (Object.is) re-renders nobody', async () => {
    const obj = { x: 1 };
    const s = createStore({ a: 0, o: obj, nan: NaN }, { name: `iso-${uid()}` });
    const n: Counts = {};
    const m = await mount(
      counted(n, 'A', () => s.useGlobalState('a')[0]),
      counted(n, 'O', () => s.useGlobalState('o')[0]),
      counted(n, 'N', () => s.useGlobalState('nan')[0]),
    );
    const before = { ...n };
    await act(async () => {
      await s.setState('a', 0);
      await s.setState('o', obj); // same reference
      await s.setState('nan', NaN); // Object.is(NaN, NaN)
      await s.setState('a', (x: number) => x);
    });
    expect(since(n, before)).toEqual({ A: 0, O: 0, N: 0 });
    await m.unmount();
  });

  it('several keys changed in one batch re-render each reader once, and readers of other keys not at all', async () => {
    const s = createStore({ a: 0, b: 0, c: 0 }, { name: `iso-${uid()}` }) as any;
    const n: Counts = {};
    const m = await mount(
      counted(n, 'A', () => s.useGlobalState('a')[0]),
      counted(n, 'B', () => s.useGlobalState('b')[0]),
      counted(n, 'C', () => s.useGlobalState('c')[0]),
      counted(n, 'AB', () => `${s.useGlobalState('a')[0]}-${s.useGlobalState('b')[0]}`),
    );
    const before = { ...n };
    await act(async () => {
      s.batch(() => {
        s.setState('a', 1);
        s.setState('b', 1);
        s.setState('a', 2);
      });
    });
    expect(since(n, before)).toEqual({ A: 1, B: 1, C: 0, AB: 1 });
    expect(m.text('AB')).toBe('2-1');
    await m.unmount();
  });

  it('a component that only takes the setter still re-renders when its key changes (the hook subscribes to the value)', async () => {
    // Documented as it is, not as one might hope: [, setA] still subscribes to a. To write without
    // subscribing, call store.setState / store.set / an action instead of the hook.
    const s = createStore({ a: 0, b: 0 }, { name: `iso-${uid()}` });
    const n: Counts = {};
    const m = await mount(
      counted(n, 'SetterOnly', () => {
        s.useGlobalState('a');
        return 'button';
      }),
    );
    let before = { ...n };
    await act(async () => s.setState('a', 1));
    expect(since(n, before)).toEqual({ SetterOnly: 1 });
    before = { ...n };
    await act(async () => s.setState('b', 1));
    expect(since(n, before)).toEqual({ SetterOnly: 0 }); // but never for another key
    await m.unmount();
  });

  it('1,000 components on 1,000 keys: one change renders exactly one component', async () => {
    const N = 1000;
    const init = Object.fromEntries(Array.from({ length: N }, (_, i) => [`k${i}`, 0]));
    const s = createStore(init, { name: `iso-${uid()}` }) as any;
    let renders = 0;
    const Cell = memo(({ k }: { k: string }) => {
      renders++;
      return h('i', null, String(s.useGlobalState(k)[0]));
    });
    const el = document.createElement('div');
    const root = createRoot(el);
    await act(async () => root.render(h('div', null, ...Object.keys(init).map((k) => h(Cell, { key: k, k })))));
    expect(renders).toBe(N);
    for (const i of [0, 499, 999, 3, 777]) {
      renders = 0;
      await act(async () => s.setState(`k${i}`, 1));
      expect([i, renders]).toEqual([i, 1]);
    }
    await act(async () => root.unmount());
  });

  it('a low-priority update (startTransition) to b does not render the reader of a either', async () => {
    const s = createStore({ a: 0, b: 0 }, { name: `iso-${uid()}` });
    const n: Counts = {};
    const m = await mount(
      counted(n, 'A', () => s.useGlobalState('a')[0]),
      counted(n, 'B', () => s.useGlobalState('b')[0]),
    );
    const before = { ...n };
    await act(async () => {
      for (let i = 1; i <= 20; i++) startTransition(() => void s.setState('b', i));
    });
    expect(n.A - before.A).toBe(0);
    expect(m.text('B')).toBe('20');
    await m.unmount();
  });

  it('under StrictMode (double renders) the isolation still holds: changing b never renders A', async () => {
    const s = createStore({ a: 0, b: 0 }, { name: `iso-${uid()}` });
    const n: Counts = {};
    const A = counted(n, 'A', () => s.useGlobalState('a')[0]);
    const B = counted(n, 'B', () => s.useGlobalState('b')[0]);
    const el = document.createElement('div');
    const root = createRoot(el);
    await act(async () => root.render(h(StrictMode, null, h(A), h(B))));
    const before = { ...n };
    await act(async () => s.setState('b', 1));
    expect(n.A - before.A).toBe(0);
    expect(n.B - before.B).toBeGreaterThan(0);
    await act(async () => root.unmount());
  });

  it('undo, redo and reset re-render only the readers of the keys they change', async () => {
    const s = createStore({ a: 0, b: 0 }, { name: `iso-${uid()}`, history: true }) as any;
    const n: Counts = {};
    const m = await mount(
      counted(n, 'A', () => s.useGlobalState('a')[0]),
      counted(n, 'B', () => s.useGlobalState('b')[0]),
    );
    await act(async () => s.setState('b', 5));
    let before = { ...n };
    await act(async () => s.undo());
    expect(since(n, before)).toEqual({ A: 0, B: 1 });
    before = { ...n };
    await act(async () => s.redo());
    expect(since(n, before)).toEqual({ A: 0, B: 1 });
    before = { ...n };
    await act(async () => s.reset()); // a is still at its initial value, so only b changes
    expect(since(n, before)).toEqual({ A: 0, B: 1 });
    expect(m.text('B')).toBe('0');
    await m.unmount();
  });

  it('a change that arrives from another tab (syncTabs) re-renders only the readers of that key', async () => {
    const name = `iso-tabs-${uid()}`;
    const s = createStore({ a: 0, b: 0 }, { name, syncTabs: true });
    const n: Counts = {};
    const m = await mount(
      counted(n, 'A', () => s.useGlobalState('a')[0]),
      counted(n, 'B', () => s.useGlobalState('b')[0]),
    );
    const before = { ...n };
    const ch = new BroadcastChannel(`createStore:${name}`);
    await act(async () => {
      ch.postMessage({ type: 'state', stamp: [5, 'zz'], values: { b: 7 } });
      await sleep(80);
    });
    ch.close();
    expect(since(n, before)).toEqual({ A: 0, B: 1 });
    expect(m.text('B')).toBe('7');
    s.destroy();
    await m.unmount();
  });

  it('a scope (createScope + Root) is isolated too: changing the app store does not render scope readers, and keys stay separate inside the scope', async () => {
    const s = createStore({ a: 0, b: 0 }, { name: `iso-${uid()}`, ssr: true }) as any;
    const scope = s.createScope({ a: 100, b: 100 });
    const n: Counts = {};
    const A = counted(n, 'A', () => s.useGlobalState('a')[0]);
    const B = counted(n, 'B', () => s.useGlobalState('b')[0]);
    const el = document.createElement('div');
    const root = createRoot(el);
    await act(async () => root.render(h(s.Root, { scope }, h(A), h(B))));
    let before = { ...n };
    await act(async () => s.setState('a', 1)); // the app store, not the scope
    expect(since(n, before)).toEqual({ A: 0, B: 0 });
    before = { ...n };
    await act(async () => scope.setState('b', 101));
    expect(since(n, before)).toEqual({ A: 0, B: 1 });
    expect(el.textContent).toBe('100101');
    await act(async () => root.unmount());
  });
});

describe('the unit is the top-level key: objects', () => {
  it('changing one field of an object key re-renders every reader of that key, whatever field it shows', async () => {
    const s = createStore({ user: { name: 'ada', avatar: 'a.png' }, other: 0 }, { name: `iso-${uid()}` });
    const n: Counts = {};
    const m = await mount(
      counted(n, 'Name', () => s.useGlobalState('user')[0].name),
      counted(n, 'Other', () => s.useGlobalState('other')[0]),
    );
    const before = { ...n };
    await act(async () => s.setState('user', (u) => ({ ...u, avatar: 'b.png' })));
    expect(since(n, before)).toEqual({ Name: 1, Other: 0 }); // Name re-rendered though the name didn't change
    await m.unmount();
  });

  it('useGlobalState(key, selector) narrows it to a field: other fields changing re-render nothing', async () => {
    const s = createStore({ user: { name: 'ada', avatar: 'a.png' } }, { name: `iso-${uid()}` });
    const n: Counts = {};
    const m = await mount(
      counted(n, 'Name', () => s.useGlobalState('user', (u) => u.name)),
      counted(n, 'Avatar', () => s.useGlobalState('user', (u) => u.avatar)),
    );
    let before = { ...n };
    await act(async () => s.setState('user', (u) => ({ ...u, avatar: 'b.png' })));
    expect(since(n, before)).toEqual({ Name: 0, Avatar: 1 });
    before = { ...n };
    await act(async () => s.setState('user', (u) => ({ ...u, name: 'grace' })));
    expect(since(n, before)).toEqual({ Name: 1, Avatar: 0 });
    expect(m.text('Name')).toBe('grace');
    await m.unmount();
  });

  it('a key selector returning a new object with the same fields (shallow-equal) does not re-render', async () => {
    const s = createStore({ user: { name: 'ada', age: 36, avatar: 'a.png' } }, { name: `iso-${uid()}` });
    const n: Counts = {};
    const m = await mount(counted(n, 'Card', () => s.useGlobalState('user', (u) => ({ name: u.name, age: u.age }))));
    const before = { ...n };
    await act(async () => s.setState('user', (u) => ({ ...u, avatar: 'b.png' })));
    expect(n.Card - before.Card).toBe(0);
    await m.unmount();
  });

  it('a selector that builds a new nested array each time does re-render (the comparison is shallow, one level)', async () => {
    // The known limit, pinned: one level deep only. Return the array itself (u.tags) instead of a copy to avoid it.
    const s = createStore({ user: { tags: ['x'], avatar: 'a.png' } }, { name: `iso-${uid()}` });
    const n: Counts = {};
    const m = await mount(
      counted(n, 'Copy', () => s.useGlobalState('user', (u) => ({ tags: [...u.tags] }))),
      counted(n, 'Same', () => s.useGlobalState('user', (u) => ({ tags: u.tags }))),
    );
    const before = { ...n };
    await act(async () => s.setState('user', (u) => ({ ...u, avatar: 'b.png' })));
    expect(since(n, before)).toEqual({ Copy: 1, Same: 0 });
    await m.unmount();
  });
});

describe('store selector form: useGlobalState((state) => ...)', () => {
  it('subscribes to the keys the selector read and nothing else (destructuring, get(), and state.key)', async () => {
    const s = createStore({ a: 1, b: 2, c: 3 }, { name: `iso-${uid()}` });
    const n: Counts = {};
    const m = await mount(
      counted(n, 'Destructure', () => s.useGlobalState(({ a, b }) => a + b)),
      counted(n, 'Get', () => s.useGlobalState((get: any) => get('a') * 10)),
      counted(n, 'Dot', () => s.useGlobalState((state) => state.b)),
    );
    let before = { ...n };
    await act(async () => s.setState('c', 30));
    expect(since(n, before)).toEqual({ Destructure: 0, Get: 0, Dot: 0 });
    before = { ...n };
    await act(async () => s.setState('a', 5));
    expect(since(n, before)).toEqual({ Destructure: 1, Get: 1, Dot: 0 });
    before = { ...n };
    await act(async () => s.setState('b', 6));
    expect(since(n, before)).toEqual({ Destructure: 1, Get: 0, Dot: 1 });
    expect([m.text('Destructure'), m.text('Get'), m.text('Dot')]).toEqual(['11', '50', '6']);
    await m.unmount();
  });

  it('a selector whose result does not change does not re-render, even though a key it reads changed', async () => {
    const s = createStore({ n: 1 }, { name: `iso-${uid()}` });
    const counts: Counts = {};
    const m = await mount(counted(counts, 'Odd', () => s.useGlobalState(({ n }) => n % 2 === 1)));
    let before = { ...counts };
    await act(async () => s.setState('n', 3)); // still odd
    expect(counts.Odd - before.Odd).toBe(0);
    before = { ...counts };
    await act(async () => s.setState('n', 4)); // now even
    expect(counts.Odd - before.Odd).toBe(1);
    expect(m.text('Odd')).toBe('false');
    await m.unmount();
  });

  it('a selector that runs again and returns a new object with the same fields does not re-render (shallow compare)', async () => {
    const s = createStore({ a: 1, b: 2 }, { name: `iso-${uid()}` });
    const n: Counts = {};
    let runs = 0;
    const m = await mount(
      counted(n, 'Pair', () =>
        s.useGlobalState(({ a, b }) => {
          runs++;
          return { big: a > 5, b };
        }),
      ),
    );
    const before = { ...n };
    const runsBefore = runs;
    await act(async () => s.setState('a', 2)); // a key it reads changed, so it runs again: { big: false, b: 2 } again
    expect(runs).toBeGreaterThan(runsBefore); // it really ran again (the test would be empty otherwise)
    expect(n.Pair - before.Pair).toBe(0);
    await act(async () => s.setState('a', 9)); // now big flips
    expect(n.Pair - before.Pair).toBe(1);
    expect(m.text('Pair')).toBe('{"big":true,"b":2}');
    await m.unmount();
  });

  it('dependencies follow the branch: after switching from a to b it stops listening to a', async () => {
    const s = createStore({ mode: 'a' as 'a' | 'b', a: 0, b: 0 }, { name: `iso-${uid()}` });
    const n: Counts = {};
    const m = await mount(counted(n, 'Pick', () => s.useGlobalState(({ mode, a, b }) => (mode === 'a' ? a : b))));
    // Note: destructuring reads all three keys. The branch test proper is below with state.key reads.
    await m.unmount();

    const counts: Counts = {};
    const m2 = await mount(counted(counts, 'Branch', () => s.useGlobalState((st) => (st.mode === 'a' ? st.a : st.b))));
    let before = { ...counts };
    await act(async () => s.setState('b', 1)); // mode a: b isn't read
    expect(counts.Branch - before.Branch).toBe(0);
    await act(async () => s.setState('mode', 'b'));
    expect(m2.text('Branch')).toBe('1');
    before = { ...counts };
    await act(async () => s.setState('a', 99)); // mode b: a is no longer read
    expect(counts.Branch - before.Branch).toBe(0);
    before = { ...counts };
    await act(async () => s.setState('b', 2));
    expect(counts.Branch - before.Branch).toBe(1);
    expect(m2.text('Branch')).toBe('2');
    expect(n.Pick).toBeGreaterThan(0);
    await m2.unmount();
  });
});

describe('computed keys', () => {
  it('readers of a computed key re-render when its inputs change it, readers of unrelated keys do not', async () => {
    const s = createStore(
      { a: 1, b: 2, c: 0 },
      { name: `iso-${uid()}`, computed: [{ sum: (get) => get('a') + get('b') }] },
    );
    const n: Counts = {};
    const m = await mount(
      counted(n, 'Sum', () => s.useGlobalState('sum')[0]),
      counted(n, 'C', () => s.useGlobalState('c')[0]),
    );
    let before = { ...n };
    await act(async () => s.setState('a', 10));
    expect(since(n, before)).toEqual({ Sum: 1, C: 0 });
    expect(m.text('Sum')).toBe('12');
    before = { ...n };
    await act(async () => s.setState('c', 1));
    expect(since(n, before)).toEqual({ Sum: 0, C: 1 });
    await m.unmount();
  });

  it('an input changes but the computed value stays the same: its readers are not re-rendered', async () => {
    const s = createStore({ n: 1 }, { name: `iso-${uid()}`, computed: [{ odd: (get) => get('n') % 2 === 1 }] });
    const counts: Counts = {};
    const m = await mount(counted(counts, 'Odd', () => s.useGlobalState('odd')[0]));
    const before = { ...counts };
    await act(async () => s.setState('n', 3));
    expect(counts.Odd - before.Odd).toBe(0);
    await act(async () => s.setState('n', 4));
    expect(counts.Odd - before.Odd).toBe(1);
    expect(m.text('Odd')).toBe('false');
    await m.unmount();
  });
});

describe('status', () => {
  it('a query reader that never reads the status is not re-rendered by fetching start and end; one that reads it is', async () => {
    let calls = 0;
    let release!: () => void;
    const s = createStore(
      {
        todos: query(
          async () => {
            calls++;
            await new Promise<void>((r) => (release = r));
            return ['t'];
          },
          { initial: [] as string[] },
        ),
        other: 0,
      },
      { name: `iso-${uid()}` },
    ) as any;
    const n: Counts = {};
    const m = await mount(
      counted(n, 'ValueOnly', () => (s.useGlobalState('todos')[0] as string[]).length),
      counted(n, 'WithStatus', () => {
        const [v, , status] = s.useGlobalState('todos');
        return `${(v as string[]).length}:${status.fetching}`;
      }),
    );
    await act(async () => sleep(0));
    expect(calls).toBe(1);
    // first load: both render the data once. ValueOnly should re-render only for the value.
    let before = { ...n };
    await act(async () => {
      release();
      await sleep(10);
    });
    expect(n.ValueOnly - before.ValueOnly).toBe(1); // the value changed: [] -> ['t']
    expect(n.WithStatus - before.WithStatus).toBeGreaterThanOrEqual(1);
    expect(m.text('WithStatus')).toBe('1:false');

    // a refetch that returns an equal-length but new array: the value changes once at the end
    before = { ...n };
    const refetch = s.fetchQuery('todos', undefined, true).catch(() => {});
    await act(async () => sleep(10)); // fetching started: only the status reader sees it
    expect(n.ValueOnly - before.ValueOnly).toBe(0);
    expect(m.text('WithStatus')).toBe('1:true');
    await act(async () => {
      release();
      await refetch;
      await sleep(10);
    });
    expect(m.text('WithStatus')).toBe('1:false');
    await m.unmount();
  });
});
