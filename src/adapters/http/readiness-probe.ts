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
  /** When set, the response body must contain this SHA (full or first 7 chars). */
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
    if (body.includes(commit) || body.includes(commit.slice(0, 7))) return undefined;
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
