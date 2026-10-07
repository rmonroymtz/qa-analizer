import { inspect, parseArgs } from 'node:util';
import { validateExplicitTicketKey } from '../application/resolve-ticket-key.js';
import { policyFor, type Environment, type EnvironmentPolicy } from '../domain/environment.js';

export type FailOnPolicy = 'not-resolved' | 'inconclusive' | 'never';

/*
 * Secrets (`JiraConfig.apiToken`, `AnthropicConfig.apiKey` and the form
 * `password`) are non-enumerable on configs built by loadConfig: read them
 * directly; spreading or cloning a part of the config drops them on purpose.
 */

export interface JiraConfig {
  baseUrl: string;
  email: string;
  /** Secret: non-enumerable on a loaded config. */
  apiToken: string;
  acField: string | undefined;
}

export interface AnthropicConfig {
  /** Optional: the SDK can resolve credentials on its own. */
  apiKey: string | undefined;
  model: string;
}

export interface GitContext {
  branch: string | undefined;
  commit: string | undefined;
  commitMessage: string | undefined;
}

export type AuthConfig =
  | { mode: 'none' }
  | {
      mode: 'form';
      user: string;
      password: string;
      loginPath: string;
      /**
       * Path globs (or `^regex`) allowed to mutate in read-only mode during the
       * hand-written login only: the login page path plus `QA_LOGIN_ALLOW`. The
       * inspector and the plan runner never get them.
       */
      loginMutationPaths: string[];
      userSelector: string;
      passwordSelector: string;
      submitSelector: string;
      /** Regex source matched against the URL after a successful login. */
      successUrlPattern: string | undefined;
    };

export interface ReadinessConfig {
  url: string | undefined;
  timeoutMs: number;
}

export interface AppConfig {
  command: 'verify';
  /** Explicit ticket key from `--ticket` or `QA_TICKET`, validated and upper-cased. */
  ticket: string | undefined;
  /** Jira project keys from `QA_JIRA_PROJECTS`; when non-empty, only their keys are accepted. */
  jiraProjects: string[];
  environment: Environment;
  policy: EnvironmentPolicy;
  /** Page to inspect first (`--url`); undefined lets the ticket choose the pages. */
  startUrl: string | undefined;
  dryRun: boolean;
  comment: boolean;
  failOn: FailOnPolicy;
  outputDir: string;
  targetBaseUrl: string;
  jira: JiraConfig;
  anthropic: AnthropicConfig;
  git: GitContext;
  auth: AuthConfig;
  readiness: ReadinessConfig;
}

/** Thrown when configuration is missing or invalid. Lists every issue; never includes secret values. */
export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

export const DEFAULT_MODEL = 'claude-opus-5-5';
export const DEFAULT_READY_TIMEOUT_MS = 300_000;
const REDACTED = '***';
const FAIL_ON_VALUES: readonly FailOnPolicy[] = ['not-resolved', 'inconclusive', 'never'];
const PROJECT_KEY = /^[A-Z][A-Z0-9]+$/;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeEnvironment(raw: string): Environment | undefined {
  switch (raw.trim().toLowerCase()) {
    case 'prod':
    case 'production':
      return 'production';
    case 'stage':
    case 'staging':
      return 'staging';
    default:
      return undefined;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidRegex(source: string): boolean {
  try {
    new RegExp(source);
    return true;
  } catch {
    return false;
  }
}

/** Returns a deep copy of the config with every secret replaced by `***`. */
export function redactConfig(config: AppConfig): AppConfig {
  const auth: AuthConfig =
    config.auth.mode === 'form' ? { ...config.auth, loginMutationPaths: [...config.auth.loginMutationPaths], password: REDACTED } : { mode: 'none' };
  return {
    command: config.command,
    ticket: config.ticket,
    jiraProjects: [...config.jiraProjects],
    environment: config.environment,
    policy: { ...config.policy, allowedMutations: [...config.policy.allowedMutations], allowedHosts: [...(config.policy.allowedHosts ?? [])] },
    startUrl: config.startUrl,
    dryRun: config.dryRun,
    comment: config.comment,
    failOn: config.failOn,
    outputDir: config.outputDir,
    targetBaseUrl: config.targetBaseUrl,
    jira: { ...config.jira, apiToken: REDACTED },
    anthropic: { ...config.anthropic, apiKey: config.anthropic.apiKey === undefined ? undefined : REDACTED },
    git: { ...config.git },
    auth,
    readiness: { ...config.readiness },
  };
}

/**
 * Turns `key` into a non-enumerable, read-only property, so JSON.stringify,
 * util.inspect, object spread and structuredClone of `holder` all skip it,
 * while `holder[key]` still reads it. A custom inspector also hides it from
 * `util.inspect(..., { showHidden: true })`.
 */
function hideSecret<T extends object>(holder: T, key: keyof T & string): T {
  const value = holder[key];
  Object.defineProperty(holder, key, { value, enumerable: false, writable: false, configurable: false });
  Object.defineProperty(holder, inspect.custom, {
    value: () => ({ ...holder }),
    enumerable: false,
  });
  return holder;
}

/** Makes JSON, string conversion and `util.inspect` of the config emit the redacted form. */
function protectSerialization(config: AppConfig): AppConfig {
  Object.defineProperties(config, {
    toJSON: { value: () => redactConfig(config), enumerable: false },
    toString: { value: () => JSON.stringify(redactConfig(config)), enumerable: false },
    [inspect.custom]: { value: () => redactConfig(config), enumerable: false },
  });
  return config;
}

interface ParsedFlags {
  command: string | undefined;
  ticket: string | undefined;
  env: string | undefined;
  url: string | undefined;
  dryRun: boolean;
  noComment: boolean;
  failOn: string | undefined;
  outputDir: string | undefined;
}

function parseFlags(argv: string[], issues: string[]): ParsedFlags {
  const empty: ParsedFlags = {
    command: undefined,
    ticket: undefined,
    env: undefined,
    url: undefined,
    dryRun: false,
    noComment: false,
    failOn: undefined,
    outputDir: undefined,
  };
  try {
    const { values, positionals } = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        ticket: { type: 'string' },
        env: { type: 'string' },
        url: { type: 'string' },
        'dry-run': { type: 'boolean' },
        'no-comment': { type: 'boolean' },
        'fail-on': { type: 'string' },
        'output-dir': { type: 'string' },
      },
    });
    return {
      command: positionals[0],
      ticket: values.ticket,
      env: values.env,
      url: values.url,
      dryRun: values['dry-run'] ?? false,
      noComment: values['no-comment'] ?? false,
      failOn: values['fail-on'],
      outputDir: values['output-dir'],
    };
  } catch (error) {
    issues.push(`invalid arguments: ${error instanceof Error ? error.message : String(error)}`);
    return empty;
  }
}

function requireEnv(env: NodeJS.ProcessEnv, name: string, issues: string[]): string {
  const value = nonEmpty(env[name]);
  if (value === undefined) issues.push(`${name} is required`);
  return value ?? '';
}

function loadAuth(env: NodeJS.ProcessEnv, issues: string[]): AuthConfig {
  const mode = nonEmpty(env.QA_AUTH_MODE)?.toLowerCase() ?? 'none';
  const loginAllow = splitList(env.QA_LOGIN_ALLOW);
  if (mode === 'none') {
    if (loginAllow.length > 0) issues.push('QA_LOGIN_ALLOW requires QA_AUTH_MODE=form');
    return { mode: 'none' };
  }
  if (mode !== 'form') {
    issues.push('QA_AUTH_MODE must be one of: none, form');
    return { mode: 'none' };
  }
  const successUrlPattern = nonEmpty(env.QA_LOGIN_SUCCESS_URL);
  if (successUrlPattern !== undefined && !isValidRegex(successUrlPattern)) {
    issues.push('QA_LOGIN_SUCCESS_URL must be a valid regular expression');
  }
  const loginPath = requireEnv(env, 'QA_LOGIN_PATH', issues);
  // The guard matches pathnames, so the query and fragment of the login page are dropped.
  const loginPagePath = loginPath.split(/[?#]/)[0] ?? '';
  return {
    mode: 'form',
    user: requireEnv(env, 'TEST_USER', issues),
    password: requireEnv(env, 'TEST_PASSWORD', issues),
    loginPath,
    loginMutationPaths: [...new Set([...(loginPagePath ? [loginPagePath] : []), ...loginAllow])],
    userSelector: requireEnv(env, 'QA_LOGIN_USER_SELECTOR', issues),
    passwordSelector: requireEnv(env, 'QA_LOGIN_PASSWORD_SELECTOR', issues),
    submitSelector: requireEnv(env, 'QA_LOGIN_SUBMIT_SELECTOR', issues),
    successUrlPattern,
  };
}

function loadReadiness(env: NodeJS.ProcessEnv, issues: string[]): ReadinessConfig {
  const url = nonEmpty(env.QA_READY_URL);
  if (url !== undefined && !isHttpUrl(url)) issues.push('QA_READY_URL must be an absolute http(s) URL');
  const rawTimeout = nonEmpty(env.QA_READY_TIMEOUT_MS);
  let timeoutMs = DEFAULT_READY_TIMEOUT_MS;
  if (rawTimeout !== undefined) {
    timeoutMs = Number(rawTimeout);
    if (!/^\d+$/.test(rawTimeout) || timeoutMs <= 0) {
      issues.push('QA_READY_TIMEOUT_MS must be a positive integer (milliseconds)');
      timeoutMs = DEFAULT_READY_TIMEOUT_MS;
    }
  }
  return { url, timeoutMs };
}

/**
 * Resolves the environment from `--env`, then `QA_ENV`, then
 * `BITBUCKET_DEPLOYMENT_ENVIRONMENT`, and fails closed when an override
 * disagrees with Bitbucket: a run must never test a production deployment in
 * full mode because of a stale variable. When Bitbucket's environment name is
 * not a known one, an override may only force production (read-only).
 */
function resolveEnvironment(flag: string | undefined, qaEnv: string | undefined, bitbucket: string | undefined, issues: string[]): Environment {
  const override = flag !== undefined ? { source: '--env', raw: flag } : qaEnv !== undefined ? { source: 'QA_ENV', raw: qaEnv } : undefined;
  const raw = override?.raw ?? bitbucket;
  if (raw === undefined) {
    issues.push('environment is required (--env, QA_ENV or BITBUCKET_DEPLOYMENT_ENVIRONMENT)');
    return 'staging';
  }
  const environment = normalizeEnvironment(raw);
  if (environment === undefined) {
    issues.push('environment must be one of: staging, stage, production, prod');
    return 'staging';
  }
  if (override !== undefined && bitbucket !== undefined) {
    const deployed = normalizeEnvironment(bitbucket);
    const conflict = `environment conflict: ${override.source} is "${override.raw}" but BITBUCKET_DEPLOYMENT_ENVIRONMENT is "${bitbucket}"`;
    if (deployed === undefined && environment !== 'production') {
      issues.push(`${conflict}, which is not a known environment; only production (read-only) may be forced`);
    } else if (deployed !== undefined && deployed !== environment) {
      issues.push(`${conflict}; remove ${override.source} or make it match`);
    }
  }
  return environment;
}

function splitList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Builds the typed application config from CLI arguments (without the node/script
 * prefix) and environment variables. Throws a ConfigError listing every problem.
 */
export function loadConfig(argv: string[], env: NodeJS.ProcessEnv): AppConfig {
  const issues: string[] = [];
  const flags = parseFlags(argv, issues);

  if (flags.command !== 'verify' && !issues.some((issue) => issue.startsWith('invalid arguments'))) {
    issues.push('command must be "verify"');
  }

  const environment = resolveEnvironment(nonEmpty(flags.env), nonEmpty(env.QA_ENV), nonEmpty(env.BITBUCKET_DEPLOYMENT_ENVIRONMENT), issues);

  const failOnRaw = flags.failOn ?? 'not-resolved';
  const failOn = FAIL_ON_VALUES.find((value) => value === failOnRaw);
  if (failOn === undefined) issues.push(`--fail-on must be one of: ${FAIL_ON_VALUES.join(', ')}`);

  const targetBaseUrl = requireEnv(env, 'TARGET_BASE_URL', issues);
  if (targetBaseUrl && !isHttpUrl(targetBaseUrl)) issues.push('TARGET_BASE_URL must be an absolute http(s) URL');

  const jiraBaseUrl = requireEnv(env, 'JIRA_BASE_URL', issues);
  if (jiraBaseUrl && !isHttpUrl(jiraBaseUrl)) issues.push('JIRA_BASE_URL must be an absolute http(s) URL');
  const jira: JiraConfig = {
    baseUrl: jiraBaseUrl.replace(/\/+$/, ''),
    email: requireEnv(env, 'JIRA_EMAIL', issues),
    apiToken: requireEnv(env, 'JIRA_API_TOKEN', issues),
    acField: nonEmpty(env.JIRA_AC_FIELD),
  };

  const auth = loadAuth(env, issues);
  const readiness = loadReadiness(env, issues);
  const allowedHosts = splitList(env.QA_READONLY_ALLOW_HOSTS).map((host) => host.toLowerCase());
  if (allowedHosts.some((host) => !HOSTNAME.test(host))) {
    issues.push('QA_READONLY_ALLOW_HOSTS must be a comma-separated list of bare hostnames (no scheme, port or path)');
  }

  const jiraProjects = [...new Set(splitList(env.QA_JIRA_PROJECTS).map((project) => project.toUpperCase()))];
  if (jiraProjects.some((project) => !PROJECT_KEY.test(project))) {
    issues.push('QA_JIRA_PROJECTS must be a comma-separated list of Jira project keys such as PROJ');
  }
  let ticket = nonEmpty(flags.ticket) ?? nonEmpty(env.QA_TICKET);
  if (ticket !== undefined) {
    const validated = validateExplicitTicketKey(ticket, { projects: jiraProjects });
    if ('problem' in validated) issues.push(`--ticket / QA_TICKET: ${validated.problem}`);
    else ticket = validated.key;
  }

  if (issues.length > 0) throw new ConfigError(issues);

  // Only QA_READONLY_ALLOW: the login endpoints live in `auth.loginMutationPaths`, used by the login alone.
  const allowedMutations = splitList(env.QA_READONLY_ALLOW);

  hideSecret(jira, 'apiToken');
  if (auth.mode === 'form') hideSecret(auth, 'password');
  const anthropic: AnthropicConfig = hideSecret(
    { apiKey: nonEmpty(env.ANTHROPIC_API_KEY), model: nonEmpty(env.QA_MODEL) ?? DEFAULT_MODEL },
    'apiKey',
  );

  return protectSerialization({
    command: 'verify',
    ticket,
    jiraProjects,
    environment,
    policy: policyFor(environment, [...new Set(allowedMutations)], [...new Set(allowedHosts)]),
    startUrl: nonEmpty(flags.url),
    dryRun: flags.dryRun,
    comment: !flags.noComment,
    failOn: failOn ?? 'not-resolved',
    outputDir: nonEmpty(flags.outputDir) ?? 'qa-report',
    targetBaseUrl: targetBaseUrl.replace(/\/+$/, ''),
    jira,
    anthropic,
    git: {
      branch: nonEmpty(env.BITBUCKET_BRANCH),
      commit: nonEmpty(env.BITBUCKET_COMMIT),
      commitMessage: nonEmpty(env.QA_COMMIT_MESSAGE),
    },
    auth,
    readiness,
  });
}
