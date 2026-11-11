// The README's quick start, verbatim, so the example can't drift from the library.
import { describe, it, expect } from 'vitest';
import { createElement, act } from 'react';
import { createRoot } from 'react-dom/client';
import { createStore } from '@createstore/createstore';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const store = createStore({ count: 0 });

function Counter() {
  const [count, setCount] = store.useGlobalState('count');
  return <button onClick={() => setCount((c) => c + 1)}>{count}</button>;
}

describe('README quick start', () => {
  it('counts', async () => {
    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    await act(async () => root.render(createElement(Counter)));
    await act(async () => el.querySelector('button')!.click());
    expect(el.querySelector('button')!.textContent).toBe('1');
    expect(store.getState('count')).toBe(1);
    await act(async () => root.unmount());
  });
});
