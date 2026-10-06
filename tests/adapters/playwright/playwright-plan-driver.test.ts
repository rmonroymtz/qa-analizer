import type { Browser } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { createPlaywrightPlanDriver } from '../../../src/adapters/playwright/playwright-plan-driver.js';
import type { EnvironmentPolicy } from '../../../src/domain/environment.js';

function fakeBrowser() {
  const events: string[] = [];
  const contextOptions: Record<string, unknown>[] = [];
  const browser = {
    newContext: async (options: Record<string, unknown>) => {
      contextOptions.push(options);
      events.push('newContext');
      return {
        route: async () => {
          events.push('route');
        },
        routeWebSocket: async () => {
          events.push('routeWebSocket');
        },
        newPage: async () => {
          events.push('newPage');
          return {
            setDefaultTimeout: () => events.push('setDefaultTimeout'),
            setDefaultNavigationTimeout: () => events.push('setDefaultNavigationTimeout'),
          };
        },
        close: async () => {
          events.push('closeContext');
        },
      };
    },
    close: async () => {
      events.push('closeBrowser');
    },
  };
  return { browser: browser as unknown as Browser, events, contextOptions };
}

const readOnly: EnvironmentPolicy = { mode: 'read-only', allowedMutations: ['/login'], allowedHosts: [] };
const full: EnvironmentPolicy = { mode: 'full', allowedMutations: [] };

describe('createPlaywrightPlanDriver', () => {
  it('creates a hardened context per session and installs the guard before any page exists', async () => {
    const fake = fakeBrowser();
    const driver = await createPlaywrightPlanDriver(
      { baseUrl: 'https://shop.example.com', policy: readOnly, storageStatePath: '/tmp/state.json' },
      async () => fake.browser,
    );
    const session = await driver.openSession();
    expect(fake.contextOptions[0]).toEqual({
      baseURL: 'https://shop.example.com',
      storageState: '/tmp/state.json',
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    expect(fake.events.slice(0, 4)).toEqual(['newContext', 'route', 'routeWebSocket', 'newPage']);
    await session.close();
    await driver.close();
    expect(fake.events.slice(-2)).toEqual(['closeContext', 'closeBrowser']);
  });

  it('installs no guard in full mode and omits a missing storage state', async () => {
    const fake = fakeBrowser();
    const driver = await createPlaywrightPlanDriver({ baseUrl: 'https://staging.example.com', policy: full }, async () => fake.browser);
    await driver.openSession();
    expect(fake.contextOptions[0]).toEqual({ baseURL: 'https://staging.example.com', serviceWorkers: 'block', acceptDownloads: false });
    expect(fake.events).not.toContain('route');
  });

  it('closes the context when the guard cannot be installed', async () => {
    const fake = fakeBrowser();
    const driver = await createPlaywrightPlanDriver({ baseUrl: 'not a url', policy: readOnly }, async () => fake.browser);
    await expect(driver.openSession()).rejects.toThrow(/base URL/);
    expect(fake.events).toEqual(['newContext', 'closeContext']);
  });
});
