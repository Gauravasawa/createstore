// The library's own behaviour checks (ported from the original test app), run against the BUILT package.
import { describe, it } from 'vitest';
import { baseTests } from './selftests/selftest';
import { extraTests } from './selftests/selftest-extra';
import { gapTests } from './selftests/selftest-gaps';

describe.each([
  ['base', baseTests],
  ['extra', extraTests],
  ['gaps', gapTests],
] as const)('self-tests: %s', (_g, tests) => {
  for (const [name, run] of tests)
    it(name, async () => {
      await run();
    });
});
