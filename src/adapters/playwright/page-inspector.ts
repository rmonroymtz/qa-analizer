import { chromium, type Browser, type BrowserContextOptions, type LaunchOptions } from '@playwright/test';
import type { EnvironmentPolicy } from '../../domain/environment.js';
import type { PageInspector, PageSnapshot } from '../../ports/page-inspector.js';
import { DEFAULT_SETTLE, trackFirstPartyRequests, type NetworkSettleResult, type SettleEventSource, type SettleTimers } from './network-settle.js';
import { installReadOnlyGuard, type BlockedRequest, type RoutableTarget } from './read-only-guard.js';

export const DEFAULT_MAX_SNAPSHOT_CHARS = 30_000;

export interface PlaywrightPageInspectorOptions {
  baseUrl: string;
  policy: EnvironmentPolicy;
  storageStatePath?: string | undefined;
  maxSnapshotChars?: number;
  navigationTimeoutMs?: number;
  /** Quiet window with no first-party request in flight before the snapshot (default 1000 ms). */
  settleQuietMs?: number;
  /** Cap on that wait; at the cap the snapshot is taken and flagged `loadIncomplete` (default 30000 ms). */
  settleTimeoutMs?: number;
  /** Injectable for tests; defaults to real timers. */
  settleTimers?: SettleTimers;
  launchOptions?: LaunchOptions;
  /** Injectable for tests; defaults to launching Chromium. */
  launch?: (options: LaunchOptions) => Promise<Browser>;
}

/** Cuts a snapshot to `maxChars`, appending a marker that states how much was kept. */
export function truncateSnapshot(snapshot: string, maxChars: number): string {
  if (snapshot.length <= maxChars) return snapshot;
  return `${snapshot.slice(0, maxChars)}\n... [snapshot truncated: ${maxChars} of ${snapshot.length} chars shown]`;
}

/** Captures the accessibility snapshot of a page so test generation is grounded in real structure. */
export class PlaywrightPageInspector implements PageInspector {
  /** Requests blocked by the read-only guard across all inspections. */
  readonly blockedRequests: BlockedRequest[] = [];

  constructor(private readonly options: PlaywrightPageInspectorOptions) {}

  async inspect(url: string): Promise<PageSnapshot> {
    const launch = this.options.launch ?? ((launchOptions: LaunchOptions) => chromium.launch(launchOptions));
    const browser = await launch({ headless: true, ...this.options.launchOptions });
    let blocked: BlockedRequest[] = [];
    try {
      const contextOptions: BrowserContextOptions = { baseURL: this.options.baseUrl };
      if (this.options.storageStatePath) contextOptions.storageState = this.options.storageStatePath;
      // Service workers could issue requests that bypass the read-only route guard.
      if (this.options.policy.mode === 'read-only') contextOptions.serviceWorkers = 'block';
      const context = await browser.newContext(contextOptions);
      if (this.options.policy.mode === 'read-only') {
        blocked = await installReadOnlyGuard(context as unknown as RoutableTarget, {
          baseUrl: this.options.baseUrl,
          allowedMutations: this.options.policy.allowedMutations,
          allowedHosts: this.options.policy.allowedHosts,
        });
      }
      const page = await context.newPage();
      // Tracked before goto so the requests the navigation starts are counted. Plain
      // networkidle is not used: third-party analytics or polling may never go idle.
      const network = trackFirstPartyRequests(page as unknown as SettleEventSource, {
        baseUrl: this.options.baseUrl,
        quietMs: this.options.settleQuietMs ?? DEFAULT_SETTLE.quietMs,
        timeoutMs: this.options.settleTimeoutMs ?? DEFAULT_SETTLE.timeoutMs,
        ...(this.options.settleTimers ? { timers: this.options.settleTimers } : {}),
      });
      let settle: NetworkSettleResult;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.options.navigationTimeoutMs ?? 30_000 });
        settle = await network.waitForSettle();
      } finally {
        network.dispose();
      }
      const snapshot: PageSnapshot = {
        url: page.url(),
        title: await page.title(),
        ariaSnapshot: truncateSnapshot(
          await page.locator('body').ariaSnapshot(),
          this.options.maxSnapshotChars ?? DEFAULT_MAX_SNAPSHOT_CHARS,
        ),
      };
      if (!settle.settled) snapshot.loadIncomplete = { pendingRequests: settle.pending };
      await context.close();
      return snapshot;
    } finally {
      this.blockedRequests.push(...blocked);
      await browser.close();
    }
  }
}
