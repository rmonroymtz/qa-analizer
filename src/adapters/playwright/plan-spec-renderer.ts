import type { Locator, ParentTarget, Step, Target, TestPlan } from '../../domain/test-plan.js';

export const REVIEW_ONLY_HEADER = '// Generated for human review only — not executed by qa-analyzer.';

/**
 * A JavaScript string literal for any input. JSON escapes quotes, backslashes and
 * control characters; U+2028/U+2029 are escaped too, because they end a `//`
 * comment line. Backticks and `${` are harmless inside a double-quoted literal.
 */
function lit(value: string): string {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function locator(spec: Locator): string {
  if ('role' in spec) {
    const options = [
      ...(spec.name !== undefined ? [`name: ${lit(spec.name)}`] : []),
      ...(spec.exact !== undefined ? [`exact: ${String(spec.exact)}`] : []),
    ];
    return `getByRole(${lit(spec.role)}${options.length > 0 ? `, { ${options.join(', ')} }` : ''})`;
  }
  if ('text' in spec) return `getByText(${lit(spec.text)}${spec.exact !== undefined ? `, { exact: ${String(spec.exact)} }` : ''})`;
  if ('label' in spec) return `getByLabel(${lit(spec.label)})`;
  if ('placeholder' in spec) return `getByPlaceholder(${lit(spec.placeholder)})`;
  return `getByTestId(${lit(spec.testId)})`;
}

function chain(target: ParentTarget): string {
  return `.${locator(target)}${target.nth !== undefined ? `.nth(${target.nth})` : ''}`;
}

function targetCode(target: Target): string {
  return `page${target.within ? chain(target.within) : ''}${chain(target)}`;
}

function stepCode(step: Step): string {
  switch (step.action) {
    case 'goto':
      return `await page.goto(${lit(step.path)});`;
    case 'click':
    case 'check':
    case 'uncheck':
    case 'hover':
      return `await ${targetCode(step.target)}.${step.action}();`;
    case 'fill':
    case 'selectOption':
      return `await ${targetCode(step.target)}.${step.action}(${lit(step.value)});`;
    case 'press':
      return step.target ? `await ${targetCode(step.target)}.press(${lit(step.key)});` : `await page.keyboard.press(${lit(step.key)});`;
    case 'waitFor':
      return `await ${targetCode(step.target)}.waitFor({ state: ${lit(step.state)} });`;
    case 'expectVisible':
      return `await expect(${targetCode(step.target)}).toBeVisible();`;
    case 'expectHidden':
      return `await expect(${targetCode(step.target)}).toBeHidden();`;
    case 'expectText':
      return `await expect(${targetCode(step.target)}).${step.match === 'equals' ? 'toHaveText' : 'toContainText'}(${lit(step.text)});`;
    case 'expectValue':
      return `await expect(${targetCode(step.target)}).toHaveValue(${lit(step.value)});`;
    case 'expectCount':
      return `await expect(${targetCode(step.target)}).toHaveCount(${step.count});`;
    case 'expectUrl':
      return `expect(new URL(page.url()).pathname + new URL(page.url()).search).toContain(${lit(step.pathPattern)});`;
    case 'expectTitle':
      return step.match === 'equals' ? `await expect(page).toHaveTitle(${lit(step.text)});` : `expect(await page.title()).toContain(${lit(step.text)});`;
  }
}

/**
 * Renders a validated plan as a readable Playwright spec. The result is an
 * artifact for humans only: qa-analyzer interprets the plan itself and never
 * executes this file. Every model-provided string is emitted as a JSON string
 * literal, so it cannot break out of its literal or comment.
 */
export function renderPlanAsSpec(plan: TestPlan, baseUrl: string): string {
  const lines = [REVIEW_ONLY_HEADER, "import { test, expect } from '@playwright/test';", '', `test.use({ baseURL: ${lit(baseUrl)} });`, ''];
  for (const test of plan.tests) {
    lines.push(`test(${lit(test.title)}, async ({ page }) => {`);
    if (test.mutating) lines.push('  // Mutating: this test changes data.');
    for (const step of test.steps) lines.push(`  ${stepCode(step)}`);
    lines.push('});', '');
  }
  for (const entry of plan.uncoverable) lines.push(`// ${entry.criterionId} not coverable: ${lit(entry.reason)}`);
  return `${lines.join('\n').trimEnd()}\n`;
}
