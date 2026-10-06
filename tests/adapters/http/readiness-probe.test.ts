import { describe, expect, it } from 'vitest';
import {
  HttpReadinessProbe,
  ReadinessTimeoutError,
  readinessProbeFromConfig,
  type Clock,
} from '../../../src/adapters/http/readiness-probe.js';

function fakeClock(): Clock & { elapsed: () => number; sleeps: number[] } {
  let now = 1_000;
  const start = now;
  const sleeps: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    elapsed: () => now - start,
    sleeps,
  };
}

function scriptedFetch(responses: (() => Response)[]) {
  const urls: string[] = [];
  let index = 0;
  const fetchFn: typeof fetch = async (input) => {
    urls.push(String(input));
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    if (!next) throw new Error('no response scripted');
    return next();
  };
  return { fetchFn, urls, calls: () => index };
}

const ok = (body = 'ok') => () => new Response(body, { status: 200 });
const unavailable = () => new Response('down', { status: 503 });
const networkError = () => {
  throw new TypeError('fetch failed');
};

describe('HttpReadinessProbe', () => {
  it('resolves on the first 2xx when no commit is expected', async () => {
    const clock = fakeClock();
    const { fetchFn, urls } = scriptedFetch([ok()]);
    await new HttpReadinessProbe({ url: 'https://app.example.com', timeoutMs: 60_000, fetch: fetchFn, clock }).waitUntilReady();
    expect(urls).toEqual(['https://app.example.com']);
    expect(clock.sleeps).toEqual([]);
  });

  it('polls through errors and non-2xx responses at the configured interval', async () => {
    const clock = fakeClock();
    const { fetchFn, calls } = scriptedFetch([networkError, unavailable, ok()]);
    await new HttpReadinessProbe({
      url: 'https://app.example.com/health',
      timeoutMs: 60_000,
      intervalMs: 5_000,
      fetch: fetchFn,
      clock,
    }).waitUntilReady();
    expect(calls()).toBe(3);
    expect(clock.sleeps).toEqual([5_000, 5_000]);
  });

  it('waits until the body contains the expected commit (full or short SHA)', async () => {
    const sha = 'abcdef1234567890abcdef1234567890abcdef12';
    const clock = fakeClock();
    const { fetchFn, calls } = scriptedFetch([ok('{"version":"0123456"}'), ok('{"version":"abcdef1"}')]);
    await new HttpReadinessProbe({
      url: 'https://app.example.com/version',
      timeoutMs: 60_000,
      expectedCommit: sha,
      fetch: fetchFn,
      clock,
    }).waitUntilReady();
    expect(calls()).toBe(2);

    const full = scriptedFetch([ok(`commit=${sha}`)]);
    await new HttpReadinessProbe({
      url: 'https://app.example.com/version',
      timeoutMs: 60_000,
      expectedCommit: sha,
      fetch: full.fetchFn,
      clock: fakeClock(),
    }).waitUntilReady();
    expect(full.calls()).toBe(1);
  });

  it('throws ReadinessTimeoutError once the overall timeout elapses', async () => {
    const clock = fakeClock();
    const { fetchFn } = scriptedFetch([unavailable]);
    const error = await new HttpReadinessProbe({
      url: 'https://user:pw@app.example.com/health',
      timeoutMs: 12_000,
      intervalMs: 5_000,
      fetch: fetchFn,
      clock,
    })
      .waitUntilReady()
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ReadinessTimeoutError);
    expect(clock.elapsed()).toBe(12_000);
    expect(clock.sleeps).toEqual([5_000, 5_000, 2_000]);
    const message = (error as Error).message;
    expect(message).toContain('503');
    expect(message).toContain('app.example.com/health');
    expect(message).not.toContain('pw@');
  });

  it('mentions the missing commit in the timeout message', async () => {
    const { fetchFn } = scriptedFetch([ok('old')]);
    const error = await new HttpReadinessProbe({
      url: 'https://app.example.com/version',
      timeoutMs: 5_000,
      expectedCommit: 'abcdef1234',
      fetch: fetchFn,
      clock: fakeClock(),
    })
      .waitUntilReady()
      .catch((caught: unknown) => caught);
    expect((error as Error).message).toContain('abcdef1');
  });
});

describe('readinessProbeFromConfig', () => {
  const base = {
    targetBaseUrl: 'https://app.example.com',
    git: { commit: 'abcdef1234567' },
  };

  it('polls QA_READY_URL and expects the commit when both are set', async () => {
    const { fetchFn, urls } = scriptedFetch([ok('abcdef1')]);
    const probe = readinessProbeFromConfig(
      { ...base, readiness: { url: 'https://app.example.com/version', timeoutMs: 1_000 } },
      { fetch: fetchFn, clock: fakeClock() },
    );
    await probe.waitUntilReady();
    expect(urls).toEqual(['https://app.example.com/version']);
    expect(probe.options.expectedCommit).toBe('abcdef1234567');
  });

  it('falls back to the target base URL without a commit check', async () => {
    const { fetchFn, urls } = scriptedFetch([ok('anything')]);
    const probe = readinessProbeFromConfig(
      { ...base, readiness: { url: undefined, timeoutMs: 1_000 } },
      { fetch: fetchFn, clock: fakeClock() },
    );
    await probe.waitUntilReady();
    expect(urls).toEqual(['https://app.example.com']);
    expect(probe.options.expectedCommit).toBeUndefined();
  });
});
