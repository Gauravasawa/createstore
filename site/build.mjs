// Builds the documentation site into site/dist, ready for Cloudflare Pages.
//
//   SITE_URL=https://example.pages.dev node site/build.mjs
//   DOCS_ENV=preview ...   preview deployments: told to search engines as noindex
//
// What it does: fingerprints every asset (so it can be cached forever), injects the site URL, writes robots.txt,
// sitemap.xml, llms.txt and llms-full.txt (the docs for language models and agents), the structured data (JSON-LD,
// with the FAQ), the social image, one static page per documentation section (so each topic has its own URL),
// security.txt, 404.html, favicon.svg, _redirects, and _headers with a Content-Security-Policy computed from the
// page's own inline code. Same input gives byte-identical output (no timestamps).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
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
// Search Console and Bing Webmaster Tools give a token to prove ownership: set the repository variables
// GOOGLE_SITE_VERIFICATION / BING_SITE_VERIFICATION (the docs workflow passes them in) and it is added to the page.
const token = (name) => {
  const v = process.env[name];
  if (!v) return '';
  if (!/^[\w-]{10,100}$/.test(v))
    throw new Error(`${name} must be the token only (letters, digits, - and _), got "${v}"`);
  return v;
};
const verification = [
  token('GOOGLE_SITE_VERIFICATION') &&
    `<meta name="google-site-verification" content="${token('GOOGLE_SITE_VERIFICATION')}">\n`,
  token('BING_SITE_VERIFICATION') && `<meta name="msvalidate.01" content="${token('BING_SITE_VERIFICATION')}">\n`,
]
  .filter(Boolean)
  .join('');
// The two fonts above the fold are fetched at once, not after the stylesheet: no late font swap, so no layout shift
const preload = ['atkinson-hyperlegible-normal-400.woff2', 'bricolage-grotesque-normal-500.woff2']
  .map((f) => `<link rel="preload" href="/assets/fonts/${woffNames.get(f)}" as="font" type="font/woff2" crossorigin>\n`)
  .join('');
// When the docs were last changed: the date of the last commit that touched the page (the deploy builds from that commit)
const lastModified = (() => {
  try {
    return execFileSync('git', ['log', '-1', '--format=%cI', '--', 'site/src/index.html'], {
      cwd: join(here, '..'),
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
      .slice(0, 10);
  } catch {
    return '';
  }
})();

const page = (file) => {
  let h = read(file).toString('utf8');
  h = h.replace('%%VERIFICATION%%', () => verification).replace('%%PRELOAD%%', () => preload);
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
const REPO_URL = 'https://github.com/Gauravasawa/createstore';
const NPM_URL = 'https://www.npmjs.com/package/@createstore/createstore';
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
    {
      '@type': 'Person',
      '@id': `${SITE}/#author`,
      name: 'Gaurav Asawa',
      url: 'https://github.com/Gauravasawa',
      sameAs: ['https://github.com/Gauravasawa'],
    },
    {
      '@type': 'SoftwareSourceCode',
      '@id': `${SITE}/#software`,
      name: '@createstore/createstore',
      alternateName: ['createStore', 'createstore', 'createStore for React'],
      description: summary,
      url: `${SITE}/`,
      sameAs: [REPO_URL, NPM_URL],
      ...(lastModified && { dateModified: lastModified }),
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
      ...(lastModified && { dateModified: lastModified }),
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
  "- Not related to Redux's `createStore` function: this is a separate library, installed as `@createstore/createstore`.",
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
  `- [Security policy and contact](${SITE}/.well-known/security.txt)`,
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

// ---- one static page per documentation section: its own URL, title, description, canonical and structured data ----
const esc = (t) => t.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const group = (id) => doc.getElementById(id).getAttribute('data-group') ?? '';
const owner = new Map(); // element id -> the section that contains it
for (const x of sections) for (const el of doc.getElementById(x.id).querySelectorAll('[id]')) owner.set(el.id, x.id);
for (const x of sections) owner.set(x.id, x.id);

// What the section pages add to the shared stylesheet and script (the home page keeps its own inline ones)
const sectionCss = `/* Section pages: the title is an h1 here, and there is no hero */
.doc-section > h1 { position: relative; margin: 0 0 14px; font: 700 clamp(28px, 3.4vw, 36px)/1.15 var(--font-display); letter-spacing: -.025em; }
h1:hover .anchor { opacity: 1; }
.sidebar a[aria-current="page"] { color: var(--ink); background: var(--accent-soft); font-weight: 700; }
.crumbs { margin: 40px 0 18px; font-size: 15px; color: var(--ink-3); }
.crumbs a { color: var(--ink-2); display: inline-block; min-height: 24px; line-height: 24px; }
.crumbs span[aria-hidden] { margin: 0 6px; }
.pager { display: flex; flex-wrap: wrap; gap: 12px; justify-content: space-between; margin-top: 56px; }
.pager a { display: block; flex: 1 1 220px; padding: 14px 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); color: var(--ink); text-decoration: none; }
.pager a:hover { border-color: var(--accent); }
.pager small { display: block; color: var(--ink-3); font-size: 13px; }
.pager .next { text-align: right; }
a.search-btn { text-decoration: none; color: inherit; }
`;
const KEY_FNS =
  '/^(useGlobalState|getState|setState|useQuery|useInfiniteQuery|fetchQuery|invalidate|abort|setQueryData|get|emit|on)$/';
const sectionJs = `(function () {
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var KEY_FNS = ${KEY_FNS};
  function markKeys(root) {
    $$('.token.function', root).forEach(function (fn) {
      if (!KEY_FNS.test(fn.textContent)) return;
      var p = fn.nextSibling, s = p && p.nextSibling;
      if (p && p.textContent === '(' && s && s.classList && s.classList.contains('string')) s.classList.add('keyname');
    });
  }
  if (window.Prism) $$('pre code[class*="language-"]').forEach(function (el) { try { Prism.highlightElement(el); } catch (e) {} markKeys(el.parentNode); });
  function copyText(text, btn) {
    var done = function () { var old = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = old; }, 1400); };
    var fallback = function () {
      var ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { btn.textContent = 'Press Ctrl+C'; }
      document.body.removeChild(ta);
    };
    if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  }
  $$('.copy').forEach(function (b) { b.addEventListener('click', function () { copyText(b.closest('.code').querySelector('code').textContent, b); }); });
  $$('[data-copy]').forEach(function (b) { b.addEventListener('click', function () { copyText(b.getAttribute('data-copy'), b); }); });
  var root = document.documentElement;
  var systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  $('.theme-btn').addEventListener('click', function () {
    var t = root.getAttribute('data-theme'); var dark = t ? t === 'dark' : systemDark.matches;
    var next = dark ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('cs-docs-theme', next); } catch (e) {}
  });
  var sidebar = $('#sidebar'), menuBtn = $('.menu-btn'), scrim = null;
  var desktop = function () { return window.matchMedia('(min-width: 961px)').matches; };
  function sync() {
    var open = desktop() ? root.getAttribute('data-nav') !== 'collapsed' : sidebar.classList.contains('open');
    menuBtn.setAttribute('aria-expanded', String(open));
    menuBtn.setAttribute('aria-label', open ? 'Hide navigation' : 'Show navigation');
  }
  function close() { sidebar.classList.remove('open'); if (scrim) { scrim.remove(); scrim = null; } sync(); }
  function open() {
    sidebar.classList.add('open');
    scrim = document.createElement('div'); scrim.className = 'scrim'; scrim.addEventListener('click', close); document.body.appendChild(scrim);
    sync();
  }
  menuBtn.addEventListener('click', function () {
    if (desktop()) {
      var collapsed = root.getAttribute('data-nav') !== 'collapsed';
      if (collapsed) root.setAttribute('data-nav', 'collapsed'); else root.removeAttribute('data-nav');
      try { localStorage.setItem('cs-docs-nav', collapsed ? 'collapsed' : 'open'); } catch (e) {}
      sync();
    } else sidebar.classList.contains('open') ? close() : open();
  });
  $('.close-btn').addEventListener('click', function () { if (desktop()) { root.setAttribute('data-nav', 'collapsed'); sync(); } else close(); });
  window.matchMedia('(min-width: 961px)').addEventListener('change', close);
  sync();
  var cur = sidebar.querySelector('a[aria-current]'); if (cur && desktop()) cur.scrollIntoView({ block: 'center' });
})();
`;
emit('src/section.css', '', 'section', '.css', Buffer.from(sectionCss));
emit('src/section.js', '', 'section', '.js', Buffer.from(sectionJs));
// The home page keeps its stylesheet inline (fastest first paint); the section pages share one cached copy of it
emit('src/site.css', '', 'site', '.css', Buffer.from(/<style>([\s\S]*?)<\/style>/.exec(index)[1]));

const headEnd = index.indexOf('</head>');
const homeHead = index.slice(0, headEnd);
const bodyStart = index.indexOf('<body>');
const topbar = /<header class="topbar">[\s\S]*?<\/header>/
  .exec(index)[0]
  .replace('href="#top"', 'href="/"')
  .replace('title="Back to the top"', 'title="createStore documentation, all on one page"')
  .replace(
    /<button class="search-btn"[\s\S]*?<\/button>/,
    '<a class="search-btn" href="/" aria-label="Open the full guide, which has search" title="The full guide has search"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg><span class="label">Full guide, with search</span></a>',
  );
const prismTags = [...index.slice(bodyStart).matchAll(/<script src="\/assets\/prism\/[^"]+"[^>]*><\/script>/g)]
  .map((m) => m[0])
  .join('\n');
const navTemplate = doc.querySelector('nav.sidebar');
const sectionPages = [];

sections.forEach((x, i) => {
  const prev = sections[i - 1];
  const next = sections[i + 1];
  const url = `${SITE}/${x.id}/`;
  const title = `${x.title}: createStore for React`;
  const description = `${x.about} Part of the createStore documentation: global state for React with the useState API.`;

  // the section, with its links pointing at section pages
  const sec = doc.getElementById(x.id).cloneNode(true);
  for (const a of sec.querySelectorAll('a[href^="#"]')) {
    const target = a.getAttribute('href').slice(1);
    const where = owner.get(target);
    if (!where) continue;
    if (where === x.id && target !== x.id) continue; // a heading in this same section: stays an anchor
    a.setAttribute('href', where === target ? `/${where}/` : `/${where}/#${target}`);
  }
  const h2 = sec.querySelector('h2');
  const h1 = doc.createElement('h1');
  h1.innerHTML = h2.innerHTML;
  h2.replaceWith(h1);
  sec.querySelector('h1 a.anchor')?.setAttribute('href', '#' + x.id);

  // the navigation, with this page marked
  const nav = navTemplate.cloneNode(true);
  for (const a of nav.querySelectorAll('a[data-nav]')) {
    a.setAttribute('href', `/${a.getAttribute('data-nav')}/`);
    if (a.getAttribute('data-nav') === x.id) a.setAttribute('aria-current', 'page');
  }

  const crumbs = [
    { name: 'createStore', url: `${SITE}/` },
    { name: group(x.id), url: `${SITE}/#${x.id}` },
    { name: x.title, url },
  ];
  const ld = {
    '@context': 'https://schema.org',
    '@graph': [
      ...graph['@graph'].filter((n) => ['WebSite', 'Person', 'SoftwareSourceCode'].includes(n['@type'])),
      {
        '@type': 'TechArticle',
        '@id': `${url}#article`,
        headline: x.title,
        description,
        url,
        inLanguage: 'en',
        author: { '@id': `${SITE}/#author` },
        isPartOf: { '@id': `${SITE}/#website` },
        about: { '@id': `${SITE}/#software` },
        mainEntityOfPage: url,
        ...(lastModified && { dateModified: lastModified }),
      },
      {
        '@type': 'BreadcrumbList',
        itemListElement: crumbs.map((c, n) => ({ '@type': 'ListItem', position: n + 1, name: c.name, item: c.url })),
      },
      ...(x.id === 'faq' ? graph['@graph'].filter((n) => n['@type'] === 'FAQPage') : []),
    ],
  };

  let head = homeHead
    .replace(/<title>[\s\S]*?<\/title>/, () => `<title>${esc(title)}</title>`)
    .replace(/(<meta name="description" content=")[^"]*"/, (_m, a) => `${a}${esc(description)}"`)
    .replace(/(<meta property="og:description" content=")[^"]*"/, (_m, a) => `${a}${esc(description)}"`)
    .replace(/(<meta name="twitter:description" content=")[^"]*"/, (_m, a) => `${a}${esc(description)}"`)
    .replace(/(<meta property="og:title" content=")[^"]*"/, (_m, a) => `${a}${esc(title)}"`)
    .replace(/(<meta name="twitter:title" content=")[^"]*"/, (_m, a) => `${a}${esc(title)}"`)
    .replace(/(<link rel="canonical" href=")[^"]*"/, (_m, a) => `${a}${url}"`)
    .replace(/(<meta property="og:url" content=")[^"]*"/, (_m, a) => `${a}${url}"`)
    .replace(
      /(<script type="application\/ld\+json">)[\s\S]*?(<\/script>)/,
      (_m, a, b) => `${a}${JSON.stringify(ld).replaceAll('<', '\\u003c')}${b}`,
    );
  head = head.replace(/<style>[\s\S]*?<\/style>\n?/, '');
  head += `<link rel="stylesheet" href="${published.get('src/site.css')}">\n<link rel="stylesheet" href="${published.get('src/section.css')}">\n`;

  const pager = [
    prev ? `<a class="prev" href="/${prev.id}/" rel="prev"><small>Previous</small>${esc(prev.title)}</a>` : '',
    next ? `<a class="next" href="/${next.id}/" rel="next"><small>Next</small>${esc(next.title)}</a>` : '',
  ].join('');
  const html = `${head}</head>
<body>
<a class="skip-link" href="#main-content">Skip to the documentation</a>
${topbar}

<div class="shell" id="top">
  ${nav.outerHTML}

  <main id="main-content" tabindex="-1">
    <div class="content">
      <nav class="crumbs" aria-label="Breadcrumb"><a href="/">createStore</a><span aria-hidden="true">/</span>${esc(group(x.id))}<span aria-hidden="true">/</span>${esc(x.title)}</nav>
      ${sec.outerHTML}
      <div class="pager">${pager}</div>
      <footer class="page-foot">
        <span>createStore documentation</span>
        <a href="/#${x.id}">Read it on the one-page guide</a>
        <a href="${REPO_URL}">GitHub</a>
        <a href="${NPM_URL}">npm</a>
      </footer>
    </div>
  </main>
</div>

${prismTags}
<script src="${published.get('src/section.js')}"></script>
</body>
</html>
`;
  mkdirSync(join(out, x.id), { recursive: true });
  writeFileSync(join(out, x.id, 'index.html'), html);
  sectionPages.push(x.id);
});

// security.txt (RFC 9116): where to report a vulnerability. It expires a year after the docs were last changed.
const expires = new Date(`${lastModified || new Date().toISOString().slice(0, 10)}T00:00:00Z`);
expires.setUTCFullYear(expires.getUTCFullYear() + 1);
mkdirSync(join(out, '.well-known'), { recursive: true });
writeFileSync(
  join(out, '.well-known', 'security.txt'),
  `Contact: ${REPO_URL}/security/advisories/new\nExpires: ${expires.toISOString()}\nPreferred-Languages: en\nCanonical: ${SITE}/.well-known/security.txt\nPolicy: ${REPO_URL}/blob/main/SECURITY.md\n`,
);

writeFileSync(join(out, 'index.html'), index);
writeFileSync(join(out, '404.html'), page('src/404.html'));
cpSync(join(here, 'src/favicon.svg'), join(out, 'favicon.svg'));

// ---- 3. robots, sitemap, redirects ----
const preview = env === 'preview';
// Crawler policy (names checked against the vendors' own documentation, 2026-11-14). Everything is allowed: the docs are
// MIT-licensed and meant to be found, cited and learned by assistants. Naming a crawler that "*" already allows changes
// nothing today; it is here so each group can be switched to "Disallow: /" on its own. Notes:
//   search     OAI-SearchBot, Claude-SearchBot, PerplexityBot: index pages so answers can cite and link them
//   on request ChatGPT-User, Claude-User, Perplexity-User: fetch a page when a person asks about it. Vendors say robots.txt may not apply
//   training   GPTBot, ClaudeBot: collect content for model training. Google-Extended is a robots.txt token only: it controls
//              Gemini training and grounding, and has no effect on Google Search or its ranking
const robotsGroup = (comment, agents) =>
  `# ${comment}\n${agents.map((a) => `User-agent: ${a}`).join('\n')}\nAllow: /\n`;
writeFileSync(
  join(out, 'robots.txt'),
  preview
    ? 'User-agent: *\nDisallow: /\n'
    : [
        '# Search engines, and every crawler not named below',
        'User-agent: *',
        'Allow: /',
        '',
        robotsGroup('AI search and answer engines: they cite and link to this site', [
          'OAI-SearchBot',
          'Claude-SearchBot',
          'PerplexityBot',
        ]),
        robotsGroup('Fetches made when a person asks an assistant about this site', [
          'ChatGPT-User',
          'Claude-User',
          'Perplexity-User',
        ]),
        robotsGroup(
          'Model training: allowed (MIT-licensed docs). To opt out of training only, turn this group into a disallow rule',
          ['GPTBot', 'ClaudeBot', 'Google-Extended'],
        ),
        `# For language models and agents: ${SITE}/llms.txt and ${SITE}/llms-full.txt`,
        `Sitemap: ${SITE}/sitemap.xml`,
        '',
      ].join('\n'),
);
if (!preview) {
  const urls = ['', ...sectionPages.map((id) => `${id}/`)];
  writeFileSync(
    join(out, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map((u) => `  <url><loc>${SITE}/${u}</loc>${lastModified ? `<lastmod>${lastModified}</lastmod>` : ''}</url>`)
      .join('\n')}\n</urlset>\n`,
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
  `  Link: <${SITE}/>; rel="canonical"`,
  '',
  '/.well-known/security.txt',
  '  Content-Type: text/plain; charset=utf-8',
  '  Cache-Control: public, max-age=86400',
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
