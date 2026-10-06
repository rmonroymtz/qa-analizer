import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Reporter, VerificationReport } from '../../application/verify-ticket.js';

/** Writes `report.json` and `summary.md` into the output directory and logs to stderr. */
export class FileReporter implements Reporter {
  constructor(
    private readonly outputDir: string,
    private readonly logLine: (message: string) => void = (message) => process.stderr.write(`[qa-analyzer] ${message}\n`),
  ) {}

  async write(report: VerificationReport, summaryMarkdown: string): Promise<string> {
    await mkdir(this.outputDir, { recursive: true });
    const reportPath = join(this.outputDir, 'report.json');
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    await writeFile(join(this.outputDir, 'summary.md'), summaryMarkdown);
    return reportPath;
  }

  log(message: string): void {
    this.logLine(message);
  }
}
