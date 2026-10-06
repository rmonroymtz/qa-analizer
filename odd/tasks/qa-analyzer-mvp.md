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
- [ ] T7 — Dockerfile, `bitbucket-pipelines.yml` example, README. Route: delegated.

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

- T6 (delegated writer): read-only guard hardening (mutations to ANY http(s) host blocked; allowed paths only on the target host; new `QA_READONLY_ALLOW_HOSTS` exact hostnames fully allowed; `EnvironmentPolicy.allowedHosts`, wired into inspector, login and generated fixtures). `VerifyTicketUseCase` (key: explicit → branch → `QA_COMMIT_MESSAGE` or HEAD commit, read lazily so `main` branches still resolve; readiness; ticket; no-AC; form login; up to 3 same-host pages with per-page tolerance; generate → run → `aggregateVerdict`; redacted `report.json` + `summary.md`; comment unless RESOLVED/dry-run/`--no-comment`, max 3 failure screenshots, comment failures logged; never throws). `configError` (401/403 or `LoginError`) drives `exitCodeForPolicy` (`not-resolved`: NOT_RESOLVED → 1, setup-caused INCONCLUSIVE → 2, else 0; `inconclusive`: raw `exitCodeFor`; `never`: 0). `GenerationError.status` keeps the API status. CLI: `src/cli/main.ts` (shebang) + `runCli` (help, ConfigError → exit 2, real adapters, human summary); login storage state lives in a temp dir outside the uploaded output dir and is deleted after the run; `npm run build` chmods `dist/cli/main.js`. RED observed for guard hardening (7 failing) and the use case/exit code (missing modules); CLI and file reporter tests were written alongside the code. Smoke: built CLI against a local fake site/Jira/Claude (401) → INCONCLUSIVE, 2 pages inspected, `configError: true`, exit 2, no secret in the report. Checks: `npm run typecheck` pass; `npm test` 199/199 pass; `npm run build` pass; `node dist/cli/main.js --help` exit 0; `node dist/cli/main.js verify` with an empty env lists 5 issues and exits 2. Commit: see T7 entry.

## Next step

T7.
