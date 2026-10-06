import { mkdir as fsMkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Browser } from '@playwright/test';
import type { AuthConfig } from '../../config/load-config.js';
import type { EnvironmentPolicy } from '../../domain/environment.js';
import { installReadOnlyGuard, type RoutableTarget } from './read-only-guard.js';

export type FormAuthConfig = Extract<AuthConfig, { mode: 'form' }>;

export interface FormLoginConfig {
  targetBaseUrl: string;
  outputDir: string;
  policy: EnvironmentPolicy;
  auth: FormAuthConfig;
}

export interface FormLoginDeps {
  mkdir?: (path: string, options: { recursive: true }) => Promise<unknown>;
}

/** The login failed. The message names the step but never the credentials. */
export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginError';
  }
}

const LOGIN_TIMEOUT_MS = 30_000;

/** The subset of a Playwright page used to detect a successful login. */
interface LoginSignalPage {
  waitForURL(url: (url: URL) => boolean, options: { timeout: number }): Promise<void>;
  locator(selector: string): { waitFor(options: { state: 'hidden'; timeout: number }): Promise<void> };
}

/** Origin plus pathname without a trailing slash, used to compare against the login page. */
function pageKey(url: URL): string {
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

function loginPageKey(loginPath: string, baseUrl: string): string {
  return pageKey(new URL(loginPath, baseUrl));
}

/**
 * Without a configured success URL, a bare `load` event proves nothing (a wrong
 * password usually reloads the login page). Success needs a positive signal:
 * the page leaves the login URL, or the password field is detached or hidden.
 */
async function waitForLoginSignal(page: LoginSignalPage, loginKey: string, passwordSelector: string): Promise<void> {
  try {
    await Promise.any([
      page.waitForURL((url) => pageKey(url) !== loginKey, { timeout: LOGIN_TIMEOUT_MS }),
      page.locator(passwordSelector).waitFor({ state: 'hidden', timeout: LOGIN_TIMEOUT_MS }),
    ]);
  } catch {
    throw new LoginError('could not confirm successful login: still on the login page with the password field visible');
  }
}

/**
 * Hand-written (never AI-generated) form login. Saves the authenticated storage
 * state to `<outputDir>/.auth/state.json` and returns that path.
 */
export async function performFormLogin(
  config: FormLoginConfig,
  browser: Browser,
  deps: FormLoginDeps = {},
): Promise<string> {
  const { auth } = config;
  const storageStatePath = join(config.outputDir, '.auth', 'state.json');
  const scrub = (text: string) =>
    [auth.password, auth.user].filter(Boolean).reduce((current, secret) => current.split(secret).join('***'), text);

  const readOnly = config.policy.mode === 'read-only';
  const context = await browser.newContext(
    readOnly ? { baseURL: config.targetBaseUrl, serviceWorkers: 'block' } : { baseURL: config.targetBaseUrl },
  );
  let step = 'open login page';
  try {
    if (readOnly) {
      await installReadOnlyGuard(context as unknown as RoutableTarget, {
        baseUrl: config.targetBaseUrl,
        allowedMutations: config.policy.allowedMutations,
        allowedHosts: config.policy.allowedHosts,
      });
    }
    const page = await context.newPage();
    await page.goto(auth.loginPath, { timeout: LOGIN_TIMEOUT_MS });
    step = 'fill user';
    await page.fill(auth.userSelector, auth.user, { timeout: LOGIN_TIMEOUT_MS });
    step = 'fill password';
    await page.fill(auth.passwordSelector, auth.password, { timeout: LOGIN_TIMEOUT_MS });
    step = 'submit';
    await page.click(auth.submitSelector, { timeout: LOGIN_TIMEOUT_MS });
    step = 'wait for successful login';
    if (auth.successUrlPattern) {
      await page.waitForURL(new RegExp(auth.successUrlPattern), { timeout: LOGIN_TIMEOUT_MS });
    } else {
      await waitForLoginSignal(page, loginPageKey(auth.loginPath, config.targetBaseUrl), auth.passwordSelector);
    }
    step = 'save storage state';
    await (deps.mkdir ?? fsMkdir)(dirname(storageStatePath), { recursive: true });
    await context.storageState({ path: storageStatePath });
    return storageStatePath;
  } catch (error) {
    if (error instanceof LoginError) throw new LoginError(scrub(error.message));
    const reason = error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error);
    throw new LoginError(scrub(`Form login failed at step "${step}": ${reason}`));
  } finally {
    await context.close().catch(() => undefined);
  }
}
