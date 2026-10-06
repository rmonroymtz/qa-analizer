import type { CriterionResult } from '../domain/criterion-result.js';
import type { Environment, EnvironmentPolicy } from '../domain/environment.js';
import type { GeneratedSuite } from './test-generator.js';

export interface RunContext {
  baseUrl: string;
  environment: Environment;
  policy: EnvironmentPolicy;
  storageStatePath?: string;
  outputDir: string;
}

export interface TestRunner {
  run(suite: GeneratedSuite, ctx: RunContext): Promise<CriterionResult[]>;
}
