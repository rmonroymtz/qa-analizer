import type { FailOnPolicy } from '../config/load-config.js';
import { exitCodeFor, type Verdict } from '../domain/verdict.js';

/**
 * Maps a verdict to the process exit code under the `--fail-on` policy.
 *
 * - `not-resolved` (default): NOT_RESOLVED → 1; INCONCLUSIVE → 0, except when it is
 *   caused by a configuration problem (bad credentials, failed login) → 2, so a
 *   broken setup is never silently green. RESOLVED → 0.
 * - `inconclusive`: the raw mapping RESOLVED → 0, NOT_RESOLVED → 1, INCONCLUSIVE → 2.
 * - `never`: always 0 (report only).
 */
export function exitCodeForPolicy(verdict: Verdict, failOn: FailOnPolicy, configError: boolean): number {
  switch (failOn) {
    case 'never':
      return 0;
    case 'inconclusive':
      return exitCodeFor(verdict);
    case 'not-resolved':
      if (verdict === 'NOT_RESOLVED') return exitCodeFor(verdict);
      if (verdict === 'INCONCLUSIVE' && configError) return exitCodeFor(verdict);
      return 0;
  }
}
