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
- [ ] T5 — Playwright runner + result classifier (assertion failure vs locator/timeout → verdict per criterion). Route: delegated.
- [ ] T6 — VerifyTicket use case + CLI wiring + exit codes + report + Jira comment composition. Route: delegated.
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

- T4 (delegated writer): `buildGenerationPrompt` (stable cacheable system prompt; ticket, ACs, policy, base URL, snapshots in the user message; read-only rules only for read-only; no-login rule only when authenticated), `GENERATION_OUTPUT_SCHEMA`, `validateGeneratedSuite` (shape, full AC coverage, unknown ids, static safety: no `require(`, `child_process`, `process.env`, dynamic `import()`, or imports other than `./qa-fixtures`), `ClaudeTestGenerator` + `GenerationError` via `client.beta.messages.stream(...).finalMessage()` with `max_tokens` 64000, `output_config: { effort: 'high', format: json_schema }`, adaptive thinking (omitted), `fallbacks: 'default'` + beta `server-side-fallback-2026-07-01` (shape confirmed in the SDK 0.131 types `BetaFallbacksParam = Array<...> | 'default'`); `refusal`/`max_tokens` stop reasons and API errors throw `GenerationError`. RED observed (missing modules) before GREEN. Checks: `npm run typecheck` pass; `npm test` 121/121 pass; `npm run build` pass. Commit: see T5 entry.

## Next step

T5.
