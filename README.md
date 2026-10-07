# qa-analyzer

Verifies a deployed Jira ticket after each deploy. It reads the ticket's acceptance criteria, has Claude write a declarative test plan grounded in the live page structure, executes the plan in a browser with Playwright against the deployed site, and reports **RESOLVED**, **NOT_RESOLVED** or **INCONCLUSIVE**. When the result is not RESOLVED, it comments on the ticket with the evidence.

It runs as a step in Bitbucket Pipelines, right after the deploy step.

## Quick start

```bash
npm ci
npm run build
npx playwright install chromium   # not needed in the Docker image

export TARGET_BASE_URL=https://staging.chupaprecios.com.mx
export JIRA_BASE_URL=https://acme.atlassian.net JIRA_EMAIL=qa@example.com JIRA_API_TOKEN=...
export ANTHROPIC_API_KEY=...

node dist/cli/main.js verify --env staging --ticket SHOP-42 --dry-run
```

No `--url` is needed: the pages to inspect come from the ticket (see [Pages to inspect](#pages-to-inspect)).

Alternatively, keep the variables in a file: `cp env.example .env`, fill it in, and run `node --env-file=.env dist/cli/main.js verify ...`. The `.env` file is git-ignored.

Expected result: a summary on stdout, and `qa-report/report.json` plus `qa-report/summary.md`. `--dry-run` skips the Jira comment.

## Verdicts

| Verdict | Meaning | Jira comment |
|---------|---------|--------------|
| RESOLVED | Every acceptance criterion passed. | No |
| NOT_RESOLVED | At least one business assertion step failed on an element that was found (or on the URL or title). That is positive evidence that the ticket is not done. | Yes, with up to 3 failure screenshots |
| INCONCLUSIVE | The tool could not decide. | Yes, unless the key was not found or Jira itself failed |

**Why INCONCLUSIVE exists.** AI-planned tests can fail for reasons unrelated to the ticket: a locator that does not match the page, a timeout, a blocked request in production, a generation refusal. Reporting those as NOT_RESOLVED would create false alarms and erode trust. So only a failed assertion step (`expect*`) whose target was found counts as a failure. Everything that stops a test from reaching or identifying its target is INCONCLUSIVE.

| Situation | Criterion result |
|-----------|------------------|
| Test passed | PASSED |
| Test passed only on its retry (read-only mode only) | PASSED, with the note "passed on retry" |
| Assertion step failed on a found element, or on the URL or title | FAILED, with the step, expected/actual and a screenshot |
| Assertion target matches no element | INCONCLUSIVE, "expected element not found: the feature may be missing or the UI changed — needs human review" |
| Assertion target matches several elements without `nth` | INCONCLUSIVE |
| Action or navigation error, step timeout, test over its 90 s budget | INCONCLUSIVE, with the step number and action |
| Assertion failed after the read-only guard blocked any request during the test (to the target or to any host not in `QA_READONLY_ALLOW_HOSTS`) | INCONCLUSIVE (the block may be the cause) |
| A step took the page off the target origin (link, redirect, script) | INCONCLUSIVE, "navigation left the target site (<origin>)"; the test stops and no screenshot is taken of the foreign page |
| Mutating test in read-only mode | INCONCLUSIVE, "mutating test skipped in read-only mode" (never executed) |
| Test without a positive assertion (only `expectHidden`, `expectCount` of 0 or `expectUrl`) | INCONCLUSIVE, "no positive assertion: ..." (never executed) |
| Criterion not verifiable from the UI (Claude says so) | INCONCLUSIVE, with the reason |

Blocked requests are listed in the criterion reason. The classification of a missing assertion target is a pending product decision; it lives in one place (`src/adapters/playwright/step-classification.ts`).

A failed criterion wins over inconclusive ones: one FAILED makes the ticket NOT_RESOLVED.

## How it works

1. Find the ticket key: `--ticket` / `QA_TICKET`, then the branch name (`BITBUCKET_BRANCH`), then the commit message (`QA_COMMIT_MESSAGE` or the HEAD commit, including Bitbucket "Merged in feature/KEY-1-..." messages). In a branch name the key must start a path segment (`feature/PROJ-123-x`); in free-form commit text it must be an upper-case whole word. Look-alike prefixes such as `UTF-8`, `SHA-256`, `ISO-8601`, `HTTP-2` or `release-2` are ignored; set `QA_JIRA_PROJECTS` to accept only your projects.
2. Wait until the deploy is live (`QA_READY_URL` reporting `BITBUCKET_COMMIT`, or `TARGET_BASE_URL` answering 2xx).
3. Read the ticket and its acceptance criteria from Jira.
4. Log in, when configured (hand-written form login, never AI-generated).
5. Capture the accessibility snapshot of up to three pages: `--url` when given, then the pages named in the ticket, else `/` (see below).
6. Ask Claude for a **test plan**: JSON data, at most one test per criterion, built from a closed step vocabulary and semantic locators found in the snapshots. The plan is validated (shape, limits, relative paths, ARIA roles, criterion coverage) before anything runs.
7. Interpret the plan in this process with the Playwright library, classify each criterion, write the report, and comment on Jira.

### Pages to inspect

Up to three pages are inspected, deduplicated, in this order:

1. `--url`, when given.
2. The pages named in the ticket (summary, then description, then acceptance criteria), in order of appearance:
   - absolute URLs on the **same site** as `TARGET_BASE_URL`: the same registrable domain (eTLD+1, from the Public Suffix List, where `.com.mx` is a two-level suffix). Their path and query are applied to the target environment; the hash is dropped.
   - root-relative paths written in the text, such as `/ofertas/laptops`.
3. `/`, only when nothing else was found.

Other domains (Figma, Google Docs, look-alikes such as `chupaprecios.com` or `evil-chupaprecios.com.mx`) are ignored. For IP addresses and `localhost`, which have no registrable domain, the host and port must match exactly.

Tickets usually link production, while the run targets the environment of the deployment. With `TARGET_BASE_URL=https://staging.chupaprecios.com.mx` and a ticket that says "see https://chupaprecios.com.mx/ofertas/laptops?orden=precio and https://www.figma.com/file/abc", the inspected page is `https://staging.chupaprecios.com.mx/ofertas/laptops?orden=precio`; the Figma link is ignored. The same ticket in a production run (`TARGET_BASE_URL=https://chupaprecios.com.mx`) inspects `https://chupaprecios.com.mx/ofertas/laptops?orden=precio`. The target domain always comes from `TARGET_BASE_URL` (set per Bitbucket deployment environment), never from the branch.

Each page keeps its source, `cli`, `ticket` or `default`, in `report.json` (`pagesInspected: [{ "path": "/ofertas", "source": "ticket" }]`), `summary.md` and the console summary (`Pages: /ofertas (ticket), / (default)`). A page that cannot be opened is logged and skipped; the run is INCONCLUSIVE only when none can be opened.

### The test plan

Claude never writes code, and qa-analyzer never executes model-written code. A plan is a list of tests; each test is a list of at most 30 steps:

| Kind | Actions |
|------|---------|
| Navigation | `goto { path }`: a path relative to `TARGET_BASE_URL` (starts with one `/`; no scheme, host, backslash or `..`). The base URL's path prefix is kept: with `TARGET_BASE_URL=https://example.com/app/`, `/cart` opens `https://example.com/app/cart` |
| Interaction | `click`, `check`, `uncheck`, `hover`, `fill { value }`, `selectOption { value }`, `press { key }`, `waitFor { state }` |
| Assertion | `expectVisible`, `expectHidden`, `expectText { text, match }`, `expectValue { value }`, `expectCount { count }`, `expectUrl { pathPattern }` (plain substring; `/` or wildcards alone are rejected), `expectTitle { text, match }` |

Targets are semantic only: `role` (+ accessible `name`), `label`, `text`, `placeholder` or `testId`, with an optional `nth` and one optional parent (`within`). There are no CSS, XPath or raw selectors. Every test needs at least one **positive** assertion: `expectVisible`, `expectText`, `expectValue`, `expectCount` with a count of at least 1, or `expectTitle`. `expectHidden`, `expectCount` of 0 and `expectUrl` also pass when a guessed target matches nothing, so a test made only of them never runs: the validator moves it to the uncoverable list and its criterion is INCONCLUSIVE, while the other tests of the plan still run. Claude marks tests that change data as `mutating`.

Each test runs in a fresh browser context (service workers blocked, downloads refused). In production the read-only guard is installed on that context by qa-analyzer, before any page exists, and nothing in the plan can remove it. It also covers popups and new tabs, which open in the same context. After every step the page must still be on the origin of `TARGET_BASE_URL`; otherwise the test stops as INCONCLUSIVE. Step timeouts: 10 s for actions and assertions, 30 s for navigation, 90 s per test.

## CLI

```text
qa-analyzer verify [options]
```

| Flag | Default | Purpose |
|------|---------|---------|
| `--ticket <KEY>` | `QA_TICKET`, then branch, then commit | Ticket to verify |
| `--env <name>` | `QA_ENV`, then `BITBUCKET_DEPLOYMENT_ENVIRONMENT` | `staging` (or `stage`), `production` (or `prod`). Must agree with `BITBUCKET_DEPLOYMENT_ENVIRONMENT` when Bitbucket sets it (see below) |
| `--url <path>` | pages named in the ticket, else `/` | Page to inspect first, before the ticket pages (resolved from the host root; only plan `goto` paths keep the `TARGET_BASE_URL` path prefix) |
| `--output-dir <dir>` | `qa-report` | Where reports and evidence go |
| `--fail-on <policy>` | `not-resolved` | Exit code policy, see below |
| `--dry-run` | off | Do everything except commenting on Jira |
| `--no-comment` | off | Never comment on Jira |
| `-h`, `--help` | | Show usage |

**Environment conflicts fail closed.** In a Bitbucket deployment step, Bitbucket sets `BITBUCKET_DEPLOYMENT_ENVIRONMENT` automatically. If `--env` or `QA_ENV` is also set and names a different environment, the run stops with a configuration error (exit 2) that names both values, instead of guessing. (`--env` wins over `QA_ENV`, but must still agree with Bitbucket.) When Bitbucket's environment name is not one of `staging`/`stage`/`production`/`prod` (for example `prod-eu`), an override may only force `production`, which is read-only. Leave `QA_ENV` empty in Bitbucket.

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

`env.example` lists every variable with comments and no secret values.

| Variable | Required | Purpose |
|----------|----------|---------|
| `TARGET_BASE_URL` | Yes | Base URL of the deployed environment. It may include a path prefix (`https://example.com/app`); plan `goto` paths are joined to it |
| `QA_ENV` | Yes, unless `--env` or `BITBUCKET_DEPLOYMENT_ENVIRONMENT` | `staging` or `production`. Leave it empty in Bitbucket: a value that conflicts with `BITBUCKET_DEPLOYMENT_ENVIRONMENT` fails the run |
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
| `QA_READONLY_ALLOW` | No | Path globs (or `^regex`) on the target host that may mutate in production, during inspection and tests |
| `QA_LOGIN_ALLOW` | No (only with `form`) | Extra path globs (or `^regex`) the login form may post to in production (for example `/api/session`), allowed during the login only |
| `QA_READONLY_ALLOW_HOSTS` | No | Hostnames to which any mutation is allowed in production (e.g. analytics) |
| `BITBUCKET_BRANCH`, `BITBUCKET_COMMIT`, `BITBUCKET_DEPLOYMENT_ENVIRONMENT` | Set by Bitbucket | Key resolution, readiness and environment |

Secrets are only read from the environment, are never printed, and are scrubbed from reports and plan artifacts. Tests are plan data interpreted by qa-analyzer, so no generated code can read the environment.

## Production safety (read-only mode)

`production` always runs read-only:

- Only `GET`, `HEAD` and `OPTIONS` are treated as safe. Every browser request with any other method (`POST`, `PUT`, `PATCH`, `DELETE`, WebDAV or custom methods) is aborted, to **any** host.
- Exceptions: paths in `QA_READONLY_ALLOW` (on the target host only) and hosts in `QA_READONLY_ALLOW_HOSTS`. During the hand-written login only, the login page path and the paths in `QA_LOGIN_ALLOW` are allowed too; the page inspection and the plan tests never get them. Paths are matched against the full URL pathname, including any `TARGET_BASE_URL` path prefix.
- Service workers are blocked, and WebSocket connections are closed for every host except those in `QA_READONLY_ALLOW_HOSTS`.
- The run fails closed: if the guard cannot be installed (for example, `TARGET_BASE_URL` does not parse), nothing runs.
- The guard is installed by qa-analyzer on every test's browser context before the page is created. The plan vocabulary has no way to remove routes, change context options or send HTTP requests outside the page.
- Claude is told to list criteria that need a mutation as uncoverable. A test it marks `mutating` is moved to uncoverable by the validator and is never executed.
- Non-mutating interactions (opening a menu, typing in a search box) are allowed; the network guard is the authoritative enforcement.

A blocked request is listed in the criterion reason. An assertion that fails after the guard blocked any request during that test, to the target host or to any other host not in `QA_READONLY_ALLOW_HOSTS` (for example the site's API on a sibling domain), is INCONCLUSIVE, never NOT_RESOLVED.

## Login setup

Set `QA_AUTH_MODE=form` and the `TEST_*` and `QA_LOGIN_*` variables. qa-analyzer logs in once with a hand-written flow, saves the session in a temporary directory outside `qa-report/`, reuses it for inspection and tests, and deletes it at the end. In production, the login page path (and `QA_LOGIN_ALLOW`) may receive mutating requests during the login only. Use a dedicated test account with the least privileges needed. If the login form posts to another host (SSO), add that host to `QA_READONLY_ALLOW_HOSTS` for production.

## Bitbucket integration

See [`bitbucket-pipelines.yml`](bitbucket-pipelines.yml), an example for the **site** repository:

1. Build the [`Dockerfile`](Dockerfile) and push it to your registry. The base image `mcr.microsoft.com/playwright:v1.63.0-noble` matches the installed `@playwright/test` version and ships the browsers.
2. Each branch runs a `stage` with `deployment: staging` (on `develop`) or `deployment: production` (on `main`), holding a Deploy step and a QA verify step. A stage is used because Bitbucket allows only one step per environment to declare `deployment`; the stage shares the deployment and its variables with both steps.
3. Put `TARGET_BASE_URL` (and `TEST_USER`/`TEST_PASSWORD`, secured) in the deployment variables, and the Jira and Claude settings in the repository variables (`JIRA_API_TOKEN` and `ANTHROPIC_API_KEY` secured).
4. The QA step runs `node /app/dist/cli/main.js verify --output-dir qa-report` and keeps `qa-report/**` as artifacts.

## Artifacts

| Path | Content |
|------|---------|
| `qa-report/report.json` | Verdict, ticket key and its source, environment, commit, pages inspected and their source, per-criterion results, timings. No secrets. |
| `qa-report/summary.md` | Human-readable summary |
| `qa-report/plan.json` | The validated test plan that was executed |
| `qa-report/generated/plan.spec.ts` | The plan rendered as a readable Playwright spec, **for human review only**; qa-analyzer never executes it |
| `qa-report/screenshots/<criterion>.png` | Full-page screenshot of each failed or inconclusive test (never of a page outside the target origin) |

**No traces.** A Playwright trace records request headers and cookies, including the session from the login step, and `qa-report/**` is uploaded as a pipeline artifact, so no traces are recorded.

**Retries.** Full mode (staging) runs each test once, because a retry could replay a mutation. Read-only mode retries a failed or inconclusive test once; a test that passes only on its retry is PASSED with the note "passed on retry".

## Known limitations

- **Single snapshot.** Claude sees each page once, before any interaction. Elements that appear only after clicks or navigation are not in the snapshot, so tests for them are more likely to be INCONCLUSIVE.
- **Closed vocabulary.** Checks that the step vocabulary cannot express (for example, visual layout, downloads, or API responses) are reported as uncoverable.
- **One ticket per run.** Only the main ticket of the deploy is verified.
- **Up to three pages** are inspected: `--url` and the same-site pages named in the ticket, or `/` when there are none.
- **Read-only covers the browser.** Mutations made by the site's own servers as a side effect of a GET are outside the guard's reach.
- **Redirects are not re-checked.** When an allowed request (for example, the login POST) is redirected, the browser follows the redirect without passing it through the guard again.

## Development

```bash
npm run typecheck
npm test
npm run build
```
