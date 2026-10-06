export interface GuardOptions {
  baseUrl: string;
  /** Path globs (`*` = one segment, `**` = any) or regex strings starting with `^`, matched against the pathname. */
  allowedMutations: string[];
  /** Hostnames (exact, case-insensitive) to which every mutating request is allowed. */
  allowedHosts?: string[] | undefined;
}

export interface RequestInfo {
  method: string;
  url: string;
}

export interface BlockedRequest {
  method: string;
  url: string;
}

/** The subset of a Playwright route used by the guard. */
export interface GuardRoute {
  request(): { method(): string; url(): string };
  abort(errorCode?: string): Promise<void>;
  continue(): Promise<void>;
}

/** The subset of a Playwright WebSocket route used by the guard. */
export interface GuardWebSocketRoute {
  url(): string;
  close(options?: { code?: number; reason?: string }): Promise<void>;
}

/** Anything with Playwright-compatible `route` and `routeWebSocket` methods: a BrowserContext or a Page. */
export interface RoutableTarget {
  route(url: string, handler: (route: GuardRoute) => Promise<void>): Promise<void>;
  routeWebSocket(
    url: (url: URL) => boolean,
    handler: (webSocket: GuardWebSocketRoute) => Promise<void> | void,
  ): Promise<void>;
}

/** Allowlist: only these methods are non-mutating. Any other method, standard or not, is treated as mutating. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** WebSocket close code 1008: policy violation. */
const POLICY_VIOLATION = 1008;

function globToRegExp(glob: string): RegExp {
  const source = glob
    .split('**')
    .map((part) =>
      part
        .split('*')
        .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
        .join('[^/]*'),
    )
    .join('.*');
  return new RegExp(`^${source.replace(/\/$/, '')}/?$`);
}

function patternMatches(pattern: string, pathname: string): boolean {
  try {
    const regex = pattern.startsWith('^') ? new RegExp(pattern) : globToRegExp(pattern);
    return regex.test(pathname);
  } catch {
    // An invalid pattern never allows anything: fail closed.
    return false;
  }
}

function parseUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

function normalizedAllowedHosts(options: GuardOptions): string[] {
  return (options.allowedHosts ?? []).map((host) => host.trim().toLowerCase());
}

/**
 * Decides whether a request must be blocked in read-only mode: every method
 * other than GET, HEAD and OPTIONS, to any host, is blocked, except to an
 * allowed host, or to an allowed path on the target host.
 */
export function shouldBlockRequest(request: RequestInfo, options: GuardOptions): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return false;
  const requested = parseUrl(request.url);
  // Only network requests can mutate server state; data: and blob: URLs never leave the browser.
  if (requested === undefined || (requested.protocol !== 'http:' && requested.protocol !== 'https:')) return false;
  if (normalizedAllowedHosts(options).includes(requested.hostname)) return false;
  const target = parseUrl(options.baseUrl);
  if (target === undefined || requested.host !== target.host) return true;
  return !options.allowedMutations.some((pattern) => patternMatches(pattern, requested.pathname));
}

/**
 * Routes every request through the read-only decision. Blocked requests are aborted
 * and recorded in the returned array, which keeps filling while the target lives.
 * WebSockets are closed for every host except the allowed hosts, and recorded with
 * the method `WEBSOCKET`. Service workers must be blocked separately, when the
 * context is created (`serviceWorkers: 'block'`), because a service worker could
 * otherwise issue requests that bypass `route`.
 *
 * Fails closed: throws if the base URL does not parse or the target cannot route
 * WebSockets.
 *
 * Known limitation: once an allowed request is continued, the browser follows its
 * redirects without passing them through `route` again, so the redirect targets
 * are not re-checked.
 */
export async function installReadOnlyGuard(target: RoutableTarget, options: GuardOptions): Promise<BlockedRequest[]> {
  if (parseUrl(options.baseUrl) === undefined) {
    throw new Error('Read-only guard: the base URL does not parse; refusing to run without a guard');
  }
  if (typeof target.routeWebSocket !== 'function') {
    throw new Error('Read-only guard: the target cannot route WebSockets; refusing to run without a guard');
  }
  const blocked: BlockedRequest[] = [];
  const allowedHosts = normalizedAllowedHosts(options);
  await target.route('**/*', async (route) => {
    const request = route.request();
    const info = { method: request.method(), url: request.url() };
    if (shouldBlockRequest(info, options)) {
      blocked.push(info);
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  await target.routeWebSocket(
    (url) => !allowedHosts.includes(url.hostname.toLowerCase()),
    async (webSocket) => {
      // Never calling connectToServer() means the page never reaches the real server.
      blocked.push({ method: 'WEBSOCKET', url: webSocket.url() });
      await webSocket.close({ code: POLICY_VIOLATION, reason: 'blocked by the qa-analyzer read-only guard' });
    },
  );
  return blocked;
}
