// Builds the documentation site into site/dist, ready for Cloudflare Pages.
//
//   SITE_URL=https://example.pages.dev node site/build.mjs
//   DOCS_ENV=preview ...   preview deployments: told to search engines as noindex
//
// What it does: fingerprints every asset (so it can be cached forever), injects the site URL, writes robots.txt,
// sitemap.xml, 404.html, favicon.svg, _redirects, and _headers with a Content-Security-Policy computed from the
// page's own inline code. Same input gives byte-identical output (no timestamps).
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
const index = page('src/index.html');
writeFileSync(join(out, 'index.html'), index);
writeFileSync(join(out, '404.html'), page('src/404.html'));
cpSync(join(here, 'src/favicon.svg'), join(out, 'favicon.svg'));

// ---- 3. robots, sitemap, redirects ----
const preview = env === 'preview';
writeFileSync(
  join(out, 'robots.txt'),
  preview ? 'User-agent: *\nDisallow: /\n' : `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`,
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
  ...(preview ? ['  X-Robots-Tag: noindex, nofollow'] : []),
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
