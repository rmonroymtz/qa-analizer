import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Returns the HEAD commit message, or undefined when git is unavailable or fails. */
export async function readHeadCommitMessage(cwd: string = process.cwd()): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['log', '-1', '--pretty=%B'], { cwd, timeout: 10_000 });
    const message = stdout.trim();
    return message.length > 0 ? message : undefined;
  } catch {
    return undefined;
  }
}
