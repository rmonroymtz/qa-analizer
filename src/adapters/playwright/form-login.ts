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

  const context = await browser.newContext({ baseURL: config.targetBaseUrl });
  let step = 'open login page';
  try {
    if (config.policy.mode === 'read-only') {
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
      await page.waitForLoadState('load', { timeout: LOGIN_TIMEOUT_MS });
    }
    step = 'save storage state';
    await (deps.mkdir ?? fsMkdir)(dirname(storageStatePath), { recursive: true });
    await context.storageState({ path: storageStatePath });
    return storageStatePath;
  } catch (error) {
    const reason = error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error);
    throw new LoginError(scrub(`Form login failed at step "${step}": ${reason}`));
  } finally {
    await context.close().catch(() => undefined);
  }
}
