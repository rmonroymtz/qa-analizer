import { chromium, type Browser, type BrowserContext, type BrowserContextOptions, type LaunchOptions, type Locator as PwLocator, type Page } from '@playwright/test';
import { joinTargetUrl, offTargetOrigin } from '../../domain/target-url.js';
import type { Locator, ParentTarget, Step, Target } from '../../domain/test-plan.js';
import { DEFAULT_SETTLE, trackFirstPartyRequests, type SettleEventSource, type SettleSettings } from './network-settle.js';
import type { PlanDriver, PlanDriverOptions, PlanSession, StepOutcome } from './plan-runner.js';
import { installReadOnlyGuard, type BlockedRequest, type RoutableTarget } from './read-only-guard.js';
import type { StepFailureDetail } from './step-classification.js';

export interface StepTimeouts {
  actionMs: number;
  assertionMs: number;
  navigationMs: number;
  /** Polling interval of assertions. */
  pollMs: number;
}

export const DEFAULT_STEP_TIMEOUTS: StepTimeouts = { actionMs: 10_000, assertionMs: 10_000, navigationMs: 30_000, pollMs: 100 };

const MAX_ACTUAL_CHARS = 300;

function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return (message.split('\n').find((line) => line.trim() !== '') ?? '').trim();
}

function quote(value: string): string {
  const shown = value.length > MAX_ACTUAL_CHARS ? `${value.slice(0, MAX_ACTUAL_CHARS)}...` : value;
  return JSON.stringify(shown);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function locate(root: Page | PwLocator, spec: Locator): PwLocator {
  if ('role' in spec) {
    return root.getByRole(spec.role, { ...(spec.name !== undefined ? { name: spec.name } : {}), ...(spec.exact !== undefined ? { exact: spec.exact } : {}) });
  }
  if ('text' in spec) return root.getByText(spec.text, spec.exact !== undefined ? { exact: spec.exact } : {});
  if ('label' in spec) return root.getByLabel(spec.label);
  if ('placeholder' in spec) return root.getByPlaceholder(spec.placeholder);
  return root.getByTestId(spec.testId);
}

function withNth(locator: PwLocator, target: ParentTarget): PwLocator {
  return target.nth === undefined ? locator : locator.nth(target.nth);
}

/** Builds a Playwright locator from a semantic target; no selector strings are ever built. */
export function resolveTarget(page: Page, target: Target): PwLocator {
  const root = target.within ? withNth(locate(page, target.within), target.within) : page;
  return withNth(locate(root, target), target);
}

interface Evaluation {
  pass: boolean;
  expected?: string;
  actual?: string;
  targetCount?: number;
  ambiguous?: boolean;
}

/** Re-evaluates until the assertion holds or the timeout expires; returns the last evaluation. */
async function poll(evaluate: () => Promise<Evaluation>, timeouts: StepTimeouts): Promise<Evaluation | { error: string }> {
  const deadline = Date.now() + timeouts.assertionMs;
  let last: Evaluation | { error: string } = { error: 'assertion was not evaluated' };
  for (;;) {
    try {
      last = await evaluate();
      if (last.pass) return last;
    } catch (error) {
      last = { error: firstLine(error) };
    }
    if (Date.now() >= deadline) return last;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, timeouts.pollMs));
  }
}

/** Evaluates a target assertion once the target resolves to exactly one element. */
async function onSingle(target: Target, locator: PwLocator, expected: string, check: (element: PwLocator) => Promise<{ pass: boolean; actual: string }>): Promise<Evaluation> {
  const count = await locator.count();
  if (count === 0) return { pass: false, targetCount: 0, expected, actual: 'not found' };
  if (count > 1 && target.nth === undefined) return { pass: false, targetCount: count, ambiguous: true, expected, actual: `${count} matching elements` };
  return { ...(await check(locator)), targetCount: count, expected };
}

function textMatches(actual: string, expected: string, match: 'contains' | 'equals'): boolean {
  return match === 'equals' ? normalizeText(actual) === normalizeText(expected) : normalizeText(actual).includes(normalizeText(expected));
}

function evaluator(page: Page, step: Step): (() => Promise<Evaluation>) | undefined {
  switch (step.action) {
    case 'expectVisible': {
      const locator = resolveTarget(page, step.target);
      return () => onSingle(step.target, locator, 'visible', async (element) => ((await element.isVisible()) ? { pass: true, actual: 'visible' } : { pass: false, actual: 'hidden' }));
    }
    case 'expectHidden': {
      const locator = resolveTarget(page, step.target);
      return async () => {
        const count = await locator.count();
        if (count === 0) return { pass: true, targetCount: 0 };
        if (count > 1 && step.target.nth === undefined) return { pass: false, targetCount: count, ambiguous: true };
        const visible = await locator.isVisible();
        return { pass: !visible, targetCount: count, expected: 'hidden', actual: visible ? 'visible' : 'hidden' };
      };
    }
    case 'expectText': {
      const locator = resolveTarget(page, step.target);
      const expected = `${step.match === 'equals' ? 'text equal to' : 'text containing'} ${quote(step.text)}`;
      return () =>
        onSingle(step.target, locator, expected, async (element) => {
          const text = await element.innerText({ timeout: 1_000 });
          return { pass: textMatches(text, step.text, step.match), actual: quote(normalizeText(text)) };
        });
    }
    case 'expectValue': {
      const locator = resolveTarget(page, step.target);
      return () =>
        onSingle(step.target, locator, `value ${quote(step.value)}`, async (element) => {
          const value = await element.inputValue({ timeout: 1_000 });
          return { pass: value === step.value, actual: quote(value) };
        });
    }
    case 'expectCount': {
      const locator = resolveTarget(page, step.target);
      return async () => {
        const count = await locator.count();
        return { pass: count === step.count, targetCount: count, expected: `${step.count} elements`, actual: `${count} elements` };
      };
    }
    case 'expectUrl':
      return async () => {
        const url = new URL(page.url());
        const path = `${url.pathname}${url.search}`;
        return { pass: path.includes(step.pathPattern), expected: `path containing ${quote(step.pathPattern)}`, actual: quote(path) };
      };
    case 'expectTitle':
      return async () => {
        const title = await page.title();
        return { pass: textMatches(title, step.text, step.match), expected: `title ${step.match === 'equals' ? 'equal to' : 'containing'} ${quote(step.text)}`, actual: quote(title) };
      };
    default:
      return undefined;
  }
}

async function act(step: Step, page: Page, timeouts: StepTimeouts): Promise<void> {
  const timeout = timeouts.actionMs;
  switch (step.action) {
    case 'click':
    case 'check':
    case 'uncheck':
    case 'hover':
      await resolveTarget(page, step.target)[step.action]({ timeout });
      return;
    case 'fill':
      await resolveTarget(page, step.target).fill(step.value, { timeout });
      return;
    case 'selectOption':
      await resolveTarget(page, step.target).selectOption(step.value, { timeout });
      return;
    case 'press':
      if (step.target) await resolveTarget(page, step.target).press(step.key, { timeout });
      else await page.keyboard.press(step.key);
      return;
    case 'waitFor':
      await resolveTarget(page, step.target).waitFor({ state: step.state, timeout });
      return;
    default:
      throw new Error(`unsupported action ${step.action}`);
  }
}

export interface ExecuteStepOptions {
  /** `TARGET_BASE_URL`: `goto` paths keep its path prefix, and the page must stay on its origin. */
  baseUrl: string;
  timeouts?: StepTimeouts;
  /**
   * After a `goto`, wait until no first-party request has been in flight for
   * `quietMs` (at most `timeoutMs`). Not settling is not a failure: assertions
   * poll anyway. Omitted: no wait beyond `domcontentloaded`.
   */
  settle?: SettleSettings;
}

async function navigate(page: Page, url: string, baseUrl: string, timeouts: StepTimeouts, settle: SettleSettings | undefined): Promise<void> {
  if (settle === undefined) {
    await page.goto(url, { timeout: timeouts.navigationMs, waitUntil: 'domcontentloaded' });
    return;
  }
  const network = trackFirstPartyRequests(page as unknown as SettleEventSource, { baseUrl, ...settle });
  try {
    await page.goto(url, { timeout: timeouts.navigationMs, waitUntil: 'domcontentloaded' });
    await network.waitForSettle();
  } finally {
    network.dispose();
  }
}

async function runStepOn(page: Page, step: Step, options: ExecuteStepOptions, timeouts: StepTimeouts): Promise<StepOutcome> {
  if (step.action === 'goto') {
    try {
      await navigate(page, joinTargetUrl(options.baseUrl, step.path), options.baseUrl, timeouts, options.settle);
      return { ok: true };
    } catch (error) {
      return { ok: false, kind: 'navigation', message: firstLine(error) };
    }
  }
  const evaluate = evaluator(page, step);
  if (evaluate === undefined) {
    try {
      await act(step, page, timeouts);
      return { ok: true };
    } catch (error) {
      return { ok: false, kind: 'action', message: firstLine(error) };
    }
  }
  const result = await poll(evaluate, timeouts);
  if ('error' in result) return { ok: false, kind: 'error', message: result.error };
  if (result.pass) return { ok: true };
  const detail: StepFailureDetail = { kind: 'assertion', message: result.ambiguous ? `target matches ${result.targetCount} elements; a more specific target or nth is needed` : 'assertion failed' };
  if (result.targetCount !== undefined) detail.targetCount = result.targetCount;
  if (result.ambiguous) detail.ambiguous = true;
  if (result.expected !== undefined) detail.expected = result.expected;
  if (result.actual !== undefined) detail.actual = result.actual;
  return { ok: false, ...detail };
}

/**
 * Executes one plan step on a page. Never throws: every failure is returned as
 * data. Whatever the step's own outcome, if the page is no longer on the target
 * origin afterwards (a link, a redirect or a script took it elsewhere), the step
 * fails with the kind `off-origin`, so nothing is evaluated on a foreign page.
 */
export async function executeStep(page: Page, step: Step, options: ExecuteStepOptions): Promise<StepOutcome> {
  const outcome = await runStepOn(page, step, options, options.timeouts ?? DEFAULT_STEP_TIMEOUTS);
  const foreign = offTargetOrigin(page.url(), options.baseUrl);
  return foreign === undefined ? outcome : { ok: false, kind: 'off-origin', message: foreign };
}

export type BrowserLauncher = (options: LaunchOptions) => Promise<Browser>;

/**
 * Launches one Chromium and opens one hardened context per session: base URL
 * (plan paths are joined to it with {@link joinTargetUrl}, so its path prefix is
 * kept), the optional storage state, service workers blocked (they could bypass the
 * route guard), downloads refused, and in read-only mode the guard installed on
 * the context before any page is created. Every `goto` waits for the first-party
 * network to settle (`options.settle`, default 1 s quiet within 30 s).
 */
export async function createPlaywrightPlanDriver(
  options: PlanDriverOptions,
  launch: BrowserLauncher = (launchOptions) => chromium.launch(launchOptions),
  timeouts: StepTimeouts = DEFAULT_STEP_TIMEOUTS,
): Promise<PlanDriver> {
  const browser = await launch({ headless: true });
  return {
    async openSession(): Promise<PlanSession> {
      const contextOptions: BrowserContextOptions = {
        baseURL: options.baseUrl,
        ...(options.storageStatePath ? { storageState: options.storageStatePath } : {}),
        serviceWorkers: 'block',
        acceptDownloads: false,
      };
      const context: BrowserContext = await browser.newContext(contextOptions);
      let blocked: BlockedRequest[] = [];
      let page: Page;
      try {
        if (options.policy.mode === 'read-only') {
          blocked = await installReadOnlyGuard(context as unknown as RoutableTarget, {
            baseUrl: options.baseUrl,
            allowedMutations: options.policy.allowedMutations,
            allowedHosts: options.policy.allowedHosts,
          });
        }
        page = await context.newPage();
        page.setDefaultTimeout(timeouts.actionMs);
        page.setDefaultNavigationTimeout(timeouts.navigationMs);
      } catch (error) {
        await context.close().catch(() => undefined);
        throw error;
      }
      return {
        runStep: (step) => executeStep(page, step, { baseUrl: options.baseUrl, timeouts, settle: options.settle ?? DEFAULT_SETTLE }),
        screenshot: async (path) => {
          const foreign = offTargetOrigin(page.url(), options.baseUrl);
          if (foreign !== undefined) throw new Error(`refusing to capture a page outside the target site (${foreign})`);
          await page.screenshot({ path, fullPage: true, timeout: timeouts.actionMs });
        },
        blockedRequests: () => blocked,
        startTracing: () => context.tracing.start({ screenshots: true, snapshots: true, sources: false }),
        stopTracing: (path) => context.tracing.stop({ path }),
        close: () => context.close(),
      };
    },
    close: () => browser.close(),
  };
}
