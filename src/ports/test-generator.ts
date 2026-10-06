import type { EnvironmentPolicy } from '../domain/environment.js';
import type { Ticket } from '../domain/ticket.js';
import type { PageSnapshot } from './page-inspector.js';

export interface GenerationInput {
  ticket: Ticket;
  snapshots: PageSnapshot[];
  baseUrl: string;
  policy: EnvironmentPolicy;
  authenticated: boolean;
}

export interface GeneratedSuite {
  specCode: string;
  criteria: { criterionId: string; testTitle: string }[];
  uncoverable: { criterionId: string; reason: string }[];
}

export interface TestGenerator {
  generate(input: GenerationInput): Promise<GeneratedSuite>;
}
