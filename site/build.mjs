// Builds the documentation site into site/dist, ready for Cloudflare Pages.
//
//   SITE_URL=https://example.pages.dev node site/build.mjs
//   DOCS_ENV=preview ...   preview deployments: told to search engines as noindex
//
// What it does: fingerprints every asset (so it can be cached forever), injects the site URL, writes robots.txt,
// sitemap.xml, llms.txt and llms-full.txt (the docs for language models and agents), the structured data (JSON-LD,
// with the FAQ), the social image, 404.html, favicon.svg, _redirects, and _headers with a Content-Security-Policy computed from the
// page's own inline code. Same input gives byte-identical output (no timestamps).
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, 'dist');
const read = (p) => readFileSync(join(here, p));
const sha = (buf, enc, len) => createHash('sha256').update(buf).digest(enc).slice(0, len);

const env = process.env.DOCS_ENV ?? 'production';
if (!['production', 'preview'].includes(env)) throw new Error(`DOCS_ENV must be production or preview, got "${env}"`);
const rawUrl = process.env.SITE_URL ?? 'http://localhost:8788';
const url = new URL(rawUrl);
if (url.protocol !== 'https:' && url.hostname !== 'localhost')
  throw new Error(`SITE_URL must be https (got ${rawUrl})`);
const SITE = url.origin; // no path, no trailing slash

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'assets', 'fonts'), { recursive: true });
mkdirSync(join(out, 'assets', 'prism'), { recursive: true });
mkdirSync(join(out, 'assets', 'licenses'), { recursive: true });

// ---- 1. fingerprinted assets: logical path -> published path ----
const published = new Map();
const emit = (logical, dir, base, ext, content) => {
  const name = `${base}.${sha(content, 'hex', 10)}${ext}`;
  writeFileSync(join(out, 'assets', dir, name), content);
  published.set(logical, `/assets/${dir ? `${dir}/` : ''}${name}`);
  return name;
};

const fontsDir = 'vendor/fonts';
const woffNames = new Map();
for (const f of readdirSync(join(here, fontsDir)).filter((n) => n.endsWith('.woff2'))) {
  woffNames.set(f, emit(`${fontsDir}/${f}`, 'fonts', basename(f, '.woff2'), '.woff2', read(`${fontsDir}/${f}`)));
}
let css = read(`${fontsDir}/fonts.css`).toString('utf8');
css = css.replace(/url\("([a-z0-9.-]+\.woff2)"\)/g, (_m, f) => {
  if (!woffNames.has(f)) throw new Error(`fonts.css refers to a missing font file: ${f}`);
  return `url("${woffNames.get(f)}")`;
});
emit('vendor/fonts/fonts.css', 'fonts', 'fonts', '.css', Buffer.from(css));

for (const f of readdirSync(join(here, 'vendor/prism')).filter((n) => n.endsWith('.js'))) {
  emit(`vendor/prism/${f}`, 'prism', basename(f, '.js'), '.js', read(`vendor/prism/${f}`));
}
emit('src/404.css', '', '404', '.css', read('src/404.css'));
for (const [from, to] of [
  ['vendor/prism/LICENSE.txt', 'prism-LICENSE.txt'],
  ['vendor/fonts/NOTICE.txt', 'fonts-NOTICE.txt'],
])
  cpSync(join(here, from), join(out, 'assets/licenses', to));

// ---- 2. pages ----
const page = (file) => {
  let h = read(file).toString('utf8');
  h = h.replaceAll('/assets/fonts/fonts.css', published.get('vendor/fonts/fonts.css'));
  h = h.replace(/\/assets\/prism\/([\w.-]+\.js)/g, (_m, f) => {
    const p = published.get(`vendor/prism/${f}`);
    if (!p) throw new Error(`page refers to a Prism file that is not vendored: ${f}`);
    return p;
  });
  h = h.replaceAll('/assets/404.css', published.get('src/404.css'));
  return h.replaceAll('%%SITE_URL%%', SITE);
};
let index = page('src/index.html');

// ---- 2b. what search engines, answer engines and AI agents read, made from the page itself so they never drift ----
const doc = new JSDOM(index).window.document;
const squash = (t) => t.replace(/\s+/g, ' ').trim();
const absolute = (href) => (href.startsWith('#') ? `${SITE}/${href}` : href.startsWith('/') ? `${SITE}${href}` : href);
const SKIP = new Set(['SCRIPT', 'STYLE', 'svg', 'BUTTON', 'NAV', 'DIALOG', 'HEADER', 'NOSCRIPT']);
const hidden = (n) =>
  SKIP.has(n.tagName) ||
  n.classList.contains('anchor') ||
  n.classList.contains('code-bar') ||
  n.classList.contains('demo') ||
  n.classList.contains('hero-actions');

function inlineMd(node) {
  return [...node.childNodes]
    .map((n) => {
      if (n.nodeType === 3) return n.textContent.replace(/\s+/g, ' ');
      if (n.nodeType !== 1 || hidden(n)) return '';
      const text = () => inlineMd(n);
      switch (n.tagName) {
        case 'CODE':
          return `\`${n.textContent}\``;
        case 'STRONG':
        case 'B':
          return `**${text().trim()}**`;
        case 'EM':
        case 'I':
          return `*${text().trim()}*`;
        case 'A': {
          const t = text().trim();
          const h = n.getAttribute('href');
          return t && h ? `[${t}](${absolute(h)})` : t;
        }
        case 'BR':
          return '\n';
        case 'UL':
        case 'OL':
          return '';
        default:
          return text();
      }
    })
    .join('');
}
const listMd = (list, depth = 0) =>
  [...list.children].flatMap((li) => {
    const mark = list.tagName === 'OL' ? `${[...list.children].indexOf(li) + 1}.` : '-';
    const nested = [...li.children]
      .filter((c) => c.tagName === 'UL' || c.tagName === 'OL')
      .flatMap((c) => listMd(c, depth + 1));
    return [`${'  '.repeat(depth)}${mark} ${squash(inlineMd(li))}`, ...nested];
  });
const tableMd = (t) => {
  const rows = [...t.querySelectorAll('tr')].map((tr) =>
    [...tr.children].map((c) => squash(inlineMd(c)).replaceAll('|', '\\|')),
  );
  if (!rows.length) return [];
  return [
    `| ${rows[0].join(' | ')} |`,
    `| ${rows[0].map(() => '---').join(' | ')} |`,
    ...rows.slice(1).map((r) => `| ${r.join(' | ')} |`),
  ];
};
const CONTAINER = /^(DIV|SECTION|P|UL|OL|TABLE|PRE|H[1-6]|BLOCKQUOTE|DETAILS|ASIDE|FIGURE)$/;
function blocks(node) {
  const out = [];
  for (const n of node.children) {
    if (hidden(n)) continue;
    const tag = n.tagName;
    if (/^H[1-6]$/.test(tag)) out.push(`${'#'.repeat(Number(tag[1]))} ${squash(inlineMd(n))}`);
    else if (tag === 'P') out.push(squash(inlineMd(n)));
    else if (tag === 'UL' || tag === 'OL') out.push(listMd(n).join('\n'));
    else if (tag === 'TABLE') out.push(tableMd(n).join('\n'));
    else if (tag === 'PRE') {
      const lang = /language-([\w-]+)/.exec(n.querySelector('code')?.className ?? n.className)?.[1] ?? '';
      out.push(`\`\`\`${lang}\n${n.textContent.replace(/\n+$/, '')}\n\`\`\``);
    } else if (tag === 'BLOCKQUOTE') out.push(blocks(n).join('\n\n').replace(/^/gm, '> '));
    else if ([...n.children].some((c) => CONTAINER.test(c.tagName))) out.push(...blocks(n));
    else if (squash(inlineMd(n))) out.push(squash(inlineMd(n)));
  }
  return out.filter(Boolean);
}

const summary = doc.querySelector('meta[name="description"]').content;
// One plain sentence per section for llms.txt, where the first sentence of the page is too weak to guide a reader.
// A section that is not listed here falls back to its own first sentence.
const ABOUT = {
  why: 'What problem it solves: the useState API, made global, with no provider and no reducers.',
  install: 'Install the package. Needs React 19 or newer.',
  'quick-start': 'A working shared counter in a few lines.',
  'learning-path': 'Which features to learn first, and which to ignore until you need them.',
  concepts: 'The few rules to know: key names, setters, immutability.',
  reading: 'Read a key with useGlobalState: returns [value, setter, status].',
  updating: 'Change a key with its setter or setState, including updater functions.',
  computed: 'Values derived from other keys, recalculated only when their inputs change.',
  'key-actions': 'Name common updates on a key, such as todos.add.',
  actions: 'Group logic that touches several keys or calls a server.',
  'actions-vs-key-actions': 'When to use a key action and when to use an action.',
  outside: 'Read, write and subscribe from plain code, outside React.',
  queries: 'Server data as a key: loading and error status, caching, refetching.',
  'named-queries': 'Queries that take params, such as a product by id, each cached separately.',
  infinite: 'Paged lists and infinite scroll with the pages option.',
  optimistic: 'Update the screen at once, call the server, roll back if it fails.',
  'cancel-retry': 'AbortSignal, automatic retries and retry delay.',
  persist:
    'Keep state across reloads in localStorage, sessionStorage or your own async storage, with versions and migrations.',
  'sync-tabs': 'Keep every open tab in sync through BroadcastChannel.',
  offline: 'Keep server data offline and queue saves until the connection returns.',
  history: 'Undo, redo and jump to any step.',
  events: 'One-off signals such as a toast, with typed payloads.',
  batch: 'Group several updates into one undo step and one save.',
  ssr: 'Server rendering and Next.js Server Components: one store per request, hydration, and how user data stays apart.',
  shared: 'Keep one store across hot reloads in development.',
  lifecycle: 'reset, destroy and waiting for saved state to load.',
  typescript: 'Types come from the initial state; typed events, actions and queries.',
  testing: 'Reset stores between tests and test components that use them.',
  architecture: 'How subscriptions, computed values and queries work inside.',
  debugging: 'Redux DevTools, the logger and change events.',
  guardrails: 'The mistakes the library catches, and what its messages say.',
  'best-practices': 'Habits that keep a store simple as an app grows.',
  troubleshooting: 'Common errors and symptoms, with their causes and fixes.',
  'cheat-sheet': 'Every common call on one page.',
  api: 'Every export, option and return value.',
  comparison: 'How it differs from useState with Context, Zustand, Redux Toolkit and TanStack Query.',
  faq: 'Short answers: provider, reducers, multiple stores, SSR, bundle size.',
};
const sections = [...doc.querySelectorAll('section.doc-section[id]')].map((sec) => {
  const first = squash(inlineMd(sec.querySelector('p') ?? sec)).replace(/`/g, '');
  const sentence = /^.*?[.!?](\s|$)/.exec(first)?.[0].trim() ?? first;
  return {
    id: sec.id,
    title: squash(inlineMd(sec.querySelector('h2'))),
    about: ABOUT[sec.id] ?? (sentence.length > 160 ? `${sentence.slice(0, 157)}...` : sentence),
  };
});
const faq = [...doc.querySelectorAll('#faq h3')].map((h) => {
  const answer = [];
  for (let n = h.nextElementSibling; n && n.tagName !== 'H3'; n = n.nextElementSibling)
    answer.push(blocks({ children: [n] }).join(' '));
  return { question: squash(inlineMd(h)), answer: squash(answer.join(' ').replace(/`/g, '')) };
});
if (!faq.length) throw new Error('the FAQ section has no questions: the structured data and llms.txt would be empty');

// Structured data: one graph, with the FAQ as questions and answers (also what answer engines quote)
const graph = {
  '@context': 'https://schema.org',
  '@graph': [
    {
      '@type': 'WebSite',
      '@id': `${SITE}/#website`,
      url: `${SITE}/`,
      name: 'createStore documentation',
      description: summary,
      inLanguage: 'en',
      publisher: { '@id': `${SITE}/#author` },
    },
    { '@type': 'Person', '@id': `${SITE}/#author`, name: 'Gaurav Asawa', url: 'https://github.com/Gauravasawa' },
    {
      '@type': 'SoftwareSourceCode',
      '@id': `${SITE}/#software`,
      name: '@createstore/createstore',
      description: summary,
      url: `${SITE}/`,
      codeRepository: 'https://github.com/Gauravasawa/createstore',
      programmingLanguage: 'TypeScript',
      runtimePlatform: 'Node.js and browsers, with React 19 or newer',
      license: 'https://opensource.org/license/mit',
      author: { '@id': `${SITE}/#author` },
      keywords: 'react, state management, global state, useState, hooks, typescript, ssr, nextjs, persist, offline',
    },
    {
      '@type': 'WebPage',
      '@id': `${SITE}/#webpage`,
      url: `${SITE}/`,
      name: doc.title,
      description: summary,
      inLanguage: 'en',
      isPartOf: { '@id': `${SITE}/#website` },
      about: { '@id': `${SITE}/#software` },
    },
    {
      '@type': 'FAQPage',
      '@id': `${SITE}/#faq`,
      mainEntity: faq.map((f) => ({
        '@type': 'Question',
        name: f.question,
        acceptedAnswer: { '@type': 'Answer', text: f.answer },
      })),
    },
  ],
};
// "<" is escaped so no answer can end the script tag
index = index.replace('%%JSONLD%%', () => JSON.stringify(graph).replaceAll('<', '\\u003c'));

// llms.txt (what to read) and llms-full.txt (everything, as Markdown): for language models and agents
const NPM = 'https://www.npmjs.com/package/@createstore/createstore';
const REPO = 'https://github.com/Gauravasawa/createstore';
const llms = [
  '# createStore',
  '',
  `> ${summary}`,
  '',
  'createStore (npm package `@createstore/createstore`) gives React global state with the same API as `useState`: you describe the state once, and any component reads or changes a key by name. There is no provider, no reducer and no action type. Everything beyond plain keys is optional and stays off until used.',
  '',
  '## Key facts',
  '',
  '- Install: `npm i @createstore/createstore`',
  '- Requires React 19 or newer. Works in the browser, in Node, and with Next.js Server Components.',
  '- TypeScript types included. ESM and CommonJS builds. No runtime dependencies. MIT license.',
  '- A component re-renders only when a key it reads changes.',
  '- Optional features: computed values, server data (`query`), persistence, undo and redo, tab sync, offline queue, events, server rendering.',
  '',
  '## Quick start',
  '',
  '```tsx',
  "import { createStore } from '@createstore/createstore';",
  '',
  'const store = createStore({ count: 0 });',
  '',
  'function Counter() {',
  "  const [count, setCount] = store.useGlobalState('count');",
  '  return <button onClick={() => setCount((c) => c + 1)}>{count}</button>;',
  '}',
  '```',
  '',
  '## Documentation',
  '',
  ...sections.map((x) => `- [${x.title}](${SITE}/#${x.id}): ${x.about}`),
  '',
  '## Optional',
  '',
  `- [The full documentation as one Markdown file](${SITE}/llms-full.txt)`,
  `- [Source code and issues on GitHub](${REPO})`,
  `- [Package on npm](${NPM})`,
  '',
].join('\n');
const body = blocks(doc.querySelector('main'))
  .join('\n\n')
  .replace(/\n{3,}/g, '\n\n');
const llmsFull = `# createStore: full documentation\n\n> ${summary}\n\nSource: ${SITE}/ (the same content as the web page, as Markdown). Package: ${NPM}. Code: ${REPO}.\n\n${body}\n`;
writeFileSync(join(out, 'llms.txt'), llms);
writeFileSync(join(out, 'llms-full.txt'), llmsFull);
cpSync(join(here, 'src/og-image.png'), join(out, 'og-image.png'));

writeFileSync(join(out, 'index.html'), index);
writeFileSync(join(out, '404.html'), page('src/404.html'));
cpSync(join(here, 'src/favicon.svg'), join(out, 'favicon.svg'));

// ---- 3. robots, sitemap, redirects ----
const preview = env === 'preview';
// Search engines and AI crawlers are all welcome, by name: answer engines can only quote what they may read
const AI_BOTS = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User', // OpenAI
  'ClaudeBot',
  'Claude-SearchBot',
  'Claude-User',
  'anthropic-ai', // Anthropic
  'PerplexityBot',
  'Perplexity-User', // Perplexity
  'Google-Extended',
  'Applebot-Extended',
  'Bingbot',
  'DuckAssistBot',
  'MistralAI-User',
  'Amazonbot',
  'meta-externalagent',
  'CCBot',
];
writeFileSync(
  join(out, 'robots.txt'),
  preview
    ? 'User-agent: *\nDisallow: /\n'
    : `User-agent: *\nAllow: /\n\n${AI_BOTS.map((b) => `User-agent: ${b}`).join('\n')}\nAllow: /\n\n# For language models and agents: ${SITE}/llms.txt and ${SITE}/llms-full.txt\nSitemap: ${SITE}/sitemap.xml\n`,
);
if (!preview) {
  writeFileSync(
    join(out, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>${SITE}/</loc></url>\n</urlset>\n`,
  );
}
writeFileSync(join(out, '_redirects'), '/index.html / 301\n');

// ---- 4. headers: the CSP lists the hash of every inline script and style, nothing else is allowed inline ----
const inline = (tag, skip) =>
  [...index.matchAll(new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))]
    .filter((m) => !skip(m[1] ?? ''))
    .map((m) => `'sha256-${sha(Buffer.from(m[2], 'utf8'), 'base64')}'`);
const scriptHashes = inline('script', (attrs) => /\ssrc=|type="application\/ld\+json"/.test(attrs));
const styleHashes = inline('style', () => false);

const csp = [
  "default-src 'none'",
  `script-src 'self' ${scriptHashes.join(' ')}`,
  `style-src 'self' ${styleHashes.join(' ')}`,
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  'upgrade-insecure-requests',
].join('; ');

const headers = [
  '/*',
  `  Content-Security-Policy: ${csp}`,
  '  Strict-Transport-Security: max-age=31536000', // no includeSubDomains: the parent domain may host other things
  '  X-Content-Type-Options: nosniff',
  '  X-Frame-Options: DENY',
  '  Referrer-Policy: strict-origin-when-cross-origin',
  '  Permissions-Policy: accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()',
  '  Cross-Origin-Opener-Policy: same-origin',
  `  Link: </llms.txt>; rel="alternate"; type="text/plain"; title="Summary for language models", </llms-full.txt>; rel="alternate"; type="text/plain"; title="Full documentation as Markdown", </sitemap.xml>; rel="sitemap"`,
  ...(preview ? ['  X-Robots-Tag: noindex, nofollow'] : []),
  '',
  '/llms.txt',
  '  Content-Type: text/plain; charset=utf-8',
  '  Cache-Control: public, max-age=3600',
  '',
  '/llms-full.txt',
  '  Content-Type: text/plain; charset=utf-8',
  '  Cache-Control: public, max-age=3600',
  '',
  '/og-image.png',
  '  Cache-Control: public, max-age=86400',
  '',
  '/assets/*', // fingerprinted file names: safe to cache for a year
  '  Cache-Control: public, max-age=31536000, immutable',
  '',
];
writeFileSync(join(out, '_headers'), headers.join('\n'));

const total = (d) =>
  readdirSync(d, { withFileTypes: true }).reduce(
    (n, e) => n + (e.isDirectory() ? total(join(d, e.name)) : readFileSync(join(d, e.name)).length),
    0,
  );
console.log(
  `site built: ${resolve(out)}\n  url ${SITE} (${env}), ${published.size} fingerprinted assets, ${scriptHashes.length} inline script(s), ${styleHashes.length} inline style(s), ${total(out)} bytes`,
);
