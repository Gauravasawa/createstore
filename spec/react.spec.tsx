import { describe, it, expect } from 'vitest';
import { createElement as h, act } from 'react';
import { renderToString } from 'react-dom/server';
import { createRoot } from 'react-dom/client';
import { createStore } from '@createstore/createstore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe('React integration', () => {
  it('useGlobalState re-renders on change and shares state between components', async () => {
    const store = createStore({ n: 0 });
    const A = () => h('span', { id: 'a' }, String(store.useGlobalState('n')[0]));
    const B = () => {
      const [, setN] = store.useGlobalState('n');
      return h('button', { onClick: () => setN((x: number) => x + 1) }, '+');
    };
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    await act(async () => root.render(h('div', null, h(A), h(B))));
    expect(el.querySelector('#a')!.textContent).toBe('0');
    await act(async () => {
      el.querySelector('button')!.click();
    });
    await act(async () => {
      el.querySelector('button')!.click();
    });
    expect(el.querySelector('#a')!.textContent).toBe('2');
    await act(async () => root.unmount());
  });

  it('SSR: ssr:true renders from the request scope, and the app store is not shared', () => {
    const store = createStore({ name: 'default' }, { name: 'ssr-test', ssr: true });
    const Name = () => h('b', null, store.useGlobalState('name')[0]);
    const html = (who: string) => renderToString(h(store.Root, { scope: store.createScope({ name: who }) }, h(Name)));
    expect(html('ada')).toContain('ada');
    expect(html('grace')).toContain('grace');
  });
});
