import { parse } from 'tldts';

/**
 * The registrable domain (eTLD+1) of a hostname per the Public Suffix List,
 * ICANN and private sections (`staging.chupaprecios.com.mx` → `chupaprecios.com.mx`,
 * `team-a.github.io` → `team-a.github.io`). Undefined for IP addresses,
 * `localhost` and hostnames without a known public suffix.
 */
export function registrableDomain(hostname: string): string | undefined {
  const result = parse(hostname, { allowPrivateDomains: true });
  if (result.isIp || !(result.isIcann || result.isPrivate)) return undefined;
  return result.domain ?? undefined;
}

/**
 * True when both URLs belong to the same site: the same registrable domain, so
 * production (`chupaprecios.com.mx`) and staging (`staging.chupaprecios.com.mx`)
 * match. Without a registrable domain (IP addresses, `localhost`) the hosts,
 * port included, must be identical. Unparseable URLs never match.
 */
export function sameSite(urlA: string, urlB: string): boolean {
  let a: URL;
  let b: URL;
  try {
    a = new URL(urlA);
    b = new URL(urlB);
  } catch {
    return false;
  }
  const domainA = registrableDomain(a.hostname);
  const domainB = registrableDomain(b.hostname);
  if (domainA === undefined || domainB === undefined) return a.host === b.host;
  return domainA === domainB;
}
