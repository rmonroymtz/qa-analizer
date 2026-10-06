# qa-analyzer

Verifies a deployed Jira ticket after each deploy. It reads the ticket's acceptance criteria, has Claude write Playwright tests grounded in the live page structure, runs them against the deployed site, and reports **RESOLVED**, **NOT_RESOLVED** or **INCONCLUSIVE**. When the result is not RESOLVED, it comments on the ticket with the evidence.

It runs as a step in Bitbucket Pipelines, right after the deploy step.

## Quick start

```bash
npm ci
npm run build
npx playwright install chromium   # not needed in the Docker image

export TARGET_BASE_URL=https://staging.example.com
export JIRA_BASE_URL=https://acme.atlassian.net JIRA_EMAIL=qa@example.com JIRA_API_TOKEN=...
export ANTHROPIC_API_KEY=...

node dist/cli/main.js verify --env staging --ticket SHOP-42 --dry-run
```

Expected result: a summary on stdout, and `qa-report/report.json` plus `qa-report/summary.md`. `--dry-run` skips the Jira comment.

## Verdicts

| Verdict | Meaning | Jira comment |
|---------|---------|--------------|
| RESOLVED | Every acceptance criterion passed. | No |
| NOT_RESOLVED | At least one business assertion (`expect`) failed. That is positive evidence that the ticket is not done. | Yes, with up to 3 failure screenshots |
| INCONCLUSIVE | The tool could not decide. | Yes, unless the key was not found or Jira itself failed |

**Why INCONCLUSIVE exists.** AI-generated tests can fail for reasons unrelated to the ticket: a locator that does not match the page, a timeout, a blocked request in production, a generation refusal. Reporting those as NOT_RESOLVED would create false alarms and erode trust. So only a failed `expect` assertion counts as a failure. Everything that stops a test from reaching or identifying its target is INCONCLUSIVE.

| Situation | Criterion result |
|-----------|------------------|
| Test passed (also on retry) | PASSED |
| `expect(...)` assertion failed | FAILED, with expected/actual and a screenshot |
| Assertion target not found, strict mode violation | INCONCLUSIVE |
| Action or navigation error, timeout, blocked request | INCONCLUSIVE |
| Spec failed to compile, test skipped | INCONCLUSIVE |
| Criterion not verifiable from the UI (Claude says so) | INCONCLUSIVE, with the reason |

A failed criterion wins over inconclusive ones: one FAILED makes the ticket NOT_RESOLVED.

## How it works

1. Find the ticket key: `--ticket` / `QA_TICKET`, then the branch name (`BITBUCKET_BRANCH`), then the commit message (`QA_COMMIT_MESSAGE` or the HEAD commit, including Bitbucket "Merged in feature/KEY-1-..." messages). In a branch name the key must start a path segment (`feature/PROJ-123-x`); in free-form commit text it must be an upper-case whole word. Look-alike prefixes such as `UTF-8`, `SHA-256`, `ISO-8601`, `HTTP-2` or `release-2` are ignored; set `QA_JIRA_PROJECTS` to accept only your projects.
2. Wait until the deploy is live (`QA_READY_URL` reporting `BITBUCKET_COMMIT`, or `TARGET_BASE_URL` answering 2xx).
3. Read the ticket and its acceptance criteria from Jira.
4. Log in, when configured (hand-written form login, never AI-generated).
5. Capture the accessibility snapshot of the start page plus up to two more same-host pages mentioned in the ticket.
6. Ask Claude for one Playwright spec, one test per criterion, using only locators found in the snapshots.
7. Run the spec, classify each criterion, write the report, and comment on Jira.

## CLI

```text
qa-analyzer verify [options]
```

| Flag | Default | Purpose |
|------|---------|---------|
| `--ticket <KEY>` | `QA_TICKET`, then branch, then commit | Ticket to verify |
| `--env <name>` | `QA_ENV`, then `BITBUCKET_DEPLOYMENT_ENVIRONMENT` | `staging` (or `stage`), `production` (or `prod`) |
| `--url <path>` | `/` | Start page to inspect |
| `--output-dir <dir>` | `qa-report` | Where reports and evidence go |
| `--fail-on <policy>` | `not-resolved` | Exit code policy, see below |
| `--dry-run` | off | Do everything except commenting on Jira |
| `--no-comment` | off | Never comment on Jira |
| `-h`, `--help` | | Show usage |

## Exit codes

| `--fail-on` | RESOLVED | NOT_RESOLVED | INCONCLUSIVE | INCONCLUSIVE from a setup problem |
|-------------|----------|--------------|--------------|-----------------------------------|
| `not-resolved` (default) | 0 | 1 | 0 | 2 |
| `inconclusive` | 0 | 1 | 2 | 2 |
| `never` | 0 | 0 | 0 | 0 |

A configuration error (missing or invalid variables) always exits 2 and prints every issue. A "setup problem" is any of these, because a broken setup should not look green:

- No ticket key could be resolved (no Jira comment is posted).
- An invalid explicit ticket key.
- A failed login.
- A 400, 401, 403, 404 or 429 response from Jira (reading the ticket) or from Claude (generating the tests): a bad request or model id, bad credentials, a ticket that does not exist, or an exhausted quota or rate limit.

Server errors (5xx, overloaded) are ordinary INCONCLUSIVE results. `--fail-on never` always exits 0.

## Environment variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `TARGET_BASE_URL` | Yes | Base URL of the deployed environment |
| `QA_ENV` | Yes, unless `--env` or `BITBUCKET_DEPLOYMENT_ENVIRONMENT` | `staging` or `production` |
| `JIRA_BASE_URL` | Yes | e.g. `https://acme.atlassian.net` |
| `JIRA_EMAIL` | Yes | Jira account for the API token |
| `JIRA_API_TOKEN` | Yes (secured) | Jira API token |
| `JIRA_AC_FIELD` | No | Custom field id with the acceptance criteria; otherwise they are read from the description |
| `ANTHROPIC_API_KEY` | Yes in CI (secured) | Claude API key; locally the SDK can also use other credential sources |
| `QA_MODEL` | No | Model override, default `claude-opus-5-5` |
| `QA_TICKET` | No | Explicit ticket key. An invalid value is a configuration error (exit 2), never a silent fallback |
| `QA_JIRA_PROJECTS` | No | Comma-separated Jira project keys (e.g. `PROJ,SHOP`). When set, only keys of these projects are accepted, from any source |
| `QA_COMMIT_MESSAGE` | No | Commit message to search for the key (default: HEAD commit) |
| `QA_READY_URL` | No | Health/version URL that reports the deployed commit |
| `QA_READY_TIMEOUT_MS` | No | Readiness timeout, default `300000` |
| `QA_AUTH_MODE` | No | `none` (default) or `form` |
| `TEST_USER`, `TEST_PASSWORD` | With `form` (secured) | Test account |
| `QA_LOGIN_PATH` | With `form` | Login page path, e.g. `/login` |
| `QA_LOGIN_USER_SELECTOR`, `QA_LOGIN_PASSWORD_SELECTOR`, `QA_LOGIN_SUBMIT_SELECTOR` | With `form` | Selectors of the login form |
| `QA_LOGIN_SUCCESS_URL` | No | Regex the URL must match after login. Without it, the login succeeds only if the page leaves the login path or the password field disappears |
| `QA_READONLY_ALLOW` | No | Path globs (or `^regex`) on the target host that may mutate in production |
| `QA_READONLY_ALLOW_HOSTS` | No | Hostnames to which any mutation is allowed in production (e.g. analytics) |
| `BITBUCKET_BRANCH`, `BITBUCKET_COMMIT`, `BITBUCKET_DEPLOYMENT_ENVIRONMENT` | Set by Bitbucket | Key resolution, readiness and environment |

Secrets are only read from the environment, are never printed, and are scrubbed from reports. The test process does not receive credential variables.

## Production safety (read-only mode)

`production` always runs read-only:

- Only `GET`, `HEAD` and `OPTIONS` are treated as safe. Every browser request with any other method (`POST`, `PUT`, `PATCH`, `DELETE`, WebDAV or custom methods) is aborted, to **any** host.
- Exceptions: the login path, paths in `QA_READONLY_ALLOW` (on the target host only), and hosts in `QA_READONLY_ALLOW_HOSTS`.
- Service workers are blocked, and WebSocket connections are closed for every host except those in `QA_READONLY_ALLOW_HOSTS`.
- The run fails closed: if the guard cannot be installed (for example, `TARGET_BASE_URL` does not parse), nothing runs.
- Claude is told not to submit forms or click mutating buttons, and to mark such criteria as uncoverable.
- The Playwright `request` fixture is disabled, and a spec that uses a Node-side HTTP client is refused before it runs.

A blocked request shows up as `net::ERR_BLOCKED_BY_CLIENT` and makes the criterion INCONCLUSIVE, never NOT_RESOLVED.

## Login setup

Set `QA_AUTH_MODE=form` and the `TEST_*` and `QA_LOGIN_*` variables. qa-analyzer logs in once with a hand-written flow, saves the session in a temporary directory outside `qa-report/`, reuses it for inspection and tests, and deletes it at the end. Use a dedicated test account with the least privileges needed. If the login form posts to another host (SSO), add that host to `QA_READONLY_ALLOW_HOSTS` for production.

## Bitbucket integration

See [`bitbucket-pipelines.yml`](bitbucket-pipelines.yml), an example for the **site** repository:

1. Build the [`Dockerfile`](Dockerfile) and push it to your registry. The base image `mcr.microsoft.com/playwright:v1.63.0-noble` matches the installed `@playwright/test` version and ships the browsers.
2. Each branch runs a `stage` with `deployment: staging` (on `develop`) or `deployment: production` (on `main`), holding a Deploy step and a QA verify step. A stage is used because Bitbucket allows only one step per environment to declare `deployment`; the stage shares the deployment and its variables with both steps.
3. Put `TARGET_BASE_URL` (and `TEST_USER`/`TEST_PASSWORD`, secured) in the deployment variables, and the Jira and Claude settings in the repository variables (`JIRA_API_TOKEN` and `ANTHROPIC_API_KEY` secured).
4. The QA step runs `node /app/dist/cli/main.js verify --output-dir qa-report` and keeps `qa-report/**` as artifacts.

## Artifacts

| Path | Content |
|------|---------|
| `qa-report/report.json` | Verdict, ticket key and its source, environment, commit, per-criterion results, timings. No secrets. |
| `qa-report/summary.md` | Human-readable summary |
| `qa-report/generated/` | The generated spec, fixtures and Playwright config |
| `qa-report/results.json` | Raw Playwright JSON report |
| `qa-report/test-results/` | Traces and screenshots of failed tests |

## Known limitations

- **Single snapshot.** Claude sees each page once, before any interaction. Elements that appear only after clicks or navigation are not in the snapshot, so tests for them are more likely to be INCONCLUSIVE.
- **AI-generated code runs in CI.** The spec passes a static check (only the fixtures import; no `require`, `process.env`, child processes, dynamic imports, `test.only`, `test.fail` or `test.fixme`; every criterion id at most once) and runs without credential variables, but it is still model-written code. Run it in an isolated container, in its own step, with no extra secrets.
- **One ticket per run.** Only the main ticket of the deploy is verified.
- **Up to three pages** are inspected: the start page and two same-host pages mentioned in the ticket.
- **Read-only covers the browser.** Mutations made by the site's own servers as a side effect of a GET are outside the guard's reach.
- **Redirects are not re-checked.** When an allowed request (for example, the login POST) is redirected, the browser follows the redirect without passing it through the guard again.

## Development

```bash
npm run typecheck
npm test
npm run build
```
