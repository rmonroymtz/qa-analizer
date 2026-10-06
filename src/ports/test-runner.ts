import type { CriterionResult } from '../domain/criterion-result.js';
import type { Environment, EnvironmentPolicy } from '../domain/environment.js';
import type { Ticket } from '../domain/ticket.js';
import type { GeneratedSuite } from './test-generator.js';

export interface RunContext {
  baseUrl: string;
  environment: Environment;
  policy: EnvironmentPolicy;
  storageStatePath?: string;
  outputDir: string;
  /** The ticket under verification; results are returned in its criterion order. */
  ticket: Ticket;
}

export interface TestRunner {
  run(suite: GeneratedSuite, ctx: RunContext): Promise<CriterionResult[]>;
}
