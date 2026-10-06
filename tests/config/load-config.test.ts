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
    expect(config.policy).toEqual({ mode: 'full', allowedMutations: [], allowedHosts: [] });
    expect(config.startUrl).toBe('/');
    expect(config.dryRun).toBe(false);
    expect(config.comment).toBe(true);
    expect(config.failOn).toBe('not-resolved');
    expect(config.outputDir).toBe('qa-report');
    expect(config.targetBaseUrl).toBe('https://staging.example.com');
    // Secrets are non-enumerable, so they are asserted directly rather than through toEqual.
    expect(config.jira).toEqual({
      baseUrl: 'https://acme.atlassian.net',
      email: 'qa@example.com',
      acField: undefined,
    });
    expect(config.jira.apiToken).toBe(SECRET_TOKEN);
    expect(config.anthropic).toEqual({ model: 'claude-opus-5-5' });
    expect(config.anthropic.apiKey).toBeUndefined();
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

  it('rejects an explicit ticket that is not a valid key, from the flag or QA_TICKET', () => {
    expect(captureError(() => loadConfig(['verify', '--ticket', 'not a key'], baseEnv())).issues.join()).toMatch(/ticket/i);
    expect(() => loadConfig(['verify'], baseEnv({ QA_TICKET: 'PROJ_1' }))).toThrow(ConfigError);
  });

  it('parses QA_JIRA_PROJECTS and enforces it on the explicit ticket', () => {
    expect(loadConfig(['verify'], baseEnv()).jiraProjects).toEqual([]);
    expect(loadConfig(['verify'], baseEnv({ QA_JIRA_PROJECTS: 'proj, shop ' })).jiraProjects).toEqual(['PROJ', 'SHOP']);
    expect(loadConfig(['verify', '--ticket', 'shop-1'], baseEnv({ QA_JIRA_PROJECTS: 'PROJ,SHOP' })).ticket).toBe('SHOP-1');
    expect(captureError(() => loadConfig(['verify', '--ticket', 'OTHER-1'], baseEnv({ QA_JIRA_PROJECTS: 'PROJ' }))).issues.join()).toContain('OTHER-1');
    expect(captureError(() => loadConfig(['verify'], baseEnv({ QA_JIRA_PROJECTS: 'PROJ,bad-key' }))).issues.join()).toContain('QA_JIRA_PROJECTS');
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

  it('lets the --env flag win over QA_ENV', () => {
    const env = baseEnv({ QA_ENV: 'production' });
    expect(loadConfig(['verify', '--env', 'staging'], env).environment).toBe('staging');
  });

  it('accepts QA_ENV and --env when they agree with BITBUCKET_DEPLOYMENT_ENVIRONMENT', () => {
    expect(loadConfig(['verify'], baseEnv({ QA_ENV: 'prod', BITBUCKET_DEPLOYMENT_ENVIRONMENT: 'production' })).environment).toBe('production');
    expect(loadConfig(['verify', '--env', 'stage'], baseEnv({ QA_ENV: undefined, BITBUCKET_DEPLOYMENT_ENVIRONMENT: 'staging' })).environment).toBe('staging');
    // An empty QA_ENV (as in env.example) does not count as set.
    expect(loadConfig(['verify'], baseEnv({ QA_ENV: '', BITBUCKET_DEPLOYMENT_ENVIRONMENT: 'production' })).environment).toBe('production');
  });

  it('fails closed when QA_ENV conflicts with BITBUCKET_DEPLOYMENT_ENVIRONMENT', () => {
    const error = captureError(() => loadConfig(['verify'], baseEnv({ QA_ENV: 'staging', BITBUCKET_DEPLOYMENT_ENVIRONMENT: 'production' })));
    expect(error.issues).toEqual([
      'environment conflict: QA_ENV is "staging" but BITBUCKET_DEPLOYMENT_ENVIRONMENT is "production"; remove QA_ENV or make it match',
    ]);
  });

  it('fails closed when --env conflicts with BITBUCKET_DEPLOYMENT_ENVIRONMENT', () => {
    const error = captureError(() => loadConfig(['verify', '--env', 'staging'], baseEnv({ QA_ENV: undefined, BITBUCKET_DEPLOYMENT_ENVIRONMENT: 'Production' })));
    expect(error.issues).toEqual([
      'environment conflict: --env is "staging" but BITBUCKET_DEPLOYMENT_ENVIRONMENT is "Production"; remove --env or make it match',
    ]);
  });

  it('fails closed when --env conflicts with BITBUCKET_DEPLOYMENT_ENVIRONMENT even if QA_ENV agrees with it', () => {
    const error = captureError(() => loadConfig(['verify', '--env', 'staging'], baseEnv({ QA_ENV: 'production', BITBUCKET_DEPLOYMENT_ENVIRONMENT: 'production' })));
    expect(error.issues.join('\n')).toMatch(/environment conflict: --env is "staging"/);
  });

  it('only lets an override force production when BITBUCKET_DEPLOYMENT_ENVIRONMENT is not a known name', () => {
    expect(loadConfig(['verify'], baseEnv({ QA_ENV: 'production', BITBUCKET_DEPLOYMENT_ENVIRONMENT: 'prod-eu' })).environment).toBe('production');
    const error = captureError(() => loadConfig(['verify'], baseEnv({ QA_ENV: 'staging', BITBUCKET_DEPLOYMENT_ENVIRONMENT: 'prod-eu' })));
    expect(error.issues).toEqual([
      'environment conflict: QA_ENV is "staging" but BITBUCKET_DEPLOYMENT_ENVIRONMENT is "prod-eu", which is not a known environment; only production (read-only) may be forced',
    ]);
  });

  it('derives a read-only policy in production from QA_READONLY_ALLOW only, and a login-only mutation list', () => {
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
        QA_LOGIN_ALLOW: '/api/auth/token, /login',
      }),
    );
    // The inspector and the plan runner get this policy: the login endpoints are not in it.
    expect(config.policy).toEqual({
      mode: 'read-only',
      allowedMutations: ['/api/search', '/api/session/**'],
      allowedHosts: [],
    });
    expect(config.auth).toEqual({
      mode: 'form',
      user: 'user',
      loginPath: '/login',
      loginMutationPaths: ['/login', '/api/auth/token'],
      userSelector: '#user',
      passwordSelector: '#pass',
      submitSelector: 'button[type=submit]',
      successUrlPattern: '/dashboard$',
    });
    expect(config.auth.mode === 'form' ? config.auth.password : undefined).toBe(SECRET_PASSWORD);
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
    expect(config.anthropic).toEqual({ model: 'claude-other' });
    expect(config.anthropic.apiKey).toBe(SECRET_KEY);
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

  it('keeps secrets out of the nested jira, auth and anthropic objects', () => {
    const config = loadConfig(['verify'], env);
    const nested = [config.jira, config.auth, config.anthropic];
    const outputs = nested.flatMap((part) => [
      JSON.stringify(part),
      inspect(part, { depth: 10 }),
      inspect(part, { depth: 10, showHidden: true }),
      JSON.stringify({ ...part }),
      inspect({ ...part }),
      JSON.stringify(structuredClone(part)),
      inspect(structuredClone(part)),
    ]);
    for (const output of outputs) {
      for (const secret of [SECRET_TOKEN, SECRET_KEY, SECRET_PASSWORD]) {
        expect(output).not.toContain(secret);
      }
    }
    expect(config.jira.apiToken).toBe(SECRET_TOKEN);
    expect(config.anthropic.apiKey).toBe(SECRET_KEY);
    expect(config.auth.mode === 'form' ? config.auth.password : undefined).toBe(SECRET_PASSWORD);
    expect(JSON.stringify(config.jira)).toContain('qa@example.com');
  });
});

describe('loadConfig login mutation paths', () => {
  const formEnv = (overrides: NodeJS.ProcessEnv = {}) =>
    baseEnv({
      QA_ENV: 'production',
      QA_AUTH_MODE: 'form',
      TEST_USER: 'user',
      TEST_PASSWORD: SECRET_PASSWORD,
      QA_LOGIN_PATH: '/account/login?next=/home#form',
      QA_LOGIN_USER_SELECTOR: '#user',
      QA_LOGIN_PASSWORD_SELECTOR: '#pass',
      QA_LOGIN_SUBMIT_SELECTOR: 'button',
      ...overrides,
    });

  it('allows the login page path (without query or fragment) only during the login', () => {
    const config = loadConfig(['verify'], formEnv());
    expect(config.policy.allowedMutations).toEqual([]);
    expect(config.auth.mode === 'form' ? config.auth.loginMutationPaths : undefined).toEqual(['/account/login']);
  });

  it('rejects QA_LOGIN_ALLOW without form login', () => {
    const error = captureError(() => loadConfig(['verify'], baseEnv({ QA_LOGIN_ALLOW: '/api/auth' })));
    expect(error.issues).toEqual(['QA_LOGIN_ALLOW requires QA_AUTH_MODE=form']);
  });

  it('keeps the login list in the redacted config', () => {
    const config = loadConfig(['verify'], formEnv({ QA_LOGIN_ALLOW: '/api/auth' }));
    const redacted = redactConfig(config);
    expect(redacted.auth.mode === 'form' ? redacted.auth.loginMutationPaths : undefined).toEqual(['/account/login', '/api/auth']);
    expect(redacted.policy.allowedMutations).toEqual([]);
  });
});
