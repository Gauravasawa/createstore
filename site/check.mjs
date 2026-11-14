// Static checks on site/dist (run `node site/build.mjs` first). Exits 1 on any failure.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = join(dirname(fileURLToPath(import.meta.url)), 'dist');
const read = (p) => readFileSync(join(dist, p), 'utf8');
const walk = (d) =>
  readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const rel = (p) => p.slice(dist.length + 1).replaceAll('\\', '/');

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

const files = walk(dist).map(rel);
const need = ['index.html', '404.html', 'robots.txt', '_headers', '_redirects', 'favicon.svg'];
check(
  'required files exist',
  need.every((f) => files.includes(f)),
  need.filter((f) => !files.includes(f)).join(', '),
);

const index = read('index.html');
const headers = read('_headers');
const site = /<link rel="canonical" href="([^"]+)\/">/.exec(index)?.[1];
check('canonical URL is set and absolute', Boolean(site && /^https?:\/\//.test(site)), String(site));
check('no unreplaced placeholders', !files.some((f) => /\.(html|txt|xml)$/.test(f) && read(f).includes('%%')));

// ---- nothing is loaded from, or sent to, a third party ----
const allowed = [
  site,
  'https://schema.org',
  'https://opensource.org/license/mit',
  'https://github.com/Gauravasawa', // the author, and the repository below it
  'https://www.npmjs.com/package/@createstore/createstore',
  'http://www.w3.org/2000/svg',
  'http://www.sitemaps.org/schemas/sitemap/0.9',
];
const external = [];
for (const f of files.filter((f) => /\.(html|css|js|svg|xml)$/.test(f) && !f.startsWith('assets/prism/'))) {
  for (const [u] of read(f).matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) {
    if (!allowed.some((a) => u.startsWith(a))) external.push(`${f}: ${u}`);
  }
}
check('no third-party URLs in pages, styles or scripts', external.length === 0, external.slice(0, 5).join('\n      '));

// ---- every local reference resolves ----
const refs = [
  ...new Set(
    [
      ...index.matchAll(/(?:src|href)="(\/[^"#]*)"/g),
      ...read(
        'assets/fonts/' +
          files
            .find((f) => /^assets\/fonts\/fonts\..*\.css$/.test(f))
            .split('/')
            .pop(),
      ).matchAll(/url\("([^"]+)"\)/g),
    ].map((m) => m[1]),
  ),
];
const broken = refs.filter((r) => r !== '/' && !existsSync(join(dist, r.startsWith('/') ? r : `assets/fonts/${r}`)));
check(`all ${refs.length} local references exist`, broken.length === 0, broken.join(', '));

// ---- the Content-Security-Policy ----
const csp = /Content-Security-Policy: (.+)/.exec(headers)?.[1] ?? '';
check('CSP is present', csp.length > 0);
check(
  "CSP has no 'unsafe-inline', 'unsafe-eval' or wildcard sources",
  !/unsafe-inline|unsafe-eval|\s\*[\s;]|https?:/.test(csp),
  csp,
);
const b64 = (s) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`;
const inlineBlocks = (tag, skip) =>
  [...index.matchAll(new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))]
    .filter((m) => !skip(m[1] ?? ''))
    .map((m) => b64(m[2]));
const unhashed = [
  ...inlineBlocks('script', (a) => /\ssrc=|ld\+json/.test(a)),
  ...inlineBlocks('style', () => false),
].filter((h) => !csp.includes(h));
check('every inline script and style is allowed by an exact hash', unhashed.length === 0, unhashed.join(' '));
// Real tags only: this is a documentation page, so code samples legitimately contain text like `onClick=`
const markup = index.replace(/<(pre|code|script|style)[\s\S]*?<\/\1>/g, '');
check(
  'no inline event handlers, javascript: URLs or style attributes',
  !/<[a-z][^>]*(\son[a-z]+\s*=|\sstyle\s*=|href\s*=\s*["']?\s*javascript:)/i.test(markup),
);

// ---- Cloudflare _headers rules ----
const blocks = headers.split(/\n\s*\n/).filter((b) => b.trim());
check(
  `_headers within Cloudflare limits (${blocks.length} rules of 100, lines <= 2000 chars)`,
  blocks.length <= 100 && headers.split('\n').every((l) => l.length <= 2000),
);
for (const h of [
  'Strict-Transport-Security',
  'X-Content-Type-Options',
  'Referrer-Policy',
  'Permissions-Policy',
  'X-Frame-Options',
])
  check(`header ${h} is set`, headers.includes(`${h}:`));
check(
  'assets are cached immutably',
  /\/assets\/\*\n\s+Cache-Control: public, max-age=31536000, immutable/.test(headers),
);
check(
  'every asset name carries a content hash',
  files
    .filter((f) => f.startsWith('assets/') && !f.startsWith('assets/licenses/'))
    .every((f) => /\.[0-9a-f]{10}\.[a-z0-9]+$/.test(f)),
);

// ---- search engines ----
const robots = read('robots.txt');
const preview = /Disallow: \//.test(robots);
check(
  'robots.txt matches the environment',
  preview ? headers.includes('X-Robots-Tag: noindex') : robots.includes(`Sitemap: ${site}/sitemap.xml`),
);
if (!preview) check('sitemap lists the home page', read('sitemap.xml').includes(`<loc>${site}/</loc>`));
const ld = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(index)?.[1];
let graph = [];
try {
  graph = JSON.parse(ld)['@graph'] ?? [];
} catch {
  /* reported below */
}
const types = graph.map((n) => n['@type']);
check(
  'structured data (JSON-LD) parses, with WebSite, SoftwareSourceCode and FAQPage',
  ['WebSite', 'SoftwareSourceCode', 'FAQPage'].every((t) => types.includes(t)),
  types.join(', '),
);
const faqQuestions = (index.match(/<h3 id="faq-/g) ?? []).length;
const faqLd = graph.find((n) => n['@type'] === 'FAQPage')?.mainEntity ?? [];
check(
  `the FAQ in the structured data matches the page (${faqQuestions} questions, each answered)`,
  faqQuestions > 0 &&
    faqLd.length === faqQuestions &&
    faqLd.every((q) => q.name && q.acceptedAnswer?.text?.length > 10),
  `${faqLd.length} in the structured data`,
);

// ---- answer engines, language models and agents ----
const llms = read('llms.txt');
const llmsFull = read('llms-full.txt');
const sectionIds = [...index.matchAll(/<section class="doc-section" id="([^"]+)"/g)].map((m) => m[1]);
check(
  'llms.txt: a title, a one-line summary, and a link for every documentation section',
  /^# \S/.test(llms) && /^> \S/m.test(llms) && sectionIds.every((id) => llms.includes(`(${site}/#${id})`)),
  sectionIds.filter((id) => !llms.includes(`(${site}/#${id})`)).join(', '),
);
const prose = llmsFull.replace(/```[\s\S]*?```/g, ''); // code samples may contain markup on purpose
check(
  'llms-full.txt: the whole documentation as Markdown, a heading for every section, no leftover markup',
  llmsFull.length > 20_000 &&
    (llmsFull.match(/^## /gm) ?? []).length >= sectionIds.length &&
    !/<\/?(div|span|section|button|svg)[\s>]/.test(prose) &&
    !llms.includes('undefined'),
);
check(
  'llms.txt and the headers are announced to agents (a <link> in the page and a Link header)',
  index.includes('href="/llms.txt"') && index.includes('href="/llms-full.txt"') && /Link: <\/llms\.txt>/.test(headers),
);
check(
  'robots.txt names the AI crawlers and points to llms.txt',
  preview ||
    (['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended'].every((b) => robots.includes(`User-agent: ${b}`)) &&
      robots.includes('/llms.txt')),
);
check(
  'social image: og:image, twitter:image and a large card, with the file present',
  index.includes(`og:image" content="${site}/og-image.png"`) &&
    index.includes('twitter:card" content="summary_large_image"') &&
    existsSync(join(dist, 'og-image.png')),
);
// A wrong name in an install command would send readers to a different, unrelated package
check(
  'examples use the published name @createstore/createstore, never a bare createstore',
  !/from &#x27;createstore&#x27;|npm (i|install) createstore(?![\w/-])/.test(index),
);
check(
  'title, description, lang, one h1',
  /<title>[^<]+<\/title>/.test(index) &&
    /<meta name="description" content="[^"]{20,}"/.test(index) &&
    /<html lang="en"/.test(index) &&
    (index.match(/<h1[\s>]/g) ?? []).length === 1,
);
check(
  'Open Graph and Twitter tags are set',
  ['og:title', 'og:description', 'og:url', 'twitter:card'].every((t) => index.includes(t)),
);
check('404 page is noindex', /<meta name="robots" content="noindex"/.test(read('404.html')));

const size = files.reduce((n, f) => n + statSync(join(dist, f)).size, 0);
check(`total size within budget (${size} <= 1,500,000 bytes)`, size <= 1_500_000);

for (const r of results)
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok || !r.detail ? '' : `\n      ${r.detail}`}`);
const bad = results.filter((r) => !r.ok).length;
if (bad) {
  console.error(`\n${bad} site check(s) failed.`);
  process.exit(1);
}
console.log(`\nAll ${results.length} site checks passed.`);
