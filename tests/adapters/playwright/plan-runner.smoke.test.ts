import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlaywrightPlanRunner } from '../../../src/adapters/playwright/plan-runner.js';
import { createPlaywrightPlanDriver } from '../../../src/adapters/playwright/playwright-plan-driver.js';
import type { TestPlan } from '../../../src/domain/test-plan.js';
import type { Ticket } from '../../../src/domain/ticket.js';

const PAGE = `<!doctype html>
<html><head><title>Shop</title></head><body>
<h1>Sale</h1>
<p role="status" id="status">Idle</p>
<button id="save">Save</button>
<button id="offers">Open offers</button>
<script>
document.getElementById('offers').addEventListener('click', () => {
  window.open('/popup', '_blank');
});
document.getElementById('save').addEventListener('click', async () => {
  const status = document.getElementById('status');
  try {
    const response = await fetch('/api/save', { method: 'POST' });
    status.textContent = response.ok ? 'Saved' : 'Error';
  } catch {
    status.textContent = 'Error';
  }
});
</script>
</body></html>`;

/** Opened as a popup (a new page in the same context): it tries to POST and reports the outcome to its opener. */
const POPUP = `<!doctype html>
<html><head><title>Offers</title></head><body>
<script>
const report = (text) => { window.opener.document.getElementById('status').textContent = text; };
fetch('/api/popup', { method: 'POST' }).then((response) => report(response.ok ? 'Popup posted' : 'Popup error'), () => report('Popup blocked'));
</script>
</body></html>`;

/**
 * Variant selectors as on the real site: option values are ASIN-like codes, not
 * the visible labels, and one value ("4") collides with another option's label.
 */
const VARIANTS = `<!doctype html>
<html><head><title>Variants</title></head><body>
<label for="size">Size</label>
<select id="size">
  <option value="B0D28HQVG1">3</option>
  <option value="B0D28HQVG3">4</option>
  <option value="4">5</option>
  <option value="B0D28HQVG9" disabled>6</option>
</select>
<button disabled>Add to cart</button>
<button>Notify me</button>
</body></html>`;

const browserAvailable = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

const ticket: Ticket = {
  key: 'SHOP-1',
  summary: 's',
  description: '',
  acceptanceCriteria: ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5'].map((id) => ({ id, text: id })),
  url: 'https://jira.example.com/browse/SHOP-1',
};

const plan: TestPlan = {
  tests: [
    { criterionId: 'AC-1', title: '[AC-1] heading', mutating: false, steps: [{ action: 'goto', path: '/' }, { action: 'expectVisible', target: { role: 'heading', name: 'Sale' } }] },
    { criterionId: 'AC-2', title: '[AC-2] title', mutating: false, steps: [{ action: 'goto', path: '/' }, { action: 'expectTitle', text: 'Checkout', match: 'equals' }] },
    { criterionId: 'AC-3', title: '[AC-3] badge', mutating: false, steps: [{ action: 'goto', path: '/' }, { action: 'expectVisible', target: { text: 'Discount badge' } }] },
    {
      criterionId: 'AC-4',
      title: '[AC-4] save',
      mutating: false,
      steps: [
        { action: 'goto', path: '/' },
        { action: 'click', target: { role: 'button', name: 'Save' } },
        { action: 'expectText', target: { role: 'status' }, text: 'Saved', match: 'equals' },
      ],
    },
    {
      criterionId: 'AC-5',
      title: '[AC-5] popup',
      mutating: false,
      steps: [
        { action: 'goto', path: '/' },
        { action: 'click', target: { role: 'button', name: 'Open offers' } },
        { action: 'expectText', target: { role: 'status' }, text: 'Popup blocked', match: 'equals' },
      ],
    },
  ],
  uncoverable: [],
};

describe.skipIf(!browserAvailable)('PlaywrightPlanRunner with a real browser', () => {
  let server: Server;
  let baseUrl: string;
  let outputDir: string;
  const posts: string[] = [];

  beforeAll(async () => {
    server = createServer((request, response) => {
      if (request.method !== 'GET') posts.push(`${request.method} ${request.url}`);
      const html = request.url === '/' ? PAGE : request.url === '/popup' ? POPUP : request.url === '/variants' ? VARIANTS : undefined;
      response.writeHead(200, { 'content-type': html ? 'text/html' : 'text/plain' });
      response.end(html ?? 'ok');
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    outputDir = await mkdtemp(join(tmpdir(), 'qa-plan-smoke-'));
  });

  afterAll(async () => {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(outputDir, { recursive: true, force: true });
  });

  it('classifies PASSED, FAILED, a missing element and blocked POSTs (also from a popup) in read-only mode', async () => {
    const runner = new PlaywrightPlanRunner({
      driverFactory: (options) => createPlaywrightPlanDriver(options, undefined, { actionMs: 3_000, assertionMs: 1_500, navigationMs: 10_000, pollMs: 50 }),
    });
    const results = await runner.run(plan, { baseUrl, environment: 'production', policy: { mode: 'read-only', allowedMutations: [] }, outputDir, ticket });

    expect(results[0]).toEqual({ criterionId: 'AC-1', status: 'PASSED', reason: 'test passed' });
    expect(results[1]).toMatchObject({
      criterionId: 'AC-2',
      status: 'FAILED',
      evidence: { expected: 'title equal to "Checkout"', actual: '"Shop"', screenshotPath: join(outputDir, 'screenshots', 'AC-2.png') },
    });
    expect(existsSync(join(outputDir, 'screenshots', 'AC-2.png'))).toBe(true);
    expect(results[2]).toMatchObject({ criterionId: 'AC-3', status: 'INCONCLUSIVE', reason: expect.stringContaining('expected element not found') });
    expect(results[3]).toMatchObject({ criterionId: 'AC-4', status: 'INCONCLUSIVE', reason: expect.stringContaining(`blocked requests: POST ${baseUrl}/api/save`) });
    // The guard is installed on the context, so it also covers a popup opened by the page.
    expect(results[4]).toEqual({ criterionId: 'AC-5', status: 'PASSED', reason: 'test passed' });
    expect(posts).toEqual([]);
  }, 60_000);
  it('writes a Playwright trace per executed criterion when tracing is on, also for a failed test', async () => {
    const runner = new PlaywrightPlanRunner({
      trace: true,
      driverFactory: (options) => createPlaywrightPlanDriver(options, undefined, { actionMs: 3_000, assertionMs: 1_500, navigationMs: 10_000, pollMs: 50 }),
    });
    const tracePlan: TestPlan = { tests: plan.tests.slice(0, 2), uncoverable: [] };
    const results = await runner.run(tracePlan, { baseUrl, environment: 'staging', policy: { mode: 'full', allowedMutations: [] }, outputDir, ticket });

    expect(results[0]).toEqual({ criterionId: 'AC-1', status: 'PASSED', reason: 'test passed', evidence: { tracePath: join(outputDir, 'traces', 'AC-1.zip') } });
    expect(results[1]).toMatchObject({ criterionId: 'AC-2', status: 'FAILED', evidence: { tracePath: join(outputDir, 'traces', 'AC-2.zip') } });
    expect(existsSync(join(outputDir, 'traces', 'AC-1.zip'))).toBe(true);
    expect(existsSync(join(outputDir, 'traces', 'AC-2.zip'))).toBe(true);
    expect(existsSync(join(outputDir, 'traces', 'AC-3.zip'))).toBe(false);
  }, 60_000);

  it('asserts disabled, enabled and selected options by visible label on a select whose values are codes', async () => {
    const size = { role: 'combobox', name: 'Size' } as const;
    const pick = [{ action: 'goto', path: '/variants' }, { action: 'selectOption', target: size, value: '4' }] as const;
    const variantPlan: TestPlan = {
      tests: [
        {
          criterionId: 'AC-1',
          title: '[AC-1] pass',
          mutating: false,
          steps: [
            ...pick,
            { action: 'expectSelectedOption', target: size, value: '4' },
            { action: 'expectDisabled', target: { role: 'option', name: '6', exact: true } },
            { action: 'expectEnabled', target: { role: 'option', name: '5', exact: true } },
            { action: 'expectDisabled', target: { role: 'button', name: 'Add to cart' } },
            { action: 'expectEnabled', target: { role: 'button', name: 'Notify me' } },
          ],
        },
        { criterionId: 'AC-2', title: '[AC-2] wrong option', mutating: false, steps: [...pick, { action: 'expectSelectedOption', target: size, value: '5' }] },
        { criterionId: 'AC-3', title: '[AC-3] not disabled', mutating: false, steps: [...pick, { action: 'expectDisabled', target: { role: 'button', name: 'Notify me' } }] },
        { criterionId: 'AC-4', title: '[AC-4] not enabled', mutating: false, steps: [...pick, { action: 'expectEnabled', target: { role: 'option', name: '6', exact: true } }] },
        { criterionId: 'AC-5', title: '[AC-5] not a select', mutating: false, steps: [...pick, { action: 'expectSelectedOption', target: { role: 'button', name: 'Notify me' }, value: '4' }] },
      ],
      uncoverable: [],
    };
    const runner = new PlaywrightPlanRunner({
      driverFactory: (options) => createPlaywrightPlanDriver(options, undefined, { actionMs: 3_000, assertionMs: 1_500, navigationMs: 10_000, pollMs: 50 }),
    });
    const results = await runner.run(variantPlan, { baseUrl, environment: 'staging', policy: { mode: 'full', allowedMutations: [] }, outputDir, ticket });

    expect(results[0]).toEqual({ criterionId: 'AC-1', status: 'PASSED', reason: 'test passed' });
    expect(results[1]).toMatchObject({ criterionId: 'AC-2', status: 'FAILED', evidence: { expected: 'selected option "5"', actual: '"4"' } });
    expect(results[2]).toMatchObject({ criterionId: 'AC-3', status: 'FAILED', evidence: { expected: 'disabled', actual: 'enabled' } });
    expect(results[3]).toMatchObject({ criterionId: 'AC-4', status: 'FAILED', evidence: { expected: 'enabled', actual: 'disabled' } });
    expect(results[4]).toMatchObject({ criterionId: 'AC-5', status: 'INCONCLUSIVE', reason: expect.stringContaining('needs a native <select> target, found <button>') });
  }, 60_000);
});
