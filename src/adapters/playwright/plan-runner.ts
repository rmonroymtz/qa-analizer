import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CriterionResult } from '../../domain/criterion-result.js';
import type { EnvironmentPolicy } from '../../domain/environment.js';
import { MUTATING_SKIPPED_REASON, type PlannedTest, type Step, type TestPlan } from '../../domain/test-plan.js';
import type { RunContext, TestRunner } from '../../ports/test-runner.js';
import { createPlaywrightPlanDriver } from './playwright-plan-driver.js';
import type { BlockedRequest } from './read-only-guard.js';
import { classifyStepFailure, type StepFailure, type StepFailureDetail } from './step-classification.js';

export type StepOutcome = { ok: true } | ({ ok: false } & StepFailureDetail);

/** One isolated browser context and page for one test. */
export interface PlanSession {
  /** Executes one step; never throws, failures are returned. */
  runStep(step: Step): Promise<StepOutcome>;
  screenshot(path: string): Promise<void>;
  /** Requests blocked by the read-only guard in this session so far. */
  blockedRequests(): readonly BlockedRequest[];
  close(): Promise<void>;
}

/** One browser for the whole run. */
export interface PlanDriver {
  openSession(): Promise<PlanSession>;
  close(): Promise<void>;
}

export interface PlanDriverOptions {
  baseUrl: string;
  policy: EnvironmentPolicy;
  storageStatePath?: string;
}

export type PlanDriverFactory = (options: PlanDriverOptions) => Promise<PlanDriver>;

export interface PlaywrightPlanRunnerOptions {
  /** Defaults to the Playwright (Chromium) driver; injectable so unit tests need no browser. */
  driverFactory?: PlanDriverFactory;
  /** Overall time budget per test attempt. */
  testBudgetMs?: number;
}

export const DEFAULT_TEST_BUDGET_MS = 90_000;

type Classified = Omit<CriterionResult, 'criterionId'>;

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0]?.trim() ?? '';
}

function screenshotName(criterionId: string): string {
  return `${criterionId.replace(/[^A-Za-z0-9_-]/g, '_')}.png`;
}

/**
 * Interprets a validated test plan in this process with the Playwright library.
 * No generated code is executed: each step is one call from a closed vocabulary.
 * Each test gets a fresh browser context; in read-only mode the guard is
 * installed on the context before any page exists, and mutating tests are never
 * run. Read-only tests are retried once; full-mode tests never, because a retry
 * could replay a mutation.
 */
export class PlaywrightPlanRunner implements TestRunner {
  constructor(private readonly options: PlaywrightPlanRunnerOptions = {}) {}

  async run(plan: TestPlan, ctx: RunContext): Promise<CriterionResult[]> {
    const factory = this.options.driverFactory ?? ((options: PlanDriverOptions) => createPlaywrightPlanDriver(options));
    const tests = new Map(plan.tests.map((test) => [test.criterionId, test]));
    const uncoverable = new Map(plan.uncoverable.map((entry) => [entry.criterionId, entry.reason]));
    const readOnly = ctx.policy.mode === 'read-only';

    let driver: PlanDriver | undefined;
    let launchError: string | undefined;
    if ([...tests.values()].some((test) => !(readOnly && test.mutating))) {
      try {
        driver = await factory({ baseUrl: ctx.baseUrl, policy: ctx.policy, ...(ctx.storageStatePath ? { storageStatePath: ctx.storageStatePath } : {}) });
      } catch (error) {
        launchError = `could not start the browser: ${errorMessage(error)}`;
      }
    }

    try {
      const results: CriterionResult[] = [];
      for (const { id } of ctx.ticket.acceptanceCriteria) {
        const reason = uncoverable.get(id);
        const test = tests.get(id);
        let result: Classified;
        if (reason !== undefined) result = { status: 'INCONCLUSIVE', reason: `not coverable: ${reason}` };
        else if (test === undefined) result = { status: 'INCONCLUSIVE', reason: 'no test generated' };
        else if (readOnly && test.mutating) result = { status: 'INCONCLUSIVE', reason: MUTATING_SKIPPED_REASON };
        else if (driver === undefined) result = { status: 'INCONCLUSIVE', reason: launchError ?? 'could not start the browser' };
        else result = await this.runWithRetry(driver, test, ctx, readOnly ? 1 : 0);
        results.push({ criterionId: id, ...result });
      }
      return results;
    } finally {
      await driver?.close().catch(() => undefined);
    }
  }

  private async runWithRetry(driver: PlanDriver, test: PlannedTest, ctx: RunContext, retries: number): Promise<Classified> {
    let result = await this.runOnce(driver, test, ctx);
    for (let attempt = 1; attempt <= retries && result.status !== 'PASSED'; attempt += 1) {
      result = await this.runOnce(driver, test, ctx);
      if (result.status === 'PASSED') return { status: 'PASSED', reason: 'test passed (passed on retry)' };
    }
    return result;
  }

  private async runOnce(driver: PlanDriver, test: PlannedTest, ctx: RunContext): Promise<Classified> {
    let session: PlanSession;
    try {
      session = await driver.openSession();
    } catch (error) {
      return { status: 'INCONCLUSIVE', reason: `could not open a browser context: ${errorMessage(error)}` };
    }
    const budgetMs = this.options.testBudgetMs ?? DEFAULT_TEST_BUDGET_MS;
    let current = 0;
    let timer: NodeJS.Timeout | undefined;
    try {
      const steps = (async (): Promise<StepFailure | undefined> => {
        for (const [index, step] of test.steps.entries()) {
          current = index;
          const outcome = await session.runStep(step);
          if (!outcome.ok) {
            const { ok: _ok, ...detail } = outcome;
            return { ...detail, stepIndex: index, action: step.action };
          }
        }
        return undefined;
      })();
      const budget = new Promise<'budget'>((resolveBudget) => {
        timer = setTimeout(() => resolveBudget('budget'), budgetMs);
      });
      const outcome = await Promise.race([steps, budget]);
      if (outcome === 'budget') {
        // Closing the context aborts the pending step; its late result is ignored.
        steps.catch(() => undefined);
        const step = test.steps[current] as Step;
        return classifyStepFailure(
          { kind: 'budget', message: `no result after ${budgetMs}ms`, stepIndex: current, action: step.action },
          session.blockedRequests(),
          ctx.baseUrl,
        );
      }
      if (outcome === undefined) return { status: 'PASSED', reason: 'test passed' };

      const classified = classifyStepFailure(outcome, session.blockedRequests(), ctx.baseUrl);
      const screenshotPath = join(resolve(ctx.outputDir), 'screenshots', screenshotName(test.criterionId));
      try {
        await mkdir(join(resolve(ctx.outputDir), 'screenshots'), { recursive: true });
        await session.screenshot(screenshotPath);
        return { ...classified, evidence: { ...classified.evidence, screenshotPath } };
      } catch {
        // Evidence is best effort; the classification stands without it.
        return classified;
      }
    } finally {
      clearTimeout(timer);
      await session.close().catch(() => undefined);
    }
  }
}
