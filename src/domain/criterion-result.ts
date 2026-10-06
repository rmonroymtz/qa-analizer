export type CriterionStatus = 'PASSED' | 'FAILED' | 'INCONCLUSIVE';

export interface CriterionEvidence {
  screenshotPath?: string;
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
