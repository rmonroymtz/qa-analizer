import { describe, expect, it } from 'vitest';
import { formatHumanSummary, runCli } from '../../src/cli/run-cli.js';
import type { VerificationReport } from '../../src/application/verify-ticket.js';

function io() {
  const captured = { out: '', err: '' };
  return { captured, io: { out: (text: string) => { captured.out += text; }, err: (text: string) => { captured.err += text; } } };
}

describe('runCli', () => {
  it.each([[[]], [['--help']], [['verify', '-h']]])('prints help and exits 0 for %j', async (argv) => {
    const { captured, io: cliIo } = io();
    expect(await runCli(argv, {}, cliIo)).toBe(0);
    expect(captured.out).toContain('Usage:');
    expect(captured.out).toContain('ticket key not found');
    expect(captured.out).toContain('--url <path>           Page to inspect first (default: pages named in the ticket, else /)');
    expect(captured.err).toBe('');
  });

  it('prints every config issue and exits 2 without environment', async () => {
    const { captured, io: cliIo } = io();
    expect(await runCli(['verify'], {}, cliIo)).toBe(2);
    expect(captured.err).toContain('TARGET_BASE_URL is required');
    expect(captured.err).toContain('JIRA_API_TOKEN is required');
    expect(captured.err).toContain('environment is required');
    expect(captured.err).toContain('Run "qa-analyzer --help" for usage.');
    expect(captured.out).toBe('');
  });
});

describe('formatHumanSummary', () => {
  it('shows the verdict, one line per criterion, the report path and the exit code', () => {
    const report = {
      verdict: 'NOT_RESOLVED',
      reason: '1 of 2 criteria passed, 1 failed, 0 inconclusive',
      configError: false,
      ticket: { key: 'SHOP-42', keySource: 'branch', summary: 'Badge' },
      environment: 'staging',
      policyMode: 'full',
      targetBaseUrl: 'https://shop.example.com',
      commit: null,
      pagesInspected: [
        { path: '/ofertas', source: 'ticket' },
        { path: '/', source: 'default' },
      ],
      results: [
        { criterionId: 'AC-1', status: 'PASSED', reason: 'test passed' },
        { criterionId: 'AC-2', status: 'FAILED', reason: 'price is discounted\nmore' },
      ],
      comment: { posted: true },
      timings: { startedAt: '', durationMs: 1, steps: {} },
    } as VerificationReport;
    const text = formatHumanSummary(report, '/out/report.json', 1);
    // Only the first line of a multi-line reason is shown.
    expect(text).toBe(
      [
        'QA verification: NOT_RESOLVED',
        'Ticket: SHOP-42 (from branch) — Badge',
        'Environment: staging (full) at https://shop.example.com',
        'Pages: /ofertas (ticket), / (default)',
        'Reason: 1 of 2 criteria passed, 1 failed, 0 inconclusive',
        '  [PASSED] AC-1 — test passed',
        '  [FAILED] AC-2 — price is discounted',
        'Jira comment: posted',
        'Report: /out/report.json',
        'Exit code: 1',
        '',
      ].join('\n'),
    );
  });

  it('explains why no comment was posted and when the report was not written', () => {
    const report = {
      verdict: 'INCONCLUSIVE',
      reason: 'ticket key not found',
      configError: true,
      ticket: null,
      environment: 'production',
      policyMode: 'read-only',
      targetBaseUrl: 'https://shop.example.com',
      commit: null,
      pagesInspected: [],
      results: [],
      comment: { posted: false, skippedReason: 'no ticket to comment on' },
      timings: { startedAt: '', durationMs: 1, steps: {} },
    } as VerificationReport;
    const lines = formatHumanSummary(report, undefined, 2).split('\n');
    expect(lines).toContain('Ticket: not found');
    expect(lines).toContain('Pages: none');
    expect(lines).toContain('Jira comment: not posted (no ticket to comment on)');
    expect(lines).toContain('Report: not written');
    expect(lines).toContain('Exit code: 2');
    expect(lines.filter((line) => line.startsWith('  ['))).toEqual([]);
  });

  it('lists the recorded traces with the command that opens them', () => {
    const report = {
      verdict: 'RESOLVED',
      reason: '1 of 1 criteria passed, 0 failed, 0 inconclusive',
      configError: false,
      ticket: { key: 'SHOP-42', keySource: 'explicit' },
      environment: 'staging',
      policyMode: 'full',
      targetBaseUrl: 'https://shop.example.com',
      commit: null,
      pagesInspected: [],
      results: [{ criterionId: 'AC-1', status: 'PASSED', reason: 'test passed', evidence: { tracePath: '/out/traces/AC-1.zip' } }],
      comment: { posted: false, skippedReason: 'verdict is RESOLVED' },
      timings: { startedAt: '', durationMs: 1, steps: {} },
    } as VerificationReport;
    const lines = formatHumanSummary(report, '/out/report.json', 0).split('\n');
    const at = lines.indexOf('Traces:');
    expect(at).toBeGreaterThan(lines.indexOf('  [PASSED] AC-1 — test passed'));
    expect(lines[at + 1]).toBe('  AC-1: npx playwright show-trace /out/traces/AC-1.zip');
  });
});

describe('runCli --trace', () => {
  it('documents the flag in the help', async () => {
    let out = '';
    await runCli(['--help'], {}, { out: (text) => (out += text), err: () => undefined });
    expect(out).toContain('--trace');
  });

  it('refuses tracing in production with exit 2 before running anything', async () => {
    let err = '';
    const code = await runCli(
      ['verify', '--trace'],
      { TARGET_BASE_URL: 'https://shop.example.com', QA_ENV: 'production', JIRA_BASE_URL: 'https://acme.atlassian.net', JIRA_EMAIL: 'qa@example.com', JIRA_API_TOKEN: 't' },
      { out: () => undefined, err: (text) => (err += text) },
    );
    expect(code).toBe(2);
    expect(err).toContain('--trace / QA_TRACE is not allowed in read-only (production) runs');
  });
});
