import { describe, expect, it } from 'vitest';
import { classifyStepFailure, MISSING_TARGET_REASON } from '../../../src/adapters/playwright/step-classification.js';

const BASE = 'https://shop.example.com';

describe('classifyStepFailure', () => {
  it('FAILED: an assertion fails while its target resolves', () => {
    const result = classifyStepFailure(
      { stepIndex: 2, action: 'expectText', kind: 'assertion', message: 'text mismatch', targetCount: 1, expected: 'containing "Sale"', actual: '"Regular"' },
      [],
      BASE,
    );
    expect(result).toEqual({
      status: 'FAILED',
      reason: 'step 3 (expectText) failed: expected containing "Sale", actual "Regular"',
      evidence: { expected: 'containing "Sale"', actual: '"Regular"' },
    });
  });

  it('FAILED: a non-target assertion (url, title) fails', () => {
    const result = classifyStepFailure({ stepIndex: 0, action: 'expectTitle', kind: 'assertion', message: 'x', expected: 'equal to "Sale"', actual: '"Home"' }, [], BASE);
    expect(result.status).toBe('FAILED');
  });

  it('INCONCLUSIVE: an assertion target matches no element', () => {
    const result = classifyStepFailure({ stepIndex: 1, action: 'expectVisible', kind: 'assertion', message: 'not found', targetCount: 0, expected: 'visible', actual: 'not found' }, [], BASE);
    expect(result.status).toBe('INCONCLUSIVE');
    expect(result.reason).toBe(`step 2 (expectVisible): ${MISSING_TARGET_REASON}`);
    expect(MISSING_TARGET_REASON).toBe('expected element not found: the feature may be missing or the UI changed — needs human review');
  });

  it('INCONCLUSIVE: an assertion target is ambiguous', () => {
    const result = classifyStepFailure({ stepIndex: 0, action: 'expectVisible', kind: 'assertion', message: 'target matches 3 elements', targetCount: 3, ambiguous: true }, [], BASE);
    expect(result).toMatchObject({ status: 'INCONCLUSIVE', reason: 'step 1 (expectVisible): target matches 3 elements' });
  });

  it('INCONCLUSIVE: an assertion could not be evaluated', () => {
    const result = classifyStepFailure({ stepIndex: 0, action: 'expectValue', kind: 'error', message: 'Target page, context or browser has been closed' }, [], BASE);
    expect(result).toEqual({ status: 'INCONCLUSIVE', reason: 'could not complete step 1 (expectValue): Target page, context or browser has been closed' });
  });

  it.each([
    ['action', 'click', 'could not complete step 4 (click): Timeout 10000ms exceeded'],
    ['navigation', 'goto', 'navigation failed at step 4 (goto): Timeout 10000ms exceeded'],
    ['budget', 'fill', 'test exceeded its time budget at step 4 (fill): Timeout 10000ms exceeded'],
  ] as const)('INCONCLUSIVE: a %s failure', (kind, action, reason) => {
    expect(classifyStepFailure({ stepIndex: 3, action, kind, message: 'Timeout 10000ms exceeded' }, [], BASE)).toEqual({ status: 'INCONCLUSIVE', reason });
  });

  it('INCONCLUSIVE: an assertion fails after the guard blocked a request to the target host', () => {
    const result = classifyStepFailure(
      { stepIndex: 2, action: 'expectVisible', kind: 'assertion', message: 'x', targetCount: 1, expected: 'visible', actual: 'hidden' },
      [{ method: 'POST', url: 'https://shop.example.com/api/cart' }],
      BASE,
    );
    expect(result.status).toBe('INCONCLUSIVE');
    expect(result.reason).toBe(
      'step 3 (expectVisible) failed after the read-only guard blocked a request to the target: expected visible, actual hidden; blocked requests: POST https://shop.example.com/api/cart',
    );
    expect(result.evidence).toEqual({ expected: 'visible', actual: 'hidden' });
  });

  it('records third-party blocked requests without changing a FAILED result', () => {
    const blocked = [
      { method: 'POST', url: 'https://analytics.example.net/collect' },
      { method: 'WEBSOCKET', url: 'wss://chat.example.net/' },
      { method: 'POST', url: 'https://a.example.net/1' },
      { method: 'POST', url: 'https://a.example.net/2' },
    ];
    const result = classifyStepFailure({ stepIndex: 0, action: 'expectTitle', kind: 'assertion', message: 'x', expected: 'e', actual: 'a' }, blocked, BASE);
    expect(result.status).toBe('FAILED');
    expect(result.reason).toBe(
      'step 1 (expectTitle) failed: expected e, actual a; blocked requests: POST https://analytics.example.net/collect, WEBSOCKET wss://chat.example.net/, POST https://a.example.net/1 and 1 more',
    );
  });

  it('adds blocked requests to an INCONCLUSIVE action failure', () => {
    const result = classifyStepFailure({ stepIndex: 0, action: 'click', kind: 'action', message: 'Timeout' }, [{ method: 'POST', url: 'https://shop.example.com/x' }], BASE);
    expect(result.reason).toBe('could not complete step 1 (click): Timeout; blocked requests: POST https://shop.example.com/x');
  });
});
