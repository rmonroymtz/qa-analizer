import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  isFirstPartyRequest,
  trackFirstPartyRequests,
  type SettleEventSource,
  type SettleRequest,
  type SettleTimers,
} from '../../../src/adapters/playwright/network-settle.js';

const BASE = 'https://staging.shop.com.mx';

/** A manual clock: timers fire only when the test advances time. */
class FakeTimers implements SettleTimers {
  private current = 0;
  private nextId = 0;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Moves time forward, firing due timers in order. */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.current = due[1].at;
      due[1].callback();
    }
    this.current = target;
  }
}

function request(url: string): SettleRequest {
  return { url: () => url };
}

function setup(options: { quietMs?: number; timeoutMs?: number } = {}) {
  const emitter = new EventEmitter();
  const timers = new FakeTimers();
  const tracker = trackFirstPartyRequests(emitter as unknown as SettleEventSource, {
    baseUrl: BASE,
    quietMs: options.quietMs ?? 1_000,
    timeoutMs: options.timeoutMs ?? 30_000,
    timers,
  });
  return { emitter, timers, tracker };
}

/** Lets pending promise callbacks run without advancing the fake clock. */
const flush = () => new Promise((resolveFlush) => setImmediate(resolveFlush));

describe('isFirstPartyRequest', () => {
  it('accepts the same registrable domain and rejects other sites and data/blob URLs', () => {
    expect(isFirstPartyRequest('https://api.shop.com.mx/products', BASE)).toBe(true);
    expect(isFirstPartyRequest('https://shop.com.mx/', BASE)).toBe(true);
    expect(isFirstPartyRequest('https://www.google-analytics.com/collect', BASE)).toBe(false);
    expect(isFirstPartyRequest('data:image/png;base64,AAAA', BASE)).toBe(false);
    expect(isFirstPartyRequest('blob:https://staging.shop.com.mx/1234', BASE)).toBe(false);
  });
});

describe('trackFirstPartyRequests', () => {
  it('settles after the quiet window when nothing is in flight', async () => {
    const { timers, tracker } = setup();
    let done = false;
    const result = tracker.waitForSettle().then((value) => {
      done = true;
      return value;
    });
    timers.advance(999);
    await flush();
    expect(done).toBe(false);
    timers.advance(1);
    expect(await result).toEqual({ settled: true, pending: [], waitedMs: 1_000 });
  });

  it('ignores a pending third-party request', async () => {
    const { emitter, timers, tracker } = setup();
    emitter.emit('request', request('https://www.google-analytics.com/collect?v=1'));
    const result = tracker.waitForSettle();
    timers.advance(1_000);
    expect(await result).toMatchObject({ settled: true, pending: [] });
  });

  it('waits for a first-party request started before the wait until it finishes', async () => {
    const { emitter, timers, tracker } = setup();
    const api = request('https://api.shop.com.mx/products/42');
    emitter.emit('request', api);
    let done = false;
    const result = tracker.waitForSettle().then((value) => {
      done = true;
      return value;
    });
    timers.advance(6_000);
    await flush();
    expect(done).toBe(false);
    emitter.emit('requestfinished', api);
    timers.advance(999);
    await flush();
    expect(done).toBe(false);
    timers.advance(1);
    expect(await result).toEqual({ settled: true, pending: [], waitedMs: 7_000 });
  });

  it('treats a failed (for example blocked) first-party request as resolved', async () => {
    const { emitter, timers, tracker } = setup();
    const post = request('https://staging.shop.com.mx/api/cart');
    emitter.emit('request', post);
    const result = tracker.waitForSettle();
    timers.advance(500);
    emitter.emit('requestfailed', post);
    timers.advance(1_000);
    expect(await result).toEqual({ settled: true, pending: [], waitedMs: 1_500 });
  });

  it('restarts the quiet window when a first-party request starts inside it', async () => {
    const { emitter, timers, tracker } = setup();
    let done = false;
    const result = tracker.waitForSettle().then((value) => {
      done = true;
      return value;
    });
    timers.advance(800);
    const late = request('https://staging.shop.com.mx/api/stock');
    emitter.emit('request', late);
    timers.advance(300);
    emitter.emit('requestfinished', late);
    timers.advance(999);
    await flush();
    expect(done).toBe(false);
    timers.advance(1);
    expect(await result).toEqual({ settled: true, pending: [], waitedMs: 2_100 });
  });

  it('gives up at the cap and lists pending first-party paths without query strings', async () => {
    const { emitter, timers, tracker } = setup({ timeoutMs: 30_000 });
    emitter.emit('request', request('https://api.shop.com.mx/products/42?token=SECRET'));
    emitter.emit('request', request('https://www.google-analytics.com/collect'));
    const result = tracker.waitForSettle();
    timers.advance(30_000);
    const value = await result;
    expect(value).toEqual({ settled: false, pending: ['/products/42'], waitedMs: 30_000 });
    expect(JSON.stringify(value)).not.toContain('SECRET');
  });

  it('lists at most five pending paths', async () => {
    const { emitter, timers, tracker } = setup({ timeoutMs: 100 });
    for (let index = 0; index < 8; index++) emitter.emit('request', request(`https://staging.shop.com.mx/api/${index}`));
    const result = tracker.waitForSettle();
    timers.advance(100);
    expect((await result).pending).toEqual(['/api/0', '/api/1', '/api/2', '/api/3', '/api/4']);
  });

  it('stops listening when disposed', () => {
    const { emitter, tracker } = setup();
    expect(emitter.listenerCount('request')).toBe(1);
    tracker.dispose();
    expect(emitter.listenerCount('request')).toBe(0);
    expect(emitter.listenerCount('requestfinished')).toBe(0);
    expect(emitter.listenerCount('requestfailed')).toBe(0);
  });
});
