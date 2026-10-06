import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PlaywrightPlanRunner,
  type PlanDriver,
  type PlanDriverOptions,
  type PlanSession,
  type StepOutcome,
} from '../../../src/adapters/playwright/plan-runner.js';
import type { BlockedRequest } from '../../../src/adapters/playwright/read-only-guard.js';
import type { EnvironmentPolicy } from '../../../src/domain/environment.js';
import type { PlannedTest, Step, TestPlan } from '../../../src/domain/test-plan.js';
import type { Ticket } from '../../../src/domain/ticket.js';
import type { RunContext } from '../../../src/ports/test-runner.js';

const ticket: Ticket = {
  key: 'SHOP-42',
  summary: 's',
  description: '',
  acceptanceCriteria: [
    { id: 'AC-1', text: 'a' },
    { id: 'AC-2', text: 'b' },
    { id: 'AC-3', text: 'c' },
  ],
  url: 'https://acme.atlassian.net/browse/SHOP-42',
};

const full: EnvironmentPolicy = { mode: 'full', allowedMutations: [] };
const readOnly: EnvironmentPolicy = { mode: 'read-only', allowedMutations: [] };

function test(criterionId: string, steps: Step[], mutating = false): PlannedTest {
  return { criterionId, title: `[${criterionId}] t`, mutating, steps };
}

const visible = (name: string): Step => ({ action: 'expectVisible', target: { role: 'heading', name } });

/** Scripted outcomes keyed by the expected heading name; every session records its steps. */
function fakeDriver(script: (step: Step, attempt: number) => StepOutcome | Promise<StepOutcome>, blocked: BlockedRequest[] = []) {
  const events: string[] = [];
  const attempts = new Map<string, number>();
  let driverOptions: PlanDriverOptions | undefined;
  const factory = async (options: PlanDriverOptions): Promise<PlanDriver> => {
    driverOptions = options;
    events.push('launch');
    return {
      openSession: async (): Promise<PlanSession> => {
        events.push('open');
        return {
          runStep: async (step) => {
            const key = JSON.stringify(step);
            const attempt = attempts.get(key) ?? 0;
            events.push(`step:${step.action}`);
            const outcome = await script(step, attempt);
            if (!outcome.ok) attempts.set(key, attempt + 1);
            return outcome;
          },
          screenshot: async (path) => {
            events.push(`screenshot:${path}`);
          },
          blockedRequests: () => blocked,
          close: async () => {
            events.push('close-session');
          },
        };
      },
      close: async () => {
        events.push('close-browser');
      },
    };
  };
  return { factory, events, options: () => driverOptions };
}

let outputDir: string;
beforeEach(async () => {
  outputDir = await mkdtemp(join(tmpdir(), 'qa-plan-runner-'));
});
afterEach(async () => {
  await rm(outputDir, { recursive: true, force: true });
});

function ctx(policy: EnvironmentPolicy): RunContext {
  return { baseUrl: 'https://shop.example.com', environment: policy.mode === 'full' ? 'staging' : 'production', policy, storageStatePath: '/tmp/state.json', outputDir, ticket };
}

const pass: StepOutcome = { ok: true };
const fail: StepOutcome = { ok: false, kind: 'assertion', message: 'not visible', targetCount: 1, expected: 'visible', actual: 'hidden' };

describe('PlaywrightPlanRunner', () => {
  it('returns one result per criterion in ticket order and closes everything', async () => {
    const driver = fakeDriver((step) => (JSON.stringify(step).includes('Broken') ? fail : pass));
    const plan: TestPlan = {
      tests: [test('AC-3', [{ action: 'goto', path: '/' }, visible('Broken')]), test('AC-1', [{ action: 'goto', path: '/' }, visible('Home')])],
      uncoverable: [{ criterionId: 'AC-2', reason: 'needs a payment' }],
    };
    const results = await new PlaywrightPlanRunner({ driverFactory: driver.factory }).run(plan, ctx(full));

    expect(results.map((result) => [result.criterionId, result.status])).toEqual([
      ['AC-1', 'PASSED'],
      ['AC-2', 'INCONCLUSIVE'],
      ['AC-3', 'FAILED'],
    ]);
    expect(results[0]?.reason).toBe('test passed');
    expect(results[1]?.reason).toBe('not coverable: needs a payment');
    expect(results[2]).toMatchObject({
      reason: 'step 2 (expectVisible) failed: expected visible, actual hidden',
      evidence: { expected: 'visible', actual: 'hidden', screenshotPath: join(outputDir, 'screenshots', 'AC-3.png') },
    });
    expect(driver.options()).toEqual({ baseUrl: 'https://shop.example.com', policy: full, storageStatePath: '/tmp/state.json' });
    // One session per test, closed after it; the browser closed last.
    expect(driver.events.filter((event) => event === 'open')).toHaveLength(2);
    expect(driver.events.filter((event) => event === 'close-session')).toHaveLength(2);
    expect(driver.events.at(-1)).toBe('close-browser');
  });

  it('stops a test at its first failing step', async () => {
    const driver = fakeDriver((step) => (step.action === 'click' ? { ok: false, kind: 'action', message: 'Timeout 10000ms exceeded' } : pass));
    const plan: TestPlan = {
      tests: [test('AC-1', [{ action: 'click', target: { role: 'button' } }, visible('After')])],
      uncoverable: [{ criterionId: 'AC-2', reason: 'x' }, { criterionId: 'AC-3', reason: 'y' }],
    };
    const [result] = await new PlaywrightPlanRunner({ driverFactory: driver.factory }).run(plan, ctx(full));
    expect(result).toMatchObject({ status: 'INCONCLUSIVE', reason: 'could not complete step 1 (click): Timeout 10000ms exceeded' });
    expect(driver.events).not.toContain('step:expectVisible');
  });

  it('never executes a mutating test in read-only mode', async () => {
    const driver = fakeDriver(() => pass);
    const plan: TestPlan = {
      tests: [test('AC-1', [visible('Saved')], true)],
      uncoverable: [{ criterionId: 'AC-2', reason: 'x' }, { criterionId: 'AC-3', reason: 'y' }],
    };
    const [result] = await new PlaywrightPlanRunner({ driverFactory: driver.factory }).run(plan, ctx(readOnly));
    expect(result).toEqual({ criterionId: 'AC-1', status: 'INCONCLUSIVE', reason: 'mutating test skipped in read-only mode' });
    expect(driver.events).not.toContain('open');
  });

  it('runs a mutating test in full mode', async () => {
    const driver = fakeDriver(() => pass);
    const plan: TestPlan = { tests: [test('AC-1', [visible('Saved')], true)], uncoverable: [{ criterionId: 'AC-2', reason: 'x' }, { criterionId: 'AC-3', reason: 'y' }] };
    const [result] = await new PlaywrightPlanRunner({ driverFactory: driver.factory }).run(plan, ctx(full));
    expect(result?.status).toBe('PASSED');
  });

  it('retries a failed test once in read-only mode and notes a pass on retry', async () => {
    const driver = fakeDriver((_step, attempt) => (attempt === 0 ? fail : pass));
    const plan: TestPlan = { tests: [test('AC-1', [visible('Flaky')])], uncoverable: [{ criterionId: 'AC-2', reason: 'x' }, { criterionId: 'AC-3', reason: 'y' }] };
    const [result] = await new PlaywrightPlanRunner({ driverFactory: driver.factory }).run(plan, ctx(readOnly));
    expect(result).toEqual({ criterionId: 'AC-1', status: 'PASSED', reason: 'test passed (passed on retry)' });
    expect(driver.events.filter((event) => event === 'open')).toHaveLength(2);
  });

  it('reports the retry result when a read-only test fails twice', async () => {
    const driver = fakeDriver(() => fail);
    const plan: TestPlan = { tests: [test('AC-1', [visible('Gone')])], uncoverable: [{ criterionId: 'AC-2', reason: 'x' }, { criterionId: 'AC-3', reason: 'y' }] };
    const [result] = await new PlaywrightPlanRunner({ driverFactory: driver.factory }).run(plan, ctx(readOnly));
    expect(result?.status).toBe('FAILED');
    expect(driver.events.filter((event) => event === 'open')).toHaveLength(2);
  });

  it('never retries in full mode, where a retry could replay a mutation', async () => {
    const driver = fakeDriver(() => fail);
    const plan: TestPlan = { tests: [test('AC-1', [visible('Gone')])], uncoverable: [{ criterionId: 'AC-2', reason: 'x' }, { criterionId: 'AC-3', reason: 'y' }] };
    await new PlaywrightPlanRunner({ driverFactory: driver.factory }).run(plan, ctx(full));
    expect(driver.events.filter((event) => event === 'open')).toHaveLength(1);
  });

  it('ends a test that exceeds its time budget as INCONCLUSIVE', async () => {
    const driver = fakeDriver((step) => (step.action === 'click' ? new Promise<StepOutcome>(() => undefined) : pass));
    const plan: TestPlan = {
      tests: [test('AC-1', [{ action: 'goto', path: '/' }, { action: 'click', target: { role: 'button' } }, visible('x')])],
      uncoverable: [{ criterionId: 'AC-2', reason: 'x' }, { criterionId: 'AC-3', reason: 'y' }],
    };
    const [result] = await new PlaywrightPlanRunner({ driverFactory: driver.factory, testBudgetMs: 20 }).run(plan, ctx(full));
    expect(result).toMatchObject({ status: 'INCONCLUSIVE', reason: 'test exceeded its time budget at step 2 (click): no result after 20ms' });
    expect(driver.events).toContain('close-session');
  });

  it('stops a test that left the target site as INCONCLUSIVE and takes no screenshot of the foreign page', async () => {
    const driver = fakeDriver((step) => (step.action === 'click' ? { ok: false, kind: 'off-origin', message: 'https://evil.example.net' } : pass));
    const plan: TestPlan = {
      tests: [test('AC-1', [{ action: 'goto', path: '/' }, { action: 'click', target: { role: 'link', name: 'Partner' } }, visible('After')])],
      uncoverable: [{ criterionId: 'AC-2', reason: 'x' }, { criterionId: 'AC-3', reason: 'y' }],
    };
    const [result] = await new PlaywrightPlanRunner({ driverFactory: driver.factory }).run(plan, ctx(full));
    expect(result).toEqual({ criterionId: 'AC-1', status: 'INCONCLUSIVE', reason: 'navigation left the target site (https://evil.example.net) at step 2 (click)' });
    expect(driver.events).not.toContain('step:expectVisible');
    expect(driver.events.some((event) => event.startsWith('screenshot:'))).toBe(false);
  });

  it('downgrades a failed assertion to INCONCLUSIVE when the guard blocked a request to another host', async () => {
    const driver = fakeDriver(() => fail, [{ method: 'POST', url: 'https://api.example.net/cart' }]);
    const plan: TestPlan = { tests: [test('AC-1', [visible('Cart')])], uncoverable: [{ criterionId: 'AC-2', reason: 'x' }, { criterionId: 'AC-3', reason: 'y' }] };
    const [result] = await new PlaywrightPlanRunner({ driverFactory: driver.factory }).run(plan, ctx(readOnly));
    expect(result).toMatchObject({
      status: 'INCONCLUSIVE',
      reason: 'step 1 (expectVisible) failed after the read-only guard blocked a request: expected visible, actual hidden; blocked requests: POST https://api.example.net/cart',
    });
  });

  it('marks every test INCONCLUSIVE when the browser cannot start', async () => {
    const factory = async (): Promise<PlanDriver> => {
      throw new Error('Executable does not exist');
    };
    const plan: TestPlan = { tests: [test('AC-1', [visible('x')])], uncoverable: [{ criterionId: 'AC-2', reason: 'x' }, { criterionId: 'AC-3', reason: 'y' }] };
    const results = await new PlaywrightPlanRunner({ driverFactory: factory }).run(plan, ctx(full));
    expect(results[0]).toEqual({ criterionId: 'AC-1', status: 'INCONCLUSIVE', reason: 'could not start the browser: Executable does not exist' });
    expect(results[1]?.reason).toBe('not coverable: x');
  });

  it('marks a criterion without a test or uncoverable entry as INCONCLUSIVE', async () => {
    const driver = fakeDriver(() => pass);
    const results = await new PlaywrightPlanRunner({ driverFactory: driver.factory }).run({ tests: [], uncoverable: [] }, ctx(full));
    expect(results.map((result) => result.reason)).toEqual(['no test generated', 'no test generated', 'no test generated']);
  });
});
