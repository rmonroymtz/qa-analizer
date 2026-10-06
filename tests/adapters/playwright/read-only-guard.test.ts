import { describe, expect, it } from 'vitest';
import { installReadOnlyGuard, shouldBlockRequest } from '../../../src/adapters/playwright/read-only-guard.js';
import { loadConfig } from '../../../src/config/load-config.js';

const options = { baseUrl: 'https://shop.example.com', allowedMutations: ['/login', '/api/search', '/api/session/**', '/cart/*/view', '^/graphql/query-\\w+$'] };

describe('shouldBlockRequest', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'delete', 'PROPFIND', 'MKCOL', 'LOCK', 'PURGE', 'CUSTOM'])('blocks %s to a non-allowed path on the target host', (method) => {
    expect(shouldBlockRequest({ method, url: 'https://shop.example.com/api/orders' }, options)).toBe(true);
  });

  it.each(['GET', 'HEAD', 'OPTIONS', 'get'])('lets %s through', (method) => {
    expect(shouldBlockRequest({ method, url: 'https://shop.example.com/api/orders' }, options)).toBe(false);
  });

  it('treats non-standard methods as mutating on other hosts too', () => {
    expect(shouldBlockRequest({ method: 'PROPPATCH', url: 'https://dav.other.io/file' }, options)).toBe(true);
  });

  it('blocks mutations to any other host', () => {
    expect(shouldBlockRequest({ method: 'POST', url: 'https://analytics.thirdparty.io/collect' }, options)).toBe(true);
    expect(shouldBlockRequest({ method: 'DELETE', url: 'https://api.other.io/items/1' }, options)).toBe(true);
  });

  it('applies allowed paths to the target host only', () => {
    expect(shouldBlockRequest({ method: 'POST', url: 'https://evil.example.org/login' }, options)).toBe(true);
    expect(shouldBlockRequest({ method: 'POST', url: 'https://shop.example.com:8443/login' }, options)).toBe(true);
  });

  it('fully allows mutations to allowed hosts, matched by hostname', () => {
    const withHosts = { ...options, allowedHosts: ['analytics.thirdparty.io', 'Auth.Example.com'] };
    expect(shouldBlockRequest({ method: 'POST', url: 'https://analytics.thirdparty.io/collect' }, withHosts)).toBe(false);
    expect(shouldBlockRequest({ method: 'PUT', url: 'https://auth.example.com:444/any/path' }, withHosts)).toBe(false);
    expect(shouldBlockRequest({ method: 'POST', url: 'https://sub.analytics.thirdparty.io/collect' }, withHosts)).toBe(true);
    expect(shouldBlockRequest({ method: 'POST', url: 'https://shop.example.com/api/orders' }, withHosts)).toBe(true);
  });

  it('still blocks other hosts when the base URL is invalid', () => {
    expect(shouldBlockRequest({ method: 'POST', url: 'https://shop.example.com/login' }, { baseUrl: 'not a url', allowedMutations: ['/login'] })).toBe(true);
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
  function fakeTarget() {
    const state: {
      handler?: (route: FakeRoute) => Promise<void>;
      wsMatcher?: (url: URL) => boolean;
      wsHandler?: (ws: FakeWebSocketRoute) => Promise<void> | void;
    } = {};
    const target = {
      route: async (_pattern: string, routeHandler: (route: FakeRoute) => Promise<void>) => {
        state.handler = routeHandler;
      },
      routeWebSocket: async (matcher: (url: URL) => boolean, wsHandler: (ws: FakeWebSocketRoute) => Promise<void> | void) => {
        state.wsMatcher = matcher;
        state.wsHandler = wsHandler;
      },
    };
    return { target, state };
  }

  it('throws at install time when the base URL does not parse', async () => {
    const { target, state } = fakeTarget();
    await expect(installReadOnlyGuard(target, { baseUrl: 'not a url', allowedMutations: [] })).rejects.toThrow(/base URL/);
    expect(state.handler).toBeUndefined();
  });

  it('refuses a target that cannot route WebSockets', async () => {
    const target = { route: async () => undefined };
    await expect(installReadOnlyGuard(target as never, options)).rejects.toThrow(/WebSocket/);
  });

  it('closes WebSockets to every host except the allowed hosts', async () => {
    const { target, state } = fakeTarget();
    const blocked = await installReadOnlyGuard(target, { ...options, allowedHosts: ['realtime.example.com'] });
    expect(state.wsMatcher?.(new URL('wss://shop.example.com/socket'))).toBe(true);
    expect(state.wsMatcher?.(new URL('wss://other.io/socket'))).toBe(true);
    expect(state.wsMatcher?.(new URL('wss://Realtime.Example.com/socket'))).toBe(false);

    const ws = new FakeWebSocketRoute('wss://shop.example.com/socket');
    await state.wsHandler?.(ws);
    expect(ws.closed).toBe(true);
    expect(ws.connected).toBe(false);
    expect(blocked).toEqual([{ method: 'WEBSOCKET', url: 'wss://shop.example.com/socket' }]);
  });

  it('aborts blocked requests, continues the rest and records what it blocked', async () => {
    let handler: ((route: FakeRoute) => Promise<void>) | undefined;
    const target = {
      route: async (pattern: string, routeHandler: (route: FakeRoute) => Promise<void>) => {
        expect(pattern).toBe('**/*');
        handler = routeHandler;
      },
      routeWebSocket: async () => undefined,
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
    QA_READONLY_ALLOW_HOSTS: 'analytics.thirdparty.io, Stats.Example.com',
  };

  it('a production config allows listed paths but blocks the login path and other mutations for the inspector and the runner', () => {
    const config = loadConfig(['verify'], env);
    expect(config.policy.mode).toBe('read-only');
    const guard = { baseUrl: config.targetBaseUrl, allowedMutations: config.policy.allowedMutations, allowedHosts: config.policy.allowedHosts };
    expect(shouldBlockRequest({ method: 'POST', url: 'https://shop.example.com/auth/login' }, guard)).toBe(true);
    expect(shouldBlockRequest({ method: 'POST', url: 'https://shop.example.com/api/search' }, guard)).toBe(false);
    expect(shouldBlockRequest({ method: 'POST', url: 'https://shop.example.com/api/checkout' }, guard)).toBe(true);
    expect(shouldBlockRequest({ method: 'POST', url: 'https://analytics.thirdparty.io/collect' }, guard)).toBe(false);
    expect(shouldBlockRequest({ method: 'POST', url: 'https://stats.example.com/hit' }, guard)).toBe(false);
    expect(shouldBlockRequest({ method: 'POST', url: 'https://other.io/hit' }, guard)).toBe(true);
  });

  it('the login guard adds the login path to the policy paths', () => {
    const config = loadConfig(['verify'], env);
    const loginPaths = config.auth.mode === 'form' ? config.auth.loginMutationPaths : [];
    const guard = { baseUrl: config.targetBaseUrl, allowedMutations: [...config.policy.allowedMutations, ...loginPaths], allowedHosts: config.policy.allowedHosts };
    expect(shouldBlockRequest({ method: 'POST', url: 'https://shop.example.com/auth/login' }, guard)).toBe(false);
    expect(shouldBlockRequest({ method: 'POST', url: 'https://shop.example.com/api/checkout' }, guard)).toBe(true);
  });

  it('parses QA_READONLY_ALLOW_HOSTS into lower-case hostnames', () => {
    expect(loadConfig(['verify'], env).policy.allowedHosts).toEqual(['analytics.thirdparty.io', 'stats.example.com']);
    expect(loadConfig(['verify'], { ...env, QA_READONLY_ALLOW_HOSTS: undefined }).policy.allowedHosts).toEqual([]);
  });

  it('rejects an allowed host that is not a bare hostname', () => {
    expect(() => loadConfig(['verify'], { ...env, QA_READONLY_ALLOW_HOSTS: 'https://x.io/path' })).toThrow(/QA_READONLY_ALLOW_HOSTS/);
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

class FakeWebSocketRoute {
  closed = false;
  connected = false;
  constructor(private readonly address: string) {}
  url() {
    return this.address;
  }
  async close() {
    this.closed = true;
  }
  connectToServer() {
    this.connected = true;
  }
}
