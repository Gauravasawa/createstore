import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  RSC,
  cache,
  ClientRoot,
  type ReactElement,
  type ReactNode,
} from './react-bindings';

// ---- Server Components (Next.js App Router) -------------------------------------------------
// <AppStore.Root> in a Server Component hands its snapshot down by store name; the store's first
// hook below picks it up, and later snapshots (client-side navigation) merge their server data in.
type PendingSnapshots = Record<string, { snapshot: unknown; scope?: unknown }>;
export const __SnapshotContext = (RSC ? null : createContext<PendingSnapshots | null>(null)) as ReturnType<
  typeof createContext<PendingSnapshots | null>
>;
// Set while the page is being left (pagehide), cleared if it's shown again (back/forward cache).
// One pair of listeners for every store: a pair per store was never removed, so each store (and each
// createScope() in the browser) stayed alive for as long as the page did.
let leavingPage = false;
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', () => { leavingPage = true; });
  window.addEventListener('pageshow', () => { leavingPage = false; });
}
const storesByName = new Map<string, object>(); // the browser's stores, by name
const MERGE = Symbol('createStore.merge');
const QUIET = Symbol('createStore.quiet');
const APP_PERSIST = Symbol('createStore.appPersist');
const ALL_PAGES = Symbol('createStore.allPages');
/** Internal: ClientRoot merges a later page's server data into the store named `name` */
export function __mergeSnapshot(name: string, snapshot: unknown) {
  const store = storesByName.get(name) as Record<symbol, ((s: unknown) => void) | undefined> | undefined;
  store?.[MERGE]?.(snapshot);
}

/**
 * Global state that works like useState, shared by every component:
 *
 *   const store = createStore({ todos: [] as Todo[] });
 *   const [todos, setTodos] = store.useGlobalState('todos');
 *
 * No provider, no reducers, no action types. Everything else is optional and
 * stays off until you use it: computed values, server data (query(), with or
 * without params or pages), persist, offline, history (undo/redo), syncTabs,
 * events, keyActions, actions, batch, reset, server rendering.
 *
 * Reading: useGlobalState('key') returns [value, setter, status] for every key,
 * computed ones too:  const [total] = useGlobalState('total');
 * Only the selector form returns the value itself: useGlobalState((get) => ...).
 *
 * React comes in through ./react-bindings. The package ships it (with a server
 * version and client-root.tsx); if you copy this file in instead, that module
 * must export:
 *   createContext, createElement, useCallback, useContext, useEffect, useRef,
 *   useSyncExternalStore   React's. In Server Components React has no hooks or
 *                          createContext: undefined there is fine (a namespace
 *                          import), the store doesn't call them there.
 *   RSC         true only in Server Components (typeof React.useState !== 'function')
 *   cache       React's cache() in Server Components (per-request stores), else undefined
 *   ClientRoot  a 'use client' component ({ name, snapshot, children }): provides
 *               { ...parent, [name]: { snapshot } }, memoised, via __SnapshotContext,
 *               and calls __mergeSnapshot(name, snapshot) in a useLayoutEffect (with
 *               useEffect a new page's components would fetch before the merge).
 *
 * Map of this file: public types → createStore → build(), which holds state
 * and computed values, persistence, history, apply() (the one place every
 * change goes through), optimistic saves, queries, events, then the hooks.
 */

/* =========================================================================
   Types
   ========================================================================= */

type Updater<T> = T | ((prev: T) => T);

/** Options of `query(fetch, options)` */
/** What a query reports after its first load was cancelled: see QueryOptions.whenAborted */
export type WhenAborted = 'loading' | 'idle';

export interface QueryOptions<T, R = T> {
  select?: (data: T) => R; // expose a transformed value; the store keeps the raw data
  initial?: T; // the value before the first response, without params (default: undefined, like a query with params)
  /**
   * What status.state says when the first load was cancelled (abort()), so nothing loaded and nothing
   * is running: 'loading' (as if still loading, until it's fetched again) or 'idle' (a fifth state,
   * only for this query). Left out: 'ready', as before.
   */
  whenAborted?: WhenAborted;
  staleTime?: number; // ms the data stays fresh (default: 30s)
  retry?: number; // retries on failure (default: 2)
  retryDelay?: RetryDelay; // ms before each retry (default: 500, 1000, 2000...)
  gcTime?: number; // ms data for params nobody shows stays cached (default: 5 minutes)
  refetchAfterMutation?: boolean; // reload after a successful server save
}

/** `pages` in `query(fetchPage, { pages: { first, next, max } })` */
export interface PagesOptions<TPage, TParam> {
  first: TParam; // the first request's page: 1, null for a cursor...
  next: (lastPage: TPage, pages: TPage[], page: TParam) => TParam | undefined | null; // undefined/null = no more
  max?: number; // keep only the newest N pages
  /**
   * When the list refreshes (stale when shown again, refetch(), invalidate()): 'first' (default) starts
   * over from the first page; 'loaded' fetches as many pages as were loaded, then swaps them in at
   * once, so a long list keeps its length (one request per page).
   */
  refresh?: 'first' | 'loaded';
}

/** Options of a paged query: `query(fetchPage, { pages: { ... }, staleTime, ... })` */
export interface PagedQueryOptions<TPage, TParam> {
  pages: PagesOptions<TPage, TParam>;
  whenAborted?: WhenAborted; // see QueryOptions.whenAborted
  staleTime?: number;
  retry?: number;
  retryDelay?: RetryDelay;
  gcTime?: number;
}

/** The third argument of `useGlobalState(key, params, options)` */
export interface UseOptions {
  enabled?: boolean; // false: don't load (yet), e.g. { enabled: !!id }
  /** Wait until these queries have data: pass their statuses. Gives you blocked, blockedBy and rootError. */
  waitFor?: Status | readonly Status[];
}

/** What `useGlobalState(pagedKey)` gives as its status: a Status plus page controls */
export interface PagedStatus extends Status {
  hasNextPage: boolean;
  fetchNextPage: () => Promise<void>; // never rejects: errors show up in `error`
  isFetchingNextPage: boolean;
}

/** `true` (or leaving it out) = the default; or your own: `attempt => 1000 * attempt` (attempt starts at 1) */
export type RetryDelay = true | ((attempt: number) => number);

/** The default retry delay: 500ms, then 1s, 2s, 4s... */
export const defaultRetryDelay = (attempt: number) => 500 * 2 ** (attempt - 1);

/** `U`: what the key holds before the first response: undefined, or nothing extra when `initial` is given */
export interface QueryDef<T, R = T, P = unknown, U = undefined, A extends WhenAborted | undefined = undefined> {
  readonly __kind: 'query';
  fetch: (params: P, signal: AbortSignal) => Promise<T>;
  options: QueryOptions<T, R>;
  /** type only: carries U (before the first response) and A (whenAborted) */
  readonly __before?: [U];
  readonly __aborted?: [A];
}

/** What `query(fetchPage, { pages })` returns */
export interface PagedQueryDef<TPage, TParam, P = unknown, A extends WhenAborted | undefined = undefined> {
  readonly __kind: 'pages';
  readonly __aborted?: [A];
  fetch: (page: TParam, params: P, signal: AbortSignal) => Promise<TPage>;
  options: PagedQueryOptions<TPage, TParam>;
}

/**
 * What selectors and computed functions receive. It works three ways:
 *   get('todos')            call it
 *   state.todos             read a property
 *   ({ todos }) => ...      destructure it
 * Every key you read is tracked as a dependency.
 */
export type StateReader<V> = V & (<K extends keyof V & string>(key: K) => V[K]);

/** One layer of computed values. Each function can read state and every earlier layer. */
// Returns `any`, not `unknown`: with `unknown` TypeScript stops inferring the later layers
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
export type ComputedLayer<V> = Record<string, (get: StateReader<V>) => any>;

/** `{ total: (get) => number }` becomes `{ total: number }` */
export type LayerValues<C> = { [K in keyof C]: C[K] extends (...args: never[]) => infer R ? R : never };
/** An object type with no keys: adds nothing to an intersection */
export type NoKeys = Record<never, never>;
// A layer that wasn't passed is inferred as the bare constraint (string keys); it adds no keys
export type AddedValues<C> = string extends keyof C ? NoKeys : LayerValues<C>;

/** Internal: how a query with params is run */
interface QueryConfig {
  whenAborted?: WhenAborted;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- params are typed by the user's fetch; `unknown` would block its annotation
  fetch: (params: any, signal: AbortSignal) => Promise<unknown>;
  staleTime?: number;
  retry?: number;
  retryDelay?: RetryDelay; // ms before each retry (default: 500, 1000, 2000...)
  gcTime?: number; // ms an unused entry stays cached (default: 5 minutes)
}

/** What any InfiniteQuery fits (its callbacks take whatever their pages are) */
type AnyInfinite = {
  readonly __kind: 'infinite';
  firstPage: unknown;
  refresh?: 'first' | 'loaded';
  fetch: (page: never, signal: AbortSignal, params: never) => Promise<unknown>;
  nextPage: (lastPage: never, pages: never[], page: never) => unknown;
  maxPages?: number;
  retry?: number;
  retryDelay?: RetryDelay;
  gcTime?: number;
};

/** Turns `{ todos: query(fn) }` into `{ todos: Todo[] }` */
// QueryDef is invariant in T (select's input), so both parts are inferred: [raw, selected]
type ValueOf<D> = D extends QueryDef<infer T, infer R, infer P, infer U> ? [T, R, P][1] | U : D;
/** What setters write: the raw data, also for a query with `select` */
type RawOf<D> = D extends QueryDef<infer T, infer R, infer P, infer U> ? [T, R, P][0] | U : D;
// Paged queries aren't state: they're read with useGlobalState(key) only
type NotPaged<S, K extends keyof S> = S[K] extends { readonly __kind: 'pages' } ? never : K;
export type RawValues<S> = { [K in keyof S as NotPaged<S, K>]: RawOf<S[K]> };
export type Values<S> = { [K in keyof S as NotPaged<S, K>]: ValueOf<S[K]> };
/** Keys declared with query(...) (not paged), and with pages */
type QueryKeysOf<S> = { [K in keyof S]: S[K] extends { readonly __kind: 'query' } ? K : never }[keyof S] & string;
type PagedKeysOf<S> = { [K in keyof S]: S[K] extends { readonly __kind: 'pages' } ? K : never }[keyof S] & string;
type ParamsOf<D> = D extends { fetch: (params: infer P, ...rest: never[]) => unknown } ? P : never;
type PagedParamsOf<D> = D extends { fetch: (page: never, params: infer P, ...rest: never[]) => unknown } ? P : never;
type PageOf<D> = D extends { fetch: (...a: never[]) => Promise<infer Page> } ? Page : never;
/** The hook's status for a key: with whenAborted: 'idle', its state can also be 'idle' */
type StatusFor<D> = D extends { readonly __aborted?: ['idle'] } ? IdleStatus : Status;
type PagedStatusFor<D> = D extends { readonly __aborted?: ['idle'] } ? PagedIdleStatus : PagedStatus;
/** A query declared without params takes no params argument (not even undefined): leave it out */
type TakesParams<P> = [P] extends [undefined] ? never : P | undefined;

/** The setter returned by useGlobalState */
export type SetValue<T> = <R = void>(
  value: Updater<T>,
  serverCall?: () => Promise<R> | R
) => Promise<R>; // resolves with what the save returned (a refund, the saved record...)


/** A per-key action: `(current, ...args) => next`, or `{ run, save }` to also save it to a server */
export type KeyAction<T> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- action arguments are whatever the user declares
  | ((current: T, ...args: any[]) => T)
  | {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same
      run: (current: T, ...args: any[]) => T;
      save?: (next: T) => Promise<unknown> | unknown; // a failed save rolls the change back
    };

const MAX_SNAPSHOT_DEPTH = 1000;
// A path inside a message: the start and the end, not a thousand ".child" segments
const shortPath = (p: string) => (p.length > 120 ? `${p.slice(0, 60)}…${p.slice(-40)}` : p);
const HISTORY_CHANNEL = '\u0000history';
const entryChannel = (k: string) => `\u0000${k}`; // a cache entry's channel
/**
 * Why `value` wouldn't come back unchanged from JSON.stringify + JSON.parse, with where it is,
 * or null when it would. `at` is the path so far, like `cart[2].addedAt`.
 */
function notJsonSafe(value: unknown, at: string, inArray: boolean): string | null {
  // A loop, not recursion: deeply nested state can't overflow the stack
  type Item = { v: unknown; at: string; inArray: boolean; depth: number } | { leave: object };
  const stack: Item[] = [{ v: value, at, inArray, depth: 0 }];
  const onPath = new Set<object>(); // the objects between the root and the current value: a cycle
  while (stack.length) {
    const item = stack.pop()!;
    if ('leave' in item) {
      onPath.delete(item.leave);
      continue;
    }
    const { v, at: where, inArray: inArr, depth } = item;
    switch (typeof v) {
      case 'string':
      case 'boolean':
        continue;
      case 'number':
        if (Number.isFinite(v)) continue;
        return `${where} is ${v} (JSON turns it into null)`;
      case 'undefined':
        // An object property that's undefined is simply absent after JSON, which reads the same
        if (inArr) return `${where} is undefined (JSON turns it into null)`;
        continue;
      case 'bigint':
        return `${where} is a BigInt (JSON can't hold it)`;
      case 'symbol':
        return `${where} is a symbol (JSON drops it)`;
      case 'function':
        return `${where} is a function (JSON drops it)`;
    }
    if (v === null) continue;
    const obj = v as object;
    if (onPath.has(obj)) return `${where} refers back to itself (JSON can't hold a cycle)`;
    if (depth >= MAX_SNAPSHOT_DEPTH) return `${shortPath(where)} is nested more than ${MAX_SNAPSHOT_DEPTH} levels deep (too deep to send as JSON reliably)`;
    if (!Array.isArray(obj)) {
      const proto = Object.getPrototypeOf(obj);
      if (proto !== Object.prototype && proto !== null) {
        if (obj instanceof Date) return `${where} is a Date (JSON turns it into a string)`;
        if (obj instanceof Map) return `${where} is a Map (JSON turns it into {})`;
        if (obj instanceof Set) return `${where} is a Set (JSON turns it into {})`;
        return `${where} is ${(obj.constructor?.name && `a ${obj.constructor.name}`) || 'a class instance'} (JSON keeps only its own fields, as a plain object)`;
      }
    }
    onPath.add(obj);
    stack.push({ leave: obj });
    // Children in reverse, so the first problem reported is the first one in reading order
    if (Array.isArray(obj)) {
      for (let i = obj.length - 1; i >= 0; i--) stack.push({ v: obj[i], at: `${where}[${i}]`, inArray: true, depth: depth + 1 });
    } else {
      const keys = Object.keys(obj);
      for (let i = keys.length - 1; i >= 0; i--) {
        const k = keys[i];
        stack.push({ v: (obj as Record<string, unknown>)[k], at: /^[A-Za-z_$][\w$]*$/.test(k) ? `${where}.${k}` : `${where}[${JSON.stringify(k)}]`, inArray: false, depth: depth + 1 });
      }
    }
  }
  return null;
}

/** The id of a store's data tag: <script type="application/json" id="createstore:<name>"> */
const dataTagId = (name: string) => `createstore:${name}`;
const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A snapshot as text that's safe inside an HTML <script> tag: JSON, with every character that
 * could end the tag or the script escaped. Use it instead of JSON.stringify:
 *   `<script>window.__STATE__ = ${serializeSnapshot(scope.snapshot())}</script>`
 */
export function serializeSnapshot(snapshot: unknown): string {
  return JSON.stringify(snapshot)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}


/** No keys outside the state: `keyActions: { nope: ... }` is a type error */
export type NoExtraKeys<KA, S> = Exclude<keyof KA, keyof S> extends never ? unknown : { [K in Exclude<keyof KA, keyof S>]: never };

export type KeyActionsMap<S> = {
  [K in keyof S]?: Record<string, KeyAction<RawOf<S[K]>>>;
};

type ActionArgs<F> = F extends (current: never, ...args: infer P) => unknown
  ? P
  : F extends { run: (current: never, ...args: infer P) => unknown }
  ? P
  : never;

/** `{ add: (todos, text: string) => ... }` becomes `{ add: (text: string) => Promise<void> }` */
type BoundActions<M> = {
  [N in keyof M]: (...args: ActionArgs<M[N]>) => Promise<void>;
};
// Without keyActions, KA is inferred as its bare constraint (an index signature per key): no actions
type ActionsFor<KA, K> = K extends keyof KA
  ? string extends keyof NonNullable<KA[K]> ? unknown : BoundActions<NonNullable<KA[K]>>
  : unknown;

/** Store members a state key can't shadow when it's exposed directly as `store.<key>` */
export type ReservedName =
  | 'useGlobalState' | 'getState' | 'setState' | 'set' | 'actions'
  | 'undo' | 'redo' | 'goTo' | 'useHistory' | 'subscribe' | 'reset' | 'destroy' | 'hydrated'
  | 'emit' | 'on' | 'fetchQuery' | 'setQueryData' | 'invalidate' | 'whenOnline' | 'batch' | 'abort'
  | 'createScope' | 'Root' | 'hydrate' | 'snapshot';

/** `store.cart.add(...)`: every state key's setter, with its key actions, unless its name is reserved */
export type DirectSetters<S, KA> = Omit<SettersOf<S, KA>, ReservedName>;

/** In actions: api.cart.add(...) and api.cart(value), like on the store (minus the api's own names) */
export type ApiSetters<S, KA> = Omit<SettersOf<S, KA>, keyof StoreApi<NoKeys>>;

/** `store.set`: the setter (with its actions) of every state key */
type SettersOf<S, KA> = {
  [K in keyof S & string as NotPaged<S, K>]: SetValue<RawOf<S[K]>> & ActionsFor<KA, K>;
};

/** What a status means, in one word: switch on it instead of checking flags in the right order */
export type StatusState = 'waiting' | 'loading' | 'error' | 'ready';
/** The status of a query with whenAborted: 'idle': its first load was cancelled, nothing is running */
export interface IdleStatus extends Omit<Status, 'state'> {
  state: StatusState | 'idle';
}
/** ...and of a paged one */
export interface PagedIdleStatus extends Omit<PagedStatus, 'state'> {
  state: StatusState | 'idle';
}

export interface Status {
  /**
   * 'waiting': params not known yet, enabled: false, or a waitFor query isn't ready (no request).
   * 'loading': first load, nothing to show yet. 'error': it failed and there's no data to show.
   * 'ready': there's data (also while refreshing in the background, or after a refresh failed).
   */
  state: StatusState;
  loading: boolean; // first load, no data yet
  fetching: boolean; // any request in progress
  error: unknown; // last error, or null
  /** Waiting, not loading: its params aren't known yet, `enabled` is false, or a `waitFor` query isn't ready */
  blocked: boolean;
  /** The query it's waiting for (through a whole waitFor chain), or null */
  blockedBy: string | null;
  /** Why it's waiting: the error of the query at the start of a waitFor chain that failed, or null */
  rootError: unknown;
  refetch: () => Promise<void>; // does nothing while blocked
}

export interface ChangeEvent {
  key: string;
  prev: unknown;
  next: unknown;
  source: 'local' | 'server' | 'remote' | 'history' | 'devtools' | 'storage' | 'hydrate';
  time: number;
}

/** Default when no `events` option is given: any name, any payload (the old behavior) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped events accept any payload on purpose
export type AnyEvents = Record<string, any>;

export interface EmitOptions {
  /** Also run the handlers in other tabs (needs `syncTabs: true`). Default: this tab only. */
  broadcast?: boolean;
}

/** emit's arguments after the name: the payload (optional when it allows undefined or is void), then options */
export type EmitArgs<E, K extends keyof E> = undefined extends E[K]
  ? [payload?: E[K], options?: EmitOptions]
  : [payload: E[K], options?: EmitOptions];

export interface StoreApi<V, E extends object = AnyEvents, W = V> {
  getState<K extends keyof V & string>(key: K): V[K];
  setState<K extends keyof W & string, R = void>(
    key: K,
    value: Updater<W[K]>,
    serverCall?: () => Promise<R> | R
  ): Promise<R>; // resolves with what the save returned
  emit<K extends keyof E & string>(event: K, ...args: EmitArgs<E, K>): void;
  on<K extends keyof E & string>(event: K, handler: (payload: E[K]) => void): () => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- untyped by name; `unknown` would force a cast at every call site
  fetchQuery(name: string, params?: unknown, force?: boolean): Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- same; also lets `(old) => ...` updaters go unannotated
  setQueryData(name: string, updater: any, params?: unknown): void;
  invalidate(name: string): Promise<void>;
  /** Runs the task now, or once back online. Read state inside the task, not before (see below). */
  whenOnline(task: () => Promise<unknown> | unknown): Promise<unknown>;
  batch<T>(fn: () => T): T;
  abort(name: string): void;
}

/**
 * Where persisted state is kept. localStorage and sessionStorage already fit;
 * adapters for IndexedDB, Capacitor, Electron or React Native AsyncStorage can
 * return Promises.
 */
export interface StorageAdapter {
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): void | Promise<void>;
  removeItem?(key: string): void | Promise<void>;
}

export interface PersistOptions<S = Record<string, unknown>> {
  storage?: 'local' | 'session' | StorageAdapter; // default: 'local'
  keys?: (keyof S)[]; // save only these
  exclude?: (keyof S)[]; // save every plain key except these (e.g. an access token)
  /** Bump when the saved shape changes (default: 0; data saved before versioning counts as 0) */
  version?: number;
  /** Turn data saved by an older version into the current shape. Without it, old data is dropped. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- old data has the shape an older version saved; the user types it
  migrate?: (persisted: any, version: number) => unknown;
  /** Wait this many ms after the last change before saving (typing doesn't write on every key). Flushed when the page is hidden. */
  debounce?: number;
}

export interface StoreOptions<S, A, KA = NoKeys, E extends object = AnyEvents> {
  name?: string;
  persist?: boolean | 'local' | 'session' | PersistOptions<S>;
  /** Keep other tabs in sync. `{ keys }` sends only those keys; `{ exclude }` sends everything else (e.g. tokens) */
  syncTabs?: boolean | { keys?: (keyof S & string)[]; exclude?: (keyof S & string)[] };
  history?: boolean | { limit?: number; keys?: (keyof S & string)[] };
  devtools?: boolean;
  /**
   * Reuse one instance per page under `name` (survives hot reload).
   * Never use it on the server: every request would share the same store and
   * leak one user's state to another. For SSR, create the store per request
   * (call createStore inside a function) and pass it down, e.g. via context.
   */
  shared?: boolean;
  /**
   * One store per request, guaranteed. Wrap the app in `<store.Root initialState={...}>`:
   * on the server every render gets its own store; in the browser Root fills the
   * app's store with the same initial state, so hydration matches. Using the store
   * on the server outside a Root or Scope throws instead of sharing data between requests.
   */
  ssr?: boolean | { keys?: (keyof S & string)[]; exclude?: (keyof S & string)[]; version?: number };
  logger?: boolean;
  onChange?: (e: ChangeEvent) => void;
  /**
   * Keep server data and queue saves while offline. `maxSize`: the most characters one saved copy may take
   * (default 2,000,000). Kept in localStorage: queries without params under `<name>:inline`, with params and
   * paged under `<name>:queries`. It holds per-user data until `reset()`, so call that on sign-out.
   */
  offline?: boolean | { maxSize?: number };
  /**
   * Check data the store didn't write itself before using it: saved state, the offline copy and
   * other tabs' changes. Return false (or throw) to ignore that value; the key keeps what it had.
   */
  validate?: (key: string, value: unknown, from: 'storage' | 'offline' | 'remote') => boolean;
  actions?: (api: StoreApi<Values<S>, E, RawValues<S>> & ApiSetters<S, KA>) => A;
  /** Event names and payload types: `events: defineEvents<{ toast: string }>()`. Type-only. */
  events?: E;
  /** Actions per state key, used as `setTodos.add(...)`: `{ todos: { add: (todos, text) => [...] } }` */
  keyActions?: KA;
  /** Called for every keyActions call that has a `save` */
  onSaveStart?: (key: string, action: string) => void;
  onSaveSuccess?: (key: string, action: string) => void;
  onSaveError?: (key: string, action: string, error: unknown) => void;
}

/* =========================================================================
   Helpers you use inside the initial state
   ========================================================================= */

const QUERY_OPTIONS = new Set(['select', 'initial', 'staleTime', 'retry', 'retryDelay', 'gcTime', 'refetchAfterMutation', 'whenAborted']);
const PAGED_OPTIONS = new Set(['pages', 'staleTime', 'retry', 'retryDelay', 'gcTime', 'whenAborted']);
const PAGES_OPTIONS = new Set(['first', 'next', 'max', 'refresh']);
// Options that exist, but somewhere else: where each one belongs
const BELONGS: Record<string, string> = {
  enabled: 'enabled is an option of the hook: useGlobalState(key, params, { enabled }), not of query()',
  first: 'first goes inside pages: query(fetchPage, { pages: { first, next } })',
  next: 'next goes inside pages: query(fetchPage, { pages: { first, next } })',
  max: 'max goes inside pages: query(fetchPage, { pages: { first, next, max } })',
  maxPages: 'maxPages is now pages.max: query(fetchPage, { pages: { first, next, max } })',
  firstPage: 'firstPage is now pages.first: query(fetchPage, { pages: { first, next } })',
  nextPage: 'nextPage is now pages.next: query(fetchPage, { pages: { first, next } })',
  fetch: 'the fetch function is query()\'s first argument: query(fetch, options)',
};

/** Throws a clear error for an option in the wrong place or a typo */
function checkQueryOptions(options: Record<string, unknown>) {
  if (!options || typeof options !== 'object') throw new Error(`query(fetch, options): options must be an object.`);
  const wa = options.whenAborted;
  if (wa !== undefined && wa !== 'loading' && wa !== 'idle')
    throw new Error(`query(): whenAborted is 'loading' or 'idle' (or left out, for 'ready'), not ${JSON.stringify(wa)}.`);
  const paged = 'pages' in options;
  for (const k of Object.keys(options)) {
    if ((paged ? PAGED_OPTIONS : QUERY_OPTIONS).has(k)) continue;
    if (paged && QUERY_OPTIONS.has(k))
      throw new Error(`query(): ${k} can't be used with pages. A paged query's value is its list of pages; ${k} is for queries without pages.`);
    throw new Error(`query(): ${BELONGS[k] ?? `there's no option "${k}". Options: ${[...(paged ? PAGED_OPTIONS : QUERY_OPTIONS)].join(', ')}`}.`);
  }
  if (paged) {
    const pages = options.pages as Record<string, unknown> | null;
    if (!pages || typeof pages !== 'object') throw new Error(`query(): pages must be an object: { first, next }.`);
    for (const k of Object.keys(pages))
      if (!PAGES_OPTIONS.has(k))
        throw new Error(`query(): pages has no option "${k}". Inside pages: first, next, max, refresh${QUERY_OPTIONS.has(k) || PAGED_OPTIONS.has(k) ? ` (${k} goes next to pages, not inside it)` : ''}.`);
    if (!('first' in pages)) throw new Error(`query(): pages needs first, the first request's page (1, or null for a cursor).`);
    if (typeof pages.next !== 'function') throw new Error(`query(): pages.next must be a function: (lastPage, pages, page) => the next page, or undefined at the end.`);
    if (pages.refresh !== undefined && pages.refresh !== 'first' && pages.refresh !== 'loaded')
      throw new Error(`query(): pages.refresh is 'first' (start over, the default) or 'loaded' (refetch as many pages as were loaded), not ${JSON.stringify(pages.refresh)}.`);
  }
}

/**
 * Data from your server, read like any other key.
 *   todos: query(fetchTodos)                                  read as useGlobalState('todos')
 *   user:  query((id, signal) => fetchUser(id, signal))       read as useGlobalState('user', id)
 *   feed:  query((page) => fetchFeed(page), { pages: { first: 1, next } })
 * Without params, a query is a state key (undo, persist, key actions, computed values work with it).
 * With params, each params gets its own cached entry. With pages, it's a paged list.
 * Until its first response it holds undefined (typed so), unless you give `initial` (e.g. [] for a list).
 * The AbortSignal is always the argument after params, so a query without params takes a placeholder:
 *   sports: query((_: undefined, signal) => fetchSports(signal))
 */
export function query<TPage, TParam, P = undefined, A extends WhenAborted | undefined = undefined>(
  fetch: (page: TParam, params: P, signal: AbortSignal) => Promise<TPage>,
  options: PagedQueryOptions<TPage, TParam> & { whenAborted?: A }
): PagedQueryDef<TPage, TParam, P, A>;
export function query<T, R = T, P = undefined, A extends WhenAborted | undefined = undefined>(
  fetch: (params: P, signal: AbortSignal) => Promise<T>,
  options: QueryOptions<T, R> & { initial: T; whenAborted?: A }
): QueryDef<T, R, P, never, A>;
export function query<T, R = T, P = undefined, A extends WhenAborted | undefined = undefined>(
  fetch: (params: P, signal: AbortSignal) => Promise<T>,
  options?: QueryOptions<T, R> & { whenAborted?: A }
): QueryDef<T, R, P, undefined, A>;
export function query(fetch: (...args: never[]) => Promise<unknown>, options: object = {}): unknown {
  if (typeof fetch !== 'function') throw new Error(`query(fetch, options): fetch must be a function that returns a promise.`);
  checkQueryOptions(options as Record<string, unknown>);
  return { __kind: 'pages' in options ? 'pages' : 'query', fetch, options };
}

/** Throws a clear error for a hook option in the wrong place or a typo */
function checkUseOptions(options: unknown, key: string) {
  if (options === undefined) return;
  if (!options || typeof options !== 'object')
    throw new Error(`useGlobalState("${key}", params, options): options must be an object like { enabled }.`);
  for (const k of Object.keys(options))
    if (k !== 'enabled' && k !== 'waitFor')
      throw new Error(
        `useGlobalState("${key}", params, options): ${QUERY_OPTIONS.has(k) || PAGED_OPTIONS.has(k) ? `${k} is an option of the query: query(fetch, { ${k} }), not of the hook` : `there's no option "${k}"; the hook takes { enabled, waitFor }`}.`
      );
  const w = (options as UseOptions).waitFor;
  if (w !== undefined && !(Array.isArray(w) ? w : [w]).every((s) => s && typeof s === 'object' && 'loading' in s && 'blocked' in s))
    throw new Error(
      `useGlobalState("${key}", params, { waitFor }): waitFor takes the status of another query (the third item of its ` +
        `useGlobalState), or a list of them: const [user, , userStatus] = useGlobalState('currentUser'), then { waitFor: userStatus }.`
    );
}

/**
 * Declares the store's events and their payload types:
 *   events: defineEvents<{ toast: string; saved: { id: number } }>()
 * It only carries the type; nothing happens at runtime.
 */
export function defineEvents<E extends object>(): E {
  return undefined as unknown as E;
}


/* =========================================================================
   Public entry
   ========================================================================= */

type L<C> = LayerValues<C>;
type AllComputed<C1, C2, C3, C4, C5, C6, C7, C8> = AddedValues<C1> & AddedValues<C2> &
  AddedValues<C3> & AddedValues<C4> & AddedValues<C5> & AddedValues<C6> & AddedValues<C7> &
  AddedValues<C8>;

/**
 * `computed` is a list of layers (up to 8). A layer's functions can read state and every
 * earlier layer, so a value that reads another computed value goes in a later layer.
 */
export function createStore<
  S extends object,
  C1 extends ComputedLayer<Values<S>>,
  C2 extends ComputedLayer<Values<S> & L<C1>>,
  C3 extends ComputedLayer<Values<S> & L<C1> & L<C2>>,
  C4 extends ComputedLayer<Values<S> & L<C1> & L<C2> & L<C3>>,
  C5 extends ComputedLayer<Values<S> & L<C1> & L<C2> & L<C3> & L<C4>>,
  C6 extends ComputedLayer<Values<S> & L<C1> & L<C2> & L<C3> & L<C4> & L<C5>>,
  C7 extends ComputedLayer<Values<S> & L<C1> & L<C2> & L<C3> & L<C4> & L<C5> & L<C6>>,
  C8 extends ComputedLayer<Values<S> & L<C1> & L<C2> & L<C3> & L<C4> & L<C5> & L<C6> & L<C7>>,
  KA extends KeyActionsMap<S> & NoExtraKeys<KA, S>,
  A extends Record<string, (...args: never[]) => unknown> = NoKeys,
  E extends object = AnyEvents
>(
  initialState: S,
  options: StoreOptions<S, A, KA, E> & {
    computed?:
      | [C1]
      | [C1, C2]
      | [C1, C2, C3]
      | [C1, C2, C3, C4]
      | [C1, C2, C3, C4, C5]
      | [C1, C2, C3, C4, C5, C6]
      | [C1, C2, C3, C4, C5, C6, C7]
      | [C1, C2, C3, C4, C5, C6, C7, C8];
  } = {}
): Store<S, A, KA, AllComputed<C1, C2, C3, C4, C5, C6, C7, C8>, E> &
  ScopeApi<S, Store<S, A, KA, AllComputed<C1, C2, C3, C4, C5, C6, C7, C8>, E>> {
  type CV = AllComputed<C1, C2, C3, C4, C5, C6, C7, C8>;
  if ('queries' in options)
    throw new Error(
      `[${options.name ?? 'store'}] the queries option was replaced: declare each query in the state with ` +
        `query(fetch, options), e.g. { product: query((id, signal) => api.product(id, signal)) }, and read it with useGlobalState('product', id).`
    );
  return withScopes<S, A, KA, CV, E>(initialState, options, makeBase<S, A, KA, CV, E>(initialState, options));
}

/** The app's own store: shared under its name in the browser when `shared` is set */
const warnedSharedOnServer = new Set<string>();
const warnedShape = new Set<symbol>();
const SHAPE = Symbol('createStore.shape');
/** What a hot reload can change about a store: its keys, computed values, key actions, options */
function definitionShape(initialState: object, opts: object): string {
  const options = opts as Record<string, unknown>;
  const names = (o: unknown) => (o && typeof o === 'object' ? Object.keys(o).sort().join(',') : '');
  const computed = ((options.computed as Record<string, unknown>[] | undefined) ?? []).map(names).join('|');
  const keyActions = Object.entries((options.keyActions as Record<string, object> | undefined) ?? {}).map(([k, v]) => `${k}:${names(v)}`).sort().join(';');
  return [names(initialState), computed, keyActions, names(options)].join('#');
}

function makeBase<
  S extends object,
  A,
  KA,
  CV,
  E extends object
>(initialState: S, options: StoreOptions<S, A, KA, E> & { computed?: readonly Record<string, (get: never) => unknown>[] }): Store<S, A, KA, CV, E> {
  if (!options.shared) return build<S, A, KA, CV, E>(initialState, options);
  if (typeof window === 'undefined') {
    // On the server a shared store would be one store for every request (one user's
    // state leaking to another), so `shared` is ignored there: each call gets its own.
    // Said once per store, and not at all with ssr: true (which already gives per-request stores).
    const id = options.name ?? 'store';
    if (!options.ssr && !warnedSharedOnServer.has(id) && warnedSharedOnServer.add(id))
      console.warn(
      `[${options.name ?? 'store'}] shared: true is ignored on the server: each createStore() call gets ` +
        `its own store. Also don't keep per-user data in a module-level store there; create it per request.`
    );
    return build<S, A, KA, CV, E>(initialState, options);
  }
  const slot = Symbol.for(`createStore:${options.name ?? 'store'}`);
  const g = globalThis as unknown as Record<symbol, unknown>;
  // #12: a hot reload that changed the definition gets the old store (that's what `shared` is
  // for), so say so instead of silently using the old keys, computed values and actions
  const shape = definitionShape(initialState, options);
  const existing = g[slot] as (Store<S, A, KA, CV, E> & Record<symbol, string>) | undefined;
  if (existing && existing[SHAPE] !== shape && !warnedShape.has(slot) && warnedShape.add(slot))
    console.warn(
      `[${options.name ?? 'store'}] the store's definition changed (a hot reload?), but shared: true keeps the existing store, ` +
        `with its old keys, computed values and actions. Reload the page to use the new definition.`
    );
  if (existing) return existing;
  const store = build<S, A, KA, CV, E>(initialState, options);
  Object.defineProperty(store, SHAPE, { value: shape });
  return (g[slot] = store) as Store<S, A, KA, CV, E>;
}

/**
 * What `snapshot()` returns and `hydrate()` takes: plain values of state keys, plus `$queries`,
 * the loaded data of named and infinite queries (by cache entry; treat it as opaque).
 */
export type Snapshot<S> = Partial<RawValues<S>> & { $version?: number; $queries?: Record<string, unknown>; $ages?: Record<string, number> };

/**
 * The store in a React Server Component (the server build): every request gets its own store,
 * through React's per-request cache(), so `AppStore.fetchQuery(...)` in a page is that request's.
 * <Root> with no props sends it to the browser. Outside a render (Server Actions, Route Handlers)
 * there's no request store, so it says to use createScope() there.
 */
function serverComponentStore(name: string, named: boolean, createScope: () => unknown): object {
  const requestStore = cache!(() => ({ scope: createScope() as Record<string | symbol, unknown> }));
  const current = (what: string) => {
    const store = requestStore();
    if (store !== requestStore())
      throw new Error(
        `[${name}] ${what} was used outside a Server Component render, so there's no request store to use. ` +
          `In Server Actions and Route Handlers, create one: const scope = createScope(), then scope.fetchQuery(...).`
      );
    return store.scope;
  };
  const clientOnly = (hook: string) => () => {
    throw new Error(`[${name}] ${hook}() only works in Client Components ('use client'). In a Server Component, load the data directly: await fetchQuery(...).`);
  };
  const Root = ({ scope, children }: { scope?: { snapshot: () => unknown }; children?: ReactNode }) => {
    if (!named)
      throw new Error(`[${name}] <Root> in a Server Component needs the store's name, so the browser can find its data: createStore(state, { name: 'shop', ssr: true }).`);
    const store = scope ?? (current('<Root>') as unknown as { snapshot: () => unknown });
    return createElement(ClientRoot as never, { name, snapshot: store.snapshot() }, children);
  };
  const own: Record<string, unknown> = {
    createScope, Root,
    useGlobalState: clientOnly('useGlobalState'), useHistory: clientOnly('useHistory'),
    hydrate: () => {
      throw new Error(`[${name}] hydrate() is for the browser. In a Server Component, load data with fetchQuery(...) and render <Root>.`);
    },
  };
  return new Proxy({}, {
    get(_t, p) {
      if (typeof p !== 'string' || p === 'then') return undefined;
      if (p in own) return own[p];
      return current(`${p}()`)[p]; // the request's store: its methods, setters and key actions
    },
    has: (_t, p) => typeof p === 'string' && (p in own || p in current(`${String(p)}`)),
  });
}

/** What createStore adds on top of a store, for server rendering */
export interface ScopeApi<S, Inst> {
  /**
   * A new, independent store: the same keys, computed values and options, its own state.
   * `initial` replaces initial values (query keys given data count as loaded). This is the
   * request's store on the server. Scopes don't persist, sync tabs, keep an offline cache
   * or connect to devtools.
   */
  createScope(initial?: Partial<RawValues<S>> | Snapshot<S>): Inst;
  /**
   * Browser only: fills the app's store with the snapshot the server sent, once, and returns
   * it for `<Root scope={...}>`. With no argument, reads the data tag the server wrote with
   * scope.toScript(). Keys the store doesn't have are ignored with a warning.
   */
  hydrate(snapshot?: Snapshot<S> | null): Inst;
  /**
   * Components inside use `scope`: `<Root scope={scope}>`. Needs `ssr: true`. In a Server Component,
   * leave `scope` out: <Root> sends the request's store (`await AppStore.fetchQuery(...)` first).
   */
  Root(props: { scope?: Inst; children?: ReactNode }): ReactElement;
}

// Browser stores already filled from a snapshot (kept across hot reloads: a shared store
// is the same object every time, and it must not be filled again)
const hydratedStores = new WeakSet<object>();

// The store's own hooks, kept before createStore puts routed ones in their place
const OWN_HOOKS = Symbol('createStore.ownHooks');
type OwnHooks = Record<'useGlobalState' | 'useHistory', (...args: never[]) => unknown>;

function withScopes<
  S extends object,
  A,
  KA,
  CV,
  E extends object
>(
  initialState: S,
  options: StoreOptions<S, A, KA, E> & { computed?: readonly Record<string, (get: never) => unknown>[] },
  base: Store<S, A, KA, CV, E>
): Store<S, A, KA, CV, E> & ScopeApi<S, Store<S, A, KA, CV, E>> {
  type Inst = Store<S, A, KA, CV, E>;
  const name = options.name ?? 'store';
  const onServer = () => typeof window === 'undefined';
  const guard = !!options.ssr;
  // React's server build has no createContext; the Server Component path below never uses Ctx
  const Ctx = (RSC ? null : createContext<Inst | null>(null)) as ReturnType<typeof createContext<Inst | null>>;
  const seedOf = (inst: Inst) => (inst as unknown as Record<symbol, (v: Record<string, unknown>) => void>)[SEED];
  const b = base as unknown as Record<string | symbol, unknown>;
  // A shared store is wrapped again after hot reloading: keep its original hooks from the first time
  const own = (b[OWN_HOOKS] ??= {
    useGlobalState: b.useGlobalState, useHistory: b.useHistory,
  }) as OwnHooks;
  const stateKeys = new Set([...Object.keys(initialState), '$queries', '$ages', '$version']);
  const ssrVersion = (options.ssr && typeof options.ssr === 'object' && options.ssr.version) || 0;

  // The stores a <Root> may provide: this store and its own scopes, not another store's
  const ownScopes = new WeakSet<object>([base]);
  const createScope = (initial?: Partial<RawValues<S>> | Snapshot<S>): Inst => {
    const scope = build<S, A, KA, CV, E>(initialState, {
      ...options, shared: false, persist: false, syncTabs: false, offline: false, devtools: false,
      ...({ [APP_PERSIST]: (options as Record<symbol, unknown>)[APP_PERSIST] ?? options.persist } as object), // what the app saves: kept out of snapshots
    }, (base as unknown as Record<symbol, Definition>)[DEFINITION]);
    if (initial) seedOf(scope)(initial as Record<string, unknown>);
    ownScopes.add(scope);
    return scope;
  };

  // The data tag scope.toScript() wrote, read once and removed (null if there isn't one)
  const readDataTag = (): Snapshot<S> | null => {
    if (!options.name) {
      console.warn(`[${name}] hydrate() with no argument needs the store's name to find its data tag: createStore(state, { name: 'shop', ssr: true }).`);
      return null;
    }
    // Only a <script type="application/json"> is data, and of those the LAST one: the server writes
    // toScript() after the page's content, so an element in that content carrying the same id (user
    // HTML like a profile bio: sanitizers keep ids on divs) can never be read as server data.
    const id = dataTagId(name);
    const tags = Array.from(document.getElementsByTagName('script')).filter((s) => s.id === id && s.type === 'application/json');
    const el = tags[tags.length - 1];
    const others = document.querySelectorAll(`[id="${id.replace(/"/g, '\\"')}"]`).length - (el ? 1 : 0);
    if (others > 0)
      console.warn(`[${name}] hydrate() found ${others} other element(s) with the data tag's id "${id}" and ignored them: only the last <script type="application/json"> (the one toScript() writes after the page) is read. If the page shows user-written HTML, that's where they came from.`);
    if (!el) {
      console.warn(`[${name}] hydrate() found no data tag (id "${dataTagId(name)}"), so the app starts from its initial state. Did the server add scope.toScript() to the page?`);
      return null;
    }
    el.remove();
    try {
      return JSON.parse(el.textContent ?? 'null') as Snapshot<S> | null;
    } catch {
      console.warn(`[${name}] hydrate() couldn't read the data tag (not valid JSON), so the app starts from its initial state.`);
      return null;
    }
  };
  const hydrate = (...args: [(Snapshot<S> | null)?]): Inst => {
    let snapshot = args[0];
    if (onServer())
      throw new Error(`[${name}] hydrate() is for the browser. On the server, create the request's store with createScope(...).`);
    // The browser has one store. Fill it once: like useState's initial value, a later call (a
    // remount, StrictMode's second render, hot reload) doesn't overwrite what changed since.
    if (!hydratedStores.has(base)) {
      hydratedStores.add(base);
      if (args.length === 0) snapshot = readDataTag(); // hydrate(): the data the server put in the page
      // A snapshot made for another state shape (an old cached page after a deployment) is
      // ignored rather than seeded: React then renders this page fresh in the browser.
      const given = snapshot && typeof snapshot === 'object' ? ((snapshot as { $version?: unknown }).$version ?? 0) : ssrVersion;
      if (given !== ssrVersion) {
        console.warn(`[${name}] hydrate() ignored a snapshot made for version ${String(given)}; this app expects version ${ssrVersion} (ssr.version). The page renders from the initial state instead.`);
        return base;
      }
      if (snapshot && typeof snapshot === 'object') {
        const known: Record<string, unknown> = {};
        const notInStore: string[] = [];
        for (const [k, v] of Object.entries(snapshot)) {
          if (stateKeys.has(k)) known[k] = v;
          else notInStore.push(k);
        }
        // A snapshot can come from an older deployment: a removed key shouldn't break the page
        if (notInStore.length)
          console.warn(`[${name}] hydrate() ignored ${notInStore.map((k) => `"${k}"`).join(', ')}: not in the store. Was the snapshot made by another version of the app?`);
        seedOf(base)(known);
      }
    }
    return base;
  };

  let warnedNested = false;
  // Snapshots from Server Components already applied: the first fills the store (hydrate), later
  // ones (client-side navigation) only add server data, so nothing the user changed is overwritten
  const appliedSnapshots = new WeakSet<object>();
  const fromServer = (snapshot: unknown) => {
    if (!snapshot || typeof snapshot !== 'object' || appliedSnapshots.has(snapshot)) return;
    appliedSnapshots.add(snapshot);
    if (!hydratedStores.has(base)) {
      hydrate(snapshot as Snapshot<S>);
      return;
    }
    const snap = snapshot as Record<string, unknown>;
    if ((snap.$version ?? 0) !== ssrVersion) return; // another version's data: not merged
    const queryDefs = (b[DEFINITION] as Definition | undefined)?.queryDefs ?? {};
    const serverData: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(snap)) if (k === '$queries' || k === '$ages' || k in queryDefs) serverData[k] = v;
    seedOf(base)(serverData);
  };
  b[MERGE] = fromServer;
  const withHeldNotify = (fn: () => void) => ((b[QUIET] as ((f: () => void) => void) | undefined) ?? ((f: () => void) => f()))(fn);
  if (options.name && !onServer()) storesByName.set(name, base);

  const Root = ({ scope, children }: { scope?: Inst; children?: ReactNode }) => {
    const parent = useContext(Ctx);
    // Nesting a Root with its own createScope() in the browser is how part of a page gets an
    // isolated store. These two are mistakes: two request stores in one server render, and the
    // browser's app store under another Root.
    if (parent && scope && !warnedNested && (onServer() || scope === base)) {
      warnedNested = true;
      console.warn(
        onServer()
          ? `[${name}] <Root> is nested inside another <Root> during server rendering, so part of the page uses a ` +
              `different store than the request's. Render <Root scope={...}> once, at the top of the app.`
          : `[${name}] the app's store (from hydrate()) is given to a <Root> nested inside another <Root>. ` +
              `Render <Root scope={hydrate(snapshot)}> once, at the top of the app.`
      );
    }
    if (!scope)
      throw new Error(
        `[${name}] <Root> needs a scope here: <Root scope={createScope(...)}> on the server, <Root scope={hydrate(snapshot)}> in the browser. ` +
          `(Only in a Server Component can <Root> go without one: there it sends the request's store.)`
      );
    if (!ownScopes.has(scope))
      throw new Error(`[${name}] <Root> got a scope made by a different store. Pass ${name === 'store' ? 'this store' : name}'s own: createScope() or hydrate() of the same store whose hooks the components use.`);
    return createElement(Ctx.Provider, { value: scope }, children);
  };

  // Hooks use the nearest Root, else the app's store. Plain parameters, no spreading:
  // these run on every render of every component.
  const useInstance = (hook: string): Inst | null => {
    const scoped = useContext(Ctx);
    const pending = useContext(__SnapshotContext); // a Server Component's <Root>, if any (always read: same hooks every render)
    if (scoped) return scoped !== base ? scoped : null;
    const mine = pending?.[name];
    if (mine) {
      if (onServer()) {
        // Next.js rendering Client Components for one request: a store for this request, from its snapshot
        return (mine.scope ??= createScope(mine.snapshot as Partial<RawValues<S>>)) as Inst;
      }
      // The browser: fill the app's store (the first snapshot) or add a later page's server data.
      // It must be there for this render (hydration compares with the server HTML), but other
      // components mustn't be updated while this one renders: so write now, notify right after.
      withHeldNotify(() => fromServer(mine.snapshot));
      return null;
    }
    if (guard && onServer())
      throw new Error(
        `[${name}] ${hook}() ran during server rendering outside <Root>. On the server every request needs its own ` +
          `store: render the app inside <Root scope={createScope(...)}>.`
      );
    return null; // the app's store: call its own hook directly
  };
  type H = (a?: never, b?: never, c?: never) => unknown;
  const scopedHook = (inst: Inst, hook: string) => (inst as unknown as Record<string, H>)[hook];
  function useGlobalState(a?: never, c?: never, d?: never) {
    const inst = useInstance('useGlobalState');
    const hook = inst ? scopedHook(inst, 'useGlobalState') : (own.useGlobalState as H);
    // Forward exactly what was passed: useGlobalState(key, undefined) means "params not known yet"
    // (arguments.length, not a rest array: that would be allocated on every render)
    const n = arguments.length;
    return n === 1 ? hook(a) : n === 2 ? hook(a, c) : hook(a, c, d);
  }
  function useHistory() {
    const inst = useInstance('useHistory');
    return inst ? scopedHook(inst, 'useHistory')() : (own.useHistory as H)();
  }
  const added: Record<string, unknown> = { useGlobalState, useHistory, createScope, hydrate, Root };
  if (RSC) return serverComponentStore(name, options.name !== undefined, createScope) as Inst & ScopeApi<S, Inst>;

  if (!guard) {
    // Without ssr: true, nothing reads a context: hooks stay the store's own, so apps that don't
    // server-render pay nothing for scopes. createScope() works here too; Root and hydrate
    // need ssr: true, because only then do hooks look for a Root.
    const needsSsr = (what: string) => () => {
      throw new Error(`[${name}] ${what} needs ssr: true in createStore's options: only then do hooks look for a Root.`);
    };
    b.createScope = createScope;
    b.Root = needsSsr('<Root>');
    b.hydrate = needsSsr('hydrate()');
    return base as Inst & ScopeApi<S, Inst>;
  }
  if (!onServer()) {
    // In the browser the store itself carries the routed hooks and the scope API. It stays
    // the same object, so shared stores are still identical across createStore calls.
    for (const [k, v] of Object.entries(added)) b[k] = v;
    return base as Inst & ScopeApi<S, Inst>;
  }

  // On the server with ssr: true, the app's store must not be used: one store would serve every
  // request. Its members are handed out as traps that throw when called, so module-level code
  // like `const { actions } = store` still loads; only a real call throws.
  const trap = (path: string): unknown =>
    new Proxy(function () {}, {
      get: (_t, p) => (p === 'then' || typeof p === 'symbol' ? undefined : trap(`${path}.${String(p)}`)),
      apply: () => {
        throw new Error(
          `[${name}] Cannot call ${path}() during server rendering: on the server every request has its own store, ` +
            `and this call can't tell which one it's for. Use the request's scope instead: scope.${path}(...), ` +
            `with const scope = createScope(...).`
        );
      },
    });
  return new Proxy(base, {
    get(target, p, receiver) {
      if (typeof p === 'string') {
        if (p in added) return added[p];
        if (p in target) return trap(p);
      }
      return Reflect.get(target, p, receiver);
    },
  }) as Inst & ScopeApi<S, Inst>;
}

export type Store<
  S extends object,
  A,
  KA = NoKeys,
  CV = NoKeys,
  E extends object = AnyEvents
> = ReturnType<typeof build<S, A, KA, CV, E>>;

/* =========================================================================
   Implementation
   ========================================================================= */

/** Internal: how createScope and Root give a store its initial state */
const SEED = Symbol('createStore.seed');
const RESERVED_EXTRAS = new Set(['createScope', 'Root', 'hydrate']);
const warnedReserved = new Set<string>();

/** Waits ms, or rejects as soon as the signal aborts */
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v != null && typeof (v as { then?: unknown }).then === 'function';

/* ---------- Stable keys for query params ---------- */

const MAX_KEY_DEPTH = 100;
// Params past these limits throw instead of costing CPU on every render and request
const MAX_KEY_VALUES = 10_000;
const MAX_KEY_CHARS = 1_000_000;
let keyValues = 0;
let keyChars = 0;
const UNSUPPORTED_TAGS = new Set([
  '[object WeakMap]', '[object WeakSet]', '[object WeakRef]', '[object Promise]',
  '[object Generator]', '[object AsyncGenerator]', '[object URLSearchParams]',
]);

/**
 * Turns query params into a string, so that:
 *  - equal params always give the same string, whatever the property order
 *    (and Map/Set insertion order), and
 *  - different params never give the same string.
 * JSON.stringify can't promise the second part: it turns every Map and Set
 * into {}, NaN and Infinity into null, and throws on BigInt and cycles.
 * Values that can't be keyed reliably (functions, symbols, WeakMap, Promise...)
 * throw a clear error instead of silently sharing an entry.
 */
function stableKey(value: unknown): string {
  keyValues = 0;
  keyChars = 0;
  return keyOf(value, [], 0);
}
// keyOf's "too many values" error (keyOf is a function declaration further down)
keyOf.tooLarge = (): never => {
  throw new Error(`Query params are too large (more than ${MAX_KEY_VALUES.toLocaleString('en')} values) to use as a cache key. Pass an id or a small filter object instead.`);
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- inspects arbitrary values (Map, Date, boxed...)
function keyOf(v: any, ancestors: object[], depth: number): string {
  if (++keyValues > MAX_KEY_VALUES)
    throw new Error(`Query params are too large (more than ${MAX_KEY_VALUES.toLocaleString('en')} values) to use as a cache key. Pass an id or a small filter object instead.`);
  switch (typeof v) {
    case 'string':
      if ((keyChars += v.length) > MAX_KEY_CHARS)
        throw new Error(`Query params are too large (more than ${MAX_KEY_CHARS.toLocaleString('en')} characters) to use as a cache key. Pass an id or a small filter object instead.`);
      return JSON.stringify(v);
    case 'number': return Object.is(v, -0) ? '-0' : String(v); // also "NaN", "Infinity", "-Infinity"
    case 'boolean': return v ? 'true' : 'false';
    case 'bigint': return `${v}n`;
    case 'undefined': return 'undefined';
    case 'symbol': throw new Error(`Query params can't contain a symbol (${String(v)}).`);
    case 'function': throw new Error(`Query params can't contain a function, so they can't be used as a cache key.`);
  }
  if (v === null) return 'null';
  if (depth >= MAX_KEY_DEPTH)
    throw new Error(`Query params are nested too deeply (more than ${MAX_KEY_DEPTH} levels) to use as a cache key.`);
  if (ancestors.includes(v)) throw new Error(`Query params contain a circular reference, so they can't be used as a cache key.`);

  const isArray = Array.isArray(v);
  const proto = isArray ? Array.prototype : Object.getPrototypeOf(v);
  const plain = proto === Object.prototype || proto === null;

  // Plain objects and arrays (nearly all params) skip the checks for special types
  let tag = '[object Object]';
  if (!isArray && !plain) {
    tag = Object.prototype.toString.call(v);
    if (UNSUPPORTED_TAGS.has(tag)) throw new Error(`A ${tag.slice(8, -1)} can't be used in query params.`);
    if (v instanceof Date) return `#Date(${v.getTime()})`; // NaN for an invalid date
    if (v instanceof RegExp) return `#RegExp(${String(v)})`;
    if (v instanceof Error) return `#Error(${JSON.stringify(v.name)},${JSON.stringify(v.message)})`;
    if (tag === '[object Number]' || tag === '[object String]' || tag === '[object Boolean]' || tag === '[object BigInt]')
      return `#Boxed(${keyOf(v.valueOf(), ancestors, depth + 1)})`;
    if (v instanceof ArrayBuffer) return `#ArrayBuffer(${Array.from(new Uint8Array(v)).join(',')})`;
    if (ArrayBuffer.isView(v))
      return `#${v.constructor?.name ?? 'View'}(${Array.from(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)).join(',')})`;
  }

  ancestors.push(v);
  try {
    const next = depth + 1;
    if (isArray) {
      if (keyValues + v.length > MAX_KEY_VALUES) keyOf.tooLarge();
      const parts: string[] = [];
      for (let i = 0; i < v.length; i++) parts.push(keyOf(v[i], ancestors, next)); // holes count as undefined
      return `[${parts.join(',')}]`;
    }
    if (!plain) {
      if (v instanceof Map) {
        const parts = [...v].map(([k, val]) => `${keyOf(k, ancestors, next)}=>${keyOf(val, ancestors, next)}`).sort();
        return `#Map{${parts.join(',')}}`;
      }
      if (v instanceof Set) return `#Set{${[...v].map((x) => keyOf(x, ancestors, next)).sort().join(',')}}`;
      if (tag !== '[object Object]') throw new Error(`A ${tag.slice(8, -1)} can't be used in query params.`);
    }
    if (typeof v.toJSON === 'function') return `#toJSON(${keyOf(v.toJSON(), ancestors, next)})`;

    const keys = Object.keys(v);
    if (keyValues + keys.length > MAX_KEY_VALUES) keyOf.tooLarge(); // before sorting thousands of keys
    if (keys.length > 1) keys.sort();
    let out = '';
    for (const k of keys) {
      const item = v[k];
      if (item !== undefined) out += `${out ? ',' : ''}${JSON.stringify(k)}:${keyOf(item, ancestors, next)}`; // undefined = absent, like JSON
    }
    const prefix = plain ? '' : v.constructor?.name || '<anonymous>';
    return `${prefix}{${out}}`;
  } finally {
    ancestors.pop();
  }
}

async function withRetry<T>(
  fn: (params: unknown, signal: AbortSignal) => Promise<T>,
  params: unknown,
  retries: number,
  signal: AbortSignal,
  retryDelay?: RetryDelay
): Promise<T> {
  const delayOf = typeof retryDelay === 'function' ? retryDelay : defaultRetryDelay;
  for (let attempt = 0; ; attempt++) {
    try {
      const data = await fn(params, signal);
      if (signal.aborted) throw signal.reason; // a fetch that ignored the signal
      return data;
    } catch (e) {
      if (attempt >= retries || signal.aborted) throw e;
      await sleep(delayOf(attempt + 1), signal);
    }
  }
}

/**
 * What a store's declared state works out to: its keys, queries and initial values, and the
 * prototypes that hold its setters. It only depends on the object passed to createStore, so it's
 * computed once and shared by every scope (a server creates one per request).
 */
interface Definition {
  source: Record<string, unknown>; // what the object held when this was worked out
  keys: string[];
  values: Record<string, unknown>; // the declared initial values; never changed
  queryDefs: Record<string, QueryDef<unknown>>;
  namedDefs: Record<string, QueryConfig | AnyInfinite>;
  pagedKeys: Set<string>;
  setProto: object; // store.set.<key>: a getter per key, shared, that asks the store it's read on
  directProto: object | null; // store.<key>: the same, minus names the store itself uses (made on first use)
  apiProto: object | null; // api.<key> in actions
}
const SETTER_OF = Symbol('createStore.setterOf');
const DEFINITION = Symbol('createStore.definition');
/** Same keys, same values (by identity): no allocation beyond the key list */
function sameEntries(a: Record<string, unknown>, b: object): boolean {
  const keys = Object.keys(b);
  if (keys.length !== Object.keys(a).length) return false;
  for (const k of keys) if (!(k in a) || !Object.is(a[k], (b as Record<string, unknown>)[k])) return false;
  return true;
}
const definitions = new WeakMap<object, Definition>();

function definitionOf(initialState: object, name: string): Definition {
  const known = definitions.get(initialState);
  if (known && sameEntries(known.source, initialState)) return known;
  for (const key of Object.keys(initialState)) {
    if (key === '$version' || key === '$queries' || key === '$ages')
      throw new Error(`[${name}] "${key}" can't be a state key: server-rendering snapshots use that name. Rename the key.`);
    if (key.startsWith('\u0000')) throw new Error(`[${name}] state keys can't start with \\u0000 (the store uses those names internally).`);
  }
  // Objects without a prototype, so names like "toString" or "constructor" are never mistaken for keys
  const queryDefs: Record<string, QueryDef<unknown>> = Object.create(null);
  // Every query() is also a named query (one cache entry per params); paged ones only that
  const namedDefs: Record<string, QueryConfig | AnyInfinite> = Object.create(null);
  const values: Record<string, unknown> = Object.create(null);
  for (const [key, def] of Object.entries(initialState) as [string, unknown][]) {
    const kind = (def as { __kind?: unknown } | null)?.__kind;
    if (kind === 'query') {
      const q = def as QueryDef<unknown>;
      queryDefs[key] = q;
      values[key] = 'initial' in q.options ? q.options.initial : undefined; // nothing yet, like a query with params
      const o = q.options;
      namedDefs[key] = { fetch: (params: unknown, signal: AbortSignal) => q.fetch(params, signal), whenAborted: o.whenAborted, staleTime: o.staleTime, retry: o.retry, retryDelay: o.retryDelay, gcTime: o.gcTime };
    } else if (kind === 'pages') {
      const q = def as PagedQueryDef<unknown, unknown>;
      const o = q.options;
      namedDefs[key] = {
        __kind: 'infinite', firstPage: o.pages.first,
        fetch: (page: unknown, signal: AbortSignal, params: unknown) => q.fetch(page, params, signal),
        nextPage: o.pages.next as AnyInfinite['nextPage'], maxPages: o.pages.max, refresh: o.pages.refresh, whenAborted: o.whenAborted, staleTime: o.staleTime, retry: o.retry, retryDelay: o.retryDelay, gcTime: o.gcTime,
      } as unknown as AnyInfinite;
    } else {
      values[key] = def;
    }
  }
  const keys = Object.keys(values);
  const setProto = Object.create(null);
  for (const k of keys)
    Object.defineProperty(setProto, k, {
      enumerable: true,
      get(this: Record<symbol, (key: string) => unknown>) {
        return this[SETTER_OF](k);
      },
    });
  const definition: Definition = {
    source: { ...initialState } as Record<string, unknown>,
    keys, values, queryDefs, namedDefs,
    pagedKeys: new Set(Object.keys(namedDefs).filter((k) => '__kind' in namedDefs[k])),
    setProto, directProto: null, apiProto: null,
  };
  definitions.set(initialState, definition);
  return definition;
}

const API_NAMES = { getState: 1, setState: 1, emit: 1, on: 1, fetchQuery: 1, setQueryData: 1, invalidate: 1, whenOnline: 1, batch: 1, abort: 1 };
/** api.<key> in actions: the same shared getters, minus the api's own names (the store already warned) */
function setterProtoOf(def: Definition, memberNames: object, field: 'apiProto'): object {
  const known = def[field];
  if (known) return known;
  const proto = {};
  for (const k of def.keys) {
    if (k in memberNames || k in Object.prototype) continue;
    Object.defineProperty(proto, k, {
      enumerable: true,
      get(this: Record<symbol, (key: string) => unknown>) {
        return this[SETTER_OF](k);
      },
    });
  }
  return (def[field] = proto);
}

/** store.<key>: the setter getters, without the names the store itself uses (warned about once) */
function directProtoOf(def: Definition, memberNames: object, name: string): object {
  if (def.directProto) return def.directProto;
  const proto = {};
  for (const k of def.keys) {
    if (k in memberNames || k in Object.prototype || RESERVED_EXTRAS.has(k)) {
      if (!warnedReserved.has(`${name}:${k}`)) {
        warnedReserved.add(`${name}:${k}`);
        console.warn(`[${name}] "${k}" is also the name of a store method, so it isn't available as store.${k}. Use store.set.${k}(...) instead.`);
      }
      continue;
    }
    Object.defineProperty(proto, k, {
      enumerable: true,
      get(this: Record<symbol, (key: string) => unknown>) {
        return this[SETTER_OF](k);
      },
    });
  }
  return (def.directProto = proto);
}

function build<
  S extends object,
  A,
  KA,
  CV,
  E extends object = AnyEvents
>(
  initialState: S,
  options: StoreOptions<S, A, KA, E> & {
    computed?: readonly Record<string, (get: never) => unknown>[];
  },
  sharedDefinition?: Definition // a scope passes its store's: the same definition by design
) {
  type SV = Values<S>; // state values
  type RV = RawValues<S>; // what setters write (the raw data for a query with select)
  type V = SV & CV; // state and computed values
  type Key = keyof V & string;
  type StateKey = keyof S & string;
  const name = options.name ?? 'store';
  const isBrowser = typeof window !== 'undefined';

  /* ---------- Sort keys into plain, query and computed ---------- */

  // Worked out once per store, shared by its scopes
  const def = sharedDefinition ?? definitionOf(initialState, name);
  const queryDefs = def.queryDefs;
  const namedDefs = def.namedDefs;
  const computedDefs: Record<string, (get: never) => unknown> = Object.create(null);
  // This store's initial values: the declared ones, plus what hydrate() or createScope() fill in
  // (own properties). Inheriting means a scope doesn't copy every declared value.
  const initialValues: Record<string, unknown> = Object.create(def.values);
  const pagedKeys = def.pagedKeys;
  const isPaged = (k: string) => pagedKeys.has(k); // runs on every render: one set lookup
  // What reset() goes back to: the values declared in createStore, never changed
  const declaredValues = def.values;
  // Layers only matter for typing; at runtime dependencies are tracked per key
  for (const layer of options.computed ?? []) {
    for (const [key, read] of Object.entries(layer)) {
      if (key in initialValues || key in computedDefs)
        throw new Error(`computed "${key}" is defined twice (as a state key or in two layers).`);
      if (typeof read !== 'function')
        throw new Error(`computed "${key}" must be a function, e.g. ${key}: (get) => ...`);
      computedDefs[key] = read;
    }
  }
  const isQuery = (k: string) => typeof k === 'string' && k in queryDefs;
  const isComputed = (k: string) => typeof k === 'string' && k in computedDefs;
  // The same keys as initialValues, without walking its prototype chain (this runs on every read)
  const stateKeySet = def.values;
  const isStateKey = (k: string) => typeof k === 'string' && k in stateKeySet;
  const hasKey = (k: string) => isStateKey(k) || isComputed(k);
  // Built once: the keys never change after the store is created
  const STATE_KEYS = def.keys; // the same list for every scope (initialValues only holds overrides)
  const ALL_KEYS = [...STATE_KEYS, ...Object.keys(computedDefs)];
  const allKeys = () => ALL_KEYS;

  /* ---------- The state reader used by selectors and computed functions ---------- */

  // Names that libraries, devtools and console.log probe on objects.
  // Reading them returns undefined without a warning.
  const PROBES = new Set([
    'then', 'toJSON', 'constructor', '$$typeof', 'valueOf', 'toString',
    'inspect', 'nodeType', 'tagName', 'asymmetricMatch', 'prototype',
  ]);
  const warned = new Set<string>();
  const readers = new WeakSet<object>();
  const rejectReader = (value: unknown, where: string) => {
    if (typeof value === 'function' && readers.has(value as object))
      throw new Error(
        `${where} returns the state itself. Return the values you need instead, e.g. ({ todos }) => todos.`
      );
  };

  /**
   * Builds the value a selector or computed function receives. It is a function
   * (so get('todos') works) wrapped in a Proxy (so state.todos and
   * ({ todos }) => ... work). Every key read is passed to `track`.
   */
  function makeReader(
    read: (key: string) => unknown,
    track: (key: string) => void,
    where: string
  ): unknown {
    const get = (key: string) => {
      if (!hasKey(key))
        throw new Error(
          isPaged(key)
            ? `${where} reads "${key}", a paged query: pages aren't state, so read them with useGlobalState('${key}').`
            : `${where} reads "${key}", which is not in the store.`
        );
      track(key);
      return read(key);
    };
    const readOnly = () => {
      throw new Error(
        `State is read-only inside ${where}. Use setState() or a setter from useGlobalState() instead.`
      );
    };
    const proxy = new Proxy(get, {
      apply: (_t, _this, args) => get(args[0]),
      get: (_t, key) => {
        if (typeof key !== 'string') return undefined;
        if (hasKey(key)) {
          track(key);
          return read(key);
        }
        if (!PROBES.has(key) && !warned.has(key)) {
          warned.add(key);
          console.warn(`[${name}] ${where} reads "${key}", which is not in the store.`);
        }
        return undefined;
      },
      has: (_t, key) => typeof key === 'string' && hasKey(key),
      ownKeys: () => {
        // {...state} or Object.keys(state) reads (and tracks) every key
        const keys = allKeys();
        keys.forEach(track);
        return keys.slice(); // a copy: callers must not be able to change the store's list
      },
      getOwnPropertyDescriptor: (_t, key) =>
        typeof key === 'string' && hasKey(key)
          ? { enumerable: true, configurable: true, writable: false, value: get(key) }
          : undefined,
      set: readOnly,
      deleteProperty: readOnly,
      defineProperty: readOnly,
    });
    readers.add(proxy);
    return proxy;
  }

  /** Same top-level values? Used so `state => ({ a, b })` doesn't re-render needlessly. */
  function shallowEqual(a: unknown, b: unknown) {
    if (Object.is(a, b)) return true;
    if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
    const ra = a as Record<string, unknown>;
    const rb = b as Record<string, unknown>;
    const ka = Object.keys(ra);
    const kb = Object.keys(rb);
    return ka.length === kb.length && ka.every((k) => Object.is(ra[k], rb[k]));
  }

  // Holds plain and query values. Computed values live in computedCache.
  const state: Record<string, unknown> = { ...def.values };

  /* ---------- Subscriptions (one channel per key) ---------- */

  const listeners = new Map<string, Set<() => void>>();
  const subscribers = new Map<string, (cb: () => void) => () => void>();
  // While `holdNotify`, notifications wait for a microtask (writes made during a render: #1)
  let holdNotify = 0;
  const held = new Set<string>();
  const heldEvents: (() => void)[] = []; // change events for subscribe/onChange/logger, delivered after the render
  const notify = (channel: string) => {
    if (holdNotify > 0) {
      held.add(channel);
      return;
    }
    listeners.get(channel)?.forEach((cb) => cb());
  };
  const hasListeners = (channel: string) =>
    (listeners.get(channel)?.size ?? 0) > 0;
  const subscribeTo = (channel: string) => {
    if (!subscribers.has(channel)) {
      subscribers.set(channel, (cb) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set());
        listeners.get(channel)!.add(cb);
        return () => {
          const set = listeners.get(channel);
          set?.delete(cb);
          if (set && set.size === 0) listeners.delete(channel);
        };
      });
    }
    return subscribers.get(channel)!;
  };
  const noSubscribe = () => () => {};

  /* ---------- Computed engine ---------- */

  interface ComputedEntry {
    value: unknown; // FAILED when it threw: `error` holds what it threw
    deps: Set<string>;
    dirty: boolean;
    error?: unknown;
  }
  const computedCache = new Map<string, ComputedEntry>();
  const computedReaders = new Map<string, { holder: { deps: Set<string> | null }; reader: unknown }>();
  const NO_VALUE = Symbol('no value');
  const FAILED = Symbol('failed');
  const THREW = Symbol('threw');
  const dependents = new Map<string, Set<string>>(); // key -> computed keys that read it
  // Keys components show, and the queries those keys read (directly or through computed values)
  const roots = new Map<string, number>(); // key -> how many components show it
  let rootQueries = new Set<string>();
  // Computed keys whose dependencies changed, handled after the current render/update
  let relinked = new Set<string>();
  let relinkScheduled = false;
  const evaluating: string[] = []; // the chain of computed keys being calculated right now

  /** "a → b → c → a", shortened in the middle for very long loops */
  const describeLoop = (chain: string[], key: string) => {
    const loop = [...chain.slice(chain.indexOf(key)), key];
    const shown = loop.length > 12 ? [...loop.slice(0, 6), '…', ...loop.slice(-3)] : loop;
    return `${shown.join(' → ')}${loop.length > 12 ? ` (${loop.length - 1} keys)` : ''}`;
  };

  function readKey(key: string): unknown {
    return isComputed(key) ? readComputed(key) : readState(key);
  }

  // query(fn, { select }): state keeps the raw data; reads see select(raw),
  // recalculated only when the raw data changes
  const selectMemo = new Map<string, { raw: unknown; out: unknown }>();
  function readState(key: string): unknown {
    const select = queryDefs[key]?.options.select;
    const raw = state[key];
    if (!select || raw === undefined) return raw; // select isn't run on "nothing loaded yet" 
    const m = selectMemo.get(key);
    if (m && Object.is(m.raw, raw)) return m.out;
    const out = select(raw);
    selectMemo.set(key, { raw, out });
    return out;
  }

  function readComputed(key: string): unknown {
    const entry = computedCache.get(key);
    if (!entry || entry.dirty) return evaluate(key);
    if (entry.value === FAILED) throw entry.error; // same inputs, same error: don't run it again
    return entry.value;
  }

  /** Save a computed result, re-linking dependencies only if they changed. */
  function storeComputed(key: string, value: unknown, deps: Set<string>, dirty: boolean) {
    const entry = computedCache.get(key);
    const old = entry?.deps;
    let same = !!old && old.size === deps.size;
    if (same) for (const d of deps) if (!old!.has(d)) { same = false; break; }
    if (!same) {
      // Its status depends on which keys it reads; so do the statuses that include it
      if (old) onRelink(key);
      else computedStatusCache.delete(key);
      if (old)
        for (const d of old) {
          const set = dependents.get(d);
          if (!set) continue;
          set.delete(key);
          if (set.size === 0) dependents.delete(d); // don't keep empty sets around
        }
      for (const d of deps) {
        let set = dependents.get(d);
        if (!set) dependents.set(d, (set = new Set()));
        set.add(key);
      }
    }
    if (entry) {
      entry.value = value;
      entry.deps = same ? old! : deps;
      entry.dirty = dirty;
      entry.error = undefined;
    } else computedCache.set(key, { value, deps, dirty });
  }

  /** Drop the cached status of key and of every computed value that reads it */
  function dropStatusCaches(key: string, seen = new Set<string>()) {
    if (seen.has(key)) return;
    seen.add(key);
    computedStatusCache.delete(key);
    dependents.get(key)?.forEach((c) => dropStatusCaches(c, seen));
  }

  /**
   * A computed key now reads different keys (mode ? a : b). Its cached statuses
   * are dropped right away; notifying and loading newly read queries waits for a
   * microtask, because this can happen while React is rendering.
   */
  function onRelink(key: string) {
    dropStatusCaches(key);
    relinked.add(key);
    if (relinkScheduled) return;
    relinkScheduled = true;
    queueMicrotask(() => {
      relinkScheduled = false;
      const keys = relinked;
      relinked = new Set();
      keys.forEach((k) => statusChanged(k)); // re-render whoever shows these statuses
      if (roots.size) syncMountedQueries();
    });
  }

  function evaluate(key: string): unknown {
    if (evaluating.includes(key))
      throw new Error(
        `computed "${evaluating[0]}" depends on itself through a loop: ${describeLoop(evaluating, key)}. ` +
          `Break the loop so one of these keys doesn't read the next.`
      );
    evaluating.push(key);
    const deps = new Set<string>();
    // One reader per computed key, reused on every run; it records into `deps`
    let r = computedReaders.get(key);
    if (!r) {
      const holder = { deps: null as Set<string> | null };
      r = { holder, reader: makeReader(readKey, (d) => void holder.deps?.add(d), `computed "${key}"`) };
      computedReaders.set(key, r);
    }
    const holder = r.holder;
    const outerDeps = holder.deps;
    holder.deps = deps;
    const reader = r.reader;
    try {
      const value = computedDefs[key](reader as never);
      rejectReader(value, `computed "${key}"`);
      storeComputed(key, value, deps, false);
      return value;
    } catch (error) {
      // Stay linked to what it read, so a change to the inputs re-runs it;
      // until then reads rethrow the same error instead of running it again
      storeComputed(key, FAILED, deps, false);
      computedCache.get(key)!.error = error;
      throw error;
    } finally {
      holder.deps = outerDeps;
      evaluating.pop();
    }
  }

  // Store-wide selectors, indexed by the keys they read last time, so a change
  // wakes only the selectors that read that key (not every selector).
  const selectorIndex = new Map<string, Set<() => void>>();
  const notifyAll = (key: string) => {
    notify(key);
    const set = selectorIndex.get(key);
    if (set) [...set].forEach((cb) => cb());
  };
  function indexSelector(cb: () => void, from: string[], to: string[]) {
    for (const k of from) {
      const set = selectorIndex.get(k);
      set?.delete(cb);
      if (set && set.size === 0) selectorIndex.delete(k);
    }
    for (const k of to) {
      if (!selectorIndex.has(k)) selectorIndex.set(k, new Set());
      selectorIndex.get(k)!.add(cb);
    }
  }

  /**
   * A key changed. Two phases, so nobody ever sees a half-updated graph:
   *   1. mark every computed key that depends on it (directly or not) as dirty
   *   2. notify the key, then each computed key whose value actually changed
   * Computed values are recalculated lazily when read, so in phase 2 every
   * read sees fresh inputs (no "diamond" glitches).
   */
  function changed(...keys: string[]) {
    const stale: { key: string; prev: unknown }[] = [];
    const seen = new Set<string>();
    const visit = (k: string) => {
      for (const c of dependents.get(k) ?? []) {
        if (seen.has(c)) continue;
        seen.add(c);
        const entry = computedCache.get(c);
        if (!entry) continue;
        stale.push({ key: c, prev: entry.dirty ? NO_VALUE : entry.value });
        entry.dirty = true;
        visit(c);
      }
    };
    keys.forEach(visit);

    keys.forEach(notifyAll);
    for (const { key: c, prev } of stale) {
      // Nobody is listening: leave it dirty until someone reads it
      if (!hasListeners(c) && !selectorIndex.has(c)) continue;
      let next: unknown;
      try {
        next = readComputed(c);
      } catch {
        notifyAll(c); // let the component re-render and hit its error boundary
        continue;
      }
      if (prev === NO_VALUE || !Object.is(prev, next)) notifyAll(c);
    }
  }

  /* ---------- Persistence ---------- */

  const p = options.persist;
  const persistCfg: PersistOptions<S> | null = !p
    ? null
    : p === true || p === 'local'
    ? { storage: 'local' }
    : p === 'session'
    ? { storage: 'session' }
    : p;
  const persistVersion = persistCfg?.version ?? 0;
  const storage = (type: 'local' | 'session') => {
    try {
      return isBrowser
        ? type === 'session'
          ? sessionStorage
          : localStorage
        : null;
    } catch {
      return null;
    }
  };
  // The offline cache (options.offline): JSON in localStorage; failures are ignored
  const offlineMax = (typeof options.offline === 'object' && options.offline.maxSize) || 2_000_000;
  let warnedOfflineSize = false;
  const writeOffline = (suffix: string, data: unknown) => {
    try {
      const text = JSON.stringify(data);
      const ls = storage('local');
      if (text.length > offlineMax) {
        // Too big to keep: skip it, and drop the older copy so it can't come back stale
        ls?.removeItem(`${name}:${suffix}`);
        if (!warnedOfflineSize) {
          warnedOfflineSize = true;
          console.warn(`[${name}] the offline copy of server data is ${text.length.toLocaleString('en')} characters, more than offline.maxSize (${offlineMax.toLocaleString('en')}), so it isn't saved. Raise offline: { maxSize }, or keep large responses out of the store.`);
        }
        return;
      }
      ls?.setItem(`${name}:${suffix}`, text);
    } catch {}
  };
  const readOffline = <T,>(suffix: string): Record<string, T> => {
    if (!options.offline) return {};
    try {
      const saved = JSON.parse(storage('local')?.getItem(`${name}:${suffix}`) ?? '{}');
      return saved && typeof saved === 'object' ? saved : {};
    } catch {
      return {};
    }
  };

  // By default, persist plain keys only. Query keys reload from the server.
  const warnedInvalid = new Set<string>();
  /** options.validate on data the store didn't write itself; rejected values are left out */
  function trusted<T>(values: Record<string, T>, from: 'storage' | 'offline' | 'remote', nameOf = (k: string) => k): Record<string, T> {
    if (!options.validate) return values;
    const out: Record<string, T> = {};
    for (const [k, v] of Object.entries(values)) {
      let ok = false;
      try {
        ok = options.validate(nameOf(k), v, from) !== false;
      } catch {}
      if (ok) out[k] = v;
      else if (!warnedInvalid.has(`${from}:${nameOf(k)}`)) {
        warnedInvalid.add(`${from}:${nameOf(k)}`);
        console.warn(`[${name}] validate() rejected "${nameOf(k)}" from ${from === 'remote' ? 'another tab' : from === 'offline' ? 'the offline copy' : 'saved state'}: ${from === 'remote' ? 'it keeps its current value' : 'it falls back to its initial value'}.`);
      }
    }
    return out;
  }
  // keys: only these; exclude: every plain key but these; neither: every plain key (queries reload)
  const persistExclude = new Set((persistCfg?.exclude as string[] | undefined) ?? []);
  const persistedKeys = !persistCfg
    ? []
    : ((persistCfg.keys as string[] | undefined) ?? STATE_KEYS.filter((k) => !isQuery(k) && !persistExclude.has(k))).filter((k) => !isComputed(k));
  const persistedKeySet = new Set(persistedKeys);
  // The keys the app persists, also in a scope (which itself saves nothing): snapshots leave them out
  const appPersist = ((options as Record<symbol, unknown>)[APP_PERSIST] ?? p) as StoreOptions<S, A, KA, E>['persist'];
  const appPersistedKeys = new Set(
    !appPersist
      ? []
      : ((typeof appPersist === 'object' && (appPersist.keys as string[] | undefined)) ||
          STATE_KEYS.filter((k) => !isQuery(k) && !(typeof appPersist === 'object' && ((appPersist.exclude as string[] | undefined) ?? []).includes(k))))
  );

  if (persistCfg?.keys && persistCfg.exclude)
    throw new Error(`[${name}] persist takes keys or exclude, not both: keys lists what's saved, exclude what isn't.`);
  for (const k of [...((persistCfg?.keys as string[] | undefined) ?? []), ...((persistCfg?.exclude as string[] | undefined) ?? [])])
    if (!isStateKey(k))
      throw new Error(
        `[${name}] persist lists "${k}", ` +
          (isComputed(k) ? 'a computed value: those are recalculated, not saved.' : isPaged(k) ? "a paged query: pages aren't state, so they can't be saved." : "which isn't a state key.")
      );
  const persistStorage: StorageAdapter | null = !persistCfg
    ? null
    : typeof persistCfg.storage === 'object'
    ? persistCfg.storage
    : storage(persistCfg.storage ?? 'local');
  const persistKey = `${name}:state`;
  /** Ignore failures, sync or async: storage must never break the store */
  const quietly = (fn: () => unknown) => {
    try {
      const r = fn();
      if (isThenable(r)) r.then(undefined, () => {});
    } catch {}
  };

  // Nothing is saved until the saved data has loaded, so an async storage
  // isn't overwritten with the initial state.
  let hydrated = !persistStorage;
  let resolveHydrated!: () => void;
  const whenHydrated = new Promise<void>((r) => (resolveHydrated = r));

  // Async storage (IndexedDB...) commits after setItem returns; a page that goes away first loses the
  // write. So we track writes that haven't committed, and when the page is hidden or left with one
  // pending, the same text also goes to localStorage (synchronous) as a rescue copy. The next load
  // uses whichever is newer ($saved), then removes the rescue copy.
  let storageIsAsync = false;
  let uncommitted = 0;
  let lastSavedText: string | null = null;
  const rescueKey = `${persistKey}:rescue`;
  const isSavedState = (text: string) => {
    try {
      const v = JSON.parse(text) as unknown;
      return !!v && typeof v === 'object' && 'state' in (v as object);
    } catch {
      return false;
    }
  };
  const savedAt = (text: string | null) => {
    try {
      return text ? Number((JSON.parse(text) as { $saved?: unknown }).$saved) || 0 : 0;
    } catch {
      return 0;
    }
  };
  const saveNow = () => {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (!persistStorage || !hydrated) return;
    const data = Object.fromEntries(persistedKeys.map((k) => [k, state[k]]));
    // $saved (when it was written) only matters for async storage, to compare with a rescue copy
    const text = JSON.stringify(storageIsAsync ? { $version: persistVersion, $saved: Date.now(), state: data } : { $version: persistVersion, state: data });
    lastSavedText = text;
    quietly(() => {
      const written = persistStorage.setItem(persistKey, text);
      if (isThenable(written)) {
        storageIsAsync = true;
        uncommitted++;
        const done = () => { uncommitted--; };
        (written as Promise<unknown>).then(done, done);
      }
      return written;
    });
  };
  const writeRescue = () => {
    if (!storageIsAsync || uncommitted === 0 || !lastSavedText) return;
    const local = storage('local');
    if (!local || local === (persistStorage as unknown)) return;
    try {
      local.setItem(rescueKey, lastSavedText);
    } catch {} // full or unavailable: as before, the async write may or may not make it
  };
  // persist: { debounce }: one write after the changes stop, not one per keystroke
  const persistDebounce = (typeof options.persist === 'object' && options.persist.debounce) || 0;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  const saveState = () => {
    if (!persistStorage || !hydrated) return;
    if (!persistDebounce) return saveNow();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, persistDebounce);
  };
  // A pending save is written when the page is hidden or closed, so nothing typed is lost; with async
  // storage, a write that hasn't committed yet is also kept as a rescue copy (see writeRescue)
  const flushSave = () => {
    if (saveTimer !== undefined) saveNow();
    writeRescue();
  };
  const flushWhenHidden = () => { if (document.visibilityState === 'hidden') flushSave(); };
  if (isBrowser && persistStorage && typeof window.addEventListener === 'function') {
    window.addEventListener('pagehide', flushSave);
    document.addEventListener('visibilitychange', flushWhenHidden);
  }

  /** Saved text → values to use, migrated to the current version. null = nothing usable. */
  let rewrite = false; // migrated or dropped: save the current shape right away
  function readSaved(raw: string | null): Record<string, unknown> | null {
    if (raw == null) return null;
    let saved: unknown;
    try {
      saved = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!saved || typeof saved !== 'object') return null;
    const obj = saved as Record<string, unknown>;
    const legacy = !('$version' in obj); // saved before versioning: the state itself
    const from = legacy ? 0 : (obj.$version as number);
    let values: unknown = legacy ? obj : obj.state;
    if (from !== persistVersion) {
      rewrite = true;
      if (!persistCfg!.migrate) {
        console.warn(`[${name}] dropped saved state from version ${from}: no persist.migrate for version ${persistVersion}.`);
        return null;
      }
      try {
        values = persistCfg!.migrate(values, from);
      } catch (error) {
        console.error(`[${name}] persist.migrate threw; starting from the initial state:`, error);
        return null;
      }
    }
    return values && typeof values === 'object' ? (values as Record<string, unknown>) : null;
  }
  const pick = (values: Record<string, unknown> | null) => {
    const out: Record<string, unknown> = {};
    if (values) for (const k of persistedKeys) if (k in values) out[k] = values[k];
    return out;
  };
  const finishHydration = () => {
    hydrated = true;
    if (rewrite) saveState();
    resolveHydrated();
  };

  if (!persistStorage) resolveHydrated();
  else {
    let raw: string | null | Promise<string | null> = null;
    try {
      raw = persistStorage.getItem(persistKey);
    } catch {}
    if (isThenable(raw)) {
      // Async storage: load after startup, then show the saved values
      storageIsAsync = true;
      (raw as Promise<string | null>).then(
        (stored) => {
          // A rescue copy from a page that went away mid-write: used when it's newer than what committed
          let text = stored;
          const local = storage('local');
          let rescued: string | null = null;
          try {
            rescued = local && local !== (persistStorage as unknown) ? local.getItem(rescueKey) : null;
            if (rescued != null) local!.removeItem(rescueKey);
          } catch {}
          // Used only when it's real saved state and strictly newer; garbage or a tie keeps what's stored
          if (rescued != null && isSavedState(rescued) && savedAt(rescued) > savedAt(stored)) text = rescued;
          const values = trusted(pick(readSaved(text)), 'storage');
          hydrated = true; // so applying them also saves the current version
          if (!destroyed) apply(values, 'storage', 'loaded from storage', false);
          if (!destroyed && text === rescued && rescued != null) saveNow(); // the rescued copy goes back into the storage
          finishHydration();
        },
        (error) => {
          console.error(`[${name}] couldn't load persisted state:`, error);
          finishHydration();
        }
      );
    } else {
      // Sync storage (localStorage...): load before anything renders
      Object.assign(state, trusted(pick(readSaved(raw as string | null)), 'storage'));
      // Nothing reads these this early today; clear them so loaded values can never be shadowed
      computedCache.clear();
      selectMemo.clear();
      finishHydration();
    }
  }

  /* ---------- Cross-tab sync ---------- */

  const channel =
    options.syncTabs && isBrowser && 'BroadcastChannel' in window
      ? new BroadcastChannel(`createStore:${name}`)
      : null;
  // syncTabs: { keys } or { exclude }: which keys other tabs get (e.g. never an access token)
  const syncCfg = typeof options.syncTabs === 'object' ? options.syncTabs : null;
  if (syncCfg?.keys && syncCfg.exclude)
    throw new Error(`[${name}] syncTabs takes keys or exclude, not both: keys lists what's sent, exclude what isn't.`);
  for (const k of [...(syncCfg?.keys ?? []), ...(syncCfg?.exclude ?? [])])
    if (!(k in initialValues)) throw new Error(`[${name}] syncTabs lists "${String(k)}", which isn't a state key.`);
  const syncKeys = syncCfg?.keys ? new Set<string>(syncCfg.keys) : null;
  const syncExclude = new Set<string>(syncCfg?.exclude ?? []);
  const syncable = (k: string) => (syncKeys ? syncKeys.has(k) : !syncExclude.has(k));

  // Logical clock, so tabs that write at the same moment agree on a winner:
  // every change gets [counter, tabId]; a tab only accepts newer stamps.
  type Stamp = [number, string];
  const tabId = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let clock = 0;
  const stamps = new Map<string, Stamp>();
  const isNewer = (a: Stamp, b?: Stamp) =>
    !b || a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

  /* ---------- DevTools ---------- */

  // The parts of the Redux DevTools extension this store uses
  interface DevtoolsConnection {
    init(state: unknown): void;
    send(action: unknown, state: unknown): void;
    subscribe(listener: (msg: unknown) => void): unknown;
    unsubscribe?(): void;
  }
  const ext =
    options.devtools &&
    isBrowser &&
    (window as unknown as { __REDUX_DEVTOOLS_EXTENSION__?: { connect(o: { name: string }): DevtoolsConnection } })
      .__REDUX_DEVTOOLS_EXTENSION__;
  let destroyed = false; // set by destroy(); declared early because devtools code checks it
  let devtools: DevtoolsConnection | null = null;
  try {
    devtools = ext ? ext.connect({ name }) : null;
  } catch (error) {
    console.error(`[${name}] couldn't connect to Redux DevTools:`, error);
  }
  let warnedDevtools = false;
  /** Send to the extension without ever letting it break the store */
  const sendDevtools = (action: unknown, st: unknown) => {
    if (!devtools || destroyed) return;
    try {
      devtools.send(action, st);
    } catch (error) {
      if (!warnedDevtools) {
        warnedDevtools = true;
        console.error(`[${name}] Redux DevTools send failed:`, error);
      }
    }
  };

  /* ---------- Observability ---------- */

  const changeListeners = new Set<(e: ChangeEvent) => void>();

  /* ---------- History (undo / redo / time travel) ---------- */

  const h = options.history;
  const historyLimit = !h ? 0 : h === true ? 100 : h.limit ?? 100;
  // null = track every state key (the old behavior)
  const historyKeys: Set<string> | null =
    h && h !== true && h.keys ? new Set(h.keys as string[]) : null;
  if (historyKeys)
    for (const k of historyKeys) {
      if (isComputed(k))
        throw new Error(
          `history.keys has "${k}", which is computed. Track the state keys it reads; it follows them on undo.`
        );
      if (!isStateKey(k)) throw new Error(`history.keys has "${k}", which is not in the store.`);
    }
  const tracksHistory = (k: string) => !historyKeys || historyKeys.has(k);
  // Each step stores only the keys it changed: { key: [before, after] }.
  // So undo never touches data that loaded from the server in between.
  interface Step {
    changes: Record<string, [unknown, unknown]>;
    seq: number;
  }
  let past: Step[] = [];
  let future: Step[] = [];
  let stepSeq = 0;
  // batch(): changes made inside are collected here and saved as one undo step
  let batchDepth = 0;
  let batchChanges: Record<string, [unknown, unknown]> | null = null;
  let warnedAsyncBatch = false;
  // Promises the store itself returns (setters with a server call); returning one from batch() is fine
  const ownPromises = new WeakSet<object>();
  const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

  /** After a failed save, drop the steps for that key made since the save started. */
  function trimHistory(key: string, fromSeq: number) {
    if (!historyLimit || !tracksHistory(key)) return;
    let trimmed = false;
    const strip = (list: Step[]) =>
      list.flatMap((st) => {
        if (st.seq < fromSeq || !hasOwn(st.changes, key)) return [st];
        trimmed = true;
        const rest = { ...st.changes };
        delete rest[key];
        return Object.keys(rest).length ? [{ ...st, changes: rest }] : [];
      });
    past = strip(past);
    future = strip(future);
    if (trimmed) updateHistoryInfo();
  }
  let historyInfo = { canUndo: false, canRedo: false, position: 0, length: 1 };
  const updateHistoryInfo = () => {
    historyInfo = {
      canUndo: past.length > 0,
      canRedo: future.length > 0,
      position: past.length,
      length: past.length + 1 + future.length,
    };
    notify(HISTORY_CHANNEL);
  };

  /** Save everything collected by the outermost batch() as one undo step. */
  function flushBatch() {
    const changes = batchChanges;
    batchChanges = null;
    if (!changes) return;
    // A key that ended where it started (a → b → a) is not a change
    for (const k of Object.keys(changes))
      if (Object.is(changes[k][0], changes[k][1])) delete changes[k];
    if (Object.keys(changes).length === 0) return;
    past = [...past, { changes, seq: stepSeq++ } as Step].slice(-historyLimit);
    future = [];
    updateHistoryInfo();
  }

  /**
   * Run several updates as one undo step:
   *   store.batch(() => { setState('cart', []); setState('step', 'success'); });
   * Updates still apply and notify immediately; only history is grouped.
   * Batches can nest; the outermost one creates the step. If fn throws, the
   * changes it already made stay and are saved as one step (undo reverts them).
   */
  function batch<T>(fn: () => T): T {
    batchDepth++;
    if (batchDepth === 1 && historyLimit) batchChanges = Object.create(null);
    let result: T;
    try {
      result = fn();
    } finally {
      if (--batchDepth === 0) {
        flushBatch();
        if (saveAfterBatch) {
          saveAfterBatch = false;
          saveState();
        }
        if (saveInlineAfterBatch) {
          saveInlineAfterBatch = false;
          saveInline();
        }
      }
    }
    // Async work (an async function, a returned fetch...) runs after the batch has
    // ended, so updates made there aren't grouped. The store's own save promises are fine.
    if (!warnedAsyncBatch && isThenable(result) && !ownPromises.has(result as object)) {
      warnedAsyncBatch = true;
      console.warn(
        `[${name}] batch() returned a promise. Only the updates made before it returned are grouped; ` +
          `group updates made later (after an await) in their own batch().`
      );
    }
    return result;
  }

  /* ---------- Inline query bookkeeping ---------- */

  interface Meta {
    loaded: boolean;
    updatedAt: number;
    aborted?: boolean; // the last load was cancelled
    inflight?: Promise<unknown>;
    mounted: number; // components currently showing this key
    version: number; // bumped on every non-server change, to spot stale responses
    needsRefetch: boolean; // a response was discarded; reload when saves settle
  }
  const metas = new Map<string, Meta>();
  const inlineAborts = new Map<string, AbortController>(); // inline query key -> its request
  const meta = (k: string): Meta => {
    if (!metas.has(k))
      metas.set(k, { loaded: false, updatedAt: 0, mounted: 0, version: 0, needsRefetch: false });
    return metas.get(k)!;
  };

  const saveInline = () => {
    if (!options.offline) return;
    const data = Object.fromEntries(
      Object.keys(queryDefs)
        .filter((k) => meta(k).loaded)
        .map((k) => [k, { data: state[k], updatedAt: meta(k).updatedAt }])
    );
    writeOffline('inline', data);
  };
  for (const [k, e] of Object.entries(trusted(readOffline<{ data: unknown; updatedAt: number } | null>('inline'), 'offline'))) {
    if (!isQuery(k) || !e || typeof e !== 'object' || !('data' in e)) continue; // malformed saved data: skip it
    state[k] = e.data;
    Object.assign(meta(k), { loaded: true, updatedAt: e.updatedAt });
    selectMemo.delete(k);
  }

  /* ---------- The one place every change goes through ---------- */

  /** Run a user callback without letting it break the store. */
  const safely = (fn: () => void, what: string) => {
    try {
      fn();
    } catch (error) {
      console.error(`[${name}] ${what} threw an error:`, error);
    }
  };

  let warnedSync = false;
  const broadcast = (message: unknown) => {
    if (!channel) return;
    try {
      channel.postMessage(message);
    } catch (error) {
      // e.g. a function or class instance in state can't be sent to other tabs
      if (!warnedSync) {
        warnedSync = true;
        console.warn(`[${name}] couldn't sync a change to other tabs:`, error);
      }
    }
  };

  // Listeners may update state, which notifies listeners again. A real cascade
  // is short; this many nested updates means a listener is feeding itself.
  const MAX_NESTING = 100;
  let applyDepth = 0;

  let warnedDestroyed = false;
  const afterDestroy = (what: string) => {
    if (!warnedDestroyed) {
      warnedDestroyed = true;
      console.warn(`[${name}] ${what} after destroy(): ignored. A destroyed store doesn't change, load or notify any more.`);
    }
  };
  function apply(
    values: Record<string, unknown>,
    source: ChangeEvent['source'],
    label: string,
    recordHistory = true
  ) {
    if (destroyed) return afterDestroy(label.startsWith('set ') ? `setState("${label.slice(4)}")` : label);
    if (applyDepth >= MAX_NESTING)
      throw new Error(
        `[${name}] update loop: ${MAX_NESTING} updates happened inside each other (last: ${label}). ` +
          `A subscribe/onChange listener is probably updating a key it also reacts to.`
      );
    applyDepth++;
    try {
      applyNow(values, source, label, recordHistory);
    } finally {
      applyDepth--;
    }
  }

  function applyNow(
    values: Record<string, unknown>,
    source: ChangeEvent['source'],
    label: string,
    recordHistory: boolean
  ) {
    const keys = Object.keys(values).filter(
      (k) => isStateKey(k) && !Object.is(state[k], values[k])
    );
    if (keys.length === 0) return;
    // Update in place: copying the whole state object on every change would make
    // each update slower the more keys the store has. Only changed keys are touched.
    const prev: Record<string, unknown> = {};
    for (const k of keys) {
      prev[k] = state[k];
      state[k] = values[k];
    }

    if (source === 'local' && recordHistory) recordStep(keys, prev);
    settlePendingWork(keys, source);
    persistChanges(keys);
    if (source !== 'remote' && source !== 'storage' && source !== 'hydrate') broadcastChanges(keys);
    if (source !== 'devtools') sendDevtools({ type: label }, state);
    changed(...keys); // computed values, then subscribers
    emitChangeEvents(keys, prev, source, label);
  }

  /** Undo history: one step, or part of the current batch() */
  function recordStep(keys: string[], prev: Record<string, unknown>) {
    if (!historyLimit) return;
    const tracked = keys.filter(tracksHistory);
    // A change to untracked keys only (modalOpen, searchText...) adds no step
    // and leaves the redo stack alone.
    if (!tracked.length) return;
    if (batchChanges) {
      // Inside batch(): keep each key's first "before" and latest "after"
      for (const k of tracked) {
        if (hasOwn(batchChanges, k)) batchChanges[k][1] = state[k];
        else batchChanges[k] = [prev[k], state[k]];
      }
      return;
    }
    const changes = Object.fromEntries(tracked.map((k) => [k, [prev[k], state[k]]]));
    past = [...past, { changes, seq: stepSeq++ } as Step].slice(-historyLimit);
    future = [];
    updateHistoryInfo();
  }

  /** Optimistic edits and in-flight responses that this change makes obsolete */
  function settlePendingWork(keys: string[], source: ChangeEvent['source']) {
    for (const k of keys) {
      // Changes from history, other tabs or devtools replace any pending
      // optimistic edits: there's nothing sensible to roll back to any more.
      if (source !== 'local' && source !== 'server') journals.delete(k);
      // Any non-server change makes in-flight responses for this key stale
      if (source !== 'server' && isQuery(k)) meta(k).version++;
    }
  }

  /** Persisted state and the offline query cache: once per batch(), not once per change in it */
  let saveAfterBatch = false;
  let saveInlineAfterBatch = false;
  function persistChanges(keys: string[]) {
    const saved = keys.some((k) => persistedKeySet.has(k)); // other keys don't touch saved state, or the debounce
    const inline = keys.some(isQuery);
    if (batchDepth > 0) {
      saveAfterBatch ||= saved;
      saveInlineAfterBatch ||= inline;
      return;
    }
    if (saved) saveState();
    if (inline) saveInline();
  }

  /** Other tabs (syncTabs): changes in the same tick go out as one message */
  const pendingSync = new Set<string>();
  let syncQueued = false;
  function broadcastChanges(keys: string[]) {
    if (!channel) return;
    for (const k of keys) if (syncable(k)) pendingSync.add(k);
    if (pendingSync.size && !syncQueued) {
      syncQueued = true;
      queueMicrotask(flushBroadcast);
    }
  }
  function flushBroadcast() {
    syncQueued = false;
    if (!channel || !pendingSync.size) return;
    // Stamped when sent: nothing from another tab can arrive in between (messages are macrotasks)
    const stamp: Stamp = [++clock, tabId];
    const keys = [...pendingSync];
    pendingSync.clear();
    keys.forEach((k) => stamps.set(k, stamp));
    broadcast({ type: 'state', stamp, values: Object.fromEntries(keys.map((k) => [k, state[k]])) });
  }

  /** onChange, subscribe() listeners and the logger */
  function emitChangeEvents(
    keys: string[],
    prev: Record<string, unknown>,
    source: ChangeEvent['source'],
    label: string
  ) {
    for (const key of keys) {
      const event: ChangeEvent = {
        key,
        prev: prev[key],
        next: state[key],
        source,
        time: Date.now(),
      };
      const deliver = () => {
        if (options.onChange) safely(() => options.onChange!(event), 'onChange');
        [...changeListeners].forEach((l) => safely(() => l(event), 'subscribe listener'));
        if (options.logger) console.log(`[${name}] ${label}`, event.prev, '→', event.next);
      };
      // While a render writes server data (heldNotify), listeners hear it right after the render,
      // with the same event: one of them updating React state mustn't happen during that render
      if (holdNotify > 0) heldEvents.push(deliver);
      else deliver();
    }
  }

  /* ---------- Reading and writing ---------- */

  function getState(): V;
  function getState<K extends Key>(key: K): V[K];
  function getState(key?: string): unknown {
    if (key !== undefined) return readKey(key);
    const derived = Object.keys(computedDefs).map((k) => [k, readComputed(k)]);
    const selected = Object.keys(queryDefs).map((k) => [k, readState(k)]);
    return { ...state, ...Object.fromEntries(selected), ...Object.fromEntries(derived) };
  }

  let selecting = 0; // > 0 while a selector function is running

  // Internal: the typed public versions are setStateWithServer and the setters
  function setState(key: string, value: unknown): void {
    if (evaluating.length)
      throw new Error(
        `setState("${key}") was called while computed "${evaluating[evaluating.length - 1]}" was calculating. ` +
          `A computed function must only calculate a value; update state in an event handler or action instead.`
      );
    if (selecting > 0)
      throw new Error(
        `setState("${key}") was called inside a selector. Selectors must only read state; ` +
          `update it in an event handler, effect or action instead.`
      );
    if (isComputed(key))
      throw new Error(
        `"${key}" is computed and read-only. Change the state keys it reads instead.`
      );
    if (!isStateKey(key))
      throw new Error(`"${key}" is not in the store.`);
    // A setter called while an updater runs (setCount(c => { setCount(...); return c + 1 })) waits for
    // that updater's result to be written, then runs: like React, no update is lost
    if (inUpdater > 0) {
      afterUpdater.push(() => setState(key, value));
      return;
    }
    let next: unknown;
    if (typeof value === 'function') {
      inUpdater++;
      try {
        next = (value as (prev: unknown) => unknown)(state[key]);
      } catch (error) {
        afterUpdater.length = 0; // updates made inside a failed update fail with it
        throw error;
      } finally {
        inUpdater--;
      }
      if (next && typeof (next as { then?: unknown }).then === 'function') warnOnce(`promise:${key}`,
        `[${name}] the updater for "${key}" returned a promise, so the promise itself was stored. Updaters must be synchronous: await first, then set the value.`);
    } else {
      next = value;
      if (next && typeof next === 'object' && 'nativeEvent' in next && typeof (next as { preventDefault?: unknown }).preventDefault === 'function')
        warnOnce(`event:${key}`, `[${name}] setState("${key}") got a browser event as its value, probably from onClick={setter}. Use onClick={() => setter(...)} instead.`);
    }
    journal(key, value);
    apply({ [key]: next }, 'local', `set ${key}`);
    if (inUpdater === 0 && afterUpdater.length) for (const run of afterUpdater.splice(0)) run();
  }
  let inUpdater = 0;
  const afterUpdater: (() => void)[] = [];
  const warnedSetter = new Set<string>();
  const warnOnce = (id: string, message: string) => {
    if (warnedSetter.has(id)) return;
    warnedSetter.add(id);
    console.warn(message);
  };

  /* ---------- Optimistic updates ---------- */

  // While a save is pending on a key, every write to that key is recorded.
  // If the save fails, its write is removed and the others are replayed on
  // top of the value from before, so overlapping saves and local edits all
  // end up correct no matter which order they finish in.
  interface JournalEntry {
    op: number; // 0 for a plain local write
    change: unknown; // the value or updater that was passed in
    pending: boolean;
  }
  const journals = new Map<string, { base: unknown; entries: JournalEntry[] }>();
  let currentOp = 0;
  let opCounter = 0;
  const hasPending = (k: string) =>
    journals.get(k)?.entries.some((e) => e.pending) ?? false;

  const SUPERSEDED = Symbol('superseded');

  function journal(key: string, change: unknown) {
    let j = journals.get(key);
    if (!j && !currentOp) return;
    if (j && !currentOp && typeof change !== 'function') {
      // A plain local value replaces everything before it, so earlier records
      // are no longer needed to rebuild the value. Keep only the pending saves
      // (to know when they settle), without their changes.
      j.base = change;
      j.entries = j.entries.filter((e) => e.pending).map((e) => ({ ...e, change: SUPERSEDED }));
      if (j.entries.length === 0) journals.delete(key);
      return;
    }
    if (!j) {
      j = { base: state[key], entries: [] };
      journals.set(key, j);
    }
    j.entries.push({ op: currentOp, change, pending: currentOp !== 0 });
  }

  /**
   * The setter behind useGlobalState. With a serverCall it updates instantly,
   * runs the call, and rolls back if the call fails.
   */
  function update(
    key: string,
    value: unknown,
    serverCall?: () => Promise<unknown> | unknown
  ): Promise<void> {
    if (!serverCall) {
      setState(key, value);
      const done = Promise.resolve();
      ownPromises.add(done);
      return done;
    }

    const op = ++opCounter;
    const startSeq = stepSeq;
    const outer = currentOp;
    currentOp = op;
    try {
      setState(key, value); // an updater that throws stops here
    } finally {
      currentOp = outer;
    }
    const touched = [...journals]
      .filter(([, j]) => j.entries.some((e) => e.op === op))
      .map(([k]) => k);

    const settle = (ok: boolean, error?: unknown) => {
      const reload: string[] = [];
      for (const k of touched) {
        const j = journals.get(k);
        if (j) {
          if (ok) {
            j.entries.forEach((e) => { if (e.op === op) e.pending = false; });
          } else {
            j.entries = j.entries.filter((e) => e.op !== op);
            let next = j.base;
            for (const e of j.entries) {
              if (e.change === SUPERSEDED) continue;
              try {
                next = typeof e.change === 'function' ? (e.change as (prev: unknown) => unknown)(next) : e.change;
              } catch {}
            }
            apply({ [k]: next }, 'local', `rollback ${key}`, false);
          }
          if (!j.entries.some((e) => e.pending)) journals.delete(k);
        } else if (!ok && isQuery(k)) {
          // The record was dropped because another tab or undo changed this key
          // meanwhile, so the failed change may be baked into what we have now.
          // The server knows the truth: reload (and the result syncs to other tabs).
          meta(k).needsRefetch = true;
        }
        if (!ok) trimHistory(k, startSeq);

        if (isQuery(k)) {
          const m = meta(k);
          m.version++; // responses that started before this save are out of date
          if (!ok) setStatus(k, { error });
          if (ok && queryDefs[k].options.refetchAfterMutation) m.needsRefetch = true;
          if (m.needsRefetch && !hasPending(k)) {
            m.needsRefetch = false;
            reload.push(k);
          }
        }
      }
      return Promise.all(reload.map((k) => loadKey(k, true).catch(() => {})));
    };

    const promise = Promise.resolve()
      .then(serverCall)
      .then(
        async (result) => {
          await settle(true);
          return result as void; // what the save returned (a refund amount, the saved record...)
        },
        (error) => {
          // The page is going away (reload, navigation) and the browser cancelled the request: it may
          // well have reached the server, so keep the change rather than roll it back (and save that)
          if (!leavingPage) settle(false, error);
          throw error;
        }
      );
    promise.catch(() => {}); // avoid "unhandled rejection" when not awaited
    ownPromises.add(promise);
    return promise;
  }

  /* ---------- Loading and error status ---------- */
  // How a query the server didn't load looked there: loading
  const SERVER_LOADING: Status = Object.freeze({
    state: 'loading', loading: true, fetching: false, error: null, blocked: false, blockedBy: null, rootError: null,
    refetch: () => Promise.resolve(),
  });

  const hydratedKeys = new Set<string>();
  const PLAIN_STATUS: Status = Object.freeze({
    state: 'ready',
    loading: false,
    fetching: false,
    error: null,
    blocked: false,
    blockedBy: null,
    rootError: null,
    refetch: () => Promise.resolve(),
  });
  // Whose status an object is, and whether that query has data: what waitFor needs to know
  const statusInfo = new WeakMap<Status, { key: string; hasData: () => boolean }>();
  const owned = <T extends Status>(status: T, key: string, hasData: () => boolean): T => {
    statusInfo.set(status, { key, hasData });
    return status;
  };
  const statuses = new Map<string, Status>();
  const computedStatusCache = new Map<string, Status>();
  // Internal channels start with \u0000, which no state key can (see above): a key named
  // "status:todos" or "__history" can't collide with them
  const statusChannel = (k: string) => `\u0000status:${k}`;

  const baseStatus = (key: string): Status =>
    owned({
      state: meta(key).loaded ? 'ready' : 'loading',
      loading: !meta(key).loaded,
      fetching: false,
      error: null,
      blocked: false,
      blockedBy: null,
      rootError: null,
      refetch: () => loadKey(key, true).then(() => {}, () => {}),
    }, key, () => meta(key).loaded);

  function setStatus(key: string, patch: Partial<Status>) {
    const next = { ...(statuses.get(key) ?? baseStatus(key)), ...patch };
    next.state = stateOf(next.loading, next.error, meta(key).loaded, false);
    const asked = abortedState(key, !!meta(key).aborted, next.loading || next.fetching, meta(key).loaded, false);
    if (asked === 'loading') {
      next.state = 'loading';
      next.loading = true;
    } else if (asked === 'idle') (next as { state: string }).state = 'idle';
    statuses.set(key, owned(next, key, () => meta(key).loaded));
    statusChanged(key);
  }
  /** The one place the precedence is decided: waiting, then loading, then error without data, then ready */
  /** A first load that was cancelled (nothing loaded, nothing running): what the query asked to report */
  function abortedState(q: string, aborted: boolean, loading: boolean, hasData: boolean, waiting: boolean): WhenAborted | null {
    if (!aborted || loading || hasData || waiting) return null;
    return (namedDefs[q] as { whenAborted?: WhenAborted } | undefined)?.whenAborted ?? null;
  }
  function stateOf(loading: boolean, error: unknown, hasData: boolean, waiting: boolean): StatusState {
    if (waiting) return 'waiting';
    if (loading) return 'loading';
    if (error != null && !hasData) return 'error';
    return 'ready';
  }

  function statusChanged(key: string, seen = new Set<string>()) {
    if (seen.has(key)) return; // a computed loop can make the dependency map circular
    seen.add(key);
    notify(statusChannel(key));
    dependents.get(key)?.forEach((c) => {
      computedStatusCache.delete(c);
      statusChanged(c, seen);
    });
  }

  function getStatus(key: string): Status {
    if (isQuery(key)) {
      if (!statuses.has(key)) statuses.set(key, baseStatus(key));
      return statuses.get(key)!;
    }
    if (isComputed(key)) {
      const cached = computedStatusCache.get(key);
      if (cached) return cached;
      readComputed(key);
      const parts = [...computedCache.get(key)!.deps].map(getStatus);
      const combined: Status = owned({
        state: parts.some((s) => s.state === 'loading') ? 'loading' : parts.some((s) => s.state === 'error') ? 'error' : 'ready',
        loading: parts.some((s) => s.loading),
        fetching: parts.some((s) => s.fetching),
        error: parts.find((s) => s.error)?.error ?? null,
        blocked: false,
        blockedBy: null,
        rootError: null,
        refetch: () => Promise.all(parts.map((s) => s.refetch())).then(() => {}),
      }, key, () => !parts.some((s) => s.loading));
      computedStatusCache.set(key, combined);
      return combined;
    }
    return PLAIN_STATUS;
  }

  /* ---------- Inline queries: query(fn) ---------- */

  function loadKey(key: string, force = false): Promise<unknown> {
    if (destroyed) return Promise.reject(new Error(`[${name}] "${key}" can't load after destroy().`));
    const def = queryDefs[key];
    const m = meta(key);
    const fresh =
      m.loaded && Date.now() - m.updatedAt < (def.options.staleTime ?? 30_000);
    if (fresh && !force) return Promise.resolve(state[key]);
    if (m.inflight) return m.inflight; // ten components, one request
    if (isBrowser && !navigator.onLine && m.loaded)
      return Promise.resolve(state[key]);

    m.aborted = false; // a new load: whatever was cancelled before is running again
    setStatus(key, { fetching: true, loading: !m.loaded });
    const startVersion = m.version;
    const controller = new AbortController();
    inlineAborts.set(key, controller);
    const request: Promise<unknown> = withRetry(
      (_params, signal) => def.fetch(undefined, signal),
      undefined,
      def.options.retry ?? 2,
      controller.signal,
      def.options.retryDelay
    ).then(
      (data) => {
        if (m.inflight === request) m.inflight = undefined;
        // The key changed locally while this request was out, or a save is
        // still pending: this response may be out of date, so don't show it.
        if (m.version !== startVersion || hasPending(key)) {
          m.updatedAt = 0;
          if (hasPending(key)) {
            m.needsRefetch = true; // reload once the saves settle
            setStatus(key, { fetching: false });
            return state[key];
          }
          return loadKey(key, true);
        }
        m.loaded = true;
        m.updatedAt = Date.now();
        m.needsRefetch = false;
        apply({ [key]: data }, 'server', `loaded ${key}`);
        setStatus(key, { loading: false, fetching: false, error: null });
        return data;
      },
      (error) => {
        if (m.inflight === request) m.inflight = undefined;
        // Aborted is a cancel, not a failure: no error status
        if (controller.signal.aborted) {
          // After reset() the controller is gone: leave the fresh status alone
          if (inlineAborts.get(key) === controller) {
            m.aborted = true;
            setStatus(key, { loading: false, fetching: false });
          }
        } else setStatus(key, { loading: false, fetching: false, error });
        throw error;
      }
    ).finally(() => {
      if (inlineAborts.get(key) === controller) inlineAborts.delete(key);
    });
    m.inflight = request;
    return request;
  }

  /** All query keys a key depends on, following computed keys. */
  function queryKeysOf(
    key: string,
    seen = new Set<string>(),
    out = new Set<string>()
  ): Set<string> {
    if (seen.has(key)) return out;
    seen.add(key);
    if (isQuery(key)) out.add(key);
    else if (isComputed(key)) {
      try {
        readComputed(key);
      } catch {
        // A failing computed still records what it read, so keep going
      }
      computedCache.get(key)?.deps.forEach((d) => queryKeysOf(d, seen, out));
    }
    return out;
  }

  /* ---------- Time travel ---------- */

  function goTo(position: number) {
    if (batchDepth > 0)
      throw new Error(`[${name}] undo, redo and goTo can't run inside batch(). Call them after it.`);
    if (
      !Number.isInteger(position) ||
      position < 0 ||
      position > past.length + future.length ||
      position === past.length
    )
      return;
    // Collect every key the jump touches, then apply them in one go
    const values: Record<string, unknown> = {};
    while (past.length > position) {
      const st = past.pop()!;
      future.unshift(st);
      for (const [k, [before]] of Object.entries(st.changes)) values[k] = before;
    }
    while (past.length < position) {
      const st = future.shift()!;
      past.push(st);
      for (const [k, [, after]] of Object.entries(st.changes)) values[k] = after;
    }
    apply(values, 'history', `history ${position}`);
    updateHistoryInfo();
  }
  const undo = () => goTo(past.length - 1);
  const redo = () => goTo(past.length + 1);

  /* ---------- Event bus ---------- */

  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  function on(event: string, handler: (payload: unknown) => void) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event)!.add(handler);
    let held: typeof handler | undefined = handler; // released after unsubscribing
    return () => {
      if (!held) return;
      const set = handlers.get(event);
      set?.delete(held);
      if (set && set.size === 0) handlers.delete(event);
      held = undefined;
    };
  }
  let emitDepth = 0;
  function emit(event: string, payload?: unknown, shouldBroadcast = false) {
    if (emitDepth >= MAX_NESTING)
      throw new Error(
        `[${name}] event loop: "${event}" was emitted ${MAX_NESTING} times inside its own handlers.`
      );
    emitDepth++;
    try {
      emitNow(event, payload, shouldBroadcast);
    } finally {
      emitDepth--;
    }
  }
  function emitNow(event: string, payload: unknown, shouldBroadcast: boolean) {
    if (destroyed) return afterDestroy(`emit("${event}")`);
    if (options.logger) console.log(`[${name}] event ${event}`, payload);
    sendDevtools({ type: `event ${event}`, payload }, state);
    if (shouldBroadcast) {
      flushBroadcast(); // the state this event is about reaches other tabs first
      broadcast({ type: 'event', event, payload });
    }
    [...(handlers.get(event) ?? [])].forEach((fn) =>
      safely(() => fn(payload), `handler for "${event}"`)
    );
  }

  /** Public, typed versions: names and payloads come from the `events` option. */
  let warnedNoChannel = false;
  function publicEmit<K extends keyof E & string>(event: K, ...args: EmitArgs<E, K>): void {
    const shouldBroadcast = args[1]?.broadcast === true;
    if (shouldBroadcast && !channel && isBrowser && !warnedNoChannel) {
      warnedNoChannel = true;
      console.warn(
        `[${name}] emit("${event}", ..., { broadcast: true }) only reaches this tab: ` +
          `turn on syncTabs (and use a browser with BroadcastChannel) to reach other tabs.`
      );
    }
    emit(event, args[0], shouldBroadcast);
  }
  function publicOn<K extends keyof E & string>(
    event: K,
    handler: (payload: E[K]) => void
  ): () => void {
    return on(event, handler as (payload: unknown) => void);
  }

  if (channel) {
    channel.onmessage = ({ data }) => {
      // Any script on this origin can post to the channel: ignore anything that isn't a well-formed message
      if (!data || typeof data !== 'object') return;
      if (data.type === 'state') {
        const stamp = data.stamp as Stamp;
        if (!Array.isArray(stamp) || stamp.length !== 2 || !Number.isSafeInteger(stamp[0]) || stamp[0] < 0 || typeof stamp[1] !== 'string') return;
        if (!data.values || typeof data.values !== 'object' || Array.isArray(data.values)) return;
        clock = Math.max(clock, stamp[0]);
        // Keep only keys where this change is newer than what we already have
        const fresh: Record<string, unknown> = {};
        for (const [k, v] of Object.entries<unknown>(data.values)) {
          if (!isStateKey(k) || !syncable(k) || !isNewer(stamp, stamps.get(k))) continue; // excluded keys are ignored, also when sent
          stamps.set(k, stamp);
          fresh[k] = v;
        }
        apply(trusted(fresh, 'remote'), 'remote', 'from other tab');
      }
      if (data.type === 'event' && typeof data.event === 'string') emit(data.event, data.payload); // local only: never re-broadcast
    };
  }
  let unsubscribeDevtools: (() => void) | undefined;
  if (devtools) {
    try {
      devtools.init(state);
    } catch (error) {
      console.error(`[${name}] Redux DevTools init failed:`, error);
    }
    const onDevtoolsMessage = (raw: unknown) => {
      if (destroyed) return;
      const msg = raw as { type?: unknown; payload?: { type?: unknown }; state?: unknown } | null;
      const t = msg?.payload?.type;
      if (msg?.type !== 'DISPATCH' || (t !== 'JUMP_TO_STATE' && t !== 'JUMP_TO_ACTION')) return;
      try {
        const next: unknown = typeof msg.state === 'string' ? JSON.parse(msg.state) : msg.state;
        if (next && typeof next === 'object') apply(next as Record<string, unknown>, 'devtools', 'time travel');
      } catch (error) {
        console.error(`[${name}] ignored a malformed Redux DevTools message:`, error);
      }
    };
    try {
      const off = devtools.subscribe(onDevtoolsMessage);
      // Newer extensions return an unsubscribe function; older ones have unsubscribe()
      unsubscribeDevtools = typeof off === 'function' ? (off as () => void) : () => devtools?.unsubscribe?.();
    } catch (error) {
      console.error(`[${name}] couldn't subscribe to Redux DevTools:`, error);
    }
  }

  /* ---------- Named queries: useQuery(name, params) ---------- */

  interface Entry {
    data?: unknown;
    error?: unknown;
    status: 'idle' | 'loading' | 'success' | 'error';
    isFetching: boolean;
    updatedAt: number;
    fetchingNext?: boolean; // infinite queries: loading the next page
    aborted?: boolean; // the last request was cancelled (matters while status is 'idle': nothing loaded)
  }
  const EMPTY: Entry = { status: 'idle', isFetching: false, updatedAt: 0 };
  // What an enabled query with no entry yet shows: it's about to load
  const PENDING: Entry = { status: 'loading', isFetching: false, updatedAt: 0 };
  const cache = new Map<string, Entry>();
  const hydratedEntries = new Map<string, Entry>(); // query entries restored by hydrate()
  const inflight = new Map<string, Promise<unknown>>();
  const namedAborts = new Map<string, AbortController>(); // cache key -> its request
  const versions = new Map<string, number>(); // cache key -> bumped by invalidate()
  const onScreen = new Map<
    string,
    { name: string; params: unknown; count: number }
  >();
  // The name is encoded so it can never contain ":", which keeps keys unambiguous
  // even for names like "todo:detail" (key = query:<name>[:<params>]).
  const queryPrefix = (q: string) => `query:${encodeURIComponent(q)}`;
  const cacheKey = (q: string, params?: unknown) =>
    params === undefined ? queryPrefix(q) : `${queryPrefix(q)}:${stableKey(params)}`;
  /** Does cache key k belong to query q (any params)? */
  const belongsTo = (k: string, q: string) => k === queryPrefix(q) || k.startsWith(`${queryPrefix(q)}:`);
  const queryNameOf = (k: string) => {
    const raw = k.slice('query:'.length).split(':')[0];
    try { return decodeURIComponent(raw); } catch { return raw; }
  };

  const saveCache = () => {
    if (!options.offline) return;
    const data = Object.fromEntries(
      [...cache].filter(([, e]) => e.status === 'success')
    );
    writeOffline('queries', data);
  };
  for (const [k, e] of Object.entries(trusted(readOffline<Entry>('queries'), 'offline', (key) => queryNameOf(key))))
    if (k.startsWith('query:') && e && typeof e === 'object' && e.data !== undefined) // malformed saved data: skip it
      cache.set(k, { data: e.data, status: 'success', isFetching: false, updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : 0 });
  // Entries nobody shows are evicted after gcTime, so viewing thousands of
  // different ids over a long session doesn't grow memory forever.
  const gcTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const gcTimeOf = (k: string) => {
    const q = queryNameOf(k);
    return namedDefs[q]?.gcTime ?? 5 * 60_000;
  };
  function scheduleGc(k: string) {
    clearTimeout(gcTimers.get(k));
    gcTimers.delete(k);
    if (!isBrowser) return; // on the server a store lives as long as its request: no timers to hold it
    if (onScreen.get(k)?.count) return;
    const ms = gcTimeOf(k);
    if (!Number.isFinite(ms)) return;
    gcTimers.set(k, setTimeout(() => {
      gcTimers.delete(k);
      if (onScreen.get(k)?.count || inflight.has(k)) return;
      releaseEntry(k);
      saveCache();
    }, ms));
  }

  /** Runs fn with notifications held, and sends them in a microtask (after the current render) */
  function holdingNotify(fn: () => void) {
    holdNotify++;
    try {
      fn();
    } finally {
      holdNotify--;
    }
    if (holdNotify === 0 && (held.size || heldEvents.length))
      queueMicrotask(() => {
        const channels = [...held];
        held.clear();
        channels.forEach((ch) => listeners.get(ch)?.forEach((cb) => cb()));
        heldEvents.splice(0).forEach((deliver) => deliver()); // hooks first, then listeners, as without holding
      });
  }

  /** Everything kept for one cache entry, released together (the entry, its setter, its select memo...) */
  function releaseEntry(k: string) {
    cache.delete(k);
    versions.delete(k);
    onScreen.delete(k);
    entrySetters.delete(k);
    entrySelect.delete(k);
    hydratedEntries.delete(k);
    const ch = entryChannel(k);
    subscribers.delete(ch);
    if (!listeners.get(ch)?.size) listeners.delete(ch);
  }

  const setEntry = (k: string, patch: Partial<Entry>) => {
    cache.set(k, { ...(cache.get(k) ?? EMPTY), ...patch });
    notify(entryChannel(k));
    saveCache();
    if (!onScreen.get(k)?.count) scheduleGc(k);
  };
  // Entries restored from offline storage are evicted too, unless shown again
  [...cache.keys()].forEach(scheduleGc);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see StoreApi.fetchQuery
  function fetchQuery(q: string, params?: unknown, force = false): Promise<any> {
    if (destroyed) return Promise.reject(new Error(`[${name}] fetchQuery("${q}") after destroy(): a destroyed store doesn't load anything.`));
    // Without params: the query's own state key (its selected value)
    if (isQuery(q) && params === undefined) return loadKey(q, force).then(() => readKey(q));
    const config = namedDefs[q];
    if (!config)
      return Promise.reject(new Error(`Query "${q}" is not in the store.`));
    if ('__kind' in config) return fetchInfinite(q, config, params, 'first', force);
    let k: string;
    try {
      k = cacheKey(q, params);
    } catch (error) {
      return Promise.reject(error); // params that can't be keyed
    }
    const entry = cache.get(k) ?? EMPTY;
    const fresh =
      entry.status === 'success' &&
      Date.now() - entry.updatedAt < (config.staleTime ?? 30_000);
    if (fresh && !force) return Promise.resolve(entry.data);
    if (inflight.has(k)) return inflight.get(k)!;
    if (isBrowser && !navigator.onLine && entry.data !== undefined)
      return Promise.resolve(entry.data);

    setEntry(k, {
      isFetching: true,
      status: entry.data === undefined ? 'loading' : entry.status,
    });
    return runEntry(
      k,
      (signal) => config.fetch(params, signal),
      config,
      (data) => data,
      () => fetchQuery(q, params, true)
    );
  }

  /**
   * Runs one request for a cache entry (named and infinite queries): retries,
   * abort, and the entry's status. `toData` turns the response into what's stored.
   */
  function runEntry(
    k: string,
    load: (signal: AbortSignal) => Promise<unknown>,
    opts: { retry?: number; retryDelay?: RetryDelay },
    toData: (response: unknown) => unknown,
    restart: () => Promise<unknown>
  ): Promise<unknown> {
    const version = versions.get(k) ?? 0;
    const controller = new AbortController();
    namedAborts.set(k, controller);
    const promise: Promise<unknown> = withRetry(
      (_params, signal) => load(signal),
      undefined,
      opts.retry ?? 2,
      controller.signal,
      opts.retryDelay
    )
      .then(
        (response) => {
          if ((versions.get(k) ?? 0) !== version) {
            // invalidate() ran while this was loading: load again instead of storing it
            if (inflight.get(k) === promise) inflight.delete(k);
            return restart();
          }
          const data = toData(response);
          setEntry(k, {
            data,
            error: undefined,
            status: 'success',
            isFetching: false,
            fetchingNext: false,
            updatedAt: Date.now(),
          });
          return data;
        },
        (error) => {
          const idle = { isFetching: false, fetchingNext: false };
          if (!controller.signal.aborted) setEntry(k, { ...idle, error, status: 'error' });
          // Aborted is a cancel, not a failure: keep any data, no error status.
          // After reset() the controller is gone: leave the fresh cache alone.
          else if (namedAborts.get(k) === controller)
            setEntry(k, { ...idle, status: cache.get(k)?.data === undefined ? 'idle' : 'success', aborted: true });
          throw error;
        }
      )
      .finally(() => {
        if (inflight.get(k) === promise) inflight.delete(k);
        if (namedAborts.get(k) === controller) namedAborts.delete(k);
      });
    inflight.set(k, promise);
    return promise;
  }

  /* ---------- Infinite queries ---------- */

  interface InfiniteData {
    pages: unknown[];
    pageParams: unknown[];
    next: unknown; // undefined or null = no more pages
  }

  /**
   * 'first': load the first page (once; `force` refreshes it). 'next': add the next page.
   * A list that's on screen is never refreshed by focus or coming back online, so nobody's scroll
   * jumps. It refreshes when it's shown again after staleTime (a page reopened, a reload), and on
   * refetch()/invalidate(): starting over (pages.refresh 'first') or refetching every loaded page
   * ('loaded').
   */
  function fetchInfinite(
    q: string,
    def: AnyInfinite,
    params: unknown,
    mode: 'first' | 'next',
    force = false
  ): Promise<unknown> {
    if (destroyed) return Promise.reject(new Error(`[${name}] "${q}" can't load after destroy().`));
    let k: string;
    try {
      k = cacheKey(q, params);
    } catch (error) {
      return Promise.reject(error);
    }
    const entry = cache.get(k) ?? EMPTY;
    const data = entry.data as InfiniteData | undefined;
    const running = inflight.get(k);
    if (running && !force) return running;
    if (!data) mode = 'first';
    // Fresh, or already on screen elsewhere (no reshuffling under someone scrolling): keep the pages.
    // Stale and shown by nobody else (a page opened again, or restored after a reload): start over.
    const staleTime = (def as { staleTime?: number }).staleTime ?? 30_000;
    const stale = Date.now() - entry.updatedAt > staleTime;
    // ("Shown again" means a mount or a reload: a focus/online refresh never starts an on-screen list over.)
    const shownAgain = stale && inFocusRefresh === 0 && (onScreen.get(k)?.count ?? 0) <= 1;
    if (mode === 'first' && data && entry.status === 'success' && !force && !shownAgain)
      return Promise.resolve(data);
    if (mode === 'next' && data!.next == null) return Promise.resolve(data); // no more pages

    namedAborts.get(k)?.abort(); // a forced refetch replaces a running request
    const page = mode === 'first' ? def.firstPage : data!.next;
    setEntry(k, {
      isFetching: true,
      fetchingNext: mode === 'next',
      status: data ? entry.status : 'loading',
    });
    // refresh: 'loaded': the same number of pages, fetched in order (each from the fresh previous page's
    // next, so cursors stay right), kept off-screen until all have arrived, then swapped in at once
    const refreshCount = mode === 'first' && data && def.refresh === 'loaded' ? data.pages.length : 1;
    if (refreshCount > 1)
      return runEntry(k, async (signal) => {
        const pages: unknown[] = [];
        const pageParams: unknown[] = [];
        // From the oldest page kept: the first page, or with `max` the start of the kept window
        let p: unknown = data!.pageParams.length ? data!.pageParams[0] : def.firstPage;
        let next: unknown = undefined;
        for (let i = 0; i < refreshCount; i++) {
          const response = await def.fetch(p as never, signal, params as never);
          pages.push(response);
          pageParams.push(p);
          next = def.nextPage(response as never, pages as never[], p as never);
          if (next == null) break; // the list got shorter: stop where it ends now
          p = next;
        }
        return { [ALL_PAGES]: true, pages, pageParams, next };
      }, def, (all) => {
        const { pages, pageParams, next } = all as InfiniteData;
        return { pages, pageParams, next } satisfies InfiniteData;
      }, () => fetchInfinite(q, def, params, 'first', true));
    return runEntry(k, (signal) => def.fetch(page as never, signal, params as never), def, (response) => {
      const base = mode === 'next' && data ? data : { pages: [], pageParams: [] };
      let pages = [...base.pages, response];
      let pageParams = [...base.pageParams, page];
      if (def.maxPages && pages.length > def.maxPages) {
        pages = pages.slice(-def.maxPages);
        pageParams = pageParams.slice(-def.maxPages);
      }
      const next = def.nextPage(response as never, pages as never[], page as never);
      return { pages, pageParams, next } satisfies InfiniteData;
    }, () => fetchInfinite(q, def, params, 'first', true));
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see StoreApi.setQueryData
  function setQueryData(q: string, updater: any, params?: unknown) {
    if (isQuery(q) && params === undefined) {
      setState(q, updater); // the query's own state key
      return;
    }
    const k = cacheKey(q, params);
    const prev = cache.get(k)?.data;
    setEntry(k, {
      data: typeof updater === 'function' ? updater(prev) : updater,
      status: 'success',
    });
  }

  /** Cancel a query's in-flight requests (every params of a named query). */
  function abort(q: string) {
    if (isQuery(q)) inlineAborts.get(q)?.abort(); // without params, and below every params
    for (const [k, c] of [...namedAborts])
      if (belongsTo(k, q)) c.abort();
  }

  async function invalidate(q: string) {
    if (isQuery(q)) {
      // Inline query: reload now if on screen, otherwise on next read
      const m = meta(q);
      m.updatedAt = 0;
      m.version++; // a response already on its way may predate the change: it reloads instead
      if (m.mounted > 0) await loadKey(q, true).catch(() => {});
    }
    // ...and every params of it
    const jobs: Promise<unknown>[] = [];
    for (const [k, entry] of cache) {
      if (!belongsTo(k, q)) continue;
      cache.set(k, { ...entry, updatedAt: 0 });
      versions.set(k, (versions.get(k) ?? 0) + 1); // in-flight responses are now out of date
      const visible = onScreen.get(k);
      if (visible?.count)
        jobs.push(fetchQuery(visible.name, visible.params, true).catch(() => {}));
    }
    // The offline copy learns it's stale too, or a reload would restore it as fresh
    saveCache();
    if (isQuery(q)) saveInline();
    await Promise.all(jobs);
  }

  /* ---------- Offline queue and refresh on focus ---------- */

  const queue: (() => void)[] = [];
  /**
   * Runs the task now, or once the connection is back. It may run much later,
   * so read the latest state inside it:
   *   whenOnline(() => api.save(store.getState('todos')))   // sends what's current then
   * not a value captured earlier:
   *   whenOnline(() => api.save(todos))                     // may send stale data
   */
  function whenOnline(task: () => Promise<unknown> | unknown) {
    if (destroyed) return Promise.reject(new Error(`[${name}] whenOnline() after destroy().`));
    if (!isBrowser || navigator.onLine) return Promise.resolve().then(task);
    const waiting = new Promise((resolve, reject) =>
      queue.push(() => Promise.resolve().then(task).then(resolve, reject))
    );
    updateWindowListeners();
    return waiting;
  }

  // Focus and coming back online refresh what's on screen. A paged list on screen keeps its pages
  // (inFocusRefresh): starting it over would drop everything below page 1 under someone's scroll.
  let inFocusRefresh = 0;
  const refreshVisible = () => {
    for (const q of Object.keys(queryDefs))
      if (meta(q).mounted > 0) loadKey(q).catch(() => {});
    inFocusRefresh++;
    try {
      for (const { name: q, params, count } of onScreen.values())
        if (count) fetchQuery(q, params).catch(() => {});
    } finally {
      inFocusRefresh--;
    }
  };
  const onOnline = () => {
    queue.splice(0).forEach((task) => task());
    refreshVisible();
    updateWindowListeners();
  };
  // Listening to window keeps the store alive, so only listen while something
  // needs it: a query on screen, or tasks waiting for the connection.
  let listening = false;
  function updateWindowListeners() {
    if (!isBrowser) return;
    const needed =
      !destroyed &&
      (queue.length > 0 ||
        Object.keys(queryDefs).some((q) => meta(q).mounted > 0) ||
        [...onScreen.values()].some((v) => v.count > 0));
    if (needed === listening) return;
    listening = needed;
    const method = needed ? 'addEventListener' : 'removeEventListener';
    window[method]('focus', refreshVisible);
    window[method]('online', onOnline);
  }

  const abortAll = () => {
    inlineAborts.forEach((c) => c.abort());
    namedAborts.forEach((c) => c.abort());
  };

  /** Stop syncing tabs and listening to the window. Useful in tests and hot reloading. */
  function destroy() {
    flushSave();
    flushBroadcast();
    if (isBrowser && persistStorage && typeof window.removeEventListener === 'function') {
      window.removeEventListener('pagehide', flushSave);
      document.removeEventListener('visibilitychange', flushWhenHidden);
    }
    destroyed = true;
    // Without this the extension keeps calling back into a store nobody uses,
    // which also keeps the whole store alive.
    try {
      unsubscribeDevtools?.();
    } catch {}
    unsubscribeDevtools = undefined;
    channel?.close();
    updateWindowListeners();
    gcTimers.forEach((t) => clearTimeout(t));
    gcTimers.clear();
    abortAll();
    queue.length = 0; // saves waiting for the connection won't run on a destroyed store
    entrySetters.clear();
    entrySelect.clear();
    if (options.shared) {
      const slot = Symbol.for(`createStore:${name}`);
      const g = globalThis as unknown as Record<symbol, unknown>;
      if (g[slot] === store) delete g[slot];
    }
  }

  /**
   * Back to a fresh store, e.g. `afterEach(() => store.reset())`: initial state,
   * no history, empty query cache, in-flight requests aborted. Subscribers and
   * event handlers stay, so mounted components keep working.
   */
  function reset() {
    abortAll();
    inlineAborts.clear();
    namedAborts.clear();
    inflight.clear();
    gcTimers.forEach((t) => clearTimeout(t));
    gcTimers.clear();
    const cachedKeys = [...cache.keys()];
    cachedKeys.forEach(releaseEntry);
    cache.clear();
    saveCache();
    cachedKeys.forEach((k) => notify(entryChannel(k))); // components show the empty entry
    for (const m of metas.values())
      Object.assign(m, { loaded: false, updatedAt: 0, inflight: undefined, needsRefetch: false, version: m.version + 1 });
    statuses.clear();
    computedStatusCache.clear();
    journals.clear();
    versions.clear();
    for (const k of Object.keys(initialValues)) delete initialValues[k]; // drop overrides: back to the declared values
    apply({ ...declaredValues }, 'local', 'reset', false);
    saveInline();
    Object.keys(queryDefs).forEach((k) => statusChanged(k));
    past = [];
    future = [];
    updateHistoryInfo();
  }

  /* ---------- Actions ---------- */

  // The api actions get: these members, plus every key's setter and key actions (api.cart.add),
  // from a prototype shared by the store's scopes
  const apiMembers: StoreApi<SV, E, RV> = {
    getState: (key) => readKey(key) as SV[typeof key],
    setState: (key, value, serverCall) => update(key, value, serverCall) as Promise<never>,
    emit: publicEmit,
    on: publicOn,
    fetchQuery,
    setQueryData,
    invalidate,
    whenOnline,
    batch,
    abort,
  };
  const api = Object.assign(Object.create(setterProtoOf(def, API_NAMES, 'apiProto')), apiMembers) as StoreApi<SV, E, RV>;
  Object.defineProperty(api, SETTER_OF, { value: (k: string) => setterFor(k) });
  const actions = (options.actions?.(api as StoreApi<SV, E, RV> & ApiSetters<S, KA>) ?? {}) as A;

  /* ---------- Per-key actions: setTodos.add(...) ---------- */

  const keyActionDefs = (options.keyActions ?? {}) as Record<string, Record<string, KeyAction<unknown>>>;
  const ssrCfg = options.ssr;
  const snapshotVersion = (ssrCfg && typeof ssrCfg === 'object' && ssrCfg.version) || 0;
  if (ssrCfg && typeof ssrCfg === 'object') {
    if ('serialize' in ssrCfg) throw new Error(`[${name}] ssr.serialize is now ssr.keys (or ssr.exclude, for everything but some keys).`);
    if (ssrCfg.keys && ssrCfg.exclude) throw new Error(`[${name}] ssr takes keys or exclude, not both: keys lists what's sent, exclude what isn't.`);
    for (const k of [...(ssrCfg.keys ?? []), ...(ssrCfg.exclude ?? [])])
      if (!isStateKey(k as string) && !(k in namedDefs))
        throw new Error(`[${name}] ssr lists "${String(k)}", which isn't a state key or query${isComputed(k as string) ? ' (computed values are recalculated, not sent)' : ''}.`);
  }

  for (const [key, defs] of Object.entries(keyActionDefs)) {
    if (!isStateKey(key))
      throw new Error(
        `keyActions has "${key}", which is not a plain or query key in the store.`
      );
    for (const [action, def] of Object.entries(defs ?? {}))
      if (typeof def !== 'function' && typeof def?.run !== 'function')
        throw new Error(`keyActions.${key}.${action} must be a function or { run, save }.`);
  }

  function bindAction(key: string, action: string, def: KeyAction<unknown>) {
    const run = typeof def === 'function' ? def : def.run;
    const save = typeof def === 'function' ? undefined : def.save;
    return (...args: unknown[]): Promise<void> => {
      const reducer = (current: unknown) => run(current, ...args);
      if (!save) return update(key, reducer);

      // Reads the value when the save runs, so a queued offline save sends the latest one.
      // The raw stored value, like run gets: not the select()-ed view of a query key.
      const send = () => save(state[key]);
      const promise = update(key, reducer, options.offline ? () => whenOnline(send) : send);
      if (options.onSaveStart) safely(() => options.onSaveStart!(key, action), 'onSaveStart');
      promise.then(
        () => {
          if (options.onSaveSuccess) safely(() => options.onSaveSuccess!(key, action), 'onSaveSuccess');
        },
        (error) => {
          if (options.onSaveError) safely(() => options.onSaveError!(key, action, error), 'onSaveError');
        }
      );
      return promise;
    };
  }

  // Stable setter per key, so it's safe in dependency arrays
  const setters = new Map<string, SetValue<unknown>>();
  function setterFor(key: string) {
    if (isComputed(key)) return undefined;
    if (!setters.has(key)) {
      const setter: SetValue<unknown> = (value, serverCall) => update(key, value, serverCall) as Promise<never>;
      const defs = hasOwn(keyActionDefs, key) ? keyActionDefs[key] : {};
      // defineProperty, because names like "name" or "length" are read-only on functions
      for (const [action, def] of Object.entries(defs ?? {}))
        Object.defineProperty(setter, action, { value: bindAction(key, action, def), enumerable: true });
      setters.set(key, setter);
    }
    return setters.get(key);
  }

  // Each setter (with its key actions) is made the first time it's used: a store with a thousand
  // keys, or a server creating a scope per request, doesn't build a thousand functions up front.
  // One shared getter: it reads its key from a per-key descriptor, so no closure per key either.
  // store.set: the definition's shared getters, asking this store for its setters (made on first use)
  const set = Object.create(def.setProto) as SettersOf<S, KA>;
  Object.defineProperty(set, SETTER_OF, { value: setterFor });

  /* ---------- React hooks ---------- */

  // Values React's server snapshot reads. On the server: the store as it is now, so
  // per-request data set before rendering (setState) is in the HTML. In the browser,
  // while hydrating: the initial values (ignoring saved state), which is what the
  // server rendered when the store was created the same way, so hydration matches.
  const readServer = (key: string): unknown => (isBrowser ? readInitial(key) : readKey(key));

  // Initial values for hydration (ignores saved state)
  const serverCache = new Map<string, unknown>();
  function readInitial(key: string): unknown {
    if (serverCache.has(key)) return serverCache.get(key);
    const value = isComputed(key)
      ? computedDefs[key](makeReader(readInitial, () => {}, `computed "${key}"`) as never)
      : queryDefs[key]?.options.select && initialValues[key] !== undefined
      ? queryDefs[key].options.select!(initialValues[key])
      : initialValues[key];
    serverCache.set(key, value);
    return value;
  }

  /**
   * The queries the shown keys read, directly or through computed values, are
   * "on screen". Recomputed when components mount/unmount and whenever a
   * computed value starts reading different keys, so a newly read query loads.
   */
  function syncMountedQueries() {
    const next = new Set<string>();
    for (const k of roots.keys()) queryKeysOf(k, new Set(), next);
    for (const q of rootQueries) if (!next.has(q)) meta(q).mounted--;
    for (const q of next)
      if (!rootQueries.has(q)) {
        meta(q).mounted++;
        loadKey(q).catch(() => {});
      }
    rootQueries = next;
    updateWindowListeners();
  }

  /**
   * Initial state from createScope() or <Root>: replaces initial values (so hydration
   * renders them, as the server did) and current values. Query keys given here count
   * as loaded, so they don't refetch until stale. Computed keys are skipped.
   */
  function seed(values: Record<string, unknown>) {
    for (const k of Object.keys(values)) hydratedKeys.add(k); // what the server sent (hydration renders these)
    const fresh: Record<string, unknown> = {};
    const queries = values.$queries;
    const ageOf = (age: unknown) => (typeof age === 'number' && age > 0 ? age : 0);
    if (queries && typeof queries === 'object')
      for (const [k, item] of Object.entries(queries as Record<string, { data?: unknown; age?: unknown } | null>)) {
        if (!k.startsWith('query:') || !item || typeof item !== 'object' || !('data' in item)) continue;
        const entry: Entry = { data: item.data, status: 'success', isFetching: false, updatedAt: Date.now() - ageOf(item.age) };
        cache.set(k, entry);
        hydratedEntries.set(k, entry); // what the server rendered: the browser's server snapshot
        notify(entryChannel(k));
      }
    for (const [k, v] of Object.entries(values)) {
      if (k === '$queries' || k === '$ages' || k === '$version' || isComputed(k)) continue;
      if (!isStateKey(k)) throw new Error(`[${name}] initialState has "${k}", which is not in the store.`);
      initialValues[k] = v;
      fresh[k] = v;
    }
    serverCache.clear();
    apply(fresh, 'hydrate', 'initial state', false);
    const ages = (values.$ages && typeof values.$ages === 'object' ? values.$ages : {}) as Record<string, unknown>;
    for (const k of Object.keys(fresh))
      if (isQuery(k)) {
        Object.assign(meta(k), { loaded: true, updatedAt: Date.now() - ageOf(ages[k]) });
        setStatus(k, { loading: false, fetching: false, error: null });
      }
  }

  /** Marks the keys a component shows as on screen while mounted, and loads their queries if needed. */
  function useLoadQueries(id: string) {
    useEffect(() => showKeys(id), [id]);
  }

  /** Marks keys as shown (on screen) and loads their queries; returns the cleanup */
  function showKeys(id: string): (() => void) | undefined {
    {
      if (!id) return; // plain keys: nothing to load
      const keys = id.split('\u0000');
      keys.forEach((k) => roots.set(k, (roots.get(k) ?? 0) + 1));
      syncMountedQueries();
      // A mounting component also refreshes stale data it shows (no-op when fresh)
      const queries = new Set<string>();
      keys.forEach((k) => queryKeysOf(k, new Set(), queries));
      queries.forEach((q) => loadKey(q).catch(() => {}));
      return () => {
        keys.forEach((k) => {
          const n = (roots.get(k) ?? 1) - 1;
          if (n > 0) roots.set(k, n);
          else roots.delete(k);
        });
        syncMountedQueries();
      };
    }
  }

  // Functions a component needs for one key, created once per key instead of
  // on every render (this matters with hundreds of components re-rendering).
  interface KeyHooks {
    getValue: () => unknown;
    getServerValue: () => unknown;
    getStatus: () => Status;
    statusSubscribe: (cb: () => void) => () => void;
    statusCanChange: boolean;
    cell: () => Cell; // the key's value and status, the same object while neither changes
    serverCell: () => Cell;
    idleCell: () => Cell; // the same, for { enabled: false }
    serverIdleCell: () => Cell;
  }
  interface Cell {
    v: unknown;
    s: Status;
  }
  const keyHooks = new Map<string, KeyHooks>();
  // What one useGlobalState(key) call remembers between renders (kept in a single ref)
  interface KeyHookState {
    key: string | null;
    setter: SetValue<unknown> | undefined;
    arr: unknown[] | null; // the last array returned
    statusUsed: boolean; // the component read the status: status changes re-render it
    renderStatus?: Status; // the status read with the value this render
    memo: { input: unknown; output: unknown; selector: unknown } | null;
    h: KeyHooks | null;
    sub: (cb: () => void) => () => void;
    subSelect: (cb: () => void) => () => void;
    enabled: boolean;
  }

  // The array useGlobalState(key) returns: [value, setter, status]. Reading index 2
  // marks the status as used (so status changes re-render that component) and returns
  // the live status. The getter lives once on this class's prototype: defining it on
  // every returned array put V8 arrays in slow dictionary mode (~20% of render time
  // with 1000 components re-rendering).
  const STATUS_OF = Symbol('status');
  class KeyTuple extends Array<unknown> {
    [STATUS_OF]!: KeyHookState;
  }
  Object.defineProperty(KeyTuple.prototype, 2, {
    enumerable: true,
    configurable: true,
    get(this: KeyTuple) {
      const s = this[STATUS_OF];
      s.statusUsed = true;
      return s.renderStatus ?? (s.enabled ? s.h!.getStatus() : s.h!.idleCell().s);
    },
  });
  function hooksFor(key: string): KeyHooks {
    let h = keyHooks.get(key);
    if (!h) {
      const canChange = isQuery(key) || isComputed(key);
      let last: Cell | null = null;
      let lastServer: Cell | null = null;
      const cellOf = (prev: Cell | null, v: unknown): Cell => {
        const s = canChange ? getStatus(key) : PLAIN_STATUS;
        return prev && Object.is(prev.v, v) && prev.s === s ? prev : { v, s };
      };
      // During hydration the browser must render what the server did: a query the server didn't
      // load was loading there, even if the offline copy has restored it here already (#10)
      const serverCellOf = (prev: Cell | null, v: unknown): Cell => {
        const s = isBrowser && isQuery(key) && !hydratedKeys.has(key) ? SERVER_LOADING : canChange ? getStatus(key) : PLAIN_STATUS;
        return prev && Object.is(prev.v, v) && prev.s === s ? prev : { v, s };
      };
      // { enabled: false }: a query that hasn't loaded is waiting, not loading
      let lastIdle: Cell | null = null;
      let lastServerIdle: Cell | null = null;
      const idleOf = (prev: Cell | null, v: unknown): Cell => {
        const s = isQuery(key) && !meta(key).loaded ? PLAIN_STATUS : canChange ? getStatus(key) : PLAIN_STATUS;
        return prev && Object.is(prev.v, v) && prev.s === s ? prev : { v, s };
      };
      h = {
        getValue: () => readKey(key),
        getServerValue: () => readServer(key),
        getStatus: () => getStatus(key),
        statusSubscribe: canChange ? subscribeTo(statusChannel(key)) : noSubscribe,
        statusCanChange: canChange,
        cell: () => (last = cellOf(last, readKey(key))),
        serverCell: () => (lastServer = serverCellOf(lastServer, readServer(key))),
        idleCell: () => (lastIdle = idleOf(lastIdle, readKey(key))),
        serverIdleCell: () => (lastServerIdle = idleOf(lastServerIdle, readServer(key))),
      };
      keyHooks.set(key, h);
    }
    return h;
  }

  /* useGlobalState('todos') and useGlobalState('todos', selector) */
  function useKeyState(key: string, selector?: (value: never) => unknown, enabled = true): unknown {
    if (!hasKey(key))
      throw new Error(
        `"${key}" is not in the store. Add it to the object you pass to createStore().`
      );
    // Everything this hook remembers lives in one ref. This hook runs in every component that
    // reads state, on every render, and React does bookkeeping per hook: one ref instead of
    // three refs and a callback cut the hooks per component from 7 to 4.
    const ref = useRef<EntryHookState | KeyHookState | null>(null);
    // The ref is shared with the other paths of useGlobalState: start over if it was theirs
    if (!ref.current || !('statusUsed' in ref.current))
      ref.current = { key: null, arr: null, statusUsed: false, memo: null, h: null, setter: undefined, sub: noSubscribe, subSelect: noSubscribe, enabled: true };
    const c = ref.current;
    if (c.key !== key || c.enabled !== enabled) {
      c.enabled = enabled;
      // The key's helpers and setter, looked up once per component (and again only if the key changes)
      const h = hooksFor(key);
      c.key = key;
      c.setter = setterFor(key);
      // One subscription for the value and the status. Status changes (fetching → idle) only
      // re-render components that actually read the status; one that destructures just
      // [value, setValue] is left alone.
      const onValue = subscribeTo(key);
      c.h = h;
      c.arr = null;
      // Query and computed keys are also marked as shown while subscribed, which loads them
      c.sub = h.statusCanChange
        ? (cb: () => void) => {
            const offValue = onValue(cb);
            const offStatus = h.statusSubscribe(() => { if (c.statusUsed) cb(); });
            const hide = enabled ? showKeys(key) : undefined; // { enabled: false }: don't load
            return () => { offValue(); offStatus(); hide?.(); };
          }
        : onValue;
      c.subSelect = h.statusCanChange
        ? (cb: () => void) => {
            const offValue = onValue(cb);
            const hide = enabled ? showKeys(key) : undefined;
            return () => { offValue(); hide?.(); };
          }
        : onValue;
    }

    // Remember the last selector result so we only re-render when it changes
    const select = (input: unknown) => {
      if (!selector) return input;
      const m = c.memo;
      if (m && m.selector === selector && Object.is(m.input, input))
        return m.output;
      selecting++;
      let output: unknown;
      try {
        output = selector(input as never);
      } finally {
        selecting--;
      }
      const keep = m && shallowEqual(m.output, output) ? m.output : output;
      c.memo = { input, output: keep, selector };
      return keep;
    };

    const h = c.h!;
    const snap = useSyncExternalStore(
      selector ? c.subSelect : c.sub,
      selector ? () => select(readKey(key)) : enabled ? h.cell : h.idleCell,
      selector ? () => select(readServer(key)) : enabled ? h.serverCell : h.serverIdleCell
    );

    if (selector) return snap;
    const value = (snap as Cell).v;
    c.renderStatus = (snap as Cell).s; // the status that goes with this value (also during hydration)
    // Return the same array while the value and setter are unchanged.
    // Index 2 is a getter: reading it marks the status as used, and it always
    // returns the live status (also when read later, outside of render).
    if (c.arr && c.arr[0] === value) return c.arr;
    const arr = new KeyTuple(3); // index 2 stays empty: reads go to the prototype getter
    arr[0] = value;
    arr[1] = c.setter;
    arr[STATUS_OF] = c; // the component's own bookkeeping: no separate link object
    c.arr = arr;
    return arr;
  }

  /* useGlobalState(state => ...), useGlobalState(get => ...), useGlobalState(({ a, b }) => ...) */
  function useStoreSelector(select: (state: never) => unknown): unknown {
    const memo = useRef<{
      select: unknown;
      deps: string[];
      values: unknown[];
      output: unknown;
      server: boolean;
    } | null>(null);

    const run = (read: (k: string) => unknown, server: boolean) => {
      // A key that throws (e.g. a computed loop the selector catches itself)
      // is recorded as THREW, and always makes the selector run again.
      const safeRead = (k: string) => {
        try {
          return read(k);
        } catch {
          return THREW;
        }
      };
      const m = memo.current;
      // Same selector, same inputs: reuse the last result
      if (
        m &&
        m.select === select &&
        m.server === server &&
        m.deps.every((d, i) => m.values[i] !== THREW && Object.is(safeRead(d), m.values[i]))
      )
        return m.output;

      // One reader per component, pointed at this run's read function and dependency set
      // (building a Proxy on every run was a sixth of the time when many selectors re-run)
      const r = (readerRef.current ??= { read, deps: new Set<string>(), reader: null as unknown });
      r.read = read;
      r.deps.clear();
      r.reader ??= makeReader((k) => r.read(k), (k) => r.deps.add(k), 'a selector');
      const deps = r.deps;
      selecting++;
      let output: unknown;
      try {
        output = select(r.reader as never);
      } finally {
        selecting--;
      }
      rejectReader(output, 'A selector');
      const list = [...deps];
      const keep = m && shallowEqual(m.output, output) ? m.output : output;
      memo.current = { select, deps: list, values: list.map(safeRead), output: keep, server };
      // Dependencies can change between runs (mode ? a : b). During render, only
      // add the new keys: with concurrent rendering this render may never commit,
      // and the screen must keep updating for the keys it actually shows. Keys
      // the committed render no longer reads are dropped after commit (below).
      const sub = subscription.current;
      if (sub.cb && !server) {
        const added = list.filter((k) => !sub.keys.includes(k));
        if (added.length) {
          indexSelector(sub.cb, [], added);
          sub.keys = [...sub.keys, ...added];
        }
      }
      return keep;
    };

    // Subscribed only to the keys this selector read last time
    const subscription = useRef<{ cb?: () => void; keys: string[] }>({ keys: [] });
    const readerRef = useRef<{ read: (k: string) => unknown; deps: Set<string>; reader: unknown } | null>(null);
    const subscribe = useCallback((cb: () => void) => {
      const sub = subscription.current;
      sub.cb = cb;
      sub.keys = memo.current?.deps ?? [];
      indexSelector(cb, [], sub.keys);
      return () => {
        indexSelector(cb, sub.keys, []);
        if (sub.cb === cb) { sub.cb = undefined; sub.keys = []; }
      };
    }, []);

    const value = useSyncExternalStore(
      subscribe,
      () => run(readKey, false),
      () => run(readServer, true)
    );
    // After commit: subscribe to exactly the keys the committed render read. The effect only
    // runs when that list changed, not on every render of every component using a selector.
    const committedDeps = memo.current?.deps ?? [];
    const depsId = committedDeps.join('\u0000');
    useEffect(() => {
      const sub = subscription.current;
      if (!sub.cb) return;
      const drop = sub.keys.filter((k) => !committedDeps.includes(k));
      const add = committedDeps.filter((k) => !sub.keys.includes(k));
      if (drop.length || add.length) {
        indexSelector(sub.cb, drop, add);
        sub.keys = committedDeps;
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps -- depsId is committedDeps, as a string
    }, [depsId]);
    useLoadQueries(committedDeps.some((k) => isQuery(k) || isComputed(k)) ? committedDeps.filter((k) => isQuery(k) || isComputed(k)).join('\u0000') : '');
    return value;
  }

  function useGlobalState<K extends PagedKeysOf<S>>(key: K): [PageOf<S[K]>[], undefined, PagedStatusFor<S[K]>];
  function useGlobalState<K extends PagedKeysOf<S>>(
    key: K,
    params: TakesParams<PagedParamsOf<S[K]>>,
    options?: UseOptions
  ): [PageOf<S[K]>[], undefined, PagedStatusFor<S[K]>];
  function useGlobalState<K extends QueryKeysOf<S> & keyof SV>(
    key: K,
    params: TakesParams<ParamsOf<S[K]>>,
    options?: UseOptions
  ): [SV[K] | undefined, SetValue<RV[K & keyof RV]>, StatusFor<S[K & keyof S]>];
  function useGlobalState<K extends Key>(
    key: K
  ): [V[K], K extends StateKey ? SetValue<RV[K & keyof RV]> & ActionsFor<KA, K> : undefined, StatusFor<S[K & keyof S]>];
  function useGlobalState<K extends Key, R>(
    key: K,
    selector: (value: V[K]) => R
  ): R;
  function useGlobalState<R>(select: (state: StateReader<V>) => R): R;
  function useGlobalState(
    keyOrSelect: string | ((state: never) => unknown),
    second?: unknown,
    options?: UseOptions
  ): unknown {
    // Every path below uses the same two hooks (a ref and one subscription), so a component
    // can move between them, e.g. useGlobalState('user', id) while id goes from undefined to set.
    if (typeof keyOrSelect === 'function')
      // eslint-disable-next-line react-hooks/rules-of-hooks -- same kind of argument on every render
      return useStoreSelector(keyOrSelect);
    // Params passed but undefined (user?.id before the user has loaded): they aren't known yet, so
    // the query waits. Leaving the params out is what reads a query without params.
    // (arguments.length, not a rest array: that would be allocated on every render)
    const paramsGiven = arguments.length >= 2 && typeof second !== 'function';
    if (paramsGiven) checkUseOptions(options, keyOrSelect);
    if (isPaged(keyOrSelect))
      // eslint-disable-next-line react-hooks/rules-of-hooks -- same two hooks as the other paths
      return usePaged(keyOrSelect, second, paramsGiven && second === undefined, blockOf(options));
    if (paramsGiven && (second !== undefined || isQuery(keyOrSelect))) {
      if (!isQuery(keyOrSelect))
        throw new Error(
          `useGlobalState("${keyOrSelect}", params): "${keyOrSelect}" ${hasKey(keyOrSelect) ? "isn't a query, so it doesn't take params" : 'is not in the store'}. ` +
            `The second argument is params for a query(...) key, or a selector function.`
        );
      // eslint-disable-next-line react-hooks/rules-of-hooks -- same two hooks as the other paths
      return useEntryState(keyOrSelect, second, second === undefined, blockOf(options));
    }
    // eslint-disable-next-line react-hooks/rules-of-hooks -- same two hooks as the other paths
    return useKeyState(keyOrSelect, second as ((value: never) => unknown) | undefined);
  }

  interface Block {
    blocked: boolean;
    blockedBy: string | null;
    rootError: unknown;
  }
  const NOT_BLOCKED: Block = { blocked: false, blockedBy: null, rootError: null };
  /** What enabled and waitFor say: waiting or not, on which query, and why */
  function blockOf(options: UseOptions | undefined): Block {
    if (!options) return NOT_BLOCKED;
    const enabled = options.enabled !== false;
    const ups = options.waitFor === undefined ? [] : Array.isArray(options.waitFor) ? options.waitFor : [options.waitFor as Status];
    let blockedBy: string | null = null;
    let rootError: unknown = null;
    let waiting = false;
    // An upstream that failed without data wins: its error is the reason
    for (const u of ups as Status[]) {
      const info = statusInfo.get(u);
      if (u.blocked && u.rootError != null) return { blocked: true, blockedBy: u.blockedBy, rootError: u.rootError };
      if (u.error != null && !(info?.hasData() ?? false)) return { blocked: true, blockedBy: info?.key ?? null, rootError: u.error };
    }
    for (const u of ups as Status[]) {
      if (u.blocked || u.loading) {
        waiting = true;
        blockedBy ??= u.blocked ? u.blockedBy ?? statusInfo.get(u)?.key ?? null : statusInfo.get(u)?.key ?? null;
        rootError ??= u.rootError ?? null;
      }
    }
    if (!waiting && enabled) return NOT_BLOCKED;
    return { blocked: true, blockedBy, rootError };
  }
  const sameBlock = (a: Block, b: Block) => a.blocked === b.blocked && a.blockedBy === b.blockedBy && Object.is(a.rootError, b.rootError);
  const noop = () => Promise.resolve();

  /** Marks a cache entry as on screen and loads it; returns the cleanup (it runs in the subscription) */
  function showEntry(q: string, params: unknown, k: string): () => void {
    const visible = onScreen.get(k) ?? { name: q, params, count: 0 };
    visible.count++;
    onScreen.set(k, visible);
    clearTimeout(gcTimers.get(k));
    gcTimers.delete(k);
    updateWindowListeners();
    fetchQuery(q, params).catch(() => {});
    return () => {
      visible.count--;
      if (visible.count === 0) scheduleGc(k);
      updateWindowListeners();
    };
  }

  // The selected value of a cache entry, recalculated only when its data changes
  const entrySelect = new Map<string, { raw: unknown; out: unknown }>();
  function selectedData(q: string, k: string, raw: unknown): unknown {
    const select = queryDefs[q]?.options.select;
    if (!select || raw === undefined) return raw;
    const m = entrySelect.get(k);
    if (m && Object.is(m.raw, raw)) return m.out;
    const out = select(raw);
    entrySelect.set(k, { raw, out });
    return out;
  }

  // The setter of one params' entry: writes it, and with a server call, rolls back on failure
  const entrySetters = new Map<string, SetValue<unknown>>();
  function entrySetter(q: string, params: unknown, k: string): SetValue<unknown> {
    let setter = entrySetters.get(k);
    if (!setter) {
      setter = (value, serverCall) => {
        const prev = cache.get(k)?.data;
        const next = typeof value === 'function' ? (value as (p: unknown) => unknown)(prev) : value;
        setEntry(k, { data: next, status: 'success' });
        if (!serverCall) return Promise.resolve() as Promise<never>;
        const done = Promise.resolve()
          .then(serverCall)
          .then(
            (result) => {
              if (queryDefs[q]?.options.refetchAfterMutation) return fetchQuery(q, params, true).then(() => result, () => result);
              return result; // what the save returned
            },
            (error) => {
              // Roll back, unless something newer has replaced the value since, or the page is being left
              // (the browser cancelled a request that may well have reached the server: #3)
              if (!leavingPage && Object.is(cache.get(k)?.data, next)) setEntry(k, { data: prev, status: prev === undefined ? 'idle' : 'success' });
              throw error;
            }
          );
        done.catch(() => {});
        ownPromises.add(done);
        return done as Promise<never>;
      };
      entrySetters.set(k, setter);
    }
    return setter;
  }

  /** state and loading for an entry's status, with a cancelled first load reported as the query asked */
  function entryState(q: string, entry: Entry, hasData: boolean, enabled: boolean): { state: StatusState; loading: boolean } {
    const loading = entry.status === 'loading';
    const asked = abortedState(q, entry.status === 'idle' && !!entry.aborted, loading, hasData, !enabled);
    if (asked === 'loading') return { state: 'loading', loading: true };
    if (asked === 'idle') return { state: 'idle' as StatusState, loading: false };
    return { state: stateOf(loading, entry.error, hasData, !enabled), loading };
  }

  interface EntryHookState {
    mode: 'entry' | 'paged';
    q: string;
    params: unknown; // the last params object: the same one again reuses k (React's Object.is, like hook deps)
    k: string;
    enabled: boolean;
    block: Block;
    sub: (cb: () => void) => () => void;
    snap: () => unknown;
    serverSnap: () => unknown;
  }

  // A setter for params that aren't known yet: there's no entry to write
  const waitingSetter = (q: string): SetValue<unknown> => () => {
    throw new Error(`useGlobalState("${q}", params): the params aren't known yet (they're undefined), so there's no entry to write.`);
  };

  // useGlobalState("feed", undefined) on a query whose function takes no params: almost surely a
  // wrapper forwarding an empty argument. It waits forever, so say so (once per query).
  const warnedNoParams = new Set<string>();
  function checkWaiting(q: string, paged: boolean) {
    if (warnedNoParams.has(q)) return;
    const fn = (initialState as Record<string, { fetch?: (...a: never[]) => unknown } | undefined>)[q]?.fetch;
    if (typeof fn !== 'function' || fn.length > (paged ? 1 : 0)) return; // it declares params: waiting is right
    warnedNoParams.add(q);
    console.warn(
      `[${name}] useGlobalState("${q}", undefined) is waiting for params, but ${q}'s fetch function takes none${paged ? ' besides the page' : ''}. ` +
        `To read it without params, leave the argument out: useGlobalState("${q}").`
    );
  }

  /** useGlobalState(key, params): one params' entry, as [value, setter, status] */
  function useEntryState(q: string, params: unknown, waitingForParams: boolean, block: Block): unknown {
    if (waitingForParams) checkWaiting(q, false);
    const ref = useRef<EntryHookState | KeyHookState | null>(null);
    let c = ref.current as EntryHookState | null;
    const same = c !== null && c.mode === 'entry' && c.q === q && Object.is(c.params, params);
    const k = waitingForParams ? '' : same ? c!.k : cacheKey(q, params); // big filters: keyed once, not per render
    const enabled = !waitingForParams && !block.blocked;
    if (!c || c.mode !== 'entry' || c.k !== k || c.enabled !== enabled || !sameBlock(c.block, block)) {
      const missing = enabled ? PENDING : EMPTY;
      const setter = waitingForParams ? waitingSetter(q) : entrySetter(q, params, k);
      const refetch = enabled ? () => fetchQuery(q, params, true).then(() => {}, () => {}) : noop;
      const why = enabled ? NOT_BLOCKED : { ...block, blocked: true };
      let last: { entry: Entry; tuple: unknown[] } | null = null;
      const tupleOf = (entry: Entry) => {
        if (last && last.entry === entry) return last.tuple;
        const status: Status = owned(
          { ...entryState(q, entry, entry.data !== undefined, enabled), fetching: entry.isFetching, error: entry.error ?? null, ...why, refetch },
          q, () => entry.data !== undefined
        );
        const tuple = [waitingForParams ? undefined : selectedData(q, k, entry.data), setter, status];
        last = { entry, tuple };
        return tuple;
      };
      const onEntry = waitingForParams ? noSubscribe : subscribeTo(entryChannel(k));
      c = {
        mode: 'entry', q, params, k, enabled, block,
        sub: (cb) => {
          const off = onEntry(cb);
          const hide = enabled ? showEntry(q, params, k) : undefined;
          return () => { off(); hide?.(); };
        },
        snap: () => tupleOf((waitingForParams ? undefined : cache.get(k)) ?? missing),
        serverSnap: () => tupleOf((waitingForParams ? undefined : isBrowser ? hydratedEntries.get(k) : cache.get(k)) ?? missing),
      };
      ref.current = c;
    }
    return useSyncExternalStore(c.sub, c.snap, c.serverSnap);
  }

  const NO_PAGES: never[] = [];

  /** useGlobalState(pagedKey, params?): [pages, undefined, status with page controls] */
  function usePaged(q: string, params: unknown, waitingForParams: boolean, block: Block): unknown {
    if (waitingForParams) checkWaiting(q, true);
    const ref = useRef<EntryHookState | KeyHookState | null>(null);
    let c = ref.current as EntryHookState | null;
    const same = c !== null && c.mode === 'paged' && c.q === q && Object.is(c.params, params);
    const k = waitingForParams ? '' : same ? c!.k : cacheKey(q, params); // big filters: keyed once, not per render
    const enabled = !waitingForParams && !block.blocked;
    if (!c || c.mode !== 'paged' || c.k !== k || c.enabled !== enabled || !sameBlock(c.block, block)) {
      const def = namedDefs[q] as AnyInfinite;
      const missing = enabled ? PENDING : EMPTY;
      // While blocked, the page controls do nothing: no requests until it can run
      const fetchNextPage = enabled ? () => fetchInfinite(q, def, params, 'next').then(() => {}, () => {}) : noop;
      const refetch = enabled ? () => fetchInfinite(q, def, params, 'first', true).then(() => {}, () => {}) : noop;
      const why = enabled ? NOT_BLOCKED : { ...block, blocked: true };
      let last: { entry: Entry; tuple: unknown[] } | null = null;
      const tupleOf = (entry: Entry) => {
        if (last && last.entry === entry) return last.tuple;
        const data = entry.data as InfiniteData | undefined;
        const status: PagedStatus = owned({
          ...entryState(q, entry, data !== undefined, enabled), // more pages loading: still 'ready'
          fetching: entry.isFetching, error: entry.error ?? null, ...why, refetch,
          hasNextPage: enabled && data ? data.next != null : false, fetchNextPage, isFetchingNextPage: !!entry.fetchingNext,
        }, q, () => data !== undefined);
        const tuple = [(waitingForParams ? undefined : data?.pages) ?? NO_PAGES, undefined, status];
        last = { entry, tuple };
        return tuple;
      };
      const onEntry = waitingForParams ? noSubscribe : subscribeTo(entryChannel(k));
      c = {
        mode: 'paged', q, params, k, enabled, block,
        sub: (cb) => {
          const off = onEntry(cb);
          const hide = enabled ? showEntry(q, params, k) : undefined;
          return () => { off(); hide?.(); };
        },
        snap: () => tupleOf((waitingForParams ? undefined : cache.get(k)) ?? missing),
        serverSnap: () => tupleOf((waitingForParams ? undefined : isBrowser ? hydratedEntries.get(k) : cache.get(k)) ?? missing),
      };
      ref.current = c;
    }
    return useSyncExternalStore(c.sub, c.snap, c.serverSnap);
  }

  function useHistory() {
    return useSyncExternalStore(
      subscribeTo(HISTORY_CHANNEL),
      () => historyInfo,
      () => historyInfo
    );
  }

  function subscribe(listener: (e: ChangeEvent) => void) {
    changeListeners.add(listener);
    let held: typeof listener | undefined = listener; // released after unsubscribing
    return () => {
      if (held) changeListeners.delete(held);
      held = undefined;
    };
  }

  /** Public setState: same as the hook setter, so it can also save to the server. */
  function setStateWithServer<K extends StateKey, R = void>(
    key: K,
    value: Updater<RV[K & keyof RV]>,
    serverCall?: () => Promise<R> | R
  ): Promise<R> {
    return update(key, value, serverCall) as Promise<never>; // resolves with what the save returned
  }

  /**
   * The state to send to the browser: plain values of every state key (or of the keys `ssr.keys`/`ssr.exclude` choose
   * keys). Query keys are included only once they've loaded, so the browser never mistakes an
   * empty initial value for data. Computed values aren't included; they're recalculated.
   */
  function snapshot(): Partial<RV> & { $queries?: Record<string, unknown>; $ages?: Record<string, number> } {
    const cfg = options.ssr;
    const only = cfg && typeof cfg === 'object' && cfg.keys ? new Set(cfg.keys as string[]) : null;
    const skip = new Set((cfg && typeof cfg === 'object' && (cfg.exclude as string[] | undefined)) || []);
    // ssr: { keys } or { exclude }. By default, a key that persists is left out while the server hasn't
    // changed it: its declared value would overwrite what the browser just restored (a logged-in user
    // would look logged out). A value the server set for this request (createScope({ user }), setState)
    // is sent, so the page hydrates as the server rendered it. ssr.keys sends a key regardless.
    const untouchedSaved = (k: string) => appPersistedKeys.has(k) && Object.is(state[k], (initialState as Record<string, unknown>)[k]);
    const list = { has: (k: string) => (only ? only.has(k) : !skip.has(k) && !untouchedSaved(k)) };
    const now = Date.now();
    // Fails here, naming the value, rather than later as different data in the browser
    const check = (what: string, at: string, value: unknown) => {
      const bad = notJsonSafe(value, at, false);
      if (!bad) return;
      throw new Error(
        `[${name}] snapshot() can't send ${what}: ${bad}. Snapshots travel as JSON, so keep that state to ` +
          `strings, numbers, booleans, null, arrays and plain objects (a Date as an ISO string or a timestamp), ` +
          `or leave it out with ssr: { exclude: [...] }.`
      );
    };
    const out: Record<string, unknown> = { $version: snapshotVersion };
    const ages: Record<string, number> = {};
    for (const k of STATE_KEYS) {
      if (list && !list.has(k)) continue;
      if (isQuery(k) && !meta(k).loaded) continue;
      if (state[k] === undefined)
        throw new Error(
          `[${name}] snapshot() can't send state key "${k}": it's undefined, and JSON drops undefined, so the browser ` +
            `would start from the initial value instead. Use null for "no value", or leave the key out with ssr: { exclude: [...] }.`
        );
      check(`state key "${k}"`, k, state[k]);
      out[k] = state[k];
      // How long ago it loaded, so the browser knows how fresh it is. An age, not a time:
      // the server's and the browser's clocks can disagree by minutes.
      if (isQuery(k)) ages[k] = Math.max(0, now - meta(k).updatedAt);
    }
    // Named and infinite queries that have data (by cache entry), so the browser can render
    // the same HTML and doesn't fetch them again
    const queries: Record<string, { data: unknown; age: number }> = {};
    for (const [k, e] of cache)
      if (e.status === 'success' && e.data !== undefined && (!list || list.has(queryNameOf(k)))) {
        check(`query "${queryNameOf(k)}"`, 'data', e.data);
        queries[k] = { data: e.data, age: Math.max(0, now - e.updatedAt) };
      }
    if (Object.keys(queries).length) out.$queries = queries;
    if (Object.keys(ages).length) out.$ages = ages;
    return out as Partial<RV> & { $queries?: Record<string, unknown>; $ages?: Record<string, number> };
  }

  function toScript(): string {
    if (!options.name)
      throw new Error(
        `[${name}] toScript() needs the store's name, so the browser can find its data: createStore(state, { name: 'shop', ssr: true }).`
      );
    return `<script type="application/json" id="${escapeAttr(dataTagId(name))}">${serializeSnapshot(snapshot())}</script>`;
  }

  const members = {
    ...api, // emit, on, fetchQuery, setQueryData, invalidate, whenOnline, batch, abort
    useGlobalState,
    getState,
    setState: setStateWithServer,
    set,
    actions,
    undo,
    redo,
    goTo,
    useHistory,
    subscribe,
    reset,
    destroy,
    /** Resolves once persisted state has loaded (right away for sync storage) */
    hydrated: whenHydrated,
    /** Undo/redo state now, outside React: { canUndo, canRedo, position, length } */
    getHistory: () => ({ ...historyInfo }),
    snapshot,
    /**
     * The snapshot as a data tag for the HTML: <script type="application/json" id="createstore:<name>">.
     * It never runs (so it works under a strict Content Security Policy) and is escaped, so data like
     * "</script>" can't end it. In the browser, hydrate() with no argument finds it.
     */
    toScript,
  };
  // store.cart.add(...): each state key's setter, with its key actions, on the store. They live on
  // its prototype, so the store's own members stay a small object that's fast to read (thousands
  // of keys defined on the store itself made every store.useGlobalState lookup slow).
  // A key named like a store member (reset, set...) stays available as store.set.<key>.
  // Built through a constructor whose prototype holds the setters: V8 keeps such objects in
  // fast-property mode (Object.create + assign left the store in slow dictionary mode).
  const Store = function (this: object) {
    Object.assign(this, members);
  } as unknown as { new (): typeof members; prototype: object };
  Store.prototype = directProtoOf(def, members, name); // shared by every scope of this store
  const store = new Store();
  Object.defineProperty(store, SETTER_OF, { value: setterFor });
  Object.defineProperty(store, SEED, { value: seed });
  Object.defineProperty(store, QUIET, { value: holdingNotify });
  Object.defineProperty(store, DEFINITION, { value: def });
  return store as typeof members & DirectSetters<S, KA>;
}