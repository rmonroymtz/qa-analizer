import { describe, expect, it } from 'vitest';
import type { EnvironmentPolicy } from '../../src/domain/environment.js';
import {
  ARIA_ROLES,
  MAX_STEPS_PER_TEST,
  MAX_STRING_LENGTH,
  MUTATING_SKIPPED_REASON,
  NO_POSITIVE_ASSERTION_REASON,
  PlanValidationError,
  validateTestPlan,
  type TestPlan,
} from '../../src/domain/test-plan.js';
import type { Ticket } from '../../src/domain/ticket.js';

const ticket: Ticket = {
  key: 'SHOP-42',
  summary: 'Sale badge',
  description: '',
  acceptanceCriteria: [
    { id: 'AC-1', text: 'Badge shown' },
    { id: 'AC-2', text: 'Order can be placed' },
  ],
  url: 'https://acme.atlassian.net/browse/SHOP-42',
};

const full: EnvironmentPolicy = { mode: 'full', allowedMutations: [] };
const readOnly: EnvironmentPolicy = { mode: 'read-only', allowedMutations: [] };

function plan(overrides: Partial<TestPlan> = {}): TestPlan {
  return {
    tests: [
      {
        criterionId: 'AC-1',
        title: '[AC-1] Badge shown',
        mutating: false,
        steps: [
          { action: 'goto', path: '/sale' },
          { action: 'expectVisible', target: { role: 'heading', name: 'Sale', exact: true } },
        ],
      },
    ],
    uncoverable: [{ criterionId: 'AC-2', reason: 'requires a mutating action' }],
    ...overrides,
  };
}

function withSteps(steps: unknown[]): unknown {
  return plan({ tests: [{ criterionId: 'AC-1', title: '[AC-1] x', mutating: false, steps: steps as never }] });
}

function violationsOf(raw: unknown, policy: EnvironmentPolicy = full): string[] {
  try {
    validateTestPlan(raw, ticket, policy);
  } catch (error) {
    if (error instanceof PlanValidationError) return error.violations;
    throw error;
  }
  return [];
}

describe('validateTestPlan', () => {
  it('accepts a plan that covers every criterion exactly once', () => {
    expect(validateTestPlan(plan(), ticket, full)).toEqual(plan());
  });

  it('accepts every step action with its fields', () => {
    const steps = [
      { action: 'goto', path: '/products?page=2#top' },
      { action: 'click', target: { role: 'button', name: 'Menu' } },
      { action: 'fill', target: { label: 'Search' }, value: 'shoes' },
      { action: 'selectOption', target: { label: 'Size' }, value: '42' },
      { action: 'check', target: { role: 'checkbox', name: 'On sale' } },
      { action: 'uncheck', target: { role: 'checkbox', name: 'On sale' } },
      { action: 'press', key: 'Enter' },
      { action: 'press', key: 'Control+A', target: { placeholder: 'Email' } },
      { action: 'hover', target: { text: 'Help', exact: false } },
      { action: 'waitFor', target: { testId: 'results' }, state: 'visible' },
      { action: 'expectVisible', target: { role: 'link', name: 'Shoes', nth: 0, within: { role: 'navigation' } } },
      { action: 'expectHidden', target: { text: 'Loading' } },
      { action: 'expectText', target: { role: 'status' }, text: '3 results', match: 'contains' },
      { action: 'expectValue', target: { label: 'Search' }, value: 'shoes' },
      { action: 'expectCount', target: { role: 'listitem', within: { role: 'list', name: 'Results', nth: 1 } }, count: 3 },
      { action: 'expectUrl', pathPattern: '/products' },
      { action: 'expectTitle', text: 'Products', match: 'equals' },
    ];
    expect(violationsOf(withSteps(steps))).toEqual([]);
  });

  it('rejects a non-object or wrongly shaped payload', () => {
    expect(() => validateTestPlan(null, ticket, full)).toThrow(PlanValidationError);
    expect(violationsOf({ tests: 'x', uncoverable: [] })).not.toEqual([]);
    expect(violationsOf({ ...plan(), uncoverable: [{ criterionId: 'AC-2' }] })).not.toEqual([]);
  });

  it('rejects a plan that omits a criterion, references an unknown one, or repeats one', () => {
    expect(violationsOf(plan({ uncoverable: [] })).join('\n')).toMatch(/does not account for criteria: AC-2/);
    expect(violationsOf(plan({ uncoverable: [...plan().uncoverable, { criterionId: 'AC-9', reason: 'x' }] })).join('\n')).toMatch(/unknown criteria: AC-9/);
    const twice = plan({ uncoverable: [{ criterionId: 'AC-1', reason: 'x' }, { criterionId: 'AC-2', reason: 'y' }] });
    expect(violationsOf(twice).join('\n')).toMatch(/duplicate criterion ids: AC-1/);
  });

  it('rejects two tests for the same criterion', () => {
    const [first] = plan().tests;
    const doubled = plan({ tests: [first!, { ...first!, title: '[AC-1] again' }] });
    expect(violationsOf(doubled).join('\n')).toMatch(/duplicate criterion ids: AC-1/);
  });

  it('prefixes a title that does not start with its criterion id', () => {
    const [first] = plan().tests;
    const result = validateTestPlan(plan({ tests: [{ ...first!, title: 'Badge shown' }] }), ticket, full);
    expect(result.tests[0]?.title).toBe('[AC-1] Badge shown');
  });

  it('requires at least one step and at least one assertion per test', () => {
    expect(violationsOf(withSteps([])).join('\n')).toMatch(/at least one step/);
    expect(violationsOf(withSteps([{ action: 'goto', path: '/' }])).join('\n')).toMatch(/at least one assertion/);
  });

  it(`rejects more than ${MAX_STEPS_PER_TEST} steps`, () => {
    const steps = Array.from({ length: MAX_STEPS_PER_TEST + 1 }, () => ({ action: 'expectTitle', text: 'x', match: 'contains' }));
    expect(violationsOf(withSteps(steps)).join('\n')).toMatch(/at most 30 steps/);
  });

  it(`rejects strings longer than ${MAX_STRING_LENGTH} characters`, () => {
    const long = 'x'.repeat(MAX_STRING_LENGTH + 1);
    expect(violationsOf(withSteps([{ action: 'expectTitle', text: long, match: 'contains' }])).join('\n')).toMatch(/at most 500/);
    expect(violationsOf(plan({ uncoverable: [{ criterionId: 'AC-2', reason: long }] })).join('\n')).toMatch(/at most 500/);
  });

  it.each([
    ['an unknown action', { action: 'evaluate', script: 'alert(1)' }],
    ['an unknown role', { action: 'click', target: { role: 'banana' } }],
    ['a CSS selector target', { action: 'click', target: { selector: '#buy' } }],
    ['two locator kinds at once', { action: 'click', target: { role: 'button', label: 'Buy' } }],
    ['an unexpected target field', { action: 'click', target: { testId: 'buy', xpath: '//a' } }],
    ['a negative nth', { action: 'click', target: { testId: 'buy', nth: -1 } }],
    ['a fractional nth', { action: 'click', target: { testId: 'buy', nth: 1.5 } }],
    ['a nested within', { action: 'click', target: { testId: 'a', within: { testId: 'b', within: { testId: 'c' } } } }],
    ['a missing target', { action: 'click' }],
    ['a missing fill value', { action: 'fill', target: { label: 'Search' } }],
    ['an invalid waitFor state', { action: 'waitFor', target: { testId: 'x' }, state: 'attached' }],
    ['an invalid text match', { action: 'expectText', target: { testId: 'x' }, text: 'a', match: 'regex' }],
    ['a negative count', { action: 'expectCount', target: { testId: 'x' }, count: -1 }],
    ['a strange key', { action: 'press', key: 'Enter; rm -rf /' }],
    ['an empty locator value', { action: 'click', target: { label: '' } }],
  ])('rejects %s', (_label, step) => {
    expect(violationsOf(withSteps([step, { action: 'expectTitle', text: 'x', match: 'contains' }]))).not.toEqual([]);
  });

  it.each([
    ['an absolute URL', 'https://evil.example.com/'],
    ['a protocol-relative URL', '//evil.example.com/'],
    ['a relative path without a leading slash', 'products'],
    ['a parent traversal', '/a/../../etc'],
    ['an encoded parent traversal', '/a/%2e%2e/b'],
    ['a backslash', '/\\evil.example.com'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['whitespace', '/a b'],
  ])('rejects a goto path with %s', (_label, path) => {
    expect(violationsOf(withSteps([{ action: 'goto', path }, { action: 'expectTitle', text: 'x', match: 'contains' }])).join('\n')).toMatch(/path/);
  });

  it('accepts every Playwright ARIA role', () => {
    const steps = ARIA_ROLES.map((role) => ({ action: 'expectHidden', target: { role } }));
    const chunks = Array.from({ length: Math.ceil(steps.length / MAX_STEPS_PER_TEST) }, (_, i) => steps.slice(i * MAX_STEPS_PER_TEST, (i + 1) * MAX_STEPS_PER_TEST));
    for (const chunk of chunks) expect(violationsOf(withSteps(chunk))).toEqual([]);
  });

  it('keeps a mutating test in full mode', () => {
    const [first] = plan().tests;
    const mutating = plan({ tests: [{ ...first!, mutating: true }] });
    expect(validateTestPlan(mutating, ticket, full).tests).toHaveLength(1);
  });

  it('moves a mutating test to uncoverable in read-only mode', () => {
    const [first] = plan().tests;
    const result = validateTestPlan(plan({ tests: [{ ...first!, mutating: true }] }), ticket, readOnly);
    expect(result.tests).toEqual([]);
    expect(result.uncoverable).toEqual([
      { criterionId: 'AC-2', reason: 'requires a mutating action' },
      { criterionId: 'AC-1', reason: MUTATING_SKIPPED_REASON },
    ]);
  });

  it('allows non-mutating interaction steps in read-only mode', () => {
    expect(violationsOf(withSteps([{ action: 'click', target: { role: 'button', name: 'Menu' } }, { action: 'expectVisible', target: { role: 'menu' } }]), readOnly)).toEqual([]);
  });

  it('strips fields that do not belong to the action', () => {
    const result = validateTestPlan(withSteps([{ action: 'expectUrl', pathPattern: '/sale', value: 'ignored' }, { action: 'expectTitle', text: 'Sale', match: 'contains' }]), ticket, full);
    expect(result.tests[0]?.steps[0]).toEqual({ action: 'expectUrl', pathPattern: '/sale' });
  });

  describe('positive assertions', () => {
    it.each([
      ['expectVisible', { action: 'expectVisible', target: { role: 'heading', name: 'Sale' } }],
      ['expectText', { action: 'expectText', target: { role: 'status' }, text: 'Saved', match: 'equals' }],
      ['expectValue', { action: 'expectValue', target: { label: 'Search' }, value: '' }],
      ['expectCount with a count of at least 1', { action: 'expectCount', target: { role: 'listitem' }, count: 1 }],
      ['expectTitle', { action: 'expectTitle', text: 'Sale', match: 'contains' }],
    ])('keeps a test whose positive assertion is %s', (_label, step) => {
      const result = validateTestPlan(withSteps([{ action: 'goto', path: '/' }, { action: 'expectHidden', target: { text: 'Loading' } }, step]), ticket, full);
      expect(result.tests.map((test) => test.criterionId)).toEqual(['AC-1']);
    });

    it.each([
      ['only expectHidden', [{ action: 'expectHidden', target: { text: 'Old banner' } }]],
      ['only expectCount of 0', [{ action: 'expectCount', target: { role: 'dialog' }, count: 0 }]],
      ['only expectUrl', [{ action: 'expectUrl', pathPattern: '/checkout' }]],
      ['negative assertions combined', [{ action: 'expectHidden', target: { text: 'x' } }, { action: 'expectCount', target: { testId: 'y' }, count: 0 }, { action: 'expectUrl', pathPattern: '/a' }]],
    ])('moves a test with %s to uncoverable, in every mode', (_label, steps) => {
      for (const policy of [full, readOnly]) {
        const result = validateTestPlan(withSteps([{ action: 'goto', path: '/' }, ...steps]), ticket, policy);
        expect(result.tests).toEqual([]);
        expect(result.uncoverable).toEqual([
          { criterionId: 'AC-2', reason: 'requires a mutating action' },
          { criterionId: 'AC-1', reason: NO_POSITIVE_ASSERTION_REASON },
        ]);
      }
    });

    it('explains the rule in the uncoverable reason', () => {
      expect(NO_POSITIVE_ASSERTION_REASON).toBe(
        'no positive assertion: the test needs an expectVisible, expectText, expectValue, expectCount (count of at least 1) or expectTitle step, so it cannot pass when its targets do not exist',
      );
    });
  });

  it.each(['/', ' / ', '/*', '/**', '*', '//*/'])('rejects a trivial expectUrl pathPattern %j', (pathPattern) => {
    const violations = violationsOf(withSteps([{ action: 'expectUrl', pathPattern }, { action: 'expectTitle', text: 'x', match: 'contains' }]));
    expect(violations.join('\n')).toMatch(/pathPattern: must name a specific path/);
  });

  it('rejects an empty expectUrl pathPattern', () => {
    expect(violationsOf(withSteps([{ action: 'expectUrl', pathPattern: '' }, { action: 'expectTitle', text: 'x', match: 'contains' }]))).not.toEqual([]);
  });

  it('collects every violation in one error', () => {
    const error = (() => {
      try {
        validateTestPlan(withSteps([{ action: 'goto', path: 'x' }, { action: 'click' }]), ticket, full);
      } catch (caught) {
        return caught as PlanValidationError;
      }
      return undefined;
    })();
    expect(error?.violations).toEqual([expect.stringMatching(/steps\[0\]\.path/), expect.stringMatching(/steps\[1\]\.target/)]);
    expect(error?.message).toMatch(/^Invalid test plan:/);
  });
});
