import { join } from 'node:path';
import type { Browser } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { LoginError, performFormLogin, type FormLoginConfig } from '../../../src/adapters/playwright/form-login.js';
import { PlaywrightPageInspector, truncateSnapshot } from '../../../src/adapters/playwright/page-inspector.js';

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

interface AfterSubmit {
  /** The URL the page shows after the submit click. */
  url: string;
  /** Whether the password field disappears after the submit click. */
  passwordHides: boolean;
}

/** Minimal fake of the Playwright surface used by the login, recording each step. */
function fakeBrowser(failOn?: string, afterSubmit: AfterSubmit = { url: 'https://app.example.com/home', passwordHides: false }) {
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
    waitForURL: async (pattern: RegExp | ((url: URL) => boolean)) => {
      if (pattern instanceof RegExp) return step(`waitForURL ${pattern.source}`);
      steps.push('waitForURL leave login');
      if (!pattern(new URL(afterSubmit.url))) throw new Error('Timeout 30000ms exceeded waiting for URL');
    },
    waitForLoadState: (state: string) => step(`waitForLoadState ${state}`),
    locator: (selector: string) => ({
      waitFor: async (options: { state: string }) => {
        steps.push(`waitFor ${selector} ${options.state}`);
        if (!afterSubmit.passwordHides) throw new Error('Timeout 30000ms exceeded waiting for locator');
      },
    }),
  };
  const context = {
    route: async () => {
      steps.push('route');
    },
    routeWebSocket: async () => {
      steps.push('routeWebSocket');
    },
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

  const withoutPattern: FormLoginConfig = { ...config, auth: { ...config.auth, successUrlPattern: undefined } };

  it('without a success URL, accepts leaving the login page', async () => {
    const fake = fakeBrowser(undefined, { url: 'https://app.example.com/home', passwordHides: false });
    await performFormLogin(withoutPattern, fake.browser, { mkdir: async () => undefined });
    expect(fake.steps).toContain('waitForURL leave login');
    expect(fake.steps).not.toContain('waitForLoadState load');
    expect(fake.steps.some((recorded) => recorded.startsWith('storageState'))).toBe(true);
  });

  it('without a success URL, accepts the password field disappearing on the same URL', async () => {
    const fake = fakeBrowser(undefined, { url: 'https://app.example.com/login?step=2', passwordHides: true });
    await performFormLogin(withoutPattern, fake.browser, { mkdir: async () => undefined });
    expect(fake.steps).toContain('waitFor #password hidden');
    expect(fake.steps.some((recorded) => recorded.startsWith('storageState'))).toBe(true);
  });

  it('without a success URL, rejects a login that stays on the login page with the password visible', async () => {
    const fake = fakeBrowser(undefined, { url: 'https://app.example.com/login/', passwordHides: false });
    const error = await performFormLogin(withoutPattern, fake.browser, { mkdir: async () => undefined }).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LoginError);
    expect((error as LoginError).message).toContain('could not confirm successful login');
    expect(fake.steps.some((recorded) => recorded.startsWith('storageState'))).toBe(false);
    expect(fake.steps.at(-1)).toBe('close');
  });

  it('in read-only mode, blocks service workers and installs the guard before opening the page', async () => {
    const fake = fakeBrowser();
    await performFormLogin({ ...config, policy: { mode: 'read-only', allowedMutations: ['/login'] } }, fake.browser, {
      mkdir: async () => undefined,
    });
    expect(fake.contextOptions()).toEqual({ baseURL: 'https://app.example.com', serviceWorkers: 'block' });
    expect(fake.steps.slice(0, 3)).toEqual(['route', 'routeWebSocket', 'goto /login']);
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

describe('PlaywrightPageInspector', () => {
  it('blocks service workers and installs the guard in read-only mode', async () => {
    const calls: string[] = [];
    let contextOptions: unknown;
    const page = {
      goto: async () => undefined,
      waitForLoadState: async () => undefined,
      url: () => 'https://app.example.com/',
      title: async () => 'Home',
      locator: () => ({ ariaSnapshot: async () => '- heading "Home"' }),
    };
    const context = {
      route: async () => {
        calls.push('route');
      },
      routeWebSocket: async () => {
        calls.push('routeWebSocket');
      },
      newPage: async () => page,
      close: async () => undefined,
    };
    const browser = {
      newContext: async (options: unknown) => {
        contextOptions = options;
        return context;
      },
      close: async () => undefined,
    } as unknown as Browser;
    const inspector = new PlaywrightPageInspector({
      baseUrl: 'https://app.example.com',
      policy: { mode: 'read-only', allowedMutations: [] },
      launch: async () => browser,
    });
    const snapshot = await inspector.inspect('/');
    expect(snapshot.title).toBe('Home');
    expect(contextOptions).toEqual({ baseURL: 'https://app.example.com', serviceWorkers: 'block' });
    expect(calls).toEqual(['route', 'routeWebSocket']);
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
