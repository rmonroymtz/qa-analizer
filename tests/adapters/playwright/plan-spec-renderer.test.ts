import { describe, expect, it } from 'vitest';
import { renderPlanAsSpec, REVIEW_ONLY_HEADER } from '../../../src/adapters/playwright/plan-spec-renderer.js';
import type { TestPlan } from '../../../src/domain/test-plan.js';

const plan: TestPlan = {
  tests: [
    {
      criterionId: 'AC-1',
      title: '[AC-1] Badge shown',
      mutating: false,
      steps: [
        { action: 'goto', path: '/sale' },
        { action: 'click', target: { role: 'button', name: 'Menu', exact: true } },
        { action: 'fill', target: { label: 'Search' }, value: 'shoes' },
        { action: 'press', key: 'Enter' },
        { action: 'waitFor', target: { testId: 'results' }, state: 'visible' },
        { action: 'expectVisible', target: { role: 'link', name: 'Shoes', nth: 1, within: { role: 'navigation' } } },
        { action: 'expectText', target: { role: 'status' }, text: '3 results', match: 'contains' },
        { action: 'expectText', target: { role: 'status' }, text: '3 results', match: 'equals' },
        { action: 'expectCount', target: { placeholder: 'Email' }, count: 2 },
        { action: 'expectUrl', pathPattern: '/sale' },
        { action: 'expectTitle', text: 'Sale', match: 'equals' },
      ],
    },
  ],
  uncoverable: [{ criterionId: 'AC-2', reason: 'requires a mutating action' }],
};

describe('renderPlanAsSpec', () => {
  it('renders a readable spec that starts with the review-only header', () => {
    const spec = renderPlanAsSpec(plan, 'https://shop.example.com');
    expect(spec.startsWith(REVIEW_ONLY_HEADER)).toBe(true);
    expect(REVIEW_ONLY_HEADER).toContain('Generated for human review only — not executed by qa-analyzer');
    expect(spec).toContain("import { test, expect } from '@playwright/test';");
    expect(spec).toContain('test.use({ baseURL: "https://shop.example.com" });');
    expect(spec).toContain('test("[AC-1] Badge shown", async ({ page }) => {');
    expect(spec).toContain('await page.goto("/sale");');
    expect(spec).toContain('await page.getByRole("button", { name: "Menu", exact: true }).click();');
    expect(spec).toContain('await page.getByLabel("Search").fill("shoes");');
    expect(spec).toContain('await page.keyboard.press("Enter");');
    expect(spec).toContain('await page.getByTestId("results").waitFor({ state: "visible" });');
    expect(spec).toContain('await expect(page.getByRole("navigation").getByRole("link", { name: "Shoes" }).nth(1)).toBeVisible();');
    expect(spec).toContain('await expect(page.getByRole("status")).toContainText("3 results");');
    expect(spec).toContain('await expect(page.getByRole("status")).toHaveText("3 results");');
    expect(spec).toContain('await expect(page.getByPlaceholder("Email")).toHaveCount(2);');
    expect(spec).toContain('expect(new URL(page.url()).pathname + new URL(page.url()).search).toContain("/sale");');
    expect(spec).toContain('await expect(page).toHaveTitle("Sale");');
    expect(spec).toContain('// AC-2 not coverable: "requires a mutating action"');
  });

  it('marks a mutating test', () => {
    const spec = renderPlanAsSpec({ tests: [{ ...plan.tests[0]!, mutating: true }], uncoverable: [] }, 'https://x.example.com');
    expect(spec).toContain('// Mutating: this test changes data.');
  });

  it('escapes hostile strings so they stay inside string literals and comments', () => {
    const hostile = 'a"b\'c`d${process.exit(1)}e\nf */ g\u2028h\\';
    const spec = renderPlanAsSpec(
      {
        tests: [
          {
            criterionId: 'AC-1',
            title: `[AC-1] ${hostile}`,
            mutating: false,
            steps: [
              { action: 'fill', target: { label: hostile }, value: hostile },
              { action: 'expectTitle', text: hostile, match: 'contains' },
            ],
          },
        ],
        uncoverable: [{ criterionId: 'AC-2', reason: hostile }],
      },
      hostile,
    );
    const literal = JSON.stringify(hostile).replace(/\u2028/g, '\\u2028');
    expect(spec).toContain(`page.getByLabel(${literal}).fill(${literal})`);
    expect(spec).toContain(`// AC-2 not coverable: ${literal}`);
    // No raw line break from the hostile input: every line is one we produced.
    expect(spec).not.toMatch(/\u2028/);
    expect(spec.split('\n').some((line) => line.startsWith('f */'))).toBe(false);
    // The rendered spec still parses as a sequence of statements: every literal is a JSON string.
    const literals = [...spec.matchAll(/"(?:[^"\\\n]|\\.)*"/g)].map((match) => JSON.parse(match[0]) as string);
    expect(literals).toContain(hostile);
  });
});
