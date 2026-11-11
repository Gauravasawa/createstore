// @vitest-environment node
// Server rendering with no browser: no window, document or localStorage. The main question: can one user's
// state ever show up in another user's response?
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { createStore } from '@createstore/createstore';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
afterEach(() => vi.restoreAllMocks());

describe('the test really runs without a browser', () => {
  it('has no window, document or localStorage', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof document).toBe('undefined');
    expect(typeof localStorage).toBe('undefined');
  });
});

describe('1 and 2: concurrent requests on one server instance never share state', () => {
  const store = createStore({ user: 'anonymous', cart: [] as string[] }, { name: 'shop', ssr: true });
  const Page = () => {
    const [user] = store.useGlobalState('user');
    const [cart] = store.useGlobalState('cart');
    return h('p', null, `${user}|${cart.join(',')}`);
  };
  // One request: its own store, awaits in the middle (other requests run meanwhile), then renders
  async function handle(user: string, items: string[], delay: number) {
    const scope = store.createScope({ user, cart: [] });
    await sleep(delay);
    for (const item of items) {
      await scope.setState('cart', [...scope.getState('cart'), item]);
      await sleep(delay);
    }
    return { html: renderToString(h(store.Root, { scope }, h(Page))), script: scope.toScript() };
  }

  it('two users, interleaved', async () => {
    const [ada, grace] = await Promise.all([handle('ada', ['a1', 'a2'], 5), handle('grace', ['g1'], 3)]);
    expect(ada.html).toContain('ada|a1,a2');
    expect(grace.html).toContain('grace|g1');
    expect(ada.html + ada.script).not.toContain('grace');
    expect(grace.html + grace.script).not.toContain('ada');
    expect(ada.html + ada.script).not.toContain('g1');
  });

  it('200 requests with random timing, each sees only its own data', async () => {
    const users = Array.from({ length: 200 }, (_, i) => `user${i}`);
    const out = await Promise.all(users.map((u) => handle(u, [`item-of-${u}`], Math.random() * 8)));
    out.forEach((r, i) => {
      expect(r.html).toContain(`${users[i]}|item-of-${users[i]}`);
      // no other user's name appears as a whole word
      for (const other of [users[(i + 1) % 200], users[(i + 99) % 200]]) {
        expect(r.html + r.script).not.toMatch(new RegExp(`${other}\\b`));
      }
    });
  });

  it('the same data renders the same HTML twice (deterministic)', () => {
    const render = () =>
      renderToString(h(store.Root, { scope: store.createScope({ user: 'ada', cart: ['x'] }) }, h(Page)));
    expect(render()).toBe(render());
  });

  it('the module-level store cannot be used by mistake: it throws instead of sharing', () => {
    expect(() => store.getState('user')).toThrow(/server rendering/);
    expect(() => store.setState('user', 'mallory')).toThrow(/server rendering/);
  });

  it('rendering outside <Root> throws, so a forgotten Root is a loud error, not a leak', () => {
    expect(() => renderToString(h(Page))).toThrow(/outside <Root>/);
  });

  it('a scope used after its request is not shared with the next one', async () => {
    const first = store.createScope({ user: 'ada' });
    await first.setState('cart', ['secret']);
    const second = store.createScope({ user: 'grace' });
    expect(second.getState('cart')).toEqual([]);
    expect(second.snapshot()).not.toHaveProperty('secret');
  });
});

describe('3: several stores with different names stay apart', () => {
  const a = createStore({ value: 'a-initial' }, { name: 'store-a', ssr: true });
  const b = createStore({ value: 'b-initial' }, { name: 'store-b', ssr: true });
  const A = () => h('i', null, a.useGlobalState('value')[0]);
  const B = () => h('b', null, b.useGlobalState('value')[0]);

  it('each store has its own scope, data and script tag', () => {
    const sa = a.createScope({ value: 'from-a' });
    const sb = b.createScope({ value: 'from-b' });
    const html = renderToString(h(a.Root, { scope: sa }, h(b.Root, { scope: sb }, h('div', null, h(A), h(B)))));
    expect(html).toContain('from-a');
    expect(html).toContain('from-b');
    expect(sa.toScript()).toContain('id="createstore:store-a"');
    expect(sb.toScript()).toContain('id="createstore:store-b"');
    expect(sa.toScript()).not.toContain('from-b');
  });

  it('a Root of one store refuses a scope made by another', () => {
    const sb = b.createScope({ value: 'x' });
    expect(() => renderToString(h(a.Root, { scope: sb as never }, h(A)))).toThrow(/different store/);
  });

  it("a store's components inside another store's Root do not read its data", () => {
    const sb = b.createScope({ value: 'only-b' });
    expect(() => renderToString(h(b.Root, { scope: sb }, h(A)))).toThrow(/outside <Root>/);
  });

  it('two stores may not share a name in a way that mixes their scopes', () => {
    const x1 = createStore({ v: 1 }, { name: 'same', ssr: true });
    const x2 = createStore({ v: 2 }, { name: 'same', ssr: true });
    const s1 = x1.createScope({ v: 10 });
    const s2 = x2.createScope({ v: 20 });
    expect(s1.getState('v')).toBe(10);
    expect(s2.getState('v')).toBe(20);
  });
});

describe('8: server rendering without browser APIs', () => {
  it('persist, syncTabs and offline do not touch the browser on the server', () => {
    const store = createStore(
      { theme: 'light' },
      { name: 'no-browser', ssr: true, persist: 'local', syncTabs: true, offline: true, devtools: true },
    );
    const T = () => h('u', null, store.useGlobalState('theme')[0]);
    const scope = store.createScope({ theme: 'dark' });
    expect(renderToString(h(store.Root, { scope }, h(T)))).toContain('dark');
  });

  it('a plain store (no ssr option) can still be created and read on the server', () => {
    const store = createStore({ n: 1 }, { persist: 'local' });
    expect(store.getState('n')).toBe(1);
  });
});

describe('10: shared stores across requests', () => {
  it('shared: true is ignored on the server: every call is its own store, with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const one = createStore({ n: 0 }, { name: 'shared-server', shared: true });
    const two = createStore({ n: 0 }, { name: 'shared-server', shared: true });
    one.setState('n', 5);
    expect(two.getState('n')).toBe(0); // not the same store
    expect(warn.mock.calls.flat().join(' ')).toMatch(/shared: true is ignored on the server/);
  });

  it('shared: true together with ssr: true gives no warning (the Root guard already protects it)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createStore({ n: 0 }, { name: 'shared-ssr', shared: true, ssr: true });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('what goes into the page', () => {
  it('toScript cannot be broken out of by user data', () => {
    const store = createStore({ bio: '' }, { name: 'xss', ssr: true });
    const scope = store.createScope({ bio: '</script><script>alert(1)</script><!--' });
    const tag = scope.toScript();
    expect(tag.match(/<\/script>/g)).toHaveLength(1); // only the closing tag of the data tag itself
    expect(tag).not.toContain('<script>alert');
  });

  it('toScript needs a name, so a missing name fails loudly', () => {
    const store = createStore({ n: 0 }, { ssr: true });
    expect(() => store.createScope().toScript()).toThrow(/needs the store's name/);
  });
});
