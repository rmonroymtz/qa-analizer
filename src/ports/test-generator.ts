import type { EnvironmentPolicy } from '../domain/environment.js';
import type { TestPlan } from '../domain/test-plan.js';
import type { Ticket } from '../domain/ticket.js';
import type { PageSnapshot } from './page-inspector.js';

export interface GenerationInput {
  ticket: Ticket;
  snapshots: PageSnapshot[];
  baseUrl: string;
  policy: EnvironmentPolicy;
  authenticated: boolean;
}

export interface TestGenerator {
  /** Returns a validated declarative plan; nothing in it is executable code. */
  generate(input: GenerationInput): Promise<TestPlan>;
}
