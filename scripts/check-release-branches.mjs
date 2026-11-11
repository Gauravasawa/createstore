// Dry-runs semantic-release against a throwaway repo to prove the branch/channel rules in release.config.mjs.
// Needs Node 22.14+ or 24.10+ (semantic-release's own requirement). Publishing plugins are left out on purpose.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { branches, analyzerAndNotes } = await import(pathToFileURL(resolve('release.config.mjs')).href);
const bin = require.resolve('semantic-release/bin/semantic-release.js');
const plugins = analyzerAndNotes.map(([name, opts]) => [require.resolve(name), opts]);

const root = mkdtempSync(join(tmpdir(), 'cs-release-'));
const origin = join(root, 'origin.git');
const work = join(root, 'work');
const URL = 'https://github.com/test/repo.git';
// Inside GitHub Actions, semantic-release would read the branch from GITHUB_REF* instead of this throwaway repo
const env = {
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GITHUB_|CI$)/.test(k))),
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t.t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t.t',
};
const git = (...a) => execFileSync('git', a, { cwd: work, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
execFileSync('git', ['init', '-q', '-b', 'main', work]);
git('config', 'core.autocrlf', 'false');
git('config', `url.${origin}.insteadOf`, URL); // the notes generator needs a GitHub-shaped URL
git('remote', 'add', 'origin', URL);
writeFileSync(join(work, '.releaserc.json'), JSON.stringify({ branches, plugins }));
writeFileSync(join(work, 'package.json'), '{"name":"x","version":"0.0.0"}');

let n = 0;
const commit = (msg) => {
  writeFileSync(join(work, 'f.txt'), String(++n));
  git('add', '-A');
  git('commit', '-q', '-m', msg);
};
const push = (b) => git('push', '-q', 'origin', b);
// A real release also records the channel it went to in a git note; without it a tag counts as unreleased there
const tag = (t, channel = null) => {
  git('tag', t);
  git('notes', '--ref', 'semantic-release-' + t, 'add', '-f', '-m', JSON.stringify({ channels: [channel] }), t);
  git('push', '-q', 'origin', t, 'refs/notes/semantic-release-' + t);
};

let failed = 0;
// What a dry run on `branch` would release: "version@channel", or "none"
const next = (branch) => {
  push(branch);
  let out;
  try {
    out = execFileSync(process.execPath, [bin, '--dry-run', '--no-ci', '--repository-url', URL], {
      cwd: work,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    out = `${e.stdout}${e.stderr}`;
  }
  const v = /next release version is (\S+)/.exec(out)?.[1];
  const ch = /Published release \S+ on (.+?) channel/.exec(out)?.[1];
  return v ? `${v}@${ch}` : out.includes('no relevant changes') ? 'none' : `ERROR ${out.slice(-300)}`;
};
const expect = (label, branch, want) => {
  const got = next(branch);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(44)} ${got}${ok ? '' : `   (wanted ${want})`}`);
};

commit('chore: init');
expect('main: chore only', 'main', 'none');
commit('fix: first');
expect('main: first release', 'main', '1.0.0@default');
tag('v1.0.0');
commit('feat: b');
expect('main: feat -> minor', 'main', '1.1.0@default');
tag('v1.1.0');

git('checkout', '-q', '-b', 'beta');
commit('feat: c');
expect('beta: first prerelease', 'beta', '1.2.0-beta.1@beta');
tag('v1.2.0-beta.1', 'beta');
commit('fix: d');
expect('beta: next prerelease increments', 'beta', '1.2.0-beta.2@beta');

git('checkout', '-q', 'main');
git('checkout', '-q', '-b', 'next');
commit('feat: e');
expect('next: release candidate on dist-tag next', 'next', '1.2.0-rc.1@next');

git('checkout', '-q', 'main');
git('checkout', '-q', '-b', 'alpha');
commit('feat!: f\n\nBREAKING CHANGE: changed');
expect('alpha: breaking change -> major alpha', 'alpha', '2.0.0-alpha.1@alpha');

git('checkout', '-q', 'main');
git('merge', '-q', '--no-ff', '-m', 'Merge beta', 'beta');
expect('main: merging beta promotes to stable', 'main', '1.2.0@default');
tag('v1.2.0');

rmSync(root, { recursive: true, force: true });
if (failed) {
  console.error(`${failed} scenario(s) failed`);
  process.exit(1);
}
console.log('release branch rules OK');
