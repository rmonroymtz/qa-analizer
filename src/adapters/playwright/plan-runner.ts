import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { CriterionResult } from '../../domain/criterion-result.js';
import type { EnvironmentPolicy } from '../../domain/environment.js';
import { MUTATING_SKIPPED_REASON, type PlannedTest, type Step, type TestPlan } from '../../domain/test-plan.js';
import type { RunContext, TestRunner } from '../../ports/test-runner.js';
import { createPlaywrightPlanDriver } from './playwright-plan-driver.js';
import type { SettleSettings } from './network-settle.js';
import type { BlockedRequest } from './read-only-guard.js';
import { classifyStepFailure, type StepFailure, type StepFailureDetail } from './step-classification.js';

export type StepOutcome = { ok: true } | ({ ok: false } & StepFailureDetail);

/** One isolated browser context and page for one test. */
export interface PlanSession {
  /**
   * Executes one step; never throws, failures are returned. A step after which
   * the page is no longer on the target origin fails with the kind `off-origin`.
   */
  runStep(step: Step): Promise<StepOutcome>;
  /** Captures the page; must refuse (throw) when the page is not on the target origin. */
  screenshot(path: string): Promise<void>;
  /** Requests blocked by the read-only guard in this session so far. */
  blockedRequests(): readonly BlockedRequest[];
  /** Starts a Playwright trace of this session's context (screenshots and DOM snapshots, no sources). */
  startTracing(): Promise<void>;
  /** Stops the trace and writes it to `path` (a .zip for `npx playwright show-trace`). */
  stopTracing(path: string): Promise<void>;
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
  /** First-party network settle wait after each `goto`; the driver's default when omitted. */
  settle?: SettleSettings;
}

export type PlanDriverFactory = (options: PlanDriverOptions) => Promise<PlanDriver>;

export interface PlaywrightPlanRunnerOptions {
  /** Defaults to the Playwright (Chromium) driver; injectable so unit tests need no browser. */
  driverFactory?: PlanDriverFactory;
  /** Overall time budget per test attempt. */
  testBudgetMs?: number;
  /** Passed to the driver: the settle wait after each `goto`. */
  settle?: SettleSettings;
  /**
   * Record one Playwright trace per executed test at `<outputDir>/traces/<id>.zip`.
   * Never done in a read-only or authenticated run, even when set: traces hold
   * cookies, headers and response bodies (the config refuses that combination first).
   */
  trace?: boolean;
  /** Warnings (tracing failures); they never change a verdict. */
  log?: (message: string) => void;
}

export const TRACE_SKIPPED_WARNING = 'Tracing skipped: traces are never recorded in read-only or authenticated runs';

export const DEFAULT_TEST_BUDGET_MS = 90_000;

type Classified = Omit<CriterionResult, 'criterionId'>;

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0]?.trim() ?? '';
}

function safeFileStem(criterionId: string): string {
  return criterionId.replace(/[^A-Za-z0-9_-]/g, '_');
}

function screenshotName(criterionId: string): string {
  return `${safeFileStem(criterionId)}.png`;
}

function traceName(criterionId: string): string {
  return `${safeFileStem(criterionId)}.zip`;
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
    let trace = this.options.trace === true;
    if (trace && (readOnly || ctx.storageStatePath !== undefined)) {
      this.options.log?.(TRACE_SKIPPED_WARNING);
      trace = false;
    }

    let driver: PlanDriver | undefined;
    let launchError: string | undefined;
    if ([...tests.values()].some((test) => !(readOnly && test.mutating))) {
      try {
        driver = await factory({
          baseUrl: ctx.baseUrl,
          policy: ctx.policy,
          ...(ctx.storageStatePath ? { storageStatePath: ctx.storageStatePath } : {}),
          ...(this.options.settle ? { settle: this.options.settle } : {}),
        });
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
        else result = await this.runWithRetry(driver, test, ctx, readOnly ? 1 : 0, trace);
        results.push({ criterionId: id, ...result });
      }
      return results;
    } finally {
      await driver?.close().catch(() => undefined);
    }
  }

  private async runWithRetry(driver: PlanDriver, test: PlannedTest, ctx: RunContext, retries: number, trace: boolean): Promise<Classified> {
    let result = await this.runOnce(driver, test, ctx, trace);
    for (let attempt = 1; attempt <= retries && result.status !== 'PASSED'; attempt += 1) {
      result = await this.runOnce(driver, test, ctx, trace);
      if (result.status === 'PASSED') return { status: 'PASSED', reason: 'test passed (passed on retry)', ...(result.evidence ? { evidence: result.evidence } : {}) };
    }
    return result;
  }

  private async runOnce(driver: PlanDriver, test: PlannedTest, ctx: RunContext, trace: boolean): Promise<Classified> {
    let session: PlanSession;
    try {
      session = await driver.openSession();
    } catch (error) {
      return { status: 'INCONCLUSIVE', reason: `could not open a browser context: ${errorMessage(error)}` };
    }
    try {
      const tracing = trace && (await this.startTrace(session, test.criterionId));
      let result: Classified | undefined;
      try {
        result = await this.runSteps(session, test, ctx);
      } finally {
        // Also after a failed, timed-out or throwing test: that is when the trace matters most.
        const tracePath = tracing ? await this.stopTrace(session, test.criterionId, ctx) : undefined;
        if (result !== undefined && tracePath !== undefined) result = { ...result, evidence: { ...result.evidence, tracePath } };
      }
      return result;
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  /** Best effort: a tracing failure is logged and never changes the verdict. */
  private async startTrace(session: PlanSession, criterionId: string): Promise<boolean> {
    try {
      await session.startTracing();
      return true;
    } catch (error) {
      this.options.log?.(`Could not start the trace for ${criterionId}: ${errorMessage(error)}`);
      return false;
    }
  }

  private async stopTrace(session: PlanSession, criterionId: string, ctx: RunContext): Promise<string | undefined> {
    const directory = join(resolve(ctx.outputDir), 'traces');
    const tracePath = join(directory, traceName(criterionId));
    try {
      await mkdir(directory, { recursive: true });
      await session.stopTracing(tracePath);
      return tracePath;
    } catch (error) {
      this.options.log?.(`Could not save the trace for ${criterionId}: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /** Runs the steps within the time budget and classifies the outcome; the caller closes the session. */
  private async runSteps(session: PlanSession, test: PlannedTest, ctx: RunContext): Promise<Classified> {
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
        );
      }
      if (outcome === undefined) return { status: 'PASSED', reason: 'test passed' };

      const classified = classifyStepFailure(outcome, session.blockedRequests());
      // Never capture a foreign page: the screenshot could end up attached to the Jira ticket.
      if (outcome.kind === 'off-origin') return classified;
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
    }
  }
}
