// The values a store keeps under symbols (StoreInternals): what each one is for, tested through what it makes happen.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement as h, act } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore } from '@createstore/createstore';
import { ClientRoot } from '../dist/esm/client-root.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const uid = () => Math.random().toString(36).slice(2, 8);
type Loose = Record<string, any>;
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});
const forget = (name: string) =>
  delete (globalThis as unknown as Record<symbol, unknown>)[Symbol.for(`createStore:${name}`)];

describe('a scope shares its store definition (DEFINITION)', () => {
  it("a scope's setters and store.<key> getters come from the same shared prototypes as the store's", () => {
    const s = createStore({ a: 1, b: 2 }, { name: `i-${uid()}`, ssr: true }) as Loose;
    const scope = s.createScope({ a: 5 });
    expect(Object.getPrototypeOf(scope.set)).toBe(Object.getPrototypeOf(s.set));
    expect(Object.getPrototypeOf(scope)).toBe(Object.getPrototypeOf(s));
    // and they still act on their own store
    scope.set.a(9);
    expect([scope.getState('a'), s.getState('a')]).toEqual([9, 1]);
    scope.a(10); // store.<key>: the key's setter
    expect(scope.getState('a')).toBe(10);
  });
});

describe('shared: true and hot reload (SHAPE, OWN_HOOKS)', () => {
  it('a reload with a changed definition warns once; with the same definition it stays quiet', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const name = `hmr-${uid()}`;
    const first = createStore({ a: 0 }, { name, shared: true }) as Loose;
    createStore({ a: 0 }, { name, shared: true });
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/definition changed/);
    createStore({ a: 0, b: 1 }, { name, shared: true });
    createStore({ a: 0, b: 1 }, { name, shared: true });
    expect(warn.mock.calls.flat().filter((m) => String(m).includes('definition changed'))).toHaveLength(1);
    first.destroy();
    forget(name);
  });

  it("after the module runs again, the store's hooks still work outside a Root (the original hooks were kept)", async () => {
    const name = `hmr-hooks-${uid()}`;
    createStore({ n: 0 }, { name, shared: true });
    const again = createStore({ n: 0 }, { name, shared: true }) as Loose; // hot reload: wrapped a second time
    const again2 = createStore({ n: 0 }, { name, shared: true }) as Loose; // and a third
    expect(again2).toBe(again);
    const el = document.createElement('div');
    const root = createRoot(el);
    const Show = () => h('b', null, String(again.useGlobalState('n')[0]));
    await act(async () => root.render(h(Show)));
    expect(el.textContent).toBe('0');
    await act(async () => again.setState('n', 3));
    expect(el.textContent).toBe('3');
    await act(async () => root.unmount());
    again.destroy();
    forget(name);
  });
});

describe('ClientRoot fills the store during render without updating other components mid-render (QUIET, MERGE)', () => {
  it('a component already showing the key is updated after the render, and React reports nothing', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const name = `cr-${uid()}`;
    const s = createStore({ user: 'anonymous' }, { name, ssr: true }) as Loose;
    const Header = () => h('i', null, s.useGlobalState('user')[0]); // outside the Root: already subscribed
    const Page = () => h('b', null, s.useGlobalState('user')[0]);
    const el = document.createElement('div');
    const root = createRoot(el);
    await act(async () => root.render(h('div', null, h(Header))));
    expect(el.textContent).toBe('anonymous');
    // a Server Component's <Root> arrives: its first hook fills the app's store while rendering
    await act(async () =>
      root.render(h('div', null, h(Header), h(ClientRoot as never, { name, snapshot: { user: 'ada' } }, h(Page)))),
    );
    expect(el.textContent).toBe('adaada');
    const messages = errors.mock.calls.map((c) => String(c[0]));
    expect(messages.filter((m) => m.includes('Cannot update a component'))).toEqual([]);
    await act(async () => root.unmount());
  });
});
