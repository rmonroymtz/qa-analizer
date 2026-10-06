import type { CriterionResult } from './criterion-result.js';
import type { Ticket } from './ticket.js';

export type Verdict = 'RESOLVED' | 'NOT_RESOLVED' | 'INCONCLUSIVE';

const EXIT_CODES: Record<Verdict, number> = {
  RESOLVED: 0,
  NOT_RESOLVED: 1,
  INCONCLUSIVE: 2,
};

export function exitCodeFor(verdict: Verdict): number {
  return EXIT_CODES[verdict];
}

/**
 * Combines per-criterion results into a ticket verdict.
 * A failed business assertion wins over inconclusive results, because it is
 * positive evidence that the ticket is not resolved.
 */
export function aggregateVerdict(results: readonly CriterionResult[], ticket: Ticket): Verdict {
  if (ticket.acceptanceCriteria.length === 0 || results.length === 0) return 'INCONCLUSIVE';
  if (results.some((result) => result.status === 'FAILED')) return 'NOT_RESOLVED';
  if (results.some((result) => result.status === 'INCONCLUSIVE')) return 'INCONCLUSIVE';
  return 'RESOLVED';
}
