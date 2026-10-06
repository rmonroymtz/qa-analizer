/**
 * Resolves a plan path against `TARGET_BASE_URL`, keeping the base path prefix:
 * with the base `https://h/app/`, the path `/x` becomes `https://h/app/x`, not
 * `https://h/x` as standard URL resolution (and Playwright's `baseURL`) would do.
 * The query and fragment of the base are dropped. A path that does not start
 * with a single `/` (an absolute URL, or a relative one) is resolved the standard way.
 */
export function joinTargetUrl(baseUrl: string, path: string): string {
  const base = new URL(baseUrl);
  if (!path.startsWith('/') || path.startsWith('//')) return new URL(path, base).toString();
  return `${base.origin}${base.pathname.replace(/\/+$/, '')}${path}`;
}

function describeOrigin(url: URL): string {
  if (url.origin !== 'null') return url.origin;
  return url.host ? `${url.protocol}//${url.host}` : url.protocol;
}

/**
 * Returns the origin of `pageUrl` when it is not the origin of the target site,
 * or undefined while the page stays on the target (or has not navigated yet:
 * `about:blank`). Every other scheme counts as having left the target.
 */
export function offTargetOrigin(pageUrl: string, baseUrl: string): string | undefined {
  if (pageUrl === 'about:blank') return undefined;
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return 'an unparseable URL';
  }
  return page.origin !== 'null' && page.origin === new URL(baseUrl).origin ? undefined : describeOrigin(page);
}
