import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  defaultLauncher,
  PlaywrightTestRunner,
  renderConfig,
  renderFixtures,
  sanitizedChildEnv,
  type ProcessLauncher,
} from '../../../src/adapters/playwright/playwright-test-runner.js';
import type { Ticket } from '../../../src/domain/ticket.js';
import type { GeneratedSuite } from '../../../src/ports/test-generator.js';

const PW_URL = 'file:///opt/qa/node_modules/@playwright/test/index.mjs';
const GUARD_URL = 'file:///opt/qa/dist/adapters/playwright/read-only-guard.js';

describe('renderFixtures', () => {
  it('imports Playwright by absolute URL and installs the guard in read-only mode', () => {
    const code = renderFixtures({
      playwrightModuleUrl: PW_URL,
      guardModuleUrl: GUARD_URL,
      guard: { baseUrl: 'https://shop.example.com', allowedMutations: ['/login'] },
    });
    expect(code).toContain(`from '${PW_URL}'`);
    expect(code).toContain(`from '${GUARD_URL}'`);
    expect(code).toContain('installReadOnlyGuard');
    expect(code).toContain('"allowedMutations":["/login"]');
    expect(code).toContain('export { expect }');
    expect(code).not.toMatch(/from '@playwright\/test'/);
  });

  it('does not install the guard in full mode', () => {
    const code = renderFixtures({ playwrightModuleUrl: PW_URL, guardModuleUrl: GUARD_URL, guard: undefined });
    expect(code).toContain(`from '${PW_URL}'`);
    expect(code).not.toContain('installReadOnlyGuard');
    expect(code).not.toContain(GUARD_URL);
  });
});

describe('renderConfig', () => {
  const config = renderConfig({
    playwrightModuleUrl: PW_URL,
    testDir: '/out/generated',
    outputDir: '/out',
    baseUrl: 'https://shop.example.com',
    storageStatePath: '/out/.auth/state.json',
  });

  it('uses absolute imports and paths', () => {
    expect(config).toContain(`from '${PW_URL}'`);
    expect(config).toContain('"testDir":"/out/generated"');
    expect(config).toContain('"outputFile":"/out/results.json"');
    expect(config).toContain('"outputDir":"/out/test-results"');
  });

  it('sets retries, workers, timeout, evidence and storage state', () => {
    const parsed = JSON.parse(config.slice(config.indexOf('defineConfig(') + 'defineConfig('.length, config.lastIndexOf(')')));
    expect(parsed).toMatchObject({
      retries: 0,
      workers: 1,
      timeout: 60_000,
      use: {
        baseURL: 'https://shop.example.com',
        storageState: '/out/.auth/state.json',
        trace: 'off',
        screenshot: 'only-on-failure',
      },
      reporter: [['json', { outputFile: '/out/results.json' }], ['list']],
    });
  });

  it('blocks service workers only in read-only mode', () => {
    const base = { playwrightModuleUrl: PW_URL, testDir: '/t', outputDir: '/o', baseUrl: 'https://x.test' };
    expect(renderConfig({ ...base, readOnly: true })).toContain('"serviceWorkers":"block"');
    expect(renderConfig(base)).not.toContain('serviceWorkers');
  });

  const parse = (text: string) => JSON.parse(text.slice(text.indexOf('defineConfig(') + 'defineConfig('.length, text.lastIndexOf(')')));
  const base = { playwrightModuleUrl: PW_URL, testDir: '/t', outputDir: '/o', baseUrl: 'https://x.test' };

  it.each([
    ['unauthenticated full mode', {}, 'retain-on-failure'],
    ['authenticated full mode', { storageStatePath: '/s.json' }, 'off'],
    ['unauthenticated read-only mode', { readOnly: true }, 'off'],
    ['authenticated read-only mode', { storageStatePath: '/s.json', readOnly: true }, 'off'],
  ])('trace setting for %s is %s (traces hold request headers and cookies)', (_label, extra, trace) => {
    const parsed = parse(renderConfig({ ...base, ...extra }));
    expect(parsed.use.trace).toBe(trace);
    expect(parsed.use.screenshot).toBe('only-on-failure');
  });

  it('retries only in read-only mode, so a retry never replays a mutation', () => {
    expect(parse(renderConfig(base)).retries).toBe(0);
    expect(parse(renderConfig({ ...base, storageStatePath: '/s.json' })).retries).toBe(0);
    expect(parse(renderConfig({ ...base, readOnly: true })).retries).toBe(1);
  });

  it('omits storageState when there is no session', () => {
    expect(renderConfig({ playwrightModuleUrl: PW_URL, testDir: '/t', outputDir: '/o', baseUrl: 'https://x.test' })).not.toContain('storageState');
  });
});

describe('sanitizedChildEnv', () => {
  it('drops credentials and keeps the rest', () => {
    const env = sanitizedChildEnv({
      PATH: '/usr/bin',
      PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright',
      JIRA_API_TOKEN: 't',
      JIRA_EMAIL: 'e',
      ANTHROPIC_API_KEY: 'k',
      TEST_USER: 'u',
      TEST_PASSWORD: 'p',
      MY_SECRET: 's',
    });
    expect(env).toEqual({ PATH: '/usr/bin', PLAYWRIGHT_BROWSERS_PATH: '/ms-playwright' });
  });
});

describe('PlaywrightTestRunner', () => {
  const ticket: Ticket = {
    key: 'SHOP-1',
    summary: 's',
    description: '',
    acceptanceCriteria: [{ id: 'AC-1', text: 'x' }, { id: 'AC-2', text: 'y' }],
    url: 'u',
  };
  const suite: GeneratedSuite = {
    specCode: "import { test, expect } from './qa-fixtures';\n",
    criteria: [{ criterionId: 'AC-1', testTitle: '[AC-1] t' }],
    uncoverable: [{ criterionId: 'AC-2', reason: 'not visible in the UI' }],
  };
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  function runner(launch: ProcessLauncher) {
    return new PlaywrightTestRunner({ launch, cliPath: '/opt/qa/cli.js', playwrightModuleUrl: PW_URL, guardModuleUrl: GUARD_URL });
  }

  it('writes the generated files, runs the CLI and classifies results.json', async () => {
    dir = await mkdtemp(join(tmpdir(), 'qa-runner-'));
    const outputDir = dir;
    const calls: { args: string[]; cwd: string }[] = [];
    const launch: ProcessLauncher = async (args, options) => {
      calls.push({ args, cwd: options.cwd });
      await writeFile(
        join(outputDir, 'results.json'),
        JSON.stringify({ errors: [], suites: [{ title: 'f', specs: [{ title: '[AC-1] t', tests: [{ status: 'expected', results: [{ status: 'passed', retry: 0, errors: [], attachments: [] }] }] }] }] }),
      );
      return { exitCode: 0, stderrTail: '' };
    };

    const results = await runner(launch).run(suite, {
      baseUrl: 'https://shop.example.com',
      environment: 'production',
      policy: { mode: 'read-only', allowedMutations: [] },
      outputDir,
      ticket,
    });

    expect(results).toEqual([
      { criterionId: 'AC-1', status: 'PASSED', reason: 'test passed' },
      { criterionId: 'AC-2', status: 'INCONCLUSIVE', reason: 'not coverable: not visible in the UI' },
    ]);
    expect(calls[0]?.args).toEqual(['/opt/qa/cli.js', 'test', '--config', join(outputDir, 'generated', 'playwright.config.mjs')]);
    expect(await readFile(join(outputDir, 'generated', 'verification.spec.ts'), 'utf8')).toBe(suite.specCode);
    expect(await readFile(join(outputDir, 'generated', 'qa-fixtures.ts'), 'utf8')).toContain('installReadOnlyGuard');
    expect(JSON.parse(await readFile(join(outputDir, 'generated', 'package.json'), 'utf8'))).toEqual({ type: 'module' });
  });

  it('marks every criterion INCONCLUSIVE with the stderr tail when results.json is missing', async () => {
    dir = await mkdtemp(join(tmpdir(), 'qa-runner-'));
    const launch: ProcessLauncher = async () => ({ exitCode: 1, stderrTail: 'Error: browserType.launch: Executable does not exist' });

    const results = await runner(launch).run(suite, {
      baseUrl: 'https://shop.example.com',
      environment: 'staging',
      policy: { mode: 'full', allowedMutations: [] },
      outputDir: dir,
      ticket,
    });

    expect(results.map((result) => result.status)).toEqual(['INCONCLUSIVE', 'INCONCLUSIVE']);
    expect(results[0]?.reason).toContain('test execution failed');
    expect(results[0]?.reason).toContain('Executable does not exist');
    expect(results[1]?.reason).toContain('not coverable');
  });

  it.each([
    ['request.post', "await request.post('/api/orders', { data: {} });"],
    ['page.request.delete', "await page.request.delete('/api/orders/1');"],
    ['node fetch', "await fetch('https://shop.example.com/api/orders', { method: 'POST' });"],
  ])('refuses to run a read-only spec that uses %s, without launching', async (_label, line) => {
    let launched = false;
    const launch: ProcessLauncher = async () => {
      launched = true;
      return { exitCode: 0, stderrTail: '' };
    };
    const results = await runner(launch).run(
      { ...suite, specCode: `${suite.specCode}${line}\n` },
      { baseUrl: 'https://shop.example.com', environment: 'production', policy: { mode: 'read-only', allowedMutations: [] }, outputDir: '/nonexistent', ticket },
    );
    expect(launched).toBe(false);
    expect(results[0]?.status).toBe('INCONCLUSIVE');
    expect(results[0]?.reason).toContain('direct HTTP client');
  });

  it.each([
    ['test.use serviceWorkers', "test.use({ serviceWorkers: 'allow' });"],
    ['routeWebSocket', "await page.routeWebSocket('**', (ws) => ws.connectToServer());"],
    ['unroute', 'await context.unrouteAll();'],
  ])('refuses to run a read-only spec that overrides a guard setting with %s', async (_label, line) => {
    let launched = false;
    const launch: ProcessLauncher = async () => {
      launched = true;
      return { exitCode: 0, stderrTail: '' };
    };
    const results = await runner(launch).run(
      { ...suite, specCode: `${suite.specCode}${line}\n` },
      { baseUrl: 'https://shop.example.com', environment: 'production', policy: { mode: 'read-only', allowedMutations: [] }, outputDir: '/nonexistent', ticket },
    );
    expect(launched).toBe(false);
    expect(results[0]?.status).toBe('INCONCLUSIVE');
    expect(results[0]?.reason).toContain('read-only guard');
  });
});

describe('defaultLauncher', () => {
  const isAlive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it('on timeout kills the whole process group, including grandchildren such as browsers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa-launcher-'));
    const pidFile = join(dir, 'grandchild.pid');
    // The child starts a long-lived grandchild (standing in for Chromium), records its pid, and hangs.
    const script = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });",
      `writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));`,
      'setTimeout(() => {}, 60000);',
    ].join('\n');
    let grandchildPid: number | undefined;
    try {
      const result = await defaultLauncher(['-e', script], { cwd: dir, env: process.env, timeoutMs: 1_000 });
      expect(result.stderrTail).toContain('killed by SIGKILL');
      grandchildPid = Number(await readFile(pidFile, 'utf8'));
      const deadline = Date.now() + 2_000;
      while (isAlive(grandchildPid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
      expect(isAlive(grandchildPid)).toBe(false);
    } finally {
      if (grandchildPid !== undefined && isAlive(grandchildPid)) process.kill(grandchildPid, 'SIGKILL');
      await rm(dir, { recursive: true, force: true });
    }
  }, 10_000);
});
