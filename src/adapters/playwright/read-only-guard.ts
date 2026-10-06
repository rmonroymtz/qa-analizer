export interface GuardOptions {
  baseUrl: string;
  /** Path globs (`*` = one segment, `**` = any) or regex strings starting with `^`, matched against the pathname. */
  allowedMutations: string[];
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

/** Anything with a Playwright-compatible `route` method: a BrowserContext or a Page. */
export interface RoutableTarget {
  route(url: string, handler: (route: GuardRoute) => Promise<void>): Promise<void>;
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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

/**
 * Decides whether a request must be blocked in read-only mode: a mutating method,
 * sent to the target host, to a path that is not explicitly allowed.
 */
export function shouldBlockRequest(request: RequestInfo, options: GuardOptions): boolean {
  if (!MUTATING_METHODS.has(request.method.toUpperCase())) return false;
  let target: URL;
  let requested: URL;
  try {
    target = new URL(options.baseUrl);
    requested = new URL(request.url);
  } catch {
    return false;
  }
  if (requested.host !== target.host) return false;
  return !options.allowedMutations.some((pattern) => patternMatches(pattern, requested.pathname));
}

/**
 * Routes every request through the read-only decision. Blocked requests are aborted
 * and recorded in the returned array, which keeps filling while the target lives.
 */
export async function installReadOnlyGuard(target: RoutableTarget, options: GuardOptions): Promise<BlockedRequest[]> {
  const blocked: BlockedRequest[] = [];
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
  return blocked;
}
