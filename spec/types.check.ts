// Compile-time tests: what TypeScript users see in their editor. Run by `npm run test:types` (tsc, no output).
// `@ts-expect-error` lines must be errors, and expectTypeOf lines must hold, or the check fails.
import { expectTypeOf } from 'vitest';
import { createStore, defineEvents, query } from '@createstore/createstore';

type Todo = { id: number; text: string; done: boolean };
const store = createStore(
  {
    count: 0,
    name: 'ada',
    todos: [] as Todo[],
    user: null as { id: number } | null,
    theme: 'light' as 'light' | 'dark',
    posts: query(async () => [{ id: 1, title: 'a' }], { initial: [] as { id: number; title: string }[] }),
  },
  {
    computed: [
      { doubled: (get) => get('count') * 2, openTodos: (get) => get('todos').filter((t) => !t.done) },
      { label: (get) => `${get('name')}: ${get('doubled')}` },
    ],
  },
);

// The key names that editors suggest: state keys and computed keys, nothing else
type Keys = Parameters<typeof store.getState>[0];
expectTypeOf<Keys>().toEqualTypeOf<
  'count' | 'name' | 'todos' | 'user' | 'theme' | 'posts' | 'doubled' | 'openTodos' | 'label'
>();

// Reads know their type
expectTypeOf(store.getState('count')).toEqualTypeOf<number>();
expectTypeOf(store.getState('theme')).toEqualTypeOf<'light' | 'dark'>();
expectTypeOf(store.getState('user')).toEqualTypeOf<{ id: number } | null>();
expectTypeOf(store.getState('todos')).toEqualTypeOf<Todo[]>();
expectTypeOf(store.getState('doubled')).toEqualTypeOf<number>(); // computed
expectTypeOf(store.getState('openTodos')).toEqualTypeOf<Todo[]>();
expectTypeOf(store.getState('label')).toEqualTypeOf<string>(); // computed from a computed value
expectTypeOf(store.getState('posts')).toEqualTypeOf<{ id: number; title: string }[]>(); // query data

// Mistakes are compile errors
// @ts-expect-error unknown key
store.getState('nope');
// @ts-expect-error a number key takes a number
store.setState('count', 'one');
// @ts-expect-error a union key takes only its members
store.setState('theme', 'blue');
// @ts-expect-error computed keys are read-only
store.setState('doubled', 4);
// @ts-expect-error the updater must return the key's type
store.setState('count', (c) => String(c));
// @ts-expect-error a todo needs all its fields
store.setState('todos', [{ id: 1 }]);

// Valid writes compile
store.setState('count', 5);
store.setState('count', (c) => c + 1);
store.setState('user', null);
store.setState('user', { id: 3 });
store.setState('todos', (t) => [...t, { id: 2, text: 'x', done: false }]);

// Hooks: [value, setter]
function Component() {
  const [count, setCount] = store.useGlobalState('count');
  expectTypeOf(count).toEqualTypeOf<number>();
  setCount((c) => c + 1);
  // @ts-expect-error a string is not a number
  setCount('x');

  const [doubled] = store.useGlobalState('doubled');
  expectTypeOf(doubled).toEqualTypeOf<number>();

  // A selector returns the value itself, typed from what it returns
  const firstOpen = store.useGlobalState('todos', (todos) => todos.find((t) => !t.done)?.text);
  expectTypeOf(firstOpen).toEqualTypeOf<string | undefined>();

  // @ts-expect-error unknown key in a hook
  store.useGlobalState('nope');
}
void Component;

// Events: declared payloads are checked
const events = createStore({}, { events: defineEvents<{ toast: string; done: void; job: { id: number } }>() });
events.emit('toast', 'Saved');
events.emit('done');
events.emit('job', { id: 1 });
// @ts-expect-error wrong payload type
events.emit('toast', 5);
// @ts-expect-error unknown event name
events.emit('nope', 1);
// @ts-expect-error payload missing
events.emit('job');
events.on('job', (payload) => expectTypeOf(payload).toEqualTypeOf<{ id: number }>());

// Options: a typo is a compile error for TypeScript users (JavaScript users get the runtime warning)
// @ts-expect-error not an option
createStore({ a: 1 }, { persits: true });
// @ts-expect-error history takes a boolean or { limit, keys }
createStore({ a: 1 }, { history: 'yes' });
// @ts-expect-error keys must be keys of the state
createStore({ a: 1 }, { history: { keys: ['b'] } });
