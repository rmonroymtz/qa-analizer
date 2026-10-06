import { setTimeout as sleep } from 'node:timers/promises';
import type { ReadinessProbe } from '../../ports/readiness-probe.js';

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: async (ms) => {
    await sleep(ms);
  },
};

export interface HttpReadinessProbeOptions {
  url: string;
  timeoutMs: number;
  intervalMs?: number;
  /** When set, the response body must report this SHA (full or first 7 chars) as a whole token. */
  expectedCommit?: string | undefined;
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
  clock?: Clock;
}

export class ReadinessTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReadinessTimeoutError';
  }
}

export const DEFAULT_READY_INTERVAL_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** Strips credentials and query string so the URL is safe to print. */
function safeUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '<invalid url>';
  }
}

function collectStrings(value: unknown, into: string[]): string[] {
  if (typeof value === 'string') into.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, into));
  else if (value !== null && typeof value === 'object') Object.values(value).forEach((item) => collectStrings(item, into));
  return into;
}

/**
 * True when the body reports the commit: the full SHA, or its 7-char short
 * form, as a whole hex token (case-insensitive), so a hashed asset name such
 * as `app.abc1234def.js` does not match the short SHA `abc1234`. A JSON body
 * is checked through its string values only.
 */
export function bodyReportsCommit(body: string, commit: string): boolean {
  const normalized = commit.trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(normalized)) return false;
  const token = (sha: string) => new RegExp(`(?<![0-9a-f])${sha}(?![0-9a-f])`, 'i');
  const patterns = [token(normalized), token(normalized.slice(0, 7))];
  let candidates: string[];
  try {
    candidates = collectStrings(JSON.parse(body), []);
  } catch {
    candidates = [body];
  }
  return candidates.some((candidate) => patterns.some((pattern) => pattern.test(candidate)));
}

/** Polls a URL until it answers 2xx (and, optionally, reports the expected commit). */
export class HttpReadinessProbe implements ReadinessProbe {
  readonly options: HttpReadinessProbeOptions;

  constructor(options: HttpReadinessProbeOptions) {
    this.options = options;
  }

  async waitUntilReady(): Promise<void> {
    const clock = this.options.clock ?? systemClock;
    const interval = this.options.intervalMs ?? DEFAULT_READY_INTERVAL_MS;
    const deadline = clock.now() + this.options.timeoutMs;
    for (;;) {
      const lastFailure = await this.attempt();
      if (lastFailure === undefined) return;
      const remaining = deadline - clock.now();
      if (remaining <= 0) {
        throw new ReadinessTimeoutError(
          `Target not ready after ${this.options.timeoutMs} ms polling ${safeUrl(this.options.url)}: ${lastFailure}`,
        );
      }
      await clock.sleep(Math.min(interval, remaining));
    }
  }

  /** Returns undefined when ready, otherwise the reason it is not. */
  private async attempt(): Promise<string | undefined> {
    const fetchFn = this.options.fetch ?? fetch;
    let response: Response;
    try {
      response = await fetchFn(this.options.url, {
        signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
        headers: { 'Cache-Control': 'no-cache' },
      });
    } catch (error) {
      return `request failed (${error instanceof Error ? error.message : String(error)})`;
    }
    if (!response.ok) return `last status ${response.status}`;
    const commit = this.options.expectedCommit;
    if (!commit) return undefined;
    const body = await response.text().catch(() => '');
    if (bodyReportsCommit(body, commit)) return undefined;
    return `response does not report commit ${commit.slice(0, 7)} yet`;
  }
}

export interface ReadinessSource {
  targetBaseUrl: string;
  readiness: { url: string | undefined; timeoutMs: number };
  git: { commit?: string | undefined };
}

/**
 * Builds the probe from config: with QA_READY_URL it also waits for the deployed
 * commit; otherwise it only waits for the target base URL to answer 2xx.
 */
export function readinessProbeFromConfig(
  config: ReadinessSource,
  deps: Pick<HttpReadinessProbeOptions, 'fetch' | 'clock' | 'intervalMs'> = {},
): HttpReadinessProbe {
  const readyUrl = config.readiness.url;
  return new HttpReadinessProbe({
    url: readyUrl ?? config.targetBaseUrl,
    timeoutMs: config.readiness.timeoutMs,
    expectedCommit: readyUrl ? config.git.commit : undefined,
    ...deps,
  });
}
