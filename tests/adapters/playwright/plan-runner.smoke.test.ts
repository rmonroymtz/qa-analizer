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
<script>
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
  acceptanceCriteria: ['AC-1', 'AC-2', 'AC-3', 'AC-4'].map((id) => ({ id, text: id })),
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
      response.writeHead(200, { 'content-type': request.url === '/' ? 'text/html' : 'text/plain' });
      response.end(request.url === '/' ? PAGE : 'ok');
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    outputDir = await mkdtemp(join(tmpdir(), 'qa-plan-smoke-'));
  });

  afterAll(async () => {
    await new Promise((resolveClose) => server.close(resolveClose));
    await rm(outputDir, { recursive: true, force: true });
  });

  it('classifies PASSED, FAILED, a missing element and a blocked POST in read-only mode', async () => {
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
    expect(posts).toEqual([]);
  }, 60_000);
});
