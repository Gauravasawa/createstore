// The app the browser smoke test runs. Used twice: in Node (to render the server HTML) and in the browser bundle,
// so both sides build the same stores. Dependencies come in as arguments, so it needs no bundler on the Node side.
export function makeApps({ createStore, query, h }) {
  // A client app: persistence, tab sync, history and server data
  const client = createStore(
    {
      count: 0,
      items: query(async () => (await fetch('/api/items')).json(), { initial: [], staleTime: 60_000 }),
    },
    { name: 'smoke-client', persist: 'local', syncTabs: true, history: true },
  );
  const Client = () => {
    const [count, setCount] = client.useGlobalState('count');
    const [items] = client.useGlobalState('items');
    return h(
      'div',
      null,
      h('p', { id: 'count' }, String(count)),
      h('p', { id: 'items' }, items.join(',')),
      h('button', { id: 'inc', onClick: () => setCount((c) => c + 1) }, '+'),
      h('button', { id: 'undo', onClick: () => client.undo() }, 'undo'),
      h('button', { id: 'redo', onClick: () => client.redo() }, 'redo'),
    );
  };

  // A server-rendered app: the page arrives with HTML and data, and the browser hydrates it
  const ssr = createStore({ user: 'anonymous', cart: [] }, { name: 'smoke-ssr', ssr: true });
  const Ssr = () => {
    const [user, setUser] = ssr.useGlobalState('user');
    const [cart] = ssr.useGlobalState('cart');
    return h(
      'div',
      null,
      h('p', { id: 'user' }, user),
      h('p', { id: 'cart' }, cart.join(',')),
      h('button', { id: 'rename', onClick: () => setUser('renamed') }, 'rename'),
    );
  };
  return { client, Client, ssr, Ssr };
}
