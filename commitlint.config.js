export default {
  extends: ['@commitlint/config-conventional'],
  // Dependabot writes "Bump x" (capital B); its titles are generated, not ours to fix
  ignores: [(msg) => msg.includes('Signed-off-by: dependabot[bot]')],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'docs', 'perf', 'refactor', 'test', 'build', 'ci', 'chore', 'style', 'revert'],
    ],
    // Bot commits (Dependabot) and pasted stack traces / URLs routinely exceed the default 100 columns
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
};
