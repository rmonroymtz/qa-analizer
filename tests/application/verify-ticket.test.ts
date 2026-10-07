import { describe, expect, it } from 'vitest';
import {
  formatPages,
  pagesToInspect,
  renderSummaryMarkdown,
  VerifyTicketUseCase,
  type Reporter,
  type VerificationReport,
  type VerifyTicketDeps,
  type VerifyTicketRequest,
} from '../../src/application/verify-ticket.js';
import type { CriterionResult } from '../../src/domain/criterion-result.js';
import type { TestPlan } from '../../src/domain/test-plan.js';
import type { Ticket } from '../../src/domain/ticket.js';
import type { PageInspector } from '../../src/ports/page-inspector.js';
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

const plan: TestPlan = {
  tests: [
    { criterionId: 'AC-1', title: '[AC-1] a', mutating: false, steps: [{ action: 'expectTitle', text: 'Sale', match: 'contains' }] },
    { criterionId: 'AC-2', title: `[AC-2] b ${SECRET}`, mutating: false, steps: [{ action: 'expectTitle', text: 'Price', match: 'contains' }] },
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
  startUrl: undefined,
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
  artifacts: Map<string, string>;
  runPlans: TestPlan[];
}

function harness(overrides: Partial<VerifyTicketDeps> = {}, options: { results?: CriterionResult[]; failInspect?: (url: string) => boolean; incompleteInspect?: (url: string) => boolean } = {}): Harness {
  const h: Harness = { comments: [], written: [], logs: [], inspected: [], runContexts: [], storageStates: [], generated: [], artifacts: new Map(), runPlans: [] } as unknown as Harness;
  let time = 1_000;
  const reporter: Reporter = {
    write: async (report) => {
      h.written.push(report);
      return '/out/report.json';
    },
    writeArtifact: async (relativePath, content) => {
      h.artifacts.set(relativePath, content);
      return `/out/${relativePath}`;
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
          if (options.incompleteInspect?.(url)) return { url, title: 't', ariaSnapshot: '- text: Loading', loadIncomplete: { pendingRequests: ['/api/x'] } };
          return { url, title: 't', ariaSnapshot: '- heading' };
        },
      };
    },
    generator: {
      generate: async (input) => {
        h.generated.push({ authenticated: input.authenticated, snapshots: input.snapshots.length });
        return plan;
      },
    },
    renderPlanSpec: (generated, baseUrl) => `// spec for ${baseUrl}: ${generated.tests.map((test) => test.title).join(', ')}`,
    runner: {
      run: async (runPlan, ctx) => {
        h.runPlans.push(runPlan);
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
  it('writes the validated plan and the review-only spec before running the plan', async () => {
    const h = harness();
    await verify(h);
    expect(JSON.parse(h.artifacts.get('plan.json') ?? '{}')).toEqual({
      ...plan,
      tests: [plan.tests[0], { ...plan.tests[1], title: '[AC-2] b ***' }],
    });
    expect(h.artifacts.get('generated/plan.spec.ts')).toBe('// spec for https://shop.example.com: [AC-1] a, [AC-2] b ***');
    expect(h.runPlans[0]).toBe(plan);
  });

  it('still runs the plan when the artifacts cannot be written', async () => {
    const h = harness();
    h.deps.reporter.writeArtifact = async () => {
      throw new Error('disk full');
    };
    const outcome = await verify(h);
    expect(outcome.report.verdict).toBe('RESOLVED');
    expect(h.logs).toContain('Could not write plan.json: disk full');
  });

  it('RESOLVED: runs every step, writes the report and does not comment', async () => {
    const h = harness();
    const outcome = await verify(h);

    expect(outcome.report.verdict).toBe('RESOLVED');
    expect(outcome.reportPath).toBe('/out/report.json');
    expect(outcome.report.ticket).toMatchObject({ key: 'SHOP-42', keySource: 'explicit', summary: 'Sale badge' });
    expect(outcome.report.commit).toBe('abc1234def');
    expect(outcome.report.results).toEqual(passed);
    expect(outcome.report.comment).toEqual({ posted: false, skippedReason: 'verdict is RESOLVED' });
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
    ['dry run', { dryRun: true }, 'dry run'],
    ['--no-comment', { comment: false }, 'comments disabled (--no-comment)'],
  ])('does not comment on %s', async (_label, request, skippedReason) => {
    const h = harness({}, { results: failedWithShots(1) });
    const outcome = await verify(h, request);
    expect(outcome.report.verdict).toBe('NOT_RESOLVED');
    expect(h.comments).toHaveLength(0);
    expect(outcome.report.comment).toEqual({ posted: false, skippedReason });
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

  it('honors the configured Jira projects when resolving the key', async () => {
    const h = harness({ readHeadCommitMessage: async () => 'OTHER-3 and SHOP-4' });
    expect((await verify(h, { explicitTicket: undefined, jiraProjects: ['SHOP'] })).report.ticket?.key).toBe('SHOP-4');
  });

  it('INCONCLUSIVE as a setup error, without falling back, when the explicit key is invalid', async () => {
    const h = harness();
    const outcome = await verify(h, { explicitTicket: 'not a key', branch: 'feature/SHOP-7-x' });
    expect(outcome.report).toMatchObject({ verdict: 'INCONCLUSIVE', ticket: null, configError: true });
    expect(outcome.report.reason).toContain('Invalid ticket key');
    expect(outcome.report.comment).toEqual({ posted: false, skippedReason: 'no ticket to comment on' });
    expect(h.comments).toHaveLength(0);
  });

  it('INCONCLUSIVE as a setup error, without a comment, when no ticket key is found', async () => {
    const h = harness();
    const outcome = await verify(h, { explicitTicket: undefined });
    expect(outcome.report).toMatchObject({ verdict: 'INCONCLUSIVE', reason: 'ticket key not found', ticket: null, configError: true });
    expect(outcome.report.comment).toEqual({ posted: false, skippedReason: 'no ticket to comment on' });
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

  it.each([400, 401, 403, 404, 429])('INCONCLUSIVE setup error without a comment when Jira returns %i for the ticket', async (status) => {
    const error = Object.assign(new Error(`Jira request GET returned ${status}`), { name: 'JiraError', status });
    const h = harness({ tickets: { getTicket: async () => { throw error; } } });
    const outcome = await verify(h);
    expect(outcome.report.verdict).toBe('INCONCLUSIVE');
    expect(outcome.report.reason).toContain('could not read ticket');
    expect(outcome.report.configError).toBe(true);
    expect(outcome.report.comment).toEqual({ posted: false, skippedReason: 'the ticket could not be read' });
    expect(h.comments).toHaveLength(0);
  });

  it('a Jira server error reading the ticket is not a setup error', async () => {
    const error = Object.assign(new Error('Jira request GET returned 503'), { name: 'JiraError', status: 503 });
    const h = harness({ tickets: { getTicket: async () => { throw error; } } });
    const outcome = await verify(h);
    expect(outcome.report).toMatchObject({ verdict: 'INCONCLUSIVE', configError: false });
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

  it('inspects the ticket pages in order of appearance when --url is not given', async () => {
    const h = harness();
    const outcome = await verify(h);
    expect(h.inspected).toEqual(['/sale?x=1', '/products/shoes', '/deals']);
    expect(h.written[0]?.pagesInspected).toEqual(outcome.report.pagesInspected);
    expect(outcome.report.pagesInspected).toEqual([
      { path: '/sale?x=1', source: 'ticket' },
      { path: '/products/shoes', source: 'ticket' },
      { path: '/deals', source: 'ticket' },
    ]);
  });

  it('inspects --url first, then the ticket pages, capped at three', async () => {
    const h = harness();
    const outcome = await verify(h, { startUrl: '/home' });
    expect(h.inspected).toEqual(['/home', '/sale?x=1', '/products/shoes']);
    expect(outcome.report.pagesInspected).toEqual([
      { path: '/home', source: 'cli' },
      { path: '/sale?x=1', source: 'ticket' },
      { path: '/products/shoes', source: 'ticket' },
    ]);
  });

  it('records only the pages that could be inspected, with their source', async () => {
    const h = harness({}, { failInspect: (url) => url === '/products/shoes' });
    const outcome = await verify(h);
    expect(outcome.report.pagesInspected).toEqual([
      { path: '/sale?x=1', source: 'ticket' },
      { path: '/deals', source: 'ticket' },
    ]);
  });

  it('marks pages whose snapshot was captured before the network settled', async () => {
    const h = harness({}, { incompleteInspect: (url) => url === '/deals' });
    const outcome = await verify(h);
    expect(outcome.report.pagesInspected).toEqual([
      { path: '/sale?x=1', source: 'ticket' },
      { path: '/products/shoes', source: 'ticket' },
      { path: '/deals', source: 'ticket', loadIncomplete: true },
    ]);
    expect(formatPages(outcome.report.pagesInspected)).toBe('/sale?x=1 (ticket), /products/shoes (ticket), /deals (ticket, load incomplete)');
    expect(h.logs.join('\n')).toContain('/deals was captured while first-party requests were still pending: /api/x');
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
    expect(outcome.report.configError).toBe(false);
    expect(outcome.report.comment).toEqual({ posted: true });
    expect(h.comments).toHaveLength(1);
  });

  it.each([400, 401, 403, 404, 429])('flags a Claude API %i during generation as a setup error', async (status) => {
    const error = Object.assign(new Error(`Claude request failed: ${status}`), { name: 'GenerationError', status });
    const h = harness({ generator: { generate: async () => { throw error; } } });
    const outcome = await verify(h);
    expect(outcome.report).toMatchObject({ verdict: 'INCONCLUSIVE', configError: true });
    expect(outcome.report.reason).toContain('test generation failed');
  });

  it('a Claude server overload during generation is not a setup error', async () => {
    const error = Object.assign(new Error('Claude request failed: overloaded'), { name: 'GenerationError', status: 529 });
    const h = harness({ generator: { generate: async () => { throw error; } } });
    expect((await verify(h)).report.configError).toBe(false);
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
    const h = harness({ reporter: { write: async () => { throw new Error('disk full'); }, writeArtifact: async (path) => path, log: () => undefined } });
    const outcome = await verify(h);
    expect(outcome.report.verdict).toBe('RESOLVED');
    expect(outcome.reportPath).toBeUndefined();
  });
});

describe('pagesToInspect', () => {
  const bare = (description: string, criteria: string[] = []): Ticket => ({
    ...ticket,
    summary: 'x',
    description,
    acceptanceCriteria: criteria.map((text, index) => ({ id: `AC-${index + 1}`, text })),
  });
  const paths = (pages: { path: string }[]) => pages.map((page) => page.path);

  it('dedupes, keeps only same-site links and caps at three', () => {
    const many = bare('/a /b /c https://shop.example.com/a https://other.io/z');
    expect(paths(pagesToInspect(undefined, many, 'https://shop.example.com'))).toEqual(['/a', '/b', '/c']);
    expect(paths(pagesToInspect('/', many, 'https://shop.example.com'))).toEqual(['/', '/a', '/b']);
  });

  it('applies the path of a production URL from the ticket to the staging target', () => {
    const prod = bare('Revisar https://chupaprecios.com.mx/ofertas/laptops?orden=precio#top y https://www.figma.com/file/abc.');
    expect(pagesToInspect(undefined, prod, 'https://staging.chupaprecios.com.mx')).toEqual([
      { path: '/ofertas/laptops?orden=precio', source: 'ticket' },
    ]);
  });

  it('ignores look-alike and other domains', () => {
    const others = bare('https://chupaprecios.com/a https://evil-chupaprecios.com.mx/b https://docs.google.com/c');
    expect(pagesToInspect(undefined, others, 'https://chupaprecios.com.mx')).toEqual([{ path: '/', source: 'default' }]);
  });

  it('falls back to / only when no page is named', () => {
    expect(pagesToInspect(undefined, bare('nothing here'), 'https://shop.example.com')).toEqual([{ path: '/', source: 'default' }]);
    expect(pagesToInspect(undefined, bare('see /cart'), 'https://shop.example.com')).toEqual([{ path: '/cart', source: 'ticket' }]);
  });

  it('puts --url first and does not repeat it when the ticket names it too', () => {
    const one = bare('Open https://shop.example.com/ then /cart.');
    expect(pagesToInspect('/', one, 'https://shop.example.com')).toEqual([
      { path: '/', source: 'cli' },
      { path: '/cart', source: 'ticket' },
    ]);
    expect(pagesToInspect('/cart/', one, 'https://shop.example.com')).toEqual([
      { path: '/cart/', source: 'cli' },
      { path: '/', source: 'ticket' },
    ]);
  });

  it('reads the summary, description and criteria in order of appearance', () => {
    const ordered: Ticket = { ...bare('/second', ['/third', '/fourth']), summary: 'Fix /first' };
    expect(paths(pagesToInspect(undefined, ordered, 'https://shop.example.com'))).toEqual(['/first', '/second', '/third']);
  });

  it('keeps the order of absolute URLs and root-relative paths as written', () => {
    const mixed = bare('/b then https://shop.example.com/a');
    expect(paths(pagesToInspect(undefined, mixed, 'https://shop.example.com'))).toEqual(['/b', '/a']);
  });

  it('matches localhost targets by exact host and port', () => {
    const local = bare('http://localhost:3000/a http://localhost:4000/b');
    expect(paths(pagesToInspect(undefined, local, 'http://localhost:3000'))).toEqual(['/a']);
  });

  it('does not treat fractions or words with slashes as paths', () => {
    expect(pagesToInspect(undefined, bare('and/or 1/2 price'), 'https://shop.example.com')).toEqual([{ path: '/', source: 'default' }]);
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
      pagesInspected: [
        { path: '/ofertas', source: 'ticket' },
        { path: '/', source: 'default' },
      ],
      results: [{ criterionId: 'AC-1', status: 'FAILED', reason: 'badge visible', evidence: { expected: 'visible', actual: 'hidden' } }],
      comment: { posted: true },
      timings: { startedAt: '2026-10-06T00:00:00.000Z', durationMs: 5, steps: {} },
    });
    expect(markdown).toContain('NOT_RESOLVED');
    expect(markdown).toContain('SHOP-42');
    expect(markdown).toContain('AC-1');
    expect(markdown).toContain('badge visible');
    expect(markdown).toContain('hidden');
    expect(markdown).toContain('- Pages inspected: /ofertas (ticket), / (default)');
  });
});
