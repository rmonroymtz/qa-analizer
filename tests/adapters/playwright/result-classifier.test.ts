import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyResults, type PlaywrightJsonReport } from '../../../src/adapters/playwright/result-classifier.js';
import type { Ticket } from '../../../src/domain/ticket.js';
import type { GeneratedSuite } from '../../../src/ports/test-generator.js';

const fixture = JSON.parse(
  readFileSync(new URL('../../fixtures/playwright/mixed-results.json', import.meta.url), 'utf8'),
) as PlaywrightJsonReport;

function ticketWith(ids: string[]): Ticket {
  return {
    key: 'SHOP-42',
    summary: 's',
    description: '',
    acceptanceCriteria: ids.map((id) => ({ id, text: `criterion ${id}` })),
    url: 'https://acme.atlassian.net/browse/SHOP-42',
  };
}

const suite: GeneratedSuite = {
  specCode: '',
  criteria: ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5'].map((id) => ({ criterionId: id, testTitle: `[${id}] x` })),
  uncoverable: [{ criterionId: 'AC-6', reason: 'requires a mutating action in a read-only environment' }],
};

function test(title: string, status: string, error?: string, resultStatus = 'failed') {
  return {
    title,
    tests: [
      {
        status,
        results: [{ status: resultStatus, retry: 0, error: error === undefined ? undefined : { message: error }, errors: [], attachments: [] }],
      },
    ],
  };
}

function report(specs: ReturnType<typeof test>[], errors: { message: string }[] = []): PlaywrightJsonReport {
  return { errors, suites: [{ title: 'verification.spec.ts', specs, suites: [] }] } as unknown as PlaywrightJsonReport;
}

describe('classifyResults with a realistic report', () => {
  const results = classifyResults(fixture, suite, ticketWith(['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6', 'AC-7']));
  const byId = Object.fromEntries(results.map((result) => [result.criterionId, result]));

  it('returns one result per criterion in ticket order', () => {
    expect(results.map((result) => result.criterionId)).toEqual(['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6', 'AC-7']);
  });

  it('a passed test is PASSED', () => {
    expect(byId['AC-1']?.status).toBe('PASSED');
  });

  it('an assertion failure is FAILED with expected, actual and the last screenshot', () => {
    expect(byId['AC-2']).toMatchObject({
      status: 'FAILED',
      reason: 'discounted price is shown',
      evidence: {
        expected: '"$80.00"',
        actual: '"$100.00"',
        screenshotPath: '/out/test-results/a2-retry1/test-failed-1.png',
      },
    });
  });

  it('an action timeout is INCONCLUSIVE', () => {
    expect(byId['AC-3']?.status).toBe('INCONCLUSIVE');
    expect(byId['AC-3']?.reason).toContain('locator.click: Timeout 30000ms exceeded');
  });

  it('a test that passes on retry (flaky) is PASSED, noting the retry', () => {
    expect(byId['AC-4']).toEqual({ criterionId: 'AC-4', status: 'PASSED', reason: 'test passed (passed on retry)' });
  });

  it('a test.skip test is INCONCLUSIVE because it was marked to skip', () => {
    expect(byId['AC-5']).toEqual({ criterionId: 'AC-5', status: 'INCONCLUSIVE', reason: 'test was marked fail/fixme/skip' });
  });

  it('an uncoverable criterion is INCONCLUSIVE with its reason', () => {
    expect(byId['AC-6']?.status).toBe('INCONCLUSIVE');
    expect(byId['AC-6']?.reason).toContain('requires a mutating action in a read-only environment');
  });

  it('a criterion with no test and not uncoverable is INCONCLUSIVE "no test generated"', () => {
    expect(byId['AC-7']).toMatchObject({ status: 'INCONCLUSIVE', reason: 'no test generated' });
  });
});

describe('classifyResults failure branches', () => {
  const ticket = ticketWith(['AC-1']);
  const one: GeneratedSuite = { specCode: '', criteria: [{ criterionId: 'AC-1', testTitle: '[AC-1] t' }], uncoverable: [] };
  const classify = (error: string, resultStatus = 'failed') =>
    classifyResults(report([test('[AC-1] t', 'unexpected', error, resultStatus)]), one, ticket)[0];

  it.each([
    ['toBeVisible matcher', 'Error: expect(locator).toBeVisible() failed\n\nLocator: getByRole(\'alert\')\nExpected: visible\nReceived: hidden'],
    ['toContain on a value', 'Error: expect(received).toContain(expected)\n\nExpected substring: "Sale"\nReceived string: "Regular"'],
    ['toBe on a value', 'Error: cart count is 1\n\nexpect(received).toBe(expected) // Object.is equality\n\nExpected: 1\nReceived: 0'],
    ['toHaveURL', 'Error: expect(page).toHaveURL(expected) failed\n\nExpected pattern: /\\/cart/\nReceived string: "https://shop.example.com/"'],
  ])('%s is FAILED', (_label, message) => {
    expect(classify(message)?.status).toBe('FAILED');
  });

  it.each([
    ['strict mode violation', "Error: locator.click: Error: strict mode violation: getByRole('button') resolved to 2 elements"],
    ['strict mode inside an expect', "Error: expect(locator).toHaveText(expected) failed\n\nError: strict mode violation: getByText('Sale') resolved to 3 elements\nExpected: \"Sale\""],
    ['element not found inside an expect', "Error: expect(locator).toBeVisible() failed\n\nLocator: getByText('Sale')\nExpected: visible\nTimeout: 5000ms\nError: element(s) not found"],
    ['navigation error', 'Error: page.goto: net::ERR_NAME_NOT_RESOLVED at https://shop.example.com/'],
    ['blocked mutation', 'Error: page.waitForResponse: net::ERR_BLOCKED_BY_CLIENT'],
    ['fill timeout', 'TimeoutError: locator.fill: Timeout 30000ms exceeded.\nCall log:\n  - waiting for getByLabel(\'Email\')'],
    ['syntax error', "SyntaxError: /out/generated/verification.spec.ts: Unexpected token (4:2)"],
    ['unknown runtime error', 'TypeError: Cannot read properties of undefined'],
  ])('%s is INCONCLUSIVE', (_label, message) => {
    expect(classify(message)?.status).toBe('INCONCLUSIVE');
  });

  it.each([
    ['test.fail that failed as expected', 'failed', 'expected'],
    ['test.fail that unexpectedly passed', 'failed', 'unexpected'],
    ['test.fixme', 'skipped', 'skipped'],
    ['test.skip', 'skipped', 'skipped'],
  ])('%s is INCONCLUSIVE, never PASSED', (_label, expectedStatus, status) => {
    const marked = test('[AC-1] t', status, status === 'unexpected' ? undefined : 'Error: expect(received).toBe(expected)', 'passed');
    marked.tests[0] = { ...marked.tests[0], expectedStatus } as (typeof marked.tests)[0];
    expect(classifyResults(report([marked]), one, ticket)[0]).toEqual({
      criterionId: 'AC-1',
      status: 'INCONCLUSIVE',
      reason: 'test was marked fail/fixme/skip',
    });
  });

  it('a test skipped at run time without being marked is INCONCLUSIVE "test was skipped"', () => {
    const skipped = test('[AC-1] t', 'skipped', undefined, 'skipped');
    skipped.tests[0] = { ...skipped.tests[0], expectedStatus: 'passed' } as (typeof skipped.tests)[0];
    expect(classifyResults(report([skipped]), one, ticket)[0]).toMatchObject({ status: 'INCONCLUSIVE', reason: 'test was skipped' });
  });

  it('a first-try pass is PASSED without a retry note', () => {
    expect(classifyResults(report([test('[AC-1] t', 'expected', undefined, 'passed')]), one, ticket)[0]).toEqual({
      criterionId: 'AC-1',
      status: 'PASSED',
      reason: 'test passed',
    });
  });

  it('a test-level timeout is INCONCLUSIVE even when the message mentions expect', () => {
    const result = classify('Test timeout of 60000ms exceeded.\nexpect(locator).toBeVisible() Expected: visible', 'timedOut');
    expect(result).toMatchObject({ status: 'INCONCLUSIVE' });
    expect(result?.reason).toMatch(/timed out/);
  });

  it('a load error with no tests makes every covered criterion INCONCLUSIVE with that error', () => {
    const results = classifyResults(report([], [{ message: 'SyntaxError: Unexpected token (4:2)\n  at verification.spec.ts' }]), one, ticket);
    expect(results[0]?.status).toBe('INCONCLUSIVE');
    expect(results[0]?.reason).toContain('test execution failed');
    expect(results[0]?.reason).toContain('SyntaxError: Unexpected token (4:2)');
  });

  it('combines several tests for one criterion: a failure wins over a pass', () => {
    const results = classifyResults(
      report([test('[AC-1] a', 'expected', undefined, 'passed'), test('[AC-1] b', 'unexpected', 'Error: expect(received).toBe(expected)\nExpected: 1\nReceived: 2')]),
      one,
      ticket,
    );
    expect(results[0]?.status).toBe('FAILED');
  });

  it('finds tests inside nested describe suites', () => {
    const nested = {
      errors: [],
      suites: [{ title: 'file', specs: [], suites: [{ title: 'group', specs: [test('[AC-1] t', 'expected', undefined, 'passed')] }] }],
    } as unknown as PlaywrightJsonReport;
    expect(classifyResults(nested, one, ticket)[0]?.status).toBe('PASSED');
  });
});
