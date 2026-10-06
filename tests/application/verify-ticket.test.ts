import { describe, expect, it } from 'vitest';
import {
  pagesToInspect,
  renderSummaryMarkdown,
  VerifyTicketUseCase,
  type Reporter,
  type VerificationReport,
  type VerifyTicketDeps,
  type VerifyTicketRequest,
} from '../../src/application/verify-ticket.js';
import type { CriterionResult } from '../../src/domain/criterion-result.js';
import type { Ticket } from '../../src/domain/ticket.js';
import type { PageInspector } from '../../src/ports/page-inspector.js';
import type { GeneratedSuite } from '../../src/ports/test-generator.js';
import type { RunContext } from '../../src/ports/test-runner.js';
import type { VerificationComment } from '../../src/ports/ticket-commenter.js';

const SECRET = 'jira-token-1234';

const ticket: Ticket = {
  key: 'SHOP-42',
  summary: 'Sale badge',
  description: 'See https://shop.example.com/sale?x=1 and /products/shoes. Not https://other.io/x.',
  acceptanceCriteria: [
    { id: 'AC-1', text: 'Badge on /deals' },
    { id: 'AC-2', text: 'Price' },
  ],
  url: 'https://acme.atlassian.net/browse/SHOP-42',
};

const suite: GeneratedSuite = {
  specCode: "import { test, expect } from './qa-fixtures';",
  criteria: [
    { criterionId: 'AC-1', testTitle: '[AC-1] a' },
    { criterionId: 'AC-2', testTitle: '[AC-2] b' },
  ],
  uncoverable: [],
};

const passed: CriterionResult[] = [
  { criterionId: 'AC-1', status: 'PASSED', reason: 'test passed' },
  { criterionId: 'AC-2', status: 'PASSED', reason: 'test passed' },
];

function failedWithShots(count: number): CriterionResult[] {
  return Array.from({ length: count }, (_, index) => ({
    criterionId: `AC-${index + 1}`,
    status: 'FAILED' as const,
    reason: 'assertion failed',
    evidence: { screenshotPath: `/out/shot-${index + 1}.png` },
  }));
}

const baseRequest: VerifyTicketRequest = {
  explicitTicket: 'shop-42',
  branch: undefined,
  commit: 'abc1234def',
  commitMessage: undefined,
  environment: 'staging',
  policy: { mode: 'full', allowedMutations: [], allowedHosts: [] },
  targetBaseUrl: 'https://shop.example.com',
  startUrl: '/',
  outputDir: '/out',
  dryRun: false,
  comment: true,
  secrets: [SECRET],
};

interface Harness {
  deps: VerifyTicketDeps;
  comments: { key: string; comment: VerificationComment }[];
  written: VerificationReport[];
  logs: string[];
  inspected: string[];
  runContexts: RunContext[];
  storageStates: (string | undefined)[];
  generated: { authenticated: boolean; snapshots: number }[];
}

function harness(overrides: Partial<VerifyTicketDeps> = {}, options: { results?: CriterionResult[]; failInspect?: (url: string) => boolean } = {}): Harness {
  const h: Harness = { comments: [], written: [], logs: [], inspected: [], runContexts: [], storageStates: [], generated: [] } as unknown as Harness;
  let time = 1_000;
  const reporter: Reporter = {
    write: async (report) => {
      h.written.push(report);
      return '/out/report.json';
    },
    log: (message) => h.logs.push(message),
  };
  h.deps = {
    tickets: { getTicket: async () => ticket },
    commenter: {
      comment: async (key, comment) => {
        h.comments.push({ key, comment });
      },
    },
    readiness: { waitUntilReady: async () => undefined },
    inspectorFor: (storageStatePath): PageInspector => {
      h.storageStates.push(storageStatePath);
      return {
        inspect: async (url) => {
          h.inspected.push(url);
          if (options.failInspect?.(url)) throw new Error(`cannot open ${url}`);
          return { url, title: 't', ariaSnapshot: '- heading' };
        },
      };
    },
    generator: {
      generate: async (input) => {
        h.generated.push({ authenticated: input.authenticated, snapshots: input.snapshots.length });
        return suite;
      },
    },
    runner: {
      run: async (_suite, ctx) => {
        h.runContexts.push(ctx);
        return options.results ?? passed;
      },
    },
    readHeadCommitMessage: async () => undefined,
    reporter,
    clock: { now: () => (time += 10) },
    ...overrides,
  };
  return h;
}

async function verify(h: Harness, request: Partial<VerifyTicketRequest> = {}) {
  return new VerifyTicketUseCase(h.deps).execute({ ...baseRequest, ...request });
}

describe('VerifyTicketUseCase', () => {
  it('RESOLVED: runs every step, writes the report and does not comment', async () => {
    const h = harness();
    const outcome = await verify(h);

    expect(outcome.report.verdict).toBe('RESOLVED');
    expect(outcome.reportPath).toBe('/out/report.json');
    expect(outcome.report.ticket).toMatchObject({ key: 'SHOP-42', keySource: 'explicit', summary: 'Sale badge' });
    expect(outcome.report.commit).toBe('abc1234def');
    expect(outcome.report.results).toEqual(passed);
    expect(outcome.report.comment).toMatchObject({ posted: false });
    expect(h.comments).toHaveLength(0);
    expect(h.written).toHaveLength(1);
    expect(h.storageStates).toEqual([undefined]);
    expect(h.generated[0]?.authenticated).toBe(false);
    expect(h.runContexts[0]).toMatchObject({ baseUrl: 'https://shop.example.com', environment: 'staging', outputDir: '/out', ticket });
    expect(Object.keys(outcome.report.timings.steps)).toEqual(expect.arrayContaining(['readiness', 'ticket', 'inspect', 'generate', 'run']));
  });

  it('NOT_RESOLVED: comments with at most 3 failure screenshots', async () => {
    const h = harness({}, { results: failedWithShots(4) });
    const outcome = await verify(h);

    expect(outcome.report.verdict).toBe('NOT_RESOLVED');
    expect(h.comments).toHaveLength(1);
    expect(h.comments[0]?.key).toBe('SHOP-42');
    expect(h.comments[0]?.comment).toMatchObject({ verdict: 'NOT_RESOLVED', environment: 'staging', commitSha: 'abc1234def' });
    expect(h.comments[0]?.comment.attachments).toEqual(['/out/shot-1.png', '/out/shot-2.png', '/out/shot-3.png']);
    expect(outcome.report.comment.posted).toBe(true);
  });

  it.each([
    ['dry run', { dryRun: true }],
    ['--no-comment', { comment: false }],
  ])('does not comment on %s', async (_label, request) => {
    const h = harness({}, { results: failedWithShots(1) });
    const outcome = await verify(h, request);
    expect(outcome.report.verdict).toBe('NOT_RESOLVED');
    expect(h.comments).toHaveLength(0);
    expect(outcome.report.comment.skippedReason).toBeDefined();
  });

  it('a comment failure is logged and does not change the verdict', async () => {
    const h = harness({ commenter: { comment: async () => { throw new Error('Jira 500'); } } }, { results: failedWithShots(1) });
    const outcome = await verify(h);
    expect(outcome.report.verdict).toBe('NOT_RESOLVED');
    expect(outcome.report.comment).toMatchObject({ posted: false, error: 'Jira 500' });
    expect(h.logs.join('\n')).toContain('Jira 500');
  });

  it('resolves the key from the branch, then from the commit message', async () => {
    const fromBranch = harness();
    expect((await verify(fromBranch, { explicitTicket: undefined, branch: 'feature/shop-7-badge' })).report.ticket).toMatchObject({ key: 'SHOP-7', keySource: 'branch' });

    const fromCommit = harness({ readHeadCommitMessage: async () => 'Merged in feature/SHOP-9-x (pull request #3)' });
    expect((await verify(fromCommit, { explicitTicket: undefined })).report.ticket).toMatchObject({ key: 'SHOP-9', keySource: 'commit' });

    const onMain = harness({ readHeadCommitMessage: async () => 'Merged in bugfix/SHOP-11-price' });
    expect((await verify(onMain, { explicitTicket: undefined, branch: 'main' })).report.ticket).toMatchObject({ key: 'SHOP-11', keySource: 'commit' });

    const fromEnv = harness({ readHeadCommitMessage: async () => 'SHOP-1 from git' });
    expect((await verify(fromEnv, { explicitTicket: undefined, commitMessage: 'SHOP-5 from env' })).report.ticket?.key).toBe('SHOP-5');
  });

  it('INCONCLUSIVE without a comment when no ticket key is found', async () => {
    const h = harness();
    const outcome = await verify(h, { explicitTicket: undefined });
    expect(outcome.report).toMatchObject({ verdict: 'INCONCLUSIVE', reason: 'ticket key not found', ticket: null, configError: false });
    expect(h.comments).toHaveLength(0);
    expect(h.written).toHaveLength(1);
  });

  it('INCONCLUSIVE with a comment when the target never becomes ready', async () => {
    const h = harness({ readiness: { waitUntilReady: async () => { throw new Error('Target not ready after 300000 ms'); } } });
    const outcome = await verify(h);
    expect(outcome.report.verdict).toBe('INCONCLUSIVE');
    expect(outcome.report.reason).toContain('Target not ready');
    expect(h.comments).toHaveLength(1);
  });

  it('INCONCLUSIVE without a comment when Jira cannot return the ticket', async () => {
    const error = Object.assign(new Error('Jira request GET returned 401'), { status: 401 });
    const h = harness({ tickets: { getTicket: async () => { throw error; } } });
    const outcome = await verify(h);
    expect(outcome.report.verdict).toBe('INCONCLUSIVE');
    expect(outcome.report.reason).toContain('could not read ticket');
    expect(outcome.report.configError).toBe(true);
    expect(h.comments).toHaveLength(0);
  });

  it('INCONCLUSIVE with a comment when the ticket has no acceptance criteria', async () => {
    const h = harness({ tickets: { getTicket: async () => ({ ...ticket, acceptanceCriteria: [] }) } });
    const outcome = await verify(h);
    expect(outcome.report).toMatchObject({ verdict: 'INCONCLUSIVE', reason: 'ticket has no acceptance criteria' });
    expect(h.comments).toHaveLength(1);
    expect(h.generated).toHaveLength(0);
  });

  it('logs in when configured and reuses the storage state everywhere', async () => {
    const h = harness({ login: async () => '/out/.auth/state.json' });
    await verify(h);
    expect(h.storageStates).toEqual(['/out/.auth/state.json']);
    expect(h.generated[0]?.authenticated).toBe(true);
    expect(h.runContexts[0]?.storageStatePath).toBe('/out/.auth/state.json');
  });

  it('INCONCLUSIVE "login failed" with a comment, flagged as a config error', async () => {
    const loginError = Object.assign(new Error('Form login failed at step "submit"'), { name: 'LoginError' });
    const h = harness({ login: async () => { throw loginError; } });
    const outcome = await verify(h);
    expect(outcome.report.verdict).toBe('INCONCLUSIVE');
    expect(outcome.report.reason).toMatch(/^login failed/);
    expect(outcome.report.configError).toBe(true);
    expect(h.comments).toHaveLength(1);
  });

  it('inspects the start URL plus up to two same-host pages from the ticket', async () => {
    const h = harness();
    const outcome = await verify(h, { startUrl: '/home' });
    expect(h.inspected).toEqual(['/home', '/sale?x=1', '/products/shoes']);
    expect(outcome.report.pagesInspected).toEqual(['/home', '/sale?x=1', '/products/shoes']);
  });

  it('tolerates a failed page when another succeeds', async () => {
    const h = harness({}, { failInspect: (url) => url === '/sale?x=1' });
    const outcome = await verify(h);
    expect(outcome.report.verdict).toBe('RESOLVED');
    expect(h.generated[0]?.snapshots).toBe(2);
    expect(h.logs.join('\n')).toContain('cannot open /sale?x=1');
  });

  it('INCONCLUSIVE when every page inspection fails', async () => {
    const h = harness({}, { failInspect: () => true });
    const outcome = await verify(h);
    expect(outcome.report.verdict).toBe('INCONCLUSIVE');
    expect(outcome.report.reason).toContain('page inspection failed');
    expect(h.comments).toHaveLength(1);
  });

  it('INCONCLUSIVE with a comment when generation fails', async () => {
    const h = harness({ generator: { generate: async () => { throw Object.assign(new Error('declined (stop_reason: refusal)'), { name: 'GenerationError' }); } } });
    const outcome = await verify(h);
    expect(outcome.report.verdict).toBe('INCONCLUSIVE');
    expect(outcome.report.reason).toContain('test generation failed');
    expect(h.comments).toHaveLength(1);
  });

  it('never crashes: an unexpected error becomes a redacted INCONCLUSIVE report', async () => {
    const h = harness({ runner: { run: async () => { throw new Error(`boom with ${SECRET}`); } } });
    const outcome = await verify(h);
    expect(outcome.report.verdict).toBe('INCONCLUSIVE');
    expect(outcome.report.reason).toContain('boom with ***');
    expect(JSON.stringify(h.written)).not.toContain(SECRET);
    expect(JSON.stringify(h.comments)).not.toContain(SECRET);
  });

  it('still returns an outcome when the report cannot be written', async () => {
    const h = harness({ reporter: { write: async () => { throw new Error('disk full'); }, log: () => undefined } });
    const outcome = await verify(h);
    expect(outcome.report.verdict).toBe('RESOLVED');
    expect(outcome.reportPath).toBeUndefined();
  });
});

describe('pagesToInspect', () => {
  it('dedupes, keeps only same-host links and caps at three', () => {
    const many: Ticket = { ...ticket, description: '/a /b /c https://shop.example.com/a https://other.io/z', acceptanceCriteria: [] };
    expect(pagesToInspect('/', many, 'https://shop.example.com')).toEqual(['/', '/a', '/b']);
  });

  it('ignores the start URL when it already appears in the ticket', () => {
    const one: Ticket = { ...ticket, description: 'Open https://shop.example.com/ then /cart.', acceptanceCriteria: [] };
    expect(pagesToInspect('/', one, 'https://shop.example.com')).toEqual(['/', '/cart']);
  });

  it('does not treat fractions or words with slashes as paths', () => {
    const noisy: Ticket = { ...ticket, description: 'and/or 1/2 price', acceptanceCriteria: [] };
    expect(pagesToInspect('/', noisy, 'https://shop.example.com')).toEqual(['/']);
  });
});

describe('renderSummaryMarkdown', () => {
  it('lists the verdict and each criterion', () => {
    const markdown = renderSummaryMarkdown({
      verdict: 'NOT_RESOLVED',
      reason: '0 of 1 criteria passed',
      configError: false,
      ticket: { key: 'SHOP-42', keySource: 'explicit', summary: 'Sale badge', url: ticket.url },
      environment: 'production',
      policyMode: 'read-only',
      targetBaseUrl: 'https://shop.example.com',
      commit: 'abc',
      pagesInspected: ['/'],
      results: [{ criterionId: 'AC-1', status: 'FAILED', reason: 'badge visible', evidence: { expected: 'visible', actual: 'hidden' } }],
      comment: { posted: true },
      timings: { startedAt: '2026-10-06T00:00:00.000Z', durationMs: 5, steps: {} },
    });
    expect(markdown).toContain('NOT_RESOLVED');
    expect(markdown).toContain('SHOP-42');
    expect(markdown).toContain('AC-1');
    expect(markdown).toContain('badge visible');
    expect(markdown).toContain('hidden');
  });
});
