import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { chromium } from '@playwright/test';
import { ClaudeTestGenerator } from '../adapters/anthropic/claude-test-generator.js';
import { FileReporter } from '../adapters/fs/file-reporter.js';
import { readHeadCommitMessage } from '../adapters/git/read-head-commit-message.js';
import { readinessProbeFromConfig } from '../adapters/http/readiness-probe.js';
import { JiraClient } from '../adapters/jira/jira-client.js';
import { JiraTicketCommenter } from '../adapters/jira/jira-ticket-commenter.js';
import { JiraTicketRepository } from '../adapters/jira/jira-ticket-repository.js';
import { performFormLogin } from '../adapters/playwright/form-login.js';
import { PlaywrightPageInspector } from '../adapters/playwright/page-inspector.js';
import { PlaywrightTestRunner } from '../adapters/playwright/playwright-test-runner.js';
import { exitCodeForPolicy } from '../application/exit-code.js';
import { VerifyTicketUseCase, type VerificationReport } from '../application/verify-ticket.js';
import { ConfigError, loadConfig, type AppConfig } from '../config/load-config.js';

export const HELP = `qa-analyzer — verify a deployed Jira ticket with AI-generated Playwright tests

Usage:
  qa-analyzer verify [options]

Options:
  --ticket <KEY>         Ticket key (default: QA_TICKET, then branch name, then commit message)
  --env <name>           staging | production (default: QA_ENV or BITBUCKET_DEPLOYMENT_ENVIRONMENT)
  --url <path>           Start page to inspect (default: /)
  --output-dir <dir>     Report directory (default: qa-report)
  --fail-on <policy>     not-resolved (default) | inconclusive | never
  --dry-run              Do everything except commenting on Jira
  --no-comment           Never comment on Jira
  -h, --help             Show this help

Exit codes (--fail-on not-resolved): 0 RESOLVED or INCONCLUSIVE, 1 NOT_RESOLVED,
2 configuration error or INCONCLUSIVE caused by setup (credentials, login).
--fail-on inconclusive: 0 RESOLVED, 1 NOT_RESOLVED, 2 INCONCLUSIVE. --fail-on never: always 0.

Required environment: TARGET_BASE_URL, JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN,
ANTHROPIC_API_KEY. See README.md for every variable.
`;

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

const processIo: CliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

export function formatHumanSummary(report: VerificationReport, reportPath: string | undefined, exitCode: number): string {
  const lines = [
    `QA verification: ${report.verdict}`,
    `Ticket: ${report.ticket ? `${report.ticket.key} (from ${report.ticket.keySource})${report.ticket.summary ? ` — ${report.ticket.summary}` : ''}` : 'not found'}`,
    `Environment: ${report.environment} (${report.policyMode}) at ${report.targetBaseUrl}`,
    `Reason: ${report.reason}`,
    ...report.results.map((result) => `  [${result.status}] ${result.criterionId} — ${result.reason.split('\n')[0]}`),
    `Jira comment: ${report.comment.posted ? 'posted' : `not posted (${report.comment.error ?? report.comment.skippedReason ?? 'n/a'})`}`,
    `Report: ${reportPath ?? 'not written'}`,
    `Exit code: ${exitCode}`,
  ];
  return `${lines.join('\n')}\n`;
}

async function verify(config: AppConfig, io: CliIo): Promise<number> {
  const outputDir = resolve(config.outputDir);
  const jira = new JiraClient({ baseUrl: config.jira.baseUrl, email: config.jira.email, apiToken: config.jira.apiToken });
  // The session state lives outside the output dir, so it never ends up in uploaded artifacts.
  const authDir = config.auth.mode === 'form' ? await mkdtemp(join(tmpdir(), 'qa-analyzer-auth-')) : undefined;
  const auth = config.auth;

  const useCase = new VerifyTicketUseCase({
    tickets: new JiraTicketRepository(jira, { acField: config.jira.acField }),
    commenter: new JiraTicketCommenter(jira),
    readiness: readinessProbeFromConfig(config),
    inspectorFor: (storageStatePath) => new PlaywrightPageInspector({ baseUrl: config.targetBaseUrl, policy: config.policy, storageStatePath }),
    generator: new ClaudeTestGenerator({
      client: new Anthropic(config.anthropic.apiKey ? { apiKey: config.anthropic.apiKey } : {}),
      model: config.anthropic.model,
    }),
    runner: new PlaywrightTestRunner(),
    login:
      auth.mode === 'form' && authDir
        ? async () => {
            const browser = await chromium.launch({ headless: true });
            try {
              return await performFormLogin({ targetBaseUrl: config.targetBaseUrl, outputDir: authDir, policy: config.policy, auth }, browser);
            } finally {
              await browser.close();
            }
          }
        : undefined,
    readHeadCommitMessage: () => readHeadCommitMessage(),
    reporter: new FileReporter(outputDir, (message) => io.err(`[qa-analyzer] ${message}\n`)),
    clock: { now: () => Date.now() },
  });

  try {
    const { report, reportPath } = await useCase.execute({
      explicitTicket: config.ticket,
      branch: config.git.branch,
      commit: config.git.commit,
      commitMessage: config.git.commitMessage,
      jiraProjects: config.jiraProjects,
      environment: config.environment,
      policy: config.policy,
      targetBaseUrl: config.targetBaseUrl,
      startUrl: config.startUrl,
      outputDir,
      dryRun: config.dryRun,
      comment: config.comment,
      secrets: [config.jira.apiToken, config.anthropic.apiKey ?? '', auth.mode === 'form' ? auth.password : ''].filter(Boolean),
    });
    const exitCode = exitCodeForPolicy(report.verdict, config.failOn, report.configError);
    io.out(formatHumanSummary(report, reportPath, exitCode));
    return exitCode;
  } finally {
    if (authDir) await rm(authDir, { recursive: true, force: true });
  }
}

/** Parses arguments and environment, runs the command, and returns the exit code. */
export async function runCli(argv: string[], env: NodeJS.ProcessEnv, io: CliIo = processIo): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    io.out(HELP);
    return 0;
  }
  let config: AppConfig;
  try {
    config = loadConfig(argv, env);
  } catch (error) {
    if (error instanceof ConfigError) {
      io.err(`${error.message}\n\nRun "qa-analyzer --help" for usage.\n`);
      return 2;
    }
    throw error;
  }
  return verify(config, io);
}
