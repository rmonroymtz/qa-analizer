import { sameSite } from '../../domain/site.js';

export const DEFAULT_SETTLE_QUIET_MS = 1_000;
export const DEFAULT_SETTLE_TIMEOUT_MS = 30_000;
const MAX_PENDING_LISTED = 5;

/** The part of a Playwright `Request` the tracker needs. */
export interface SettleRequest {
  url(): string;
}

export type SettleEvent = 'request' | 'requestfinished' | 'requestfailed';
type SettleListener = (request: SettleRequest) => void;

/** A Playwright `Page` or `BrowserContext`, or any emitter with the same request events. */
export interface SettleEventSource {
  on(event: SettleEvent, listener: SettleListener): unknown;
  off(event: SettleEvent, listener: SettleListener): unknown;
}

/** Injectable so tests control time. */
export interface SettleTimers {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: SettleTimers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface SettleSettings {
  /** Time with no first-party request in flight that counts as settled. */
  quietMs: number;
  /** Hard cap on the wait. */
  timeoutMs: number;
}

export const DEFAULT_SETTLE: SettleSettings = { quietMs: DEFAULT_SETTLE_QUIET_MS, timeoutMs: DEFAULT_SETTLE_TIMEOUT_MS };

export interface NetworkSettleOptions extends Partial<SettleSettings> {
  /** `TARGET_BASE_URL`: requests on its registrable domain are first-party. */
  baseUrl: string;
  timers?: SettleTimers;
}

export interface NetworkSettleResult {
  settled: boolean;
  /** Up to five first-party requests still in flight at the cap: path only, never the query string. */
  pending: string[];
  waitedMs: number;
}

export interface NetworkSettleTracker {
  /** Resolves once no first-party request was in flight for the quiet window, or at the cap. Never rejects. */
  waitForSettle(): Promise<NetworkSettleResult>;
  /** Removes the listeners; call it before the page or context is closed. */
  dispose(): void;
}

/**
 * True for a request to the target's own site (the same registrable domain, so
 * `api.shop.com` counts for `staging.shop.com`). Third parties such as analytics
 * or CDNs on other domains, and `data:`/`blob:` URLs, are not first-party.
 */
export function isFirstPartyRequest(url: string, baseUrl: string): boolean {
  if (!/^https?:/i.test(url)) return false;
  return sameSite(url, baseUrl);
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '(unparseable URL)';
  }
}

/**
 * Starts counting the first-party requests in flight on `source`. Attach it
 * before navigating, so the requests the navigation starts are counted. A
 * request ends on `requestfinished` or `requestfailed` (a request blocked by the
 * read-only guard fails, so it never holds the wait). Third-party requests are
 * ignored: analytics or polling on other domains never go idle.
 */
export function trackFirstPartyRequests(source: SettleEventSource, options: NetworkSettleOptions): NetworkSettleTracker {
  const timers = options.timers ?? realTimers;
  const quietMs = options.quietMs ?? DEFAULT_SETTLE_QUIET_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS;
  const inFlight = new Set<SettleRequest>();
  // Set while a wait is running: re-arms or cancels the quiet timer when the in-flight count changes.
  let onChange: (() => void) | undefined;

  const started: SettleListener = (request) => {
    if (!isFirstPartyRequest(request.url(), options.baseUrl)) return;
    inFlight.add(request);
    onChange?.();
  };
  const ended: SettleListener = (request) => {
    if (inFlight.delete(request)) onChange?.();
  };
  source.on('request', started);
  source.on('requestfinished', ended);
  source.on('requestfailed', ended);

  return {
    waitForSettle(): Promise<NetworkSettleResult> {
      const start = timers.now();
      return new Promise((resolveWait) => {
        let quietTimer: unknown;
        const finish = (settled: boolean) => {
          onChange = undefined;
          if (quietTimer !== undefined) timers.clearTimeout(quietTimer);
          timers.clearTimeout(capTimer);
          const pending = settled ? [] : [...inFlight].slice(0, MAX_PENDING_LISTED).map((request) => pathOf(request.url()));
          resolveWait({ settled, pending, waitedMs: timers.now() - start });
        };
        const rearm = () => {
          if (quietTimer !== undefined) timers.clearTimeout(quietTimer);
          quietTimer = inFlight.size === 0 ? timers.setTimeout(() => finish(true), quietMs) : undefined;
        };
        const capTimer = timers.setTimeout(() => finish(false), timeoutMs);
        onChange = rearm;
        rearm();
      });
    },
    dispose(): void {
      source.off('request', started);
      source.off('requestfinished', ended);
      source.off('requestfailed', ended);
    },
  };
}
