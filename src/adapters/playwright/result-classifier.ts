import type { CriterionEvidence, CriterionResult } from '../../domain/criterion-result.js';
import type { Ticket } from '../../domain/ticket.js';
import type { GeneratedSuite } from '../../ports/test-generator.js';

/** The subset of Playwright's JSON reporter output used for classification. */
export interface PlaywrightJsonReport {
  suites: JsonSuite[];
  errors?: { message?: string }[];
}

interface JsonSuite {
  title: string;
  specs?: JsonSpec[];
  suites?: JsonSuite[];
}

interface JsonSpec {
  title: string;
  tests: JsonTest[];
}

interface JsonTest {
  status: 'skipped' | 'expected' | 'unexpected' | 'flaky';
  /** `failed` for test.fail, `skipped` for test.fixme/test.skip; `passed` for an ordinary test. */
  expectedStatus?: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';
  results: JsonResult[];
}

interface JsonResult {
  status?: string;
  retry?: number;
  error?: { message?: string };
  errors?: { message?: string }[];
  attachments?: { name: string; path?: string; contentType: string }[];
}

const TITLE_PREFIX = /^\[(AC-\d+)\]/;
const ANSI = /\u001b\[[0-9;]*m/g;
const MAX_REASON = 300;
const MAX_VALUE = 500;

/** Errors that mean "the test could not reach or identify its target", never a business failure. */
const INCONCLUSIVE_MARKERS = [
  'element(s) not found',
  'strict mode violation',
  'net::ERR',
  'ERR_BLOCKED_BY_CLIENT',
  'has been closed',
];
const MATCHER_CALL = /expect\([^)]*\)(?:\.not)?\.(?:to[A-Z]\w*)\(/;

function clean(text: string): string {
  return text.replace(ANSI, '');
}

function firstLine(message: string): string {
  const line = message.split('\n').find((candidate) => candidate.trim() !== '') ?? '';
  const trimmed = line.trim().replace(/^Error:\s*/, '');
  return trimmed.length > MAX_REASON ? `${trimmed.slice(0, MAX_REASON)}...` : trimmed;
}

function extract(message: string, label: 'Expected' | 'Received'): string | undefined {
  const match = message.match(new RegExp(`^\\s*${label}(?: [\\w ]+)?:\\s*(.+)$`, 'm'));
  const value = match?.[1]?.trim();
  if (!value) return undefined;
  return value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE)}...` : value;
}

function isAssertionFailure(message: string): boolean {
  if (INCONCLUSIVE_MARKERS.some((marker) => message.includes(marker))) return false;
  if (!message.includes('expect(')) return false;
  return MATCHER_CALL.test(message) || /^\s*(Expected|Received)\b/m.test(message);
}

function lastScreenshot(results: JsonResult[]): string | undefined {
  for (const result of [...results].reverse()) {
    const shot = [...(result.attachments ?? [])]
      .reverse()
      .find((attachment) => attachment.name === 'screenshot' && attachment.path);
    if (shot?.path) return shot.path;
  }
  return undefined;
}

function classifyTest(criterionId: string, test: JsonTest): CriterionResult {
  // A test marked fail/fixme/skip does not check the criterion, whatever its outcome.
  if (test.expectedStatus !== undefined && test.expectedStatus !== 'passed') {
    return { criterionId, status: 'INCONCLUSIVE', reason: 'test was marked fail/fixme/skip' };
  }
  if (test.status === 'expected') return { criterionId, status: 'PASSED', reason: 'test passed' };
  if (test.status === 'flaky') return { criterionId, status: 'PASSED', reason: 'test passed (passed on retry)' };
  if (test.status === 'skipped') return { criterionId, status: 'INCONCLUSIVE', reason: 'test was skipped' };

  const last = test.results[test.results.length - 1];
  const message = clean(last?.error?.message ?? last?.errors?.[0]?.message ?? 'unknown error');
  if (last?.status === 'timedOut') {
    return { criterionId, status: 'INCONCLUSIVE', reason: `test timed out: ${firstLine(message)}` };
  }
  if (!isAssertionFailure(message)) {
    return { criterionId, status: 'INCONCLUSIVE', reason: `could not complete the test steps: ${firstLine(message)}` };
  }
  const evidence: CriterionEvidence = {};
  const expected = extract(message, 'Expected');
  const actual = extract(message, 'Received');
  const screenshotPath = lastScreenshot(test.results);
  if (expected !== undefined) evidence.expected = expected;
  if (actual !== undefined) evidence.actual = actual;
  if (screenshotPath !== undefined) evidence.screenshotPath = screenshotPath;
  return { criterionId, status: 'FAILED', reason: firstLine(message), evidence };
}

function collectSpecs(suites: JsonSuite[]): JsonSpec[] {
  return suites.flatMap((suite) => [...(suite.specs ?? []), ...collectSpecs(suite.suites ?? [])]);
}

/** Several tests for one criterion combine like the ticket verdict: FAILED wins, then INCONCLUSIVE. */
function combine(results: CriterionResult[]): CriterionResult {
  return (
    results.find((result) => result.status === 'FAILED') ??
    results.find((result) => result.status === 'INCONCLUSIVE') ??
    (results[0] as CriterionResult)
  );
}

/**
 * Maps a Playwright JSON report to one result per acceptance criterion, in ticket
 * order. Only a failed `expect` assertion is FAILED; anything that prevented the
 * test from reaching or identifying its target (locators, navigation, blocked
 * requests, timeouts, load errors, skips) is INCONCLUSIVE.
 */
export function classifyResults(report: PlaywrightJsonReport, suite: GeneratedSuite, ticket: Pick<Ticket, 'acceptanceCriteria'>): CriterionResult[] {
  const byCriterion = new Map<string, CriterionResult[]>();
  for (const spec of collectSpecs(report.suites ?? [])) {
    const criterionId = spec.title.match(TITLE_PREFIX)?.[1];
    if (criterionId === undefined) continue;
    for (const test of spec.tests) {
      byCriterion.set(criterionId, [...(byCriterion.get(criterionId) ?? []), classifyTest(criterionId, test)]);
    }
  }
  const uncoverable = new Map(suite.uncoverable.map((entry) => [entry.criterionId, entry.reason]));
  const loadError = report.errors?.find((error) => error.message)?.message;

  return ticket.acceptanceCriteria.map(({ id }) => {
    const reason = uncoverable.get(id);
    if (reason !== undefined) return { criterionId: id, status: 'INCONCLUSIVE', reason: `not coverable: ${reason}` };
    const results = byCriterion.get(id);
    if (results && results.length > 0) return combine(results);
    if (loadError !== undefined) {
      return { criterionId: id, status: 'INCONCLUSIVE', reason: `test execution failed: ${firstLine(clean(loadError))}` };
    }
    return { criterionId: id, status: 'INCONCLUSIVE', reason: 'no test generated' };
  });
}
