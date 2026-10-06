# Feature: qa-analyzer MVP

## Objective

A CLI that runs as a post-deploy step in Bitbucket Pipelines, reads the main Jira ticket, has Claude generate Playwright tests against the real page structure, runs them against `TARGET_BASE_URL`, and reports a verdict (RESOLVED / NOT_RESOLVED / INCONCLUSIVE). It comments on the Jira ticket when the result is not RESOLVED.

## Problem / Why

Manual verification of deployed tickets is slow and inconsistent. AI-generated tests without page context hallucinate selectors and produce false NOT_RESOLVED verdicts, so the design grounds generation in a captured accessibility snapshot (approach 1: single snapshot) and uses a three-state verdict.

## Scope

- TypeScript (Node 24, ESM), `@playwright/test`, `@anthropic-ai/sdk` (model `claude-opus-5-5`), vitest for unit tests.
- Hexagonal layout: `src/domain`, `src/application`, `src/ports`, `src/adapters`, `src/cli`.
- Single main ticket per run. Key resolution order: `--ticket` / `QA_TICKET` → branch name (`BITBUCKET_BRANCH`) → merge commit message → INCONCLUSIVE (exit 2, no Jira comment).
- Environments: `staging` (full) and `production` (read-only: mutating requests blocked via `page.route`, except an allowlist such as login).
- Login: hand-written setup (form login config, credentials from env), `storageState` reused by generated tests. `auth: none | form`.
- Wait for readiness (health/version URL with `BITBUCKET_COMMIT`) before testing.
- Exit codes: 0 RESOLVED, 1 NOT_RESOLVED, 2 INCONCLUSIVE/error. `--fail-on` policy.
- Evidence: `qa-report/` (generated specs, Playwright JSON report, traces, screenshots) and a screenshot attached to the Jira comment.

## Constraints

- Selector-not-found, timeout, generation failure, or missing acceptance criteria → INCONCLUSIVE, never NOT_RESOLVED.
- Production must never execute mutating actions.
- Secrets only via env vars; never logged.
- Artifacts and code in English.

## Delivery

- Strategy: `ask-on-risk`. Forecast is about 2000+ authored lines, which is over the 400-line budget. Chain strategy: **pending**, because there is no remote yet; decide before the first PR.
- Review (RDD): global off. Ordinary checks only.

## Tasks

- [x] T1 — Scaffold + domain + config + ticket key resolution (TS project, vitest, Verdict/Ticket/AcceptanceCriterion, env/CLI config parsing, ticket key resolver). Route: delegated (2+ non-trivial files).
- [x] T2 — Jira adapter (fetch issue, ADF→text, AC field from `JIRA_AC_FIELD` or description, comment in ADF, attach screenshot). Route: delegated.
- [x] T3 — Playwright inspector + auth setup + production read-only guard + readiness wait. Route: delegated.
- [x] T4 — Claude test generator (prompt with ticket + aria snapshot + env policy, structured output → spec code + criterion mapping). Route: delegated.
- [x] T5 — Playwright runner + result classifier (assertion failure vs locator/timeout → verdict per criterion). Route: delegated.
- [x] T6 — VerifyTicket use case + CLI wiring + exit codes + report + Jira comment composition. Route: delegated.
- [x] T7 — Dockerfile, `bitbucket-pipelines.yml` example, README. Route: delegated.
- [x] T8 — Hardening from the independent T1–T3 verification. Fixes: every AC must have a result in `aggregateVerdict`; the form login must require a success signal; read-only must allow only GET/HEAD/OPTIONS and block service workers and WebSockets; stricter ticket-key matching; an invalid explicit `--ticket` must fail; Jira credentials must use private fields; nested config redaction; no empty ADF text nodes; the guard must throw on a bad base URL; stricter short-SHA matching. Route: delegated (multi-file). Reason: verifier findings, user-authorized scope (correctness of the existing tasks).
- [ ] T9 — Fixes from the independent T4–T7 verification that do not depend on the isolation design. Exit codes: a missing ticket key and Anthropic/Jira 400/404/429 errors become config-level (exit 2). No traces in authenticated or read-only runs. Reject duplicate or overlapping criterion ids. `test.fail`/`test.fixme` must not count as PASSED. No retries in full mode. Kill the process group on timeout. Tighten the weak tests. Route: delegated.
- [ ] T10 — Isolate the AI-generated test execution: the read-only guard must not be removable by generated code (page.route precedence, page.request, browser.newContext), and secrets must not be exfiltrated (/proc/<ppid>/environ, regex-check bypass). Design: **pending user decision** (declarative plan interpreted by the parent vs. sandboxed code execution). Route: delegated.

## Acceptance criteria

- `qa-analyzer verify --ticket KEY` runs end to end with mocked ports in tests.
- Unit tests cover key resolution, verdict classification, read-only guard, Jira ADF and comment composition.
- `npm run typecheck`, `npm test`, and `npm run build` pass.

## Checks

`npm run typecheck`, `npm test`, `npm run build`

## Progress / Evidence

- T1 (delegated writer): scaffold (TS 7 strict ESM/NodeNext, vitest 5), domain (Verdict, Ticket, CriterionResult, EnvironmentPolicy), ports, `loadConfig` + `redactConfig`, `resolveTicketKey`, `readHeadCommitMessage`. RED observed (missing modules) before GREEN. Checks: `npm run typecheck` pass; `npm test` 38/38 pass; `npm run build` pass. Commit: `e1189de` feat: scaffold project with domain, config and ticket key resolution.

- T2 (delegated writer): `JiraClient` (basic auth, injectable fetch, `JiraError` with status, credentials scrubbed), `adfToText`, `extractAcceptanceCriteria` (custom field ADF/string, description heading/paragraph label in EN/ES, plain-text fallback), `buildVerificationCommentAdf`, `JiraTicketRepository`, `JiraTicketCommenter` (attachments first; upload failures reported in the comment). RED observed (missing modules) before GREEN. Checks: `npm run typecheck` pass; `npm test` 64/64 pass; `npm run build` pass. Commit: `1af5612` feat(jira): add Jira ticket repository and verification commenter.

- T3 (delegated writer): `shouldBlockRequest` + `installReadOnlyGuard` (mutating methods to the target host blocked unless the path matches an allowed glob or `^regex`; invalid patterns fail closed), `performFormLogin` + `LoginError` (credentials scrubbed, context always closed), `PlaywrightPageInspector` + `truncateSnapshot` (default 30000 chars), `HttpReadinessProbe` + `readinessProbeFromConfig` + `ReadinessTimeoutError` (injectable fetch and clock). Playwright 1.63 APIs (`locator.ariaSnapshot`, `context.route`, `route.abort`) confirmed against the installed type definitions. No real browser in unit tests (login tested with a fake browser). RED observed (missing modules) before GREEN. Checks: `npm run typecheck` pass; `npm test` 98/98 pass; `npm run build` pass. Commit: `5581889` feat(playwright): add page inspector, read-only guard, form login and readiness probe.

- T4 (delegated writer): `buildGenerationPrompt` (stable cacheable system prompt; ticket, ACs, policy, base URL, snapshots in the user message; read-only rules only for read-only; no-login rule only when authenticated), `GENERATION_OUTPUT_SCHEMA`, `validateGeneratedSuite` (shape, full AC coverage, unknown ids, static safety: no `require(`, `child_process`, `process.env`, dynamic `import()`, or imports other than `./qa-fixtures`), `ClaudeTestGenerator` + `GenerationError` via `client.beta.messages.stream(...).finalMessage()` with `max_tokens` 64000, `output_config: { effort: 'high', format: json_schema }`, adaptive thinking (omitted), `fallbacks: 'default'` + beta `server-side-fallback-2026-07-01` (shape confirmed in the SDK 0.131 types `BetaFallbacksParam = Array<...> | 'default'`); `refusal`/`max_tokens` stop reasons and API errors throw `GenerationError`. RED observed (missing modules) before GREEN. Checks: `npm run typecheck` pass; `npm test` 121/121 pass; `npm run build` pass. Commit: `cd5cbaf` feat(anthropic): add Claude test generator with structured output validation.

- T5 (delegated writer): `classifyResults` (maps `[AC-n]` titles, nested describes, ticket order; passed/flaky → PASSED; `expect` matcher failure → FAILED with expected/actual and the last screenshot; `element(s) not found`, strict mode, `net::ERR`, blocked requests, action timeouts, test timeouts, load/syntax errors, skips, unknown errors → INCONCLUSIVE; uncoverable → INCONCLUSIVE "not coverable: ..."; missing test → "no test generated"; several tests per criterion combine FAILED > INCONCLUSIVE > PASSED). `PlaywrightTestRunner` writes `generated/{package.json (type module), qa-fixtures.ts, verification.spec.ts, playwright.config.mjs}` with absolute `file:` imports of `@playwright/test` and the compiled guard, spawns the resolved CLI with `process.execPath` and a secret-free env, parses `results.json` (missing → all INCONCLUSIVE with the stderr tail). Read-only extras: the `request` fixture throws and specs using `request.post/put/patch/delete/fetch` or Node `fetch(` are refused before launch. Port change: `RunContext.ticket` added. Decision: an `expect` whose target is not found (`element(s) not found`) is INCONCLUSIVE, per the selector-not-found constraint. RED observed (missing modules) before GREEN. Real-browser smoke run from `dist` with the output dir outside the package: PASSED/FAILED (expected/actual/screenshot)/INCONCLUSIVE (click timeout) and a POST blocked by the guard, as expected. Checks: `npm run typecheck` pass; `npm test` 156/156 pass; `npm run build` pass. Commit: `dc32f5f` feat(playwright): add generated-suite runner and per-criterion result classifier.

- T6 (delegated writer): read-only guard hardening (mutations to ANY http(s) host blocked; allowed paths only on the target host; new `QA_READONLY_ALLOW_HOSTS` exact hostnames fully allowed; `EnvironmentPolicy.allowedHosts`, wired into inspector, login and generated fixtures). `VerifyTicketUseCase` (key: explicit → branch → `QA_COMMIT_MESSAGE` or HEAD commit, read lazily so `main` branches still resolve; readiness; ticket; no-AC; form login; up to 3 same-host pages with per-page tolerance; generate → run → `aggregateVerdict`; redacted `report.json` + `summary.md`; comment unless RESOLVED/dry-run/`--no-comment`, max 3 failure screenshots, comment failures logged; never throws). `configError` (401/403 or `LoginError`) drives `exitCodeForPolicy` (`not-resolved`: NOT_RESOLVED → 1, setup-caused INCONCLUSIVE → 2, else 0; `inconclusive`: raw `exitCodeFor`; `never`: 0). `GenerationError.status` keeps the API status. CLI: `src/cli/main.ts` (shebang) + `runCli` (help, ConfigError → exit 2, real adapters, human summary); login storage state lives in a temp dir outside the uploaded output dir and is deleted after the run; `npm run build` chmods `dist/cli/main.js`. RED observed for guard hardening (7 failing) and the use case/exit code (missing modules); CLI and file reporter tests were written alongside the code. Smoke: built CLI against a local fake site/Jira/Claude (401) → INCONCLUSIVE, 2 pages inspected, `configError: true`, exit 2, no secret in the report. Checks: `npm run typecheck` pass; `npm test` 199/199 pass; `npm run build` pass; `node dist/cli/main.js --help` exit 0; `node dist/cli/main.js verify` with an empty env lists 5 issues and exits 2. Commit: `2043bbb` feat(cli): add verify-ticket use case, exit code policy and CLI wiring.

- T7 (delegated writer): `Dockerfile` (`mcr.microsoft.com/playwright:v1.63.0-noble`, matching `@playwright/test` 1.63.0 in package-lock; git installed for commit-message key resolution; `npm ci`, build, `npm prune --omit=dev`; `ENTRYPOINT ["node", "/app/dist/cli/main.js"]`), `.dockerignore`, example `bitbucket-pipelines.yml` (stages with `deployment: staging|production` on `develop`/`main`, Deploy placeholder + shared "QA verify" step, `qa-report/**` artifacts, variable placement comments), `README.md` (verdict semantics, quick start, flags, env table, exit codes, read-only safety, login, Bitbucket, artifacts, limitations). Exception to test-first: docs/config only. Structural check: `bitbucket-pipelines.yml` parsed with Python `yaml.safe_load` (branches develop/main, deployments staging/production, artifacts `qa-report/**`). Not done: `.env.example` (writing `.env*` files is denied by the permission settings; every variable is documented in the README table instead); `docker build` not run. Checks: `npm run typecheck` pass; `npm test` 199/199 pass; `npm run build` pass. Commit: recorded in the next work unit (self-referential SHA).

- T8 (delegated writer): hardening from the independent T1–T3 verification. `aggregateVerdict` now requires a result for every ticket criterion (missing → INCONCLUSIVE; unknown ids ignored; any FAILED → NOT_RESOLVED). Form login without `QA_LOGIN_SUCCESS_URL` requires leaving the login path (origin + path) or the password field becoming hidden/detached, else `LoginError` "could not confirm successful login". Read-only guard: method allowlist (only GET/HEAD/OPTIONS safe), `serviceWorkers: 'block'` in the inspector, login and generated Playwright config, WebSockets closed (code 1008) via `context.routeWebSocket` with a URL predicate that skips `QA_READONLY_ALLOW_HOSTS`, install throws on an unparseable base URL or a target without `routeWebSocket`, specs that mention `serviceWorkers`/`routeWebSocket`/`unroute` are refused in read-only; redirect re-checking documented as a known limitation (code comment + README). Ticket keys: branch keys must start a path segment and end at `-`/`_`/`/`/end; free-form commit keys are upper-case whole words; stoplist UTF, SHA, ISO, RFC, HTTP, TLS, SSL, MD, AES, RSA, X, ES, IE, PR plus RELEASE; new `QA_JIRA_PROJECTS` restricts every source; an invalid explicit key is a `ConfigError` (exit 2) in `loadConfig` and a setup-caused INCONCLUSIVE (no fallback) in the use case. `JiraClient` keeps the authorization header, secrets and fetch in `#private` fields. Config secrets (`jira.apiToken`, `auth.password`, `anthropic.apiKey`) are non-enumerable with a custom inspector, so JSON, inspect (also `showHidden`), spread and `structuredClone` of the nested objects omit them. Jira comment ADF drops empty text nodes (an empty paragraph keeps `content: []`). Readiness matches the full or short SHA only as a whole hex token, through JSON string values when the body is JSON. RED observed per fix before GREEN. Real-browser smoke (Chromium, built guard): WebSocket closed with 1008, `PROPFIND` blocked, `GET` 200. CLI smoke: `verify --ticket "bad key"` exits 2 with the ticket issue listed. Checks: `npm run typecheck` pass; `npm test` 240/240 pass; `npm run build` pass. Commits: `ccd0335` fix(playwright): require a login success signal and harden the read-only guard; `8d197e7` fix: require full criterion coverage and stricter ticket key and commit matching; fix(security) commit with this document update (self-referential SHA). Out of scope, pending a user decision: how the classifier treats an `expect` whose target is not found.

## Next step

An independent verification of T4–T8, and the user decision on how the classifier treats an `expect` whose target element is not found. Pending human items: create `.env.example` (blocked for the agent by permission settings), optionally `docker build` the image, then decide the chain strategy and open the PR(s).
