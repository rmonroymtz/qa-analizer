import { describe, expect, it } from 'vitest';
import { installReadOnlyGuard, shouldBlockRequest } from '../../../src/adapters/playwright/read-only-guard.js';
import { loadConfig } from '../../../src/config/load-config.js';

const options = { baseUrl: 'https://shop.example.com', allowedMutations: ['/login', '/api/search', '/api/session/**', '/cart/*/view', '^/graphql/query-\\w+$'] };

describe('shouldBlockRequest', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'delete'])('blocks %s to a non-allowed path on the target host', (method) => {
    expect(shouldBlockRequest({ method, url: 'https://shop.example.com/api/orders' }, options)).toBe(true);
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('lets %s through', (method) => {
    expect(shouldBlockRequest({ method, url: 'https://shop.example.com/api/orders' }, options)).toBe(false);
  });

  it('ignores mutations to other hosts', () => {
    expect(shouldBlockRequest({ method: 'POST', url: 'https://analytics.thirdparty.io/collect' }, options)).toBe(false);
  });

  it('treats a different port as a different host', () => {
    expect(shouldBlockRequest({ method: 'POST', url: 'https://shop.example.com:8443/api/orders' }, options)).toBe(false);
  });

  it('matches the host case-insensitively', () => {
    expect(shouldBlockRequest({ method: 'POST', url: 'https://SHOP.example.com/api/orders' }, options)).toBe(true);
  });

  it('allows exact allowed paths, ignoring the query string and a trailing slash', () => {
    expect(shouldBlockRequest({ method: 'POST', url: 'https://shop.example.com/login?next=/home' }, options)).toBe(false);
    expect(shouldBlockRequest({ method: 'POST', url: 'https://shop.example.com/login/' }, options)).toBe(false);
  });

  it('does not treat an allowed path as a prefix', () => {
    expect(shouldBlockRequest({ method: 'POST', url: 'https://shop.example.com/login-admin' }, options)).toBe(true);
    expect(shouldBlockRequest({ method: 'POST', url: 'https://shop.example.com/api/search/save' }, options)).toBe(true);
  });

  it('supports ** and * globs', () => {
    expect(shouldBlockRequest({ method: 'POST', url: 'https://shop.example.com/api/session/refresh/token' }, options)).toBe(false);
    expect(shouldBlockRequest({ method: 'POST', url: 'https://shop.example.com/cart/42/view' }, options)).toBe(false);
    expect(shouldBlockRequest({ method: 'POST', url: 'https://shop.example.com/cart/42/items/view' }, options)).toBe(true);
  });

  it('supports regex patterns starting with ^', () => {
    expect(shouldBlockRequest({ method: 'POST', url: 'https://shop.example.com/graphql/query-products' }, options)).toBe(false);
    expect(shouldBlockRequest({ method: 'POST', url: 'https://shop.example.com/graphql/mutation-order' }, options)).toBe(true);
  });

  it('fails closed on an invalid regex pattern', () => {
    const invalid = { baseUrl: options.baseUrl, allowedMutations: ['^/broken($'] };
    expect(shouldBlockRequest({ method: 'POST', url: 'https://shop.example.com/broken(' }, invalid)).toBe(true);
  });

  it('respects a base URL with a path prefix only by host', () => {
    const prefixed = { baseUrl: 'https://shop.example.com/app/', allowedMutations: [] };
    expect(shouldBlockRequest({ method: 'POST', url: 'https://shop.example.com/other' }, prefixed)).toBe(true);
  });

  it('does not block unparseable URLs such as data URLs', () => {
    expect(shouldBlockRequest({ method: 'POST', url: 'data:text/plain,hello' }, options)).toBe(false);
  });
});

describe('installReadOnlyGuard', () => {
  it('aborts blocked requests, continues the rest and records what it blocked', async () => {
    let handler: ((route: FakeRoute) => Promise<void>) | undefined;
    const target = {
      route: async (pattern: string, routeHandler: (route: FakeRoute) => Promise<void>) => {
        expect(pattern).toBe('**/*');
        handler = routeHandler;
      },
    };
    const blocked = await installReadOnlyGuard(target, options);

    const mutation = new FakeRoute('POST', 'https://shop.example.com/api/orders');
    const read = new FakeRoute('GET', 'https://shop.example.com/api/orders');
    await handler?.(mutation);
    await handler?.(read);

    expect(mutation.outcome).toBe('abort:blockedbyclient');
    expect(read.outcome).toBe('continue');
    expect(blocked).toEqual([{ method: 'POST', url: 'https://shop.example.com/api/orders' }]);
  });
});

describe('config to guard wiring', () => {
  const env = {
    TARGET_BASE_URL: 'https://shop.example.com',
    QA_ENV: 'production',
    JIRA_BASE_URL: 'https://acme.atlassian.net',
    JIRA_EMAIL: 'qa@example.com',
    JIRA_API_TOKEN: 'token',
    QA_AUTH_MODE: 'form',
    TEST_USER: 'user',
    TEST_PASSWORD: 'secret',
    QA_LOGIN_PATH: '/auth/login',
    QA_LOGIN_USER_SELECTOR: '#u',
    QA_LOGIN_PASSWORD_SELECTOR: '#p',
    QA_LOGIN_SUBMIT_SELECTOR: '#s',
    QA_READONLY_ALLOW: '/api/search',
  };

  it('a production config allows login and listed paths but blocks other mutations', () => {
    const config = loadConfig(['verify'], env);
    expect(config.policy.mode).toBe('read-only');
    const guard = { baseUrl: config.targetBaseUrl, allowedMutations: config.policy.allowedMutations };
    expect(shouldBlockRequest({ method: 'POST', url: 'https://shop.example.com/auth/login' }, guard)).toBe(false);
    expect(shouldBlockRequest({ method: 'POST', url: 'https://shop.example.com/api/search' }, guard)).toBe(false);
    expect(shouldBlockRequest({ method: 'POST', url: 'https://shop.example.com/api/checkout' }, guard)).toBe(true);
  });

  it('a staging config is full mode', () => {
    expect(loadConfig(['verify'], { ...env, QA_ENV: 'staging' }).policy.mode).toBe('full');
  });
});

class FakeRoute {
  outcome: string | undefined;
  constructor(
    private readonly method: string,
    private readonly url: string,
  ) {}
  request() {
    return { method: () => this.method, url: () => this.url };
  }
  async abort(errorCode?: string) {
    this.outcome = `abort:${errorCode}`;
  }
  async continue() {
    this.outcome = 'continue';
  }
}
