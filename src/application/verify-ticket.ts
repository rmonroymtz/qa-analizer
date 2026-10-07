import type { CriterionResult } from '../domain/criterion-result.js';
import type { Environment, EnvironmentPolicy } from '../domain/environment.js';
import type { TestPlan } from '../domain/test-plan.js';
import { sameSite } from '../domain/site.js';
import type { Ticket } from '../domain/ticket.js';
import { aggregateVerdict, type Verdict } from '../domain/verdict.js';
import type { PageInspector, PageSnapshot } from '../ports/page-inspector.js';
import type { ReadinessProbe } from '../ports/readiness-probe.js';
import type { TestGenerator } from '../ports/test-generator.js';
import type { TestRunner } from '../ports/test-runner.js';
import type { TicketCommenter } from '../ports/ticket-commenter.js';
import type { TicketRepository } from '../ports/ticket-repository.js';
import { InvalidTicketKeyError, resolveTicketKey, type TicketKeyCandidates, type TicketKeySource } from './resolve-ticket-key.js';

export interface VerifyTicketRequest {
  explicitTicket: string | undefined;
  branch: string | undefined;
  commit: string | undefined;
  /** Overrides the HEAD commit message (QA_COMMIT_MESSAGE). */
  commitMessage: string | undefined;
  /** Jira project keys (QA_JIRA_PROJECTS); when non-empty, only their keys are accepted. */
  jiraProjects?: readonly string[] | undefined;
  environment: Environment;
  policy: EnvironmentPolicy;
  targetBaseUrl: string;
  /** Page to inspect first (`--url`); when undefined, the ticket pages (or `/`) are used. */
  startUrl: string | undefined;
  outputDir: string;
  dryRun: boolean;
  comment: boolean;
  /** Secret values scrubbed from every reported message. */
  secrets: string[];
}

/** Persists the report and artifacts, and prints progress. */
export interface Reporter {
  /** Writes report.json and summary.md; returns the report path. */
  write(report: VerificationReport, summaryMarkdown: string): Promise<string>;
  /** Writes a text artifact at a fixed path relative to the output directory; returns its path. */
  writeArtifact(relativePath: string, content: string): Promise<string>;
  log(message: string): void;
}

export interface Clock {
  now(): number;
}

export interface VerifyTicketDeps {
  tickets: TicketRepository;
  commenter: TicketCommenter;
  readiness: ReadinessProbe;
  /** Builds an inspector bound to the (optional) authenticated session. */
  inspectorFor(storageStatePath: string | undefined): PageInspector;
  generator: TestGenerator;
  /** Renders the plan as a readable spec, an artifact for humans that is never executed. */
  renderPlanSpec(plan: TestPlan, baseUrl: string): string;
  runner: TestRunner;
  /** Present only when form login is configured; returns the storage state path. */
  login?: (() => Promise<string>) | undefined;
  readHeadCommitMessage(): Promise<string | undefined>;
  reporter: Reporter;
  clock: Clock;
}

export interface VerificationReport {
  verdict: Verdict;
  reason: string;
  /** True when an INCONCLUSIVE verdict comes from setup (credentials, login), not from the site. */
  configError: boolean;
  ticket: { key: string; keySource: TicketKeySource; summary?: string; url?: string } | null;
  environment: Environment;
  policyMode: EnvironmentPolicy['mode'];
  targetBaseUrl: string;
  commit: string | null;
  pagesInspected: InspectedPage[];
  results: CriterionResult[];
  comment: { posted: boolean; skippedReason?: string; error?: string };
  timings: { startedAt: string; durationMs: number; steps: Record<string, number> };
}

/** Where a page to inspect came from: `--url`, the ticket text, or the `/` fallback. */
export type PageSource = 'cli' | 'ticket' | 'default';

export interface InspectedPage {
  path: string;
  source: PageSource;
  /** True when the snapshot was captured while first-party requests were still pending. */
  loadIncomplete?: true;
}

export interface VerifyTicketOutcome {
  report: VerificationReport;
  /** Undefined when the report could not be written. */
  reportPath: string | undefined;
}

const MAX_PAGES = 3;
const MAX_ATTACHMENTS = 3;
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`)\]]+/g;
const PATH_IN_TEXT = /(?:^|[\s("'`])(\/[A-Za-z0-9][\w\-./?=&%#~]*)/g;

function trimPunctuation(value: string): string {
  return value.replace(/[.,;:!?]+$/, '');
}

/**
 * Pages named in the ticket, in order of appearance: the path and query (no
 * hash) of absolute URLs on the same site as the target (same registrable
 * domain, so production URLs map onto staging), and root-relative paths.
 */
function ticketPages(ticket: Ticket, baseUrl: string): string[] {
  const text = [ticket.summary, ticket.description, ...ticket.acceptanceCriteria.map((criterion) => criterion.text)].join('\n');
  const found: { index: number; path: string }[] = [];
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const raw = trimPunctuation(match[0]);
    if (!sameSite(raw, baseUrl)) continue;
    const url = new URL(raw);
    found.push({ index: match.index, path: `${url.pathname}${url.search}` });
  }
  // Blank the URLs (keeping offsets) so their paths are not matched twice.
  const withoutUrls = text.replace(URL_IN_TEXT, (url) => ' '.repeat(url.length));
  for (const match of withoutUrls.matchAll(PATH_IN_TEXT)) {
    if (match[1]) found.push({ index: match.index + match[0].length - match[1].length, path: trimPunctuation(match[1]) });
  }
  return found.sort((a, b) => a.index - b.index).map((entry) => entry.path);
}

/**
 * The pages to inspect, at most `max`, deduplicated: `--url` first when given,
 * then the ticket pages in order of appearance, and `/` only when the list is
 * otherwise empty.
 */
export function pagesToInspect(startUrl: string | undefined, ticket: Ticket, baseUrl: string, max = MAX_PAGES): InspectedPage[] {
  const candidates: InspectedPage[] = [
    ...(startUrl === undefined ? [] : [{ path: startUrl, source: 'cli' as const }]),
    ...ticketPages(ticket, baseUrl).map((path) => ({ path, source: 'ticket' as const })),
  ];
  const normalize = (path: string) => path.replace(/(.)\/+$/, '$1');
  const pages: InspectedPage[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (pages.length >= max) break;
    const key = normalize(candidate.path);
    if (seen.has(key)) continue;
    seen.add(key);
    pages.push(candidate);
  }
  return pages.length > 0 ? pages : [{ path: '/', source: 'default' }];
}

/** `/ofertas (ticket), / (default, load incomplete)`, or `none`. */
export function formatPages(pages: readonly InspectedPage[]): string {
  if (pages.length === 0) return 'none';
  return pages.map((page) => `${page.path} (${page.source}${page.loadIncomplete ? ', load incomplete' : ''})`).join(', ');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * API statuses that point at the setup, not at the site under test: a bad request
 * or model id (400), bad or missing credentials (401/403), a missing ticket or
 * endpoint (404), and an exhausted quota or rate limit (429).
 */
const SETUP_STATUSES = new Set([400, 401, 403, 404, 429]);

function isConfigFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as { status?: unknown }).status;
  return error.name === 'LoginError' || (typeof status === 'number' && SETUP_STATUSES.has(status));
}

function redactText(text: string, secrets: string[]): string {
  return secrets.reduce((current, secret) => (secret ? current.split(secret).join('***') : current), text);
}

/** Scrubs every secret from every string of a JSON-serializable value. */
function redactJson<T>(value: T, secrets: string[]): T {
  const escaped = secrets.filter((secret) => secret.length > 0).map((secret) => JSON.stringify(secret).slice(1, -1));
  return JSON.parse(redactText(JSON.stringify(value), escaped)) as T;
}

function redactReport(report: VerificationReport, secrets: string[]): VerificationReport {
  return redactJson(report, secrets);
}

function countSummary(results: CriterionResult[]): string {
  const count = (status: CriterionResult['status']) => results.filter((result) => result.status === status).length;
  return `${count('PASSED')} of ${results.length} criteria passed, ${count('FAILED')} failed, ${count('INCONCLUSIVE')} inconclusive`;
}

export function renderSummaryMarkdown(report: VerificationReport): string {
  const lines = [
    `# QA verification: ${report.verdict}`,
    '',
    `- Ticket: ${report.ticket ? `${report.ticket.key}${report.ticket.summary ? ` — ${report.ticket.summary}` : ''}` : 'not found'}`,
    `- Environment: ${report.environment} (${report.policyMode})`,
    `- Target: ${report.targetBaseUrl}`,
    `- Commit: ${report.commit ?? 'unknown'}`,
    `- Reason: ${report.reason}`,
    `- Pages inspected: ${formatPages(report.pagesInspected)}`,
    '',
  ];
  if (report.results.length > 0) {
    lines.push('## Acceptance criteria', '', '| Criterion | Status | Reason |', '| --- | --- | --- |');
    for (const result of report.results) {
      const details = [result.reason];
      if (result.evidence?.expected !== undefined) details.push(`expected ${result.evidence.expected}`);
      if (result.evidence?.actual !== undefined) details.push(`actual ${result.evidence.actual}`);
      lines.push(`| ${result.criterionId} | ${result.status} | ${details.join('; ').replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

interface RunState {
  key: string | undefined;
  keySource: TicketKeySource | undefined;
  ticket: Ticket | undefined;
  pagesInspected: InspectedPage[];
  steps: Record<string, number>;
}

class StepFailure extends Error {
  constructor(
    readonly reason: string,
    readonly comment: boolean,
    readonly configError: boolean,
  ) {
    super(reason);
  }
}

/**
 * Verifies the main ticket of a deployment end to end. Never throws: every
 * failure ends in an INCONCLUSIVE report, so the pipeline always gets a verdict.
 */
export class VerifyTicketUseCase {
  constructor(private readonly deps: VerifyTicketDeps) {}

  async execute(request: VerifyTicketRequest): Promise<VerifyTicketOutcome> {
    const startedAt = this.deps.clock.now();
    const state: RunState = { key: undefined, keySource: undefined, ticket: undefined, pagesInspected: [], steps: {} };
    let verdict: Verdict = 'INCONCLUSIVE';
    let reason: string;
    let results: CriterionResult[] = [];
    let configError = false;
    let shouldComment = false;

    try {
      results = await this.verify(request, state);
      verdict = aggregateVerdict(results, state.ticket as Ticket);
      reason = countSummary(results);
      shouldComment = verdict !== 'RESOLVED';
    } catch (error) {
      if (error instanceof StepFailure) {
        reason = error.reason;
        shouldComment = error.comment;
        configError = error.configError;
      } else {
        reason = `unexpected error: ${errorMessage(error)}`;
        shouldComment = state.key !== undefined;
      }
    }

    let report: VerificationReport = redactReport(
      {
        verdict,
        reason,
        configError,
        ticket: state.key && state.keySource ? { key: state.key, keySource: state.keySource, ...(state.ticket ? { summary: state.ticket.summary, url: state.ticket.url } : {}) } : null,
        environment: request.environment,
        policyMode: request.policy.mode,
        targetBaseUrl: request.targetBaseUrl,
        commit: request.commit ?? null,
        pagesInspected: state.pagesInspected,
        results,
        comment: { posted: false },
        timings: { startedAt: new Date(startedAt).toISOString(), durationMs: 0, steps: state.steps },
      },
      request.secrets,
    );

    report.comment = await this.postComment(report, request, shouldComment, state);
    report = { ...report, timings: { ...report.timings, durationMs: this.deps.clock.now() - startedAt } };

    let reportPath: string | undefined;
    try {
      reportPath = await this.deps.reporter.write(report, renderSummaryMarkdown(report));
    } catch (error) {
      this.deps.reporter.log(`Could not write the report: ${redactText(errorMessage(error), request.secrets)}`);
    }
    return { report, reportPath };
  }

  private async timed<T>(state: RunState, step: string, action: () => Promise<T>): Promise<T> {
    const start = this.deps.clock.now();
    try {
      return await action();
    } finally {
      state.steps[step] = this.deps.clock.now() - start;
    }
  }

  private async verify(request: VerifyTicketRequest, state: RunState): Promise<CriterionResult[]> {
    const { deps } = this;
    const candidates = { explicit: request.explicitTicket, branch: request.branch };
    // The HEAD commit is read only when neither the explicit key nor the branch (e.g. `main`) has one.
    const resolve = (all: TicketKeyCandidates) => {
      try {
        return resolveTicketKey(all, { projects: request.jiraProjects });
      } catch (error) {
        // An invalid explicit key is a setup problem: never fall back to another source.
        if (error instanceof InvalidTicketKeyError) throw new StepFailure(error.message, false, true);
        throw error;
      }
    };
    const resolved =
      resolve({ ...candidates, commitMessage: request.commitMessage }) ??
      (request.commitMessage === undefined ? resolve({ ...candidates, commitMessage: await deps.readHeadCommitMessage() }) : null);
    // Without a key there is nothing to verify or comment on: a pipeline setup problem.
    if (resolved === null) throw new StepFailure('ticket key not found', false, true);
    state.key = resolved.key;
    state.keySource = resolved.source;
    deps.reporter.log(`Ticket ${resolved.key} (from ${resolved.source})`);

    await this.timed(state, 'readiness', () => deps.readiness.waitUntilReady()).catch((error: unknown) => {
      throw new StepFailure(`target not ready: ${errorMessage(error)}`, true, false);
    });

    const ticket = await this.timed(state, 'ticket', () => deps.tickets.getTicket(resolved.key)).catch((error: unknown) => {
      throw new StepFailure(`could not read ticket: ${errorMessage(error)}`, false, isConfigFailure(error));
    });
    state.ticket = ticket;
    if (ticket.acceptanceCriteria.length === 0) throw new StepFailure('ticket has no acceptance criteria', true, false);

    let storageStatePath: string | undefined;
    const login = deps.login;
    if (login) {
      storageStatePath = await this.timed(state, 'login', login).catch((error: unknown) => {
        throw new StepFailure(`login failed: ${errorMessage(error)}`, true, true);
      });
    }

    const inspector = deps.inspectorFor(storageStatePath);
    const snapshots: PageSnapshot[] = [];
    const failures: string[] = [];
    await this.timed(state, 'inspect', async () => {
      for (const page of pagesToInspect(request.startUrl, ticket, request.targetBaseUrl)) {
        try {
          const snapshot = await inspector.inspect(page.path);
          snapshots.push(snapshot);
          if (snapshot.loadIncomplete) {
            state.pagesInspected.push({ ...page, loadIncomplete: true });
            const pending = snapshot.loadIncomplete.pendingRequests.join(', ') || 'unknown';
            deps.reporter.log(`Page ${page.path} was captured while first-party requests were still pending: ${pending}`);
          } else {
            state.pagesInspected.push(page);
          }
        } catch (error) {
          failures.push(`${page.path}: ${errorMessage(error)}`);
          deps.reporter.log(`Page inspection failed for ${page.path} (${page.source}): ${errorMessage(error)}`);
        }
      }
    });
    if (snapshots.length === 0) throw new StepFailure(`page inspection failed: ${failures.join('; ')}`, true, false);

    const plan = await this.timed(state, 'generate', () =>
      deps.generator.generate({ ticket, snapshots, baseUrl: request.targetBaseUrl, policy: request.policy, authenticated: storageStatePath !== undefined }),
    ).catch((error: unknown) => {
      throw new StepFailure(`test generation failed: ${errorMessage(error)}`, true, isConfigFailure(error));
    });

    await this.writePlanArtifacts(plan, request);

    return this.timed(state, 'run', () =>
      deps.runner.run(plan, {
        baseUrl: request.targetBaseUrl,
        environment: request.environment,
        policy: request.policy,
        ...(storageStatePath ? { storageStatePath } : {}),
        outputDir: request.outputDir,
        ticket,
      }),
    );
  }

  /** Writes `plan.json` and the review-only `generated/plan.spec.ts`; failures are logged, never fatal. */
  private async writePlanArtifacts(plan: TestPlan, request: VerifyTicketRequest): Promise<void> {
    const redacted = redactJson(plan, request.secrets);
    const artifacts: [string, () => string][] = [
      ['plan.json', () => `${JSON.stringify(redacted, null, 2)}\n`],
      ['generated/plan.spec.ts', () => this.deps.renderPlanSpec(redacted, request.targetBaseUrl)],
    ];
    for (const [path, content] of artifacts) {
      try {
        await this.deps.reporter.writeArtifact(path, content());
      } catch (error) {
        this.deps.reporter.log(`Could not write ${path}: ${redactText(errorMessage(error), request.secrets)}`);
      }
    }
  }

  private async postComment(
    report: VerificationReport,
    request: VerifyTicketRequest,
    shouldComment: boolean,
    state: RunState,
  ): Promise<VerificationReport['comment']> {
    if (report.verdict === 'RESOLVED') return { posted: false, skippedReason: 'verdict is RESOLVED' };
    if (report.ticket === null) return { posted: false, skippedReason: 'no ticket to comment on' };
    // The only non-commenting failure with a known key is a ticket Jira could not return.
    if (!shouldComment) return { posted: false, skippedReason: 'the ticket could not be read' };
    if (request.dryRun) return { posted: false, skippedReason: 'dry run' };
    if (!request.comment) return { posted: false, skippedReason: 'comments disabled (--no-comment)' };
    const attachments = report.results
      .filter((result) => result.status === 'FAILED' && result.evidence?.screenshotPath)
      .map((result) => result.evidence?.screenshotPath as string)
      .slice(0, MAX_ATTACHMENTS);
    const start = this.deps.clock.now();
    try {
      await this.deps.commenter.comment(report.ticket.key, {
        verdict: report.verdict,
        environment: report.environment,
        ...(request.commit ? { commitSha: request.commit } : {}),
        summary: report.reason,
        results: report.results,
        attachments,
      });
      return { posted: true };
    } catch (error) {
      const message = redactText(errorMessage(error), request.secrets);
      this.deps.reporter.log(`Could not comment on ${report.ticket.key}: ${message}`);
      return { posted: false, error: message };
    } finally {
      state.steps.comment = this.deps.clock.now() - start;
    }
  }
}
