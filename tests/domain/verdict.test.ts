import { describe, expect, it } from 'vitest';
import { aggregateVerdict, exitCodeFor } from '../../src/domain/verdict.js';
import { policyFor } from '../../src/domain/environment.js';
import type { CriterionResult } from '../../src/domain/criterion-result.js';
import type { Ticket } from '../../src/domain/ticket.js';

const ticket: Ticket = {
  key: 'PROJ-1',
  summary: 'Summary',
  description: 'Description',
  acceptanceCriteria: [
    { id: 'AC-1', text: 'First' },
    { id: 'AC-2', text: 'Second' },
  ],
  url: 'https://jira.example.com/browse/PROJ-1',
};

function result(criterionId: string, status: CriterionResult['status']): CriterionResult {
  return { criterionId, status, reason: `${status} reason` };
}

describe('exitCodeFor', () => {
  it('maps each verdict to its exit code', () => {
    expect(exitCodeFor('RESOLVED')).toBe(0);
    expect(exitCodeFor('NOT_RESOLVED')).toBe(1);
    expect(exitCodeFor('INCONCLUSIVE')).toBe(2);
  });
});

describe('aggregateVerdict', () => {
  it('is INCONCLUSIVE when the ticket has no acceptance criteria', () => {
    const noCriteria = { ...ticket, acceptanceCriteria: [] };
    expect(aggregateVerdict([result('AC-1', 'PASSED')], noCriteria)).toBe('INCONCLUSIVE');
  });

  it('is INCONCLUSIVE when there are no results', () => {
    expect(aggregateVerdict([], ticket)).toBe('INCONCLUSIVE');
  });

  it('is NOT_RESOLVED when any criterion failed, even if others are inconclusive', () => {
    const results = [result('AC-1', 'INCONCLUSIVE'), result('AC-2', 'FAILED')];
    expect(aggregateVerdict(results, ticket)).toBe('NOT_RESOLVED');
  });

  it('is INCONCLUSIVE when nothing failed but something is inconclusive', () => {
    const results = [result('AC-1', 'PASSED'), result('AC-2', 'INCONCLUSIVE')];
    expect(aggregateVerdict(results, ticket)).toBe('INCONCLUSIVE');
  });

  it('is RESOLVED when every result passed', () => {
    const results = [result('AC-1', 'PASSED'), result('AC-2', 'PASSED')];
    expect(aggregateVerdict(results, ticket)).toBe('RESOLVED');
  });
});

describe('policyFor', () => {
  it('is read-only in production and full in staging', () => {
    expect(policyFor('production', ['/login'])).toEqual({ mode: 'read-only', allowedMutations: ['/login'] });
    expect(policyFor('staging', [])).toEqual({ mode: 'full', allowedMutations: [] });
  });
});
