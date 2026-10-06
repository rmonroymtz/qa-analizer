import type { CriterionEvidence, CriterionStatus } from '../../domain/criterion-result.js';
import type { StepAction } from '../../domain/test-plan.js';
import type { BlockedRequest } from './read-only-guard.js';

/**
 * Why a step did not succeed:
 * - `assertion`: an assertion was evaluated and did not hold before its timeout;
 * - `error`: an assertion could not be evaluated (closed page, detached element);
 * - `action`: an interaction failed (not found, timeout, strict mode, detached);
 * - `navigation`: `goto` failed;
 * - `off-origin`: after this step the page was no longer on the target site
 *   (the message is the foreign origin);
 * - `budget`: the whole test ran out of time during this step.
 */
export type StepFailureKind = 'assertion' | 'error' | 'action' | 'navigation' | 'off-origin' | 'budget';

export interface StepFailureDetail {
  kind: StepFailureKind;
  message: string;
  /** For target assertions: how many elements the target matched when the assertion gave up. */
  targetCount?: number;
  /** The target matched several elements and no `nth` was given. */
  ambiguous?: boolean;
  expected?: string;
  actual?: string;
}

export interface StepFailure extends StepFailureDetail {
  /** Zero-based index of the failing step. */
  stepIndex: number;
  action: StepAction;
}

export interface StepClassification {
  status: CriterionStatus;
  reason: string;
  evidence?: CriterionEvidence;
}

/**
 * An assertion whose target matches no element. It may mean the feature is
 * missing (NOT_RESOLVED) or that the UI changed or the plan guessed a name
 * (INCONCLUSIVE). Pending a user decision, it is INCONCLUSIVE; change it here only.
 */
export const MISSING_TARGET_STATUS: CriterionStatus = 'INCONCLUSIVE';
export const MISSING_TARGET_REASON = 'expected element not found: the feature may be missing or the UI changed — needs human review';

const MAX_BLOCKED_LISTED = 3;

function stepLabel(failure: StepFailure): string {
  return `step ${failure.stepIndex + 1} (${failure.action})`;
}

function blockedSuffix(blocked: readonly BlockedRequest[]): string {
  if (blocked.length === 0) return '';
  const listed = blocked.slice(0, MAX_BLOCKED_LISTED).map((request) => `${request.method} ${request.url}`);
  const more = blocked.length > MAX_BLOCKED_LISTED ? ` and ${blocked.length - MAX_BLOCKED_LISTED} more` : '';
  return `; blocked requests: ${listed.join(', ')}${more}`;
}

/**
 * Classifies the first failing step of a test. Only an assertion that was
 * evaluated against a resolved target (or against the URL or title) is FAILED;
 * everything that kept the test from reaching or identifying its target is
 * INCONCLUSIVE. A failed assertion after the read-only guard blocked any request
 * (to the target or to another host not in `QA_READONLY_ALLOW_HOSTS`, such as
 * the site's API on a sibling domain) is INCONCLUSIVE too, because the block may
 * have caused it.
 */
export function classifyStepFailure(failure: StepFailure, blocked: readonly BlockedRequest[]): StepClassification {
  const label = stepLabel(failure);
  const suffix = blockedSuffix(blocked);
  switch (failure.kind) {
    case 'action':
    case 'error':
      return { status: 'INCONCLUSIVE', reason: `could not complete ${label}: ${failure.message}${suffix}` };
    case 'navigation':
      return { status: 'INCONCLUSIVE', reason: `navigation failed at ${label}: ${failure.message}${suffix}` };
    case 'off-origin':
      return { status: 'INCONCLUSIVE', reason: `navigation left the target site (${failure.message}) at ${label}${suffix}` };
    case 'budget':
      return { status: 'INCONCLUSIVE', reason: `test exceeded its time budget at ${label}: ${failure.message}${suffix}` };
    case 'assertion':
      break;
  }
  if (failure.targetCount === 0) return { status: MISSING_TARGET_STATUS, reason: `${label}: ${MISSING_TARGET_REASON}${suffix}` };
  if (failure.ambiguous) return { status: 'INCONCLUSIVE', reason: `${label}: ${failure.message}${suffix}` };

  const evidence: CriterionEvidence = {};
  if (failure.expected !== undefined) evidence.expected = failure.expected;
  if (failure.actual !== undefined) evidence.actual = failure.actual;
  const details = failure.expected !== undefined || failure.actual !== undefined ? `expected ${failure.expected ?? '?'}, actual ${failure.actual ?? '?'}` : failure.message;
  if (blocked.length > 0) {
    return { status: 'INCONCLUSIVE', reason: `${label} failed after the read-only guard blocked a request: ${details}${suffix}`, evidence };
  }
  return { status: 'FAILED', reason: `${label} failed: ${details}${suffix}`, evidence };
}
