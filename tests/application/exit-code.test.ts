import { describe, expect, it } from 'vitest';
import { exitCodeForPolicy } from '../../src/application/exit-code.js';

describe('exitCodeForPolicy', () => {
  it.each([
    ['not-resolved', 'RESOLVED', false, 0],
    ['not-resolved', 'NOT_RESOLVED', false, 1],
    ['not-resolved', 'INCONCLUSIVE', false, 0],
    ['not-resolved', 'INCONCLUSIVE', true, 2],
    ['inconclusive', 'RESOLVED', false, 0],
    ['inconclusive', 'NOT_RESOLVED', false, 1],
    ['inconclusive', 'INCONCLUSIVE', false, 2],
    ['inconclusive', 'INCONCLUSIVE', true, 2],
    ['never', 'NOT_RESOLVED', false, 0],
    ['never', 'INCONCLUSIVE', true, 0],
  ] as const)('--fail-on %s with %s (config error: %s) exits %i', (failOn, verdict, configError, code) => {
    expect(exitCodeForPolicy(verdict, failOn, configError)).toBe(code);
  });
});
