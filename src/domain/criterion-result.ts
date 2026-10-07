export type CriterionStatus = 'PASSED' | 'FAILED' | 'INCONCLUSIVE';

export interface CriterionEvidence {
  screenshotPath?: string;
  /**
   * Playwright trace of the test (opt-in `--trace`). Local evidence only: it can
   * hold cookies and response bodies, so it is never attached to the Jira comment.
   */
  tracePath?: string;
  expected?: string;
  actual?: string;
}

/** The outcome of verifying one acceptance criterion. */
export interface CriterionResult {
  criterionId: string;
  status: CriterionStatus;
  reason: string;
  evidence?: CriterionEvidence;
}
