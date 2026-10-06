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
  });

  it('prints every config issue and exits 2 without environment', async () => {
    const { captured, io: cliIo } = io();
    expect(await runCli(['verify'], {}, cliIo)).toBe(2);
    expect(captured.err).toContain('TARGET_BASE_URL is required');
    expect(captured.err).toContain('JIRA_API_TOKEN is required');
    expect(captured.err).toContain('environment is required');
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
      pagesInspected: ['/'],
      results: [
        { criterionId: 'AC-1', status: 'PASSED', reason: 'test passed' },
        { criterionId: 'AC-2', status: 'FAILED', reason: 'price is discounted\nmore' },
      ],
      comment: { posted: true },
      timings: { startedAt: '', durationMs: 1, steps: {} },
    } as VerificationReport;
    const text = formatHumanSummary(report, '/out/report.json', 1);
    expect(text).toContain('QA verification: NOT_RESOLVED');
    expect(text).toContain('SHOP-42 (from branch)');
    expect(text).toContain('[FAILED] AC-2 — price is discounted');
    expect(text).not.toContain('more');
    expect(text).toContain('Report: /out/report.json');
    expect(text).toContain('Exit code: 1');
  });
});
