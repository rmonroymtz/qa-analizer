import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { Reporter, VerificationReport } from '../../application/verify-ticket.js';

/** Writes `report.json`, `summary.md` and artifacts into the output directory and logs to stderr. */
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

  async writeArtifact(relativePath: string, content: string): Promise<string> {
    const root = resolve(this.outputDir);
    const path = resolve(root, relativePath);
    const inside = relative(root, path);
    if (inside === '' || inside.startsWith('..') || resolve(root, inside) !== path) {
      throw new Error(`artifact path ${relativePath} is outside the output directory`);
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    return path;
  }

  log(message: string): void {
    this.logLine(message);
  }
}
