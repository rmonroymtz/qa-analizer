import { EventEmitter } from 'node:events';
import type { Page } from '@playwright/test';
import { describe, expect, it } from 'vitest';
import { executeStep, type StepTimeouts } from '../../../src/adapters/playwright/playwright-plan-driver.js';
import type { Step } from '../../../src/domain/test-plan.js';

/** A fake DOM element: just enough for the semantic locators the driver builds. */
interface El {
  role?: string;
  name?: string;
  text?: string;
  label?: string;
  placeholder?: string;
  testId?: string;
  hidden?: boolean;
  value?: string;
  children?: El[];
  onClick?: () => void;
}

const BASE = 'https://shop.example.com';
const FAST: StepTimeouts = { actionMs: 50, assertionMs: 30, navigationMs: 50, pollMs: 5 };

function descendants(elements: readonly El[]): El[] {
  return elements.flatMap((element) => [element, ...descendants(element.children ?? [])]);
}

function nameMatches(actual: string | undefined, expected: string, exact: boolean | undefined): boolean {
  if (actual === undefined) return false;
  return exact ? actual === expected : actual.toLowerCase().includes(expected.toLowerCase());
}

/** A fake Playwright locator over a lazily computed list of elements (lazy like the real one). */
class FakeLocator {
  constructor(
    private readonly elements: () => El[],
    private readonly log: string[],
  ) {}

  private query(predicate: (element: El) => boolean): FakeLocator {
    return new FakeLocator(() => this.elements().flatMap((element) => descendants(element.children ?? []).filter(predicate)), this.log);
  }

  private one(): El {
    const elements = this.elements();
    if (elements.length !== 1) throw new Error(`strict mode violation: resolved to ${elements.length} elements`);
    return elements[0] as El;
  }

  getByRole(role: string, options: { name?: string; exact?: boolean } = {}) {
    return this.query((element) => element.role === role && (options.name === undefined || nameMatches(element.name, options.name, options.exact)));
  }

  getByText(text: string, options: { exact?: boolean } = {}) {
    return this.query((element) => nameMatches(element.text, text, options.exact));
  }

  getByLabel(label: string) {
    return this.query((element) => element.label === label);
  }

  getByPlaceholder(placeholder: string) {
    return this.query((element) => element.placeholder === placeholder);
  }

  getByTestId(testId: string) {
    return this.query((element) => element.testId === testId);
  }

  nth(index: number) {
    return new FakeLocator(() => {
      const element = this.elements()[index];
      return element ? [element] : [];
    }, this.log);
  }

  async count() {
    return this.elements().length;
  }

  async isVisible() {
    return !this.one().hidden;
  }

  async innerText() {
    return this.one().text ?? '';
  }

  async inputValue() {
    return this.one().value ?? '';
  }

  async click() {
    const element = this.one();
    this.log.push(`click:${element.name ?? element.text ?? '?'}`);
    element.onClick?.();
  }

  async press(key: string) {
    const element = this.one();
    this.log.push(`press:${key}@${element.label ?? element.name ?? '?'}`);
  }
}

function fakePage(elements: El[], initialUrl = `${BASE}/`) {
  const log: string[] = [];
  const state = { url: initialUrl };
  const root = new FakeLocator(() => [{ children: elements }], log);
  const page = {
    getByRole: root.getByRole.bind(root),
    getByText: root.getByText.bind(root),
    getByLabel: root.getByLabel.bind(root),
    getByPlaceholder: root.getByPlaceholder.bind(root),
    getByTestId: root.getByTestId.bind(root),
    url: () => state.url,
    title: async () => 'Shop',
    goto: async (url: string) => {
      log.push(`goto:${url}`);
      state.url = url;
    },
    keyboard: {
      press: async (key: string) => {
        log.push(`keyboard:${key}`);
      },
    },
  };
  return { page: page as unknown as Page, log, state };
}

const run = (page: Page, step: Step, baseUrl = BASE) => executeStep(page, step, { baseUrl, timeouts: FAST });

describe('executeStep', () => {
  describe('expectHidden', () => {
    it('passes for a hidden element and for a target that matches nothing', async () => {
      const { page } = fakePage([{ text: 'Loading', hidden: true }]);
      expect(await run(page, { action: 'expectHidden', target: { text: 'Loading' } })).toEqual({ ok: true });
      expect(await run(page, { action: 'expectHidden', target: { text: 'Spinner' } })).toEqual({ ok: true });
    });

    it('fails with the found element still visible', async () => {
      const { page } = fakePage([{ text: 'Loading' }]);
      expect(await run(page, { action: 'expectHidden', target: { text: 'Loading' } })).toEqual({
        ok: false,
        kind: 'assertion',
        message: 'assertion failed',
        targetCount: 1,
        expected: 'hidden',
        actual: 'visible',
      });
    });

    it('reports an ambiguous target without nth', async () => {
      const { page } = fakePage([{ text: 'Loading' }, { text: 'Loading' }]);
      expect(await run(page, { action: 'expectHidden', target: { text: 'Loading' } })).toMatchObject({ ok: false, kind: 'assertion', ambiguous: true, targetCount: 2 });
    });
  });

  describe('expectCount', () => {
    const list = [{ role: 'listitem', text: 'a' }, { role: 'listitem', text: 'b' }];

    it('passes on the exact count', async () => {
      const { page } = fakePage(list);
      expect(await run(page, { action: 'expectCount', target: { role: 'listitem' }, count: 2 })).toEqual({ ok: true });
    });

    it('fails with expected and actual counts', async () => {
      const { page } = fakePage(list);
      expect(await run(page, { action: 'expectCount', target: { role: 'listitem' }, count: 3 })).toEqual({
        ok: false,
        kind: 'assertion',
        message: 'assertion failed',
        targetCount: 2,
        expected: '3 elements',
        actual: '2 elements',
      });
    });
  });

  describe('expectValue', () => {
    it('passes on the current value and fails with the actual one', async () => {
      const { page } = fakePage([{ label: 'Search', value: 'shoes' }]);
      expect(await run(page, { action: 'expectValue', target: { label: 'Search' }, value: 'shoes' })).toEqual({ ok: true });
      expect(await run(page, { action: 'expectValue', target: { label: 'Search' }, value: 'boots' })).toMatchObject({
        ok: false,
        kind: 'assertion',
        targetCount: 1,
        expected: 'value "boots"',
        actual: '"shoes"',
      });
    });

    it('reports a missing target with a count of 0', async () => {
      const { page } = fakePage([]);
      expect(await run(page, { action: 'expectValue', target: { label: 'Search' }, value: 'x' })).toMatchObject({ ok: false, kind: 'assertion', targetCount: 0, actual: 'not found' });
    });
  });

  describe('within and nth', () => {
    const elements: El[] = [
      { role: 'navigation', name: 'Main', children: [{ role: 'link', name: 'Home', text: 'Home' }, { role: 'link', name: 'Sale', text: 'Sale' }] },
      { role: 'navigation', name: 'Footer', children: [{ role: 'link', name: 'Privacy', text: 'Privacy' }, { role: 'link', name: 'Terms', text: 'Terms' }] },
    ];

    it('resolves the nth match inside the parent target only', async () => {
      const { page } = fakePage(elements);
      const target = { role: 'link', nth: 1, within: { role: 'navigation', name: 'Main' } } as const;
      expect(await run(page, { action: 'expectText', target, text: 'Sale', match: 'equals' })).toEqual({ ok: true });
      expect(await run(page, { action: 'expectText', target: { ...target, within: { role: 'navigation', name: 'Footer' } }, text: 'Sale', match: 'equals' })).toMatchObject({
        ok: false,
        kind: 'assertion',
        actual: '"Terms"',
      });
    });

    it('applies nth to the parent target', async () => {
      const { page } = fakePage(elements);
      expect(await run(page, { action: 'expectCount', target: { role: 'link', within: { role: 'navigation', nth: 1 } }, count: 2 })).toEqual({ ok: true });
      expect(await run(page, { action: 'expectVisible', target: { role: 'link', name: 'Privacy', within: { role: 'navigation', nth: 0 } } })).toMatchObject({ ok: false, targetCount: 0 });
    });

    it('is ambiguous without nth when several elements match', async () => {
      const { page } = fakePage(elements);
      expect(await run(page, { action: 'expectVisible', target: { role: 'link', within: { role: 'navigation', name: 'Main' } } })).toMatchObject({ ok: false, ambiguous: true, targetCount: 2 });
    });
  });

  describe('press', () => {
    it('presses a key on the target element', async () => {
      const { page, log } = fakePage([{ label: 'Search' }]);
      expect(await run(page, { action: 'press', key: 'Enter', target: { label: 'Search' } })).toEqual({ ok: true });
      expect(log).toEqual(['press:Enter@Search']);
    });

    it('presses a key on the focused element without a target', async () => {
      const { page, log } = fakePage([]);
      expect(await run(page, { action: 'press', key: 'Escape' })).toEqual({ ok: true });
      expect(log).toEqual(['keyboard:Escape']);
    });

    it('fails as an action when the target is missing', async () => {
      const { page } = fakePage([]);
      expect(await run(page, { action: 'press', key: 'Enter', target: { label: 'Search' } })).toMatchObject({ ok: false, kind: 'action', message: expect.stringContaining('strict mode') });
    });
  });

  describe('goto', () => {
    it('keeps the path prefix of the base URL', async () => {
      const { page, log } = fakePage([], 'about:blank');
      expect(await run(page, { action: 'goto', path: '/products?page=2' }, 'https://h.example.com/app/')).toEqual({ ok: true });
      expect(log).toEqual(['goto:https://h.example.com/app/products?page=2']);
    });

    /** A fake page whose navigation starts one first-party API request that ends after `finishAfterMs`. */
    function loadingPage(finishAfterMs: number) {
      const { page, log } = fakePage([], 'about:blank');
      const emitter = new EventEmitter();
      const api = { url: () => `${BASE}/api/products?token=x` };
      const fake = page as unknown as { goto: (url: string) => Promise<void>; url: () => string; on: unknown; off: unknown };
      let url = 'about:blank';
      fake.on = emitter.on.bind(emitter);
      fake.off = emitter.off.bind(emitter);
      fake.url = () => url;
      fake.goto = async (target: string) => {
        url = target;
        log.push('goto');
        emitter.emit('request', api);
        setTimeout(() => {
          log.push('api-done');
          emitter.emit('requestfinished', api);
        }, finishAfterMs);
      };
      return { page, log, emitter };
    }

    it('waits for the first-party requests started by the navigation to settle', async () => {
      const { page, log, emitter } = loadingPage(40);
      const outcome = await executeStep(page, { action: 'goto', path: '/p/42' }, { baseUrl: BASE, timeouts: FAST, settle: { quietMs: 10, timeoutMs: 1_000 } });
      expect(outcome).toEqual({ ok: true });
      expect(log).toEqual(['goto', 'api-done']);
      expect(emitter.listenerCount('request')).toBe(0);
    });

    it('continues without failing when the network does not settle before the cap', async () => {
      const { page, log } = loadingPage(500);
      const outcome = await executeStep(page, { action: 'goto', path: '/p/42' }, { baseUrl: BASE, timeouts: FAST, settle: { quietMs: 10, timeoutMs: 30 } });
      expect(outcome).toEqual({ ok: true });
      expect(log).toEqual(['goto']);
    });
  });

  describe('off-origin navigation', () => {
    it('fails a step that leaves the target site, whatever its own outcome', async () => {
      const { page, state } = fakePage([{ role: 'link', name: 'Partner', onClick: () => (state.url = 'https://partner.example.net/landing') }]);
      expect(await run(page, { action: 'click', target: { role: 'link', name: 'Partner' } })).toEqual({ ok: false, kind: 'off-origin', message: 'https://partner.example.net' });
      expect(await run(page, { action: 'expectTitle', text: 'Shop', match: 'equals' })).toEqual({ ok: false, kind: 'off-origin', message: 'https://partner.example.net' });
    });

    it('fails a goto that ends on another origin (for example after a redirect)', async () => {
      const { page } = fakePage([], 'about:blank');
      const redirecting = page as unknown as { goto: (url: string) => Promise<void>; url: () => string };
      let url = 'about:blank';
      redirecting.goto = async () => {
        url = 'https://sso.example.org/login';
      };
      redirecting.url = () => url;
      expect(await run(page, { action: 'goto', path: '/account' })).toEqual({ ok: false, kind: 'off-origin', message: 'https://sso.example.org' });
    });

    it('accepts any path on the target origin', async () => {
      const { page, state } = fakePage([{ role: 'link', name: 'Other', onClick: () => (state.url = `${BASE}/elsewhere`) }]);
      expect(await run(page, { action: 'click', target: { role: 'link', name: 'Other' } }, `${BASE}/app`)).toEqual({ ok: true });
    });
  });
});
