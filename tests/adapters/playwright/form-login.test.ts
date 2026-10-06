import { join } from 'node:path';
import type { Browser } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { LoginError, performFormLogin, type FormLoginConfig } from '../../../src/adapters/playwright/form-login.js';
import { truncateSnapshot } from '../../../src/adapters/playwright/page-inspector.js';

const PASSWORD = 'very-secret-password';

const config: FormLoginConfig = {
  targetBaseUrl: 'https://app.example.com',
  outputDir: '/tmp/qa-out',
  policy: { mode: 'full', allowedMutations: ['/login'] },
  auth: {
    mode: 'form',
    user: 'qa-user',
    password: PASSWORD,
    loginPath: '/login',
    userSelector: '#user',
    passwordSelector: '#password',
    submitSelector: 'button[type=submit]',
    successUrlPattern: '/dashboard$',
  },
};

/** Minimal fake of the Playwright surface used by the login, recording each step. */
function fakeBrowser(failOn?: string) {
  const steps: string[] = [];
  let contextOptions: unknown;
  const step = async (name: string) => {
    steps.push(name);
    if (name === failOn) throw new Error(`Timeout while typing "${PASSWORD}" into ${name}`);
  };
  const page = {
    goto: (url: string) => step(`goto ${url}`),
    fill: (selector: string) => step(`fill ${selector}`),
    click: (selector: string) => step(`click ${selector}`),
    waitForURL: (pattern: RegExp) => step(`waitForURL ${pattern.source}`),
    waitForLoadState: (state: string) => step(`waitForLoadState ${state}`),
  };
  const context = {
    route: async () => undefined,
    newPage: async () => page,
    storageState: async (options: { path: string }) => step(`storageState ${options.path}`),
    close: async () => {
      steps.push('close');
    },
  };
  const browser = {
    newContext: async (options: unknown) => {
      contextOptions = options;
      return context;
    },
  } as unknown as Browser;
  return { browser, steps, contextOptions: () => contextOptions };
}

describe('performFormLogin', () => {
  it('fills the form, waits for the success URL and saves the storage state', async () => {
    const fake = fakeBrowser();
    const path = await performFormLogin(config, fake.browser, { mkdir: async () => undefined });
    const expectedPath = join('/tmp/qa-out', '.auth', 'state.json');
    expect(path).toBe(expectedPath);
    expect(fake.contextOptions()).toEqual({ baseURL: 'https://app.example.com' });
    expect(fake.steps).toEqual([
      'goto /login',
      'fill #user',
      'fill #password',
      'click button[type=submit]',
      'waitForURL \\/dashboard$',
      `storageState ${expectedPath}`,
      'close',
    ]);
  });

  it('waits for a page load when no success URL is configured', async () => {
    const fake = fakeBrowser();
    await performFormLogin(
      { ...config, auth: { ...config.auth, successUrlPattern: undefined } },
      fake.browser,
      { mkdir: async () => undefined },
    );
    expect(fake.steps).toContain('waitForLoadState load');
  });

  it('throws LoginError without secrets and still closes the context', async () => {
    const fake = fakeBrowser('fill #password');
    const error = await performFormLogin(config, fake.browser, { mkdir: async () => undefined }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LoginError);
    expect((error as LoginError).message).toContain('fill password');
    expect((error as LoginError).message).not.toContain(PASSWORD);
    expect(fake.steps.at(-1)).toBe('close');
  });
});

describe('truncateSnapshot', () => {
  it('returns short snapshots unchanged', () => {
    expect(truncateSnapshot('- heading "Hi"', 100)).toBe('- heading "Hi"');
  });

  it('truncates long snapshots with a marker', () => {
    const result = truncateSnapshot('x'.repeat(50), 10);
    expect(result.startsWith('x'.repeat(10))).toBe(true);
    expect(result).toContain('[snapshot truncated: 10 of 50 chars shown]');
  });
});
