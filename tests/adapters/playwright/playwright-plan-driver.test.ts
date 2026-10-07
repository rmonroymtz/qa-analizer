import type { Browser } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { createPlaywrightPlanDriver } from '../../../src/adapters/playwright/playwright-plan-driver.js';
import type { EnvironmentPolicy } from '../../../src/domain/environment.js';

function fakeBrowser(pageUrl = 'about:blank') {
  const events: string[] = [];
  const contextOptions: Record<string, unknown>[] = [];
  const browser = {
    newContext: async (options: Record<string, unknown>) => {
      contextOptions.push(options);
      events.push('newContext');
      return {
        tracing: {
          start: async (options: Record<string, unknown>) => {
            events.push(`traceStart:${JSON.stringify(options)}`);
          },
          stop: async (options: Record<string, unknown>) => {
            events.push(`traceStop:${JSON.stringify(options)}`);
          },
        },
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
            url: () => pageUrl,
            screenshot: async () => {
              events.push('screenshot');
            },
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

  it('captures a page on the target origin but refuses to capture a foreign page', async () => {
    const onTarget = fakeBrowser('https://shop.example.com/app/cart');
    const session = await (await createPlaywrightPlanDriver({ baseUrl: 'https://shop.example.com/app', policy: full }, async () => onTarget.browser)).openSession();
    await session.screenshot('/tmp/a.png');
    expect(onTarget.events).toContain('screenshot');

    const foreign = fakeBrowser('https://partner.example.net/');
    const foreignSession = await (await createPlaywrightPlanDriver({ baseUrl: 'https://shop.example.com', policy: full }, async () => foreign.browser)).openSession();
    await expect(foreignSession.screenshot('/tmp/b.png')).rejects.toThrow('refusing to capture a page outside the target site (https://partner.example.net)');
    expect(foreign.events).not.toContain('screenshot');
  });

  it('records a trace on the session context with screenshots and snapshots but no sources', async () => {
    const fake = fakeBrowser('https://shop.example.com/');
    const session = await (await createPlaywrightPlanDriver({ baseUrl: 'https://shop.example.com', policy: full }, async () => fake.browser)).openSession();
    expect(fake.events.some((event) => event.startsWith('trace'))).toBe(false);
    await session.startTracing();
    await session.stopTracing('/out/traces/AC-1.zip');
    expect(fake.events.filter((event) => event.startsWith('trace'))).toEqual([
      'traceStart:{"screenshots":true,"snapshots":true,"sources":false}',
      'traceStop:{"path":"/out/traces/AC-1.zip"}',
    ]);
  });
});
