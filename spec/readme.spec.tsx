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

  it('shares a list between components (the todos example)', async () => {
    const { useGlobalState } = createStore({ todos: [] as { text: string }[] });
    const Form = ({ onAdd }: { onAdd: (text: string) => void }) => <button onClick={() => onAdd('a')}>add</button>;

    function TodoCount() {
      const [todos] = useGlobalState('todos');
      return <p>{todos.length} todos</p>;
    }

    function AddTodo() {
      const [todos, setTodos] = useGlobalState('todos');
      const add = (text: string) => setTodos([...todos, { text }]);
      return <Form onAdd={add} />;
    }

    const el = document.createElement('div');
    document.body.append(el);
    const root = createRoot(el);
    await act(async () => root.render(createElement('div', null, createElement(TodoCount), createElement(AddTodo))));
    expect(el.querySelector('p')!.textContent).toBe('0 todos');
    await act(async () => el.querySelector('button')!.click());
    expect(el.querySelector('p')!.textContent).toBe('1 todos');
    await act(async () => root.unmount());
  });
});
