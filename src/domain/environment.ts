export type Environment = 'staging' | 'production';

export interface EnvironmentPolicy {
  mode: 'full' | 'read-only';
  /** URL path globs (or regex strings starting with `^`) allowed to mutate despite read-only mode, e.g. login. */
  allowedMutations: string[];
}

/** Production is always read-only; staging allows the full test surface. */
export function policyFor(environment: Environment, allowedMutations: string[]): EnvironmentPolicy {
  return {
    mode: environment === 'production' ? 'read-only' : 'full',
    allowedMutations: [...allowedMutations],
  };
}
