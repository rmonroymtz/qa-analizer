import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, redactConfig } from '../../src/config/load-config.js';

const SECRET_TOKEN = 'jira-secret-token-value';
const SECRET_KEY = 'sk-ant-secret-key-value';
const SECRET_PASSWORD = 'p4ssw0rd-secret-value';

function baseEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    TARGET_BASE_URL: 'https://staging.example.com',
    QA_ENV: 'staging',
    JIRA_BASE_URL: 'https://acme.atlassian.net/',
    JIRA_EMAIL: 'qa@example.com',
    JIRA_API_TOKEN: SECRET_TOKEN,
    ...overrides,
  };
}

function captureError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected a ConfigError');
}

describe('loadConfig', () => {
  it('applies defaults for a minimal staging run', () => {
    const config = loadConfig(['verify'], baseEnv());
    expect(config.command).toBe('verify');
    expect(config.environment).toBe('staging');
    expect(config.policy).toEqual({ mode: 'full', allowedMutations: [] });
    expect(config.startUrl).toBe('/');
    expect(config.dryRun).toBe(false);
    expect(config.comment).toBe(true);
    expect(config.failOn).toBe('not-resolved');
    expect(config.outputDir).toBe('qa-report');
    expect(config.targetBaseUrl).toBe('https://staging.example.com');
    expect(config.jira).toEqual({
      baseUrl: 'https://acme.atlassian.net',
      email: 'qa@example.com',
      apiToken: SECRET_TOKEN,
      acField: undefined,
    });
    expect(config.anthropic).toEqual({ apiKey: undefined, model: 'claude-opus-5-5' });
    expect(config.auth).toEqual({ mode: 'none' });
    expect(config.readiness).toEqual({ url: undefined, timeoutMs: 300000 });
    expect(config.ticket).toBeUndefined();
  });

  it('parses all CLI flags', () => {
    const config = loadConfig(
      [
        'verify',
        '--ticket',
        'PROJ-7',
        '--env',
        'prod',
        '--url',
        '/checkout',
        '--dry-run',
        '--no-comment',
        '--fail-on',
        'inconclusive',
        '--output-dir',
        'out',
      ],
      baseEnv(),
    );
    expect(config.ticket).toBe('PROJ-7');
    expect(config.environment).toBe('production');
    expect(config.startUrl).toBe('/checkout');
    expect(config.dryRun).toBe(true);
    expect(config.comment).toBe(false);
    expect(config.failOn).toBe('inconclusive');
    expect(config.outputDir).toBe('out');
  });

  it('uses QA_TICKET when no --ticket flag is given', () => {
    expect(loadConfig(['verify'], baseEnv({ QA_TICKET: 'ABC-1' })).ticket).toBe('ABC-1');
  });

  it('reads git context from Bitbucket variables', () => {
    const config = loadConfig(
      ['verify'],
      baseEnv({ BITBUCKET_BRANCH: 'feature/X-1', BITBUCKET_COMMIT: 'abc1234def', QA_COMMIT_MESSAGE: 'X-1 fix' }),
    );
    expect(config.git).toEqual({ branch: 'feature/X-1', commit: 'abc1234def', commitMessage: 'X-1 fix' });
  });

  it.each([
    ['prod', 'production'],
    ['Production', 'production'],
    ['stage', 'staging'],
    ['STAGING', 'staging'],
  ])('normalizes environment %s to %s', (raw, expected) => {
    expect(loadConfig(['verify'], baseEnv({ QA_ENV: raw })).environment).toBe(expected);
  });

  it('falls back to BITBUCKET_DEPLOYMENT_ENVIRONMENT', () => {
    const env = baseEnv({ QA_ENV: undefined, BITBUCKET_DEPLOYMENT_ENVIRONMENT: 'Production' });
    expect(loadConfig(['verify'], env).environment).toBe('production');
  });

  it('lets the --env flag win over environment variables', () => {
    const env = baseEnv({ QA_ENV: 'production', BITBUCKET_DEPLOYMENT_ENVIRONMENT: 'production' });
    expect(loadConfig(['verify', '--env', 'staging'], env).environment).toBe('staging');
  });

  it('derives a read-only policy in production that always allows the login path', () => {
    const config = loadConfig(
      ['verify'],
      baseEnv({
        QA_ENV: 'production',
        QA_AUTH_MODE: 'form',
        TEST_USER: 'user',
        TEST_PASSWORD: SECRET_PASSWORD,
        QA_LOGIN_PATH: '/login',
        QA_LOGIN_USER_SELECTOR: '#user',
        QA_LOGIN_PASSWORD_SELECTOR: '#pass',
        QA_LOGIN_SUBMIT_SELECTOR: 'button[type=submit]',
        QA_LOGIN_SUCCESS_URL: '/dashboard$',
        QA_READONLY_ALLOW: '/api/search, /api/session/** ,',
      }),
    );
    expect(config.policy).toEqual({
      mode: 'read-only',
      allowedMutations: ['/login', '/api/search', '/api/session/**'],
    });
    expect(config.auth).toEqual({
      mode: 'form',
      user: 'user',
      password: SECRET_PASSWORD,
      loginPath: '/login',
      userSelector: '#user',
      passwordSelector: '#pass',
      submitSelector: 'button[type=submit]',
      successUrlPattern: '/dashboard$',
    });
  });

  it('parses readiness settings', () => {
    const config = loadConfig(
      ['verify'],
      baseEnv({ QA_READY_URL: 'https://staging.example.com/version', QA_READY_TIMEOUT_MS: '60000' }),
    );
    expect(config.readiness).toEqual({ url: 'https://staging.example.com/version', timeoutMs: 60000 });
  });

  it('reads optional Anthropic and Jira settings', () => {
    const config = loadConfig(
      ['verify'],
      baseEnv({ ANTHROPIC_API_KEY: SECRET_KEY, QA_MODEL: 'claude-other', JIRA_AC_FIELD: 'customfield_10050' }),
    );
    expect(config.anthropic).toEqual({ apiKey: SECRET_KEY, model: 'claude-other' });
    expect(config.jira.acField).toBe('customfield_10050');
  });

  it('reports every missing or invalid field at once', () => {
    const error = captureError(() =>
      loadConfig(['verify', '--fail-on', 'sometimes'], {
        QA_ENV: 'qa',
        QA_AUTH_MODE: 'form',
        QA_READY_TIMEOUT_MS: 'soon',
        QA_LOGIN_SUCCESS_URL: '(',
      }),
    );
    const text = error.issues.join('\n');
    for (const field of [
      'TARGET_BASE_URL',
      'environment',
      'JIRA_BASE_URL',
      'JIRA_EMAIL',
      'JIRA_API_TOKEN',
      '--fail-on',
      'QA_READY_TIMEOUT_MS',
      'TEST_USER',
      'TEST_PASSWORD',
      'QA_LOGIN_PATH',
      'QA_LOGIN_USER_SELECTOR',
      'QA_LOGIN_PASSWORD_SELECTOR',
      'QA_LOGIN_SUBMIT_SELECTOR',
      'QA_LOGIN_SUCCESS_URL',
    ]) {
      expect(text).toContain(field);
    }
    expect(error.message).toContain('TARGET_BASE_URL');
  });

  it('requires the verify command', () => {
    expect(captureError(() => loadConfig([], baseEnv())).issues.join()).toContain('command');
    expect(captureError(() => loadConfig(['run'], baseEnv())).issues.join()).toContain('command');
  });

  it('rejects unknown flags', () => {
    expect(() => loadConfig(['verify', '--bogus'], baseEnv())).toThrow(ConfigError);
  });

  it('rejects an invalid TARGET_BASE_URL without echoing it', () => {
    const error = captureError(() =>
      loadConfig(['verify'], baseEnv({ TARGET_BASE_URL: 'ftp://user:hunter2@host' })),
    );
    expect(error.message).toContain('TARGET_BASE_URL');
    expect(error.message).not.toContain('hunter2');
  });

  it('never leaks secrets in error messages', () => {
    const error = captureError(() =>
      loadConfig(['verify'], {
        JIRA_API_TOKEN: SECRET_TOKEN,
        ANTHROPIC_API_KEY: SECRET_KEY,
        QA_AUTH_MODE: 'form',
        TEST_PASSWORD: SECRET_PASSWORD,
      }),
    );
    for (const secret of [SECRET_TOKEN, SECRET_KEY, SECRET_PASSWORD]) {
      expect(error.message).not.toContain(secret);
    }
  });
});

describe('config redaction', () => {
  const env = baseEnv({
    ANTHROPIC_API_KEY: SECRET_KEY,
    QA_AUTH_MODE: 'form',
    TEST_USER: 'user',
    TEST_PASSWORD: SECRET_PASSWORD,
    QA_LOGIN_PATH: '/login',
    QA_LOGIN_USER_SELECTOR: '#user',
    QA_LOGIN_PASSWORD_SELECTOR: '#pass',
    QA_LOGIN_SUBMIT_SELECTOR: '#submit',
  });

  it('redactConfig masks every secret and keeps the rest', () => {
    const redacted = redactConfig(loadConfig(['verify'], env));
    const text = JSON.stringify(redacted);
    for (const secret of [SECRET_TOKEN, SECRET_KEY, SECRET_PASSWORD]) {
      expect(text).not.toContain(secret);
    }
    expect(redacted.jira.apiToken).toBe('***');
    expect(redacted.jira.email).toBe('qa@example.com');
  });

  it('keeps secrets out of JSON, toString and inspect output', () => {
    const config = loadConfig(['verify'], env);
    for (const output of [JSON.stringify(config), String(config), inspect(config, { depth: 10 })]) {
      for (const secret of [SECRET_TOKEN, SECRET_KEY, SECRET_PASSWORD]) {
        expect(output).not.toContain(secret);
      }
    }
    expect(config.jira.apiToken).toBe(SECRET_TOKEN);
  });
});
