import type { GenerationInput } from '../../ports/test-generator.js';

export const FIXTURES_IMPORT = "import { test, expect } from './qa-fixtures';";

/**
 * Stable across every run so it can be cached; all volatile content (ticket,
 * policy, snapshots) goes in the user message.
 */
const SYSTEM_PROMPT = `You are a senior QA engineer who verifies that a deployed Jira ticket is resolved by writing Playwright end-to-end tests.

You receive a ticket with numbered acceptance criteria, the environment policy, the base URL, and accessibility (aria) snapshots of the relevant pages as they are deployed right now. Write ONE Playwright TypeScript spec file that checks the acceptance criteria against the live site.

Rules for the spec code:
1. The first line must be exactly: ${FIXTURES_IMPORT}
   Import nothing else. Do not use require(), dynamic import(), process.env, the file system, or child processes.
   Do not use test.only, test.fail, test.fixme or test.skip.
2. Write one test() per acceptance criterion you can verify. Title each test "[AC-n] <short description>", where AC-n is the criterion id exactly as given (for example "[AC-1] Sale badge is visible").
3. Use only locators grounded in the provided aria snapshots. Prefer page.getByRole(...), page.getByLabel(...) and page.getByText(...) with the accessible names that appear in the snapshots. Never invent CSS ids, classes, test ids, or XPath.
4. Navigate with relative URLs only (for example await page.goto('/products')); baseURL is already configured.
5. Express every business check as an expect(...) assertion with a clear message as the second argument, for example: await expect(page.getByRole('heading', { name: 'Cart' }), 'cart page heading is shown').toBeVisible();
   Keep the steps that reach the state under test free of business assertions, so that a failed expect means the criterion is not met.
6. When a criterion cannot be verified from the UI or from the provided snapshots, do not write a test for it and never fake a passing test: list it in "uncoverable" with a short reason.
7. Follow the environment rules in the user message. When they say the environment is READ-ONLY, apply them strictly and list every criterion that needs a mutation as uncoverable.
8. When the user message says the session is already authenticated, never write login steps.

Output a JSON object with:
- specCode: the full spec file content.
- criteria: one entry per written test, { criterionId, testTitle }, where testTitle is the exact test title.
- uncoverable: one entry per criterion without a test, { criterionId, reason }.
Every acceptance criterion id must appear exactly once, either in criteria or in uncoverable.`;

const READ_ONLY_RULES = `Environment rules: this environment is READ-ONLY (production).
- Never submit forms, and never create, update or delete data.
- Never click buttons or links that mutate state (save, submit, buy, pay, add to cart, delete, subscribe, send, and similar).
- Typing into a search or filter field is allowed only when it does not submit a mutating request.
- Mark every criterion that requires a mutation as uncoverable with the reason "requires a mutating action in a read-only environment".
- Mutating network requests are blocked by a guard; a blocked request surfaces as net::ERR_BLOCKED_BY_CLIENT.`;

const FULL_RULES = `Environment rules: this environment allows the full test surface (staging). Mutating actions such as submitting forms are allowed when a criterion needs them.`;

export const GENERATION_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    specCode: { type: 'string' },
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        properties: { criterionId: { type: 'string' }, testTitle: { type: 'string' } },
        required: ['criterionId', 'testTitle'],
        additionalProperties: false,
      },
    },
    uncoverable: {
      type: 'array',
      items: {
        type: 'object',
        properties: { criterionId: { type: 'string' }, reason: { type: 'string' } },
        required: ['criterionId', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['specCode', 'criteria', 'uncoverable'],
  additionalProperties: false,
} as const;

export interface GenerationPrompt {
  system: string;
  user: string;
}

/** Builds the prompt for one ticket. Pure: the same input always yields the same prompt. */
export function buildGenerationPrompt(input: GenerationInput): GenerationPrompt {
  const { ticket } = input;
  const criteria = ticket.acceptanceCriteria.map((criterion) => `${criterion.id}: ${criterion.text}`).join('\n');
  const snapshots = input.snapshots
    .map((snapshot, index) =>
      [`### Page ${index + 1}`, `URL: ${snapshot.url}`, `Title: ${snapshot.title}`, '```yaml', snapshot.ariaSnapshot, '```'].join('\n'),
    )
    .join('\n\n');

  const sections = [
    `## Ticket ${ticket.key}`,
    `Summary: ${ticket.summary}`,
    '',
    'Description:',
    ticket.description.trim() || '(no description)',
    '',
    '## Acceptance criteria',
    criteria,
    '',
    '## Environment',
    `Policy mode: ${input.policy.mode}`,
    input.policy.mode === 'read-only' ? READ_ONLY_RULES : FULL_RULES,
    `Base URL: ${input.baseUrl}`,
    input.authenticated
      ? 'Authentication: the session is already authenticated; do not write login steps.'
      : 'Authentication: none configured; test the pages as an anonymous visitor.',
    '',
    '## Page snapshots',
    snapshots || '(no snapshots captured)',
  ];
  return { system: SYSTEM_PROMPT, user: sections.join('\n') };
}
