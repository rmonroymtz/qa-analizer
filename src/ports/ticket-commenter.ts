import type { CriterionResult } from '../domain/criterion-result.js';
import type { Environment } from '../domain/environment.js';
import type { Verdict } from '../domain/verdict.js';

export interface VerificationComment {
  verdict: Verdict;
  environment: Environment;
  commitSha?: string;
  summary: string;
  results: CriterionResult[];
  /** Local file paths to attach to the ticket. */
  attachments: string[];
}

export interface TicketCommenter {
  comment(key: string, comment: VerificationComment): Promise<void>;
}
