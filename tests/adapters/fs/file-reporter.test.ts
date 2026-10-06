import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileReporter } from '../../../src/adapters/fs/file-reporter.js';
import type { VerificationReport } from '../../../src/application/verify-ticket.js';

describe('FileReporter', () => {
  it('writes report.json and summary.md, creating the directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qa-reporter-'));
    try {
      const outputDir = join(root, 'nested', 'qa-report');
      const report = { verdict: 'RESOLVED', results: [] } as unknown as VerificationReport;
      const path = await new FileReporter(outputDir, () => undefined).write(report, '# summary');
      expect(path).toBe(join(outputDir, 'report.json'));
      expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(report);
      expect(await readFile(join(outputDir, 'summary.md'), 'utf8')).toBe('# summary');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('writes an artifact under the output directory, creating subdirectories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qa-reporter-'));
    try {
      const reporter = new FileReporter(root, () => undefined);
      const path = await reporter.writeArtifact('generated/plan.spec.ts', '// spec');
      expect(path).toBe(join(root, 'generated', 'plan.spec.ts'));
      expect(await readFile(path, 'utf8')).toBe('// spec');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses an artifact path outside the output directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qa-reporter-'));
    try {
      await expect(new FileReporter(join(root, 'out'), () => undefined).writeArtifact('../escape.txt', 'x')).rejects.toThrow(/outside/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
