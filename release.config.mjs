// semantic-release configuration. Channels:
//   main            -> stable        (npm dist-tag: latest)
//   next            -> 1.2.0-rc.N    (dist-tag: next)
//   beta            -> 1.2.0-beta.N  (dist-tag: beta)
//   alpha           -> 1.2.0-alpha.N (dist-tag: alpha)
//   1.x, 1.2.x      -> maintenance releases of older lines (dist-tag: release-1.x)
import { execSync } from 'node:child_process';

const current = () => {
  try {
    return execSync('git branch --show-current', { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};
const branch = process.env.GITHUB_REF_NAME ?? current();
// Prerelease branches only publish. Committing CHANGELOG.md / package.json back to them would make
// every later merge into main conflict; their notes live in the GitHub release instead.
const commitsBack = !['alpha', 'beta', 'next'].includes(branch);

export const branches = [
  '+([0-9])?(.{+([0-9]),x}).x',
  'main',
  { name: 'next', prerelease: 'rc', channel: 'next' },
  { name: 'beta', prerelease: true },
  { name: 'alpha', prerelease: true },
];

const noteTypes = [
  { type: 'feat', section: 'Features' },
  { type: 'fix', section: 'Bug Fixes' },
  { type: 'perf', section: 'Performance' },
  { type: 'revert', section: 'Reverts' },
  { type: 'docs', section: 'Documentation' },
  { type: 'refactor', section: 'Refactoring' },
  { type: 'build', section: 'Build System' },
  { type: 'test', section: 'Tests', hidden: true },
  { type: 'ci', section: 'CI', hidden: true },
  { type: 'chore', section: 'Chores', hidden: true },
  { type: 'style', section: 'Style', hidden: true },
];

export const analyzerAndNotes = [
  [
    '@semantic-release/commit-analyzer',
    {
      preset: 'conventionalcommits',
      releaseRules: [
        { type: 'docs', scope: 'README', release: 'patch' }, // the README ships on npm
        { type: 'perf', release: 'patch' },
        { type: 'revert', release: 'patch' },
        { scope: 'no-release', release: false },
      ],
    },
  ],
  ['@semantic-release/release-notes-generator', { preset: 'conventionalcommits', presetConfig: { types: noteTypes } }],
];

export const plugins = [
  ...analyzerAndNotes,
  ...(commitsBack
    ? [['@semantic-release/changelog', { changelogFile: 'CHANGELOG.md', changelogTitle: '# Changelog' }]]
    : []),
  // Publishes with npm trusted publishing (OIDC): no token. Provenance is attached automatically.
  '@semantic-release/npm',
  ...(commitsBack
    ? [
        [
          '@semantic-release/git',
          {
            assets: ['CHANGELOG.md', 'package.json', 'package-lock.json'],
            message: 'chore(release): ${nextRelease.version} [skip ci]\n\n${nextRelease.notes}',
          },
        ],
      ]
    : []),
  // No issue/PR comments or labels: the workflow only gets contents: write
  ['@semantic-release/github', { successComment: false, failComment: false, failTitle: false, releasedLabels: false }],
];

export default { branches, plugins };
