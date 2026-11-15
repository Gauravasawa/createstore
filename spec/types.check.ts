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

// Computed layers: each layer reads state and every earlier layer (guards the generic chain in createStore)
const noLayers = createStore({ a: 1 });
void noLayers;
expectTypeOf<Parameters<typeof noLayers.getState>[0]>().toEqualTypeOf<'a'>();

const oneLayer = createStore({ a: 1 }, { computed: [{ b: (get) => get('a') + 1 }] });
expectTypeOf(oneLayer.getState('b')).toEqualTypeOf<number>();

const eight = createStore(
  { a: 1 },
  {
    computed: [
      { l1: (get) => get('a') + 1 },
      { l2: (get) => `${get('l1')}` },
      { l3: (get) => get('l2').length > 0 },
      { l4: (get) => [get('l1')] },
      { l5: (get) => get('l4').length },
      { l6: (get) => (get('l3') ? 'y' : 'n') as 'y' | 'n' },
      { l7: (get) => ({ v: get('l6') }) },
      { l8: (get) => get('l7').v + get('l2') + get('l1') + get('a') },
    ],
  },
);
// get('earlierComputed') inside a later layer has the earlier value's real type, not `any`
expectTypeOf(eight.getState('l1')).toEqualTypeOf<number>();
expectTypeOf(eight.getState('l2')).toEqualTypeOf<string>();
expectTypeOf(eight.getState('l3')).toEqualTypeOf<boolean>();
expectTypeOf(eight.getState('l4')).toEqualTypeOf<number[]>();
expectTypeOf(eight.getState('l5')).toEqualTypeOf<number>();
expectTypeOf(eight.getState('l6')).toEqualTypeOf<'y' | 'n'>();
expectTypeOf(eight.getState('l7')).toEqualTypeOf<{ v: 'y' | 'n' }>();
expectTypeOf(eight.getState('l8')).toEqualTypeOf<string>();
expectTypeOf<Parameters<typeof eight.getState>[0]>().toEqualTypeOf<
  'a' | 'l1' | 'l2' | 'l3' | 'l4' | 'l5' | 'l6' | 'l7' | 'l8'
>();

// Every layer count from 1 to 8 compiles, and at every depth a layer can read the layer right before it
const d3 = createStore(
  { a: 1 },
  { computed: [{ c1: (get) => get('a') }, { c2: (get) => [get('c1')] }, { c3: (get) => [get('c2')] }] },
);
expectTypeOf(d3.getState('c3')).toEqualTypeOf<number[][]>();
const d4 = createStore(
  { a: 1 },
  {
    computed: [
      { c1: (get) => get('a') },
      { c2: (get) => [get('c1')] },
      { c3: (get) => [get('c2')] },
      { c4: (get) => [get('c3')] },
    ],
  },
);
expectTypeOf(d4.getState('c4')).toEqualTypeOf<number[][][]>();
const d5 = createStore(
  { a: 1 },
  {
    computed: [
      { c1: (get) => get('a') },
      { c2: (get) => [get('c1')] },
      { c3: (get) => [get('c2')] },
      { c4: (get) => [get('c3')] },
      { c5: (get) => [get('c4')] },
    ],
  },
);
expectTypeOf(d5.getState('c5')).toEqualTypeOf<number[][][][]>();
const d6 = createStore(
  { a: 1 },
  {
    computed: [
      { c1: (get) => get('a') },
      { c2: (get) => [get('c1')] },
      { c3: (get) => [get('c2')] },
      { c4: (get) => [get('c3')] },
      { c5: (get) => [get('c4')] },
      { c6: (get) => [get('c5')] },
    ],
  },
);
expectTypeOf(d6.getState('c6')).toEqualTypeOf<number[][][][][]>();
const d7 = createStore(
  { a: 1 },
  {
    computed: [
      { c1: (get) => get('a') },
      { c2: (get) => [get('c1')] },
      { c3: (get) => [get('c2')] },
      { c4: (get) => [get('c3')] },
      { c5: (get) => [get('c4')] },
      { c6: (get) => [get('c5')] },
      { c7: (get) => [get('c6')] },
    ],
  },
);
expectTypeOf(d7.getState('c7')).toEqualTypeOf<number[][][][][][]>();
const d8 = createStore(
  { a: 1 },
  {
    computed: [
      { c1: (get) => get('a') },
      { c2: (get) => [get('c1')] },
      { c3: (get) => [get('c2')] },
      { c4: (get) => [get('c3')] },
      { c5: (get) => [get('c4')] },
      { c6: (get) => [get('c5')] },
      { c7: (get) => [get('c6')] },
      { c8: (get) => [get('c7')] },
    ],
  },
);
expectTypeOf(d8.getState('c8')).toEqualTypeOf<number[][][][][][][]>();

// A layer cannot read a later layer, or itself
createStore(
  { a: 1 },
  {
    computed: [
      // @ts-expect-error l2 is declared in a later layer
      { l1: (get) => get('l2') },
      { l2: (get) => get('a') },
    ],
  },
);
// @ts-expect-error a value in the same layer is not visible to its sibling
createStore({ a: 1 }, { computed: [{ x: (get) => get('a'), y: (get) => get('x') }] });

// Options: a typo is a compile error for TypeScript users (JavaScript users get the runtime warning)
// @ts-expect-error not an option
createStore({ a: 1 }, { persits: true });
// @ts-expect-error history takes a boolean or { limit, keys }
createStore({ a: 1 }, { history: 'yes' });
// @ts-expect-error keys must be keys of the state
createStore({ a: 1 }, { history: { keys: ['b'] } });
