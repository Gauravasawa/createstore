// Seeded, model-based tests: random sequences of operations checked against a small independent model.
// Deterministic (fixed seeds), so a failure always reproduces.
import { describe, expect, it, vi } from 'vitest';
import { createStore, serializeSnapshot } from '@createstore/createstore';

const rng = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const uid = () => Math.random().toString(36).slice(2, 8);

describe('optimistic updates', () => {
  it('any interleaving of local edits, successful saves and failing saves ends at initial + local + successful saves', async () => {
    const R = rng(12345);
    for (let trial = 0; trial < 150; trial++) {
      const s = createStore({ n: 0 }, { name: `opt-${trial}-${uid()}` });
      const ops = Array.from({ length: 4 + Math.floor(R() * 6) }, () => ({
        kind: (['local', 'ok', 'fail'] as const)[Math.floor(R() * 3)],
        k: 1 + Math.floor(R() * 9),
        start: Math.floor(R() * 6),
        ms: Math.floor(R() * 6),
      }));
      const expected = ops.filter((o) => o.kind !== 'fail').reduce((sum, o) => sum + o.k, 0);
      await Promise.all(
        ops.map(
          (op) =>
            new Promise<void>((done) =>
              setTimeout(() => {
                if (op.kind === 'local') {
                  s.setState('n', (c: number) => c + op.k);
                  done();
                } else {
                  const server = () =>
                    new Promise<void>((ok, no) =>
                      setTimeout(() => (op.kind === 'ok' ? ok() : no(new Error('x'))), op.ms),
                    );
                  s.setState('n', (c: number) => c + op.k, server).then(
                    () => done(),
                    () => done(),
                  );
                }
              }, op.start),
            ),
        ),
      );
      expect(s.getState('n'), `trial ${trial}: ${JSON.stringify(ops)}`).toBe(expected);
    }
  });
});

describe('undo and redo', () => {
  it('300 random set/undo/redo sequences match a stack model (limit 5)', () => {
    const R = rng(777);
    for (let trial = 0; trial < 300; trial++) {
      const LIMIT = 5;
      const s = createStore({ n: 0 }, { name: `hist-${trial}-${uid()}`, history: { limit: LIMIT } });
      let current = 0;
      let past: number[] = [];
      const future: number[] = [];
      for (let i = 0; i < 40; i++) {
        const r = R();
        let op: string;
        if (r < 0.6) {
          const v = Math.floor(R() * 4);
          op = `set ${v}`;
          s.setState('n', v);
          if (v !== current) {
            past = [...past, current].slice(-LIMIT);
            future.length = 0;
            current = v;
          }
        } else if (r < 0.8) {
          op = 'undo';
          s.undo();
          if (past.length) {
            future.push(current);
            current = past.pop()!;
          }
        } else {
          op = 'redo';
          s.redo();
          if (future.length) {
            past = [...past, current].slice(-LIMIT);
            current = future.pop()!;
          }
        }
        const h = s.getHistory();
        const where = `trial ${trial}, step ${i} (${op})`;
        expect(s.getState('n'), where).toBe(current);
        expect(h.canUndo, where).toBe(past.length > 0);
        expect(h.canRedo, where).toBe(future.length > 0);
      }
    }
  });
});

describe('computed values', () => {
  it('stay equal to their inputs after every operation and inside listeners (300 random runs)', () => {
    const R = rng(1000);
    for (let trial = 0; trial < 300; trial++) {
      const s = createStore(
        { a: 0, b: 0 },
        {
          name: `comp-${trial}-${uid()}`,
          history: true,
          computed: [{ sum: (get) => get('a') + get('b') }, { double: (get) => get('sum') * 2 }],
        },
      );
      const consistent = () =>
        s.getState('sum') === s.getState('a') + s.getState('b') && s.getState('double') === 2 * s.getState('sum');
      let insideListener = true;
      s.subscribe(() => {
        if (!consistent()) insideListener = false;
      });
      for (let i = 0; i < 30; i++) {
        const r = R();
        const key = R() < 0.5 ? 'a' : 'b';
        const v = Math.floor(R() * 5);
        if (r < 0.45) s.setState(key, v);
        else if (r < 0.6) s.setState(key, (c: number) => c + v);
        else if (r < 0.75)
          s.batch(() => {
            s.setState('a', v);
            s.setState('b', v + 1);
          });
        else if (r < 0.9) s.undo();
        else s.redo();
        expect(consistent(), `trial ${trial}, op ${i}`).toBe(true);
      }
      expect(insideListener, `trial ${trial}: a listener saw an inconsistent computed value`).toBe(true);
    }
  });
});

describe('serializeSnapshot', () => {
  it('2,000 random strings full of HTML and script-breaking characters never appear raw, and always round-trip', () => {
    const R = rng(99);
    const alphabet = [
      '<',
      '>',
      '&',
      '/',
      '!',
      '-',
      '"',
      "'",
      '\\',
      's',
      'c',
      'r',
      'i',
      'p',
      't',
      ' ',
      '\u2028',
      '\u2029',
      'é',
      '\u0000',
      '𝄞',
    ];
    const fixed = ['</script><script>alert(1)</script>', '<!--', '-->', '<script', '</SCRIPT >', ']]>', '\u2028\u2029'];
    const strings = [
      ...fixed,
      ...Array.from({ length: 2000 }, () =>
        Array.from({ length: 1 + Math.floor(R() * 24) }, () => alphabet[Math.floor(R() * alphabet.length)]).join(''),
      ),
    ];
    for (const s of strings) {
      const out = serializeSnapshot({ value: s, [s]: s });
      expect(/[<>&\u2028\u2029]/.test(out), `raw dangerous character for ${JSON.stringify(s)}`).toBe(false);
      expect(JSON.parse(out)).toEqual({ value: s, [s]: s });
    }
    vi.restoreAllMocks();
  });
});
