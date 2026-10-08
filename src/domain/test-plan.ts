import type { EnvironmentPolicy } from './environment.js';
import type { Ticket } from './ticket.js';

/**
 * A declarative test plan: the model describes WHAT to check with a closed step
 * vocabulary and semantic locators, and our own process interprets it. No code
 * written by the model is ever executed.
 */
export interface TestPlan {
  tests: PlannedTest[];
  uncoverable: UncoverableCriterion[];
}

export interface PlannedTest {
  criterionId: string;
  /** Always starts with `[<criterionId>]`. */
  title: string;
  /** True when the test submits, creates, updates or deletes data. */
  mutating: boolean;
  steps: Step[];
}

export interface UncoverableCriterion {
  criterionId: string;
  reason: string;
}

/** The ARIA roles accepted by Playwright's `getByRole` (Playwright 1.63). */
export const ARIA_ROLES = [
  'alert', 'alertdialog', 'application', 'article', 'banner', 'blockquote', 'button', 'caption', 'cell', 'checkbox',
  'code', 'columnheader', 'combobox', 'complementary', 'contentinfo', 'definition', 'deletion', 'dialog', 'directory',
  'document', 'emphasis', 'feed', 'figure', 'form', 'generic', 'grid', 'gridcell', 'group', 'heading', 'img',
  'insertion', 'link', 'list', 'listbox', 'listitem', 'log', 'main', 'marquee', 'math', 'meter', 'menu', 'menubar',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'navigation', 'none', 'note', 'option', 'paragraph', 'presentation',
  'progressbar', 'radio', 'radiogroup', 'region', 'row', 'rowgroup', 'rowheader', 'scrollbar', 'search', 'searchbox',
  'separator', 'slider', 'spinbutton', 'status', 'strong', 'subscript', 'superscript', 'switch', 'tab', 'table',
  'tablist', 'tabpanel', 'term', 'textbox', 'time', 'timer', 'toolbar', 'tooltip', 'tree', 'treegrid', 'treeitem',
] as const;

export type AriaRole = (typeof ARIA_ROLES)[number];

/** Semantic locators only: no CSS, XPath or raw selectors. */
export type Locator =
  | { role: AriaRole; name?: string; exact?: boolean }
  | { label: string }
  | { text: string; exact?: boolean }
  | { placeholder: string }
  | { testId: string };

/** A locator with an optional zero-based index among its matches. */
export type ParentTarget = Locator & { nth?: number };

/** A target element, optionally searched inside one parent element. */
export type Target = ParentTarget & { within?: ParentTarget };

export type TextMatch = 'contains' | 'equals';

export type Step =
  | { action: 'goto'; path: string }
  | { action: 'click' | 'check' | 'uncheck' | 'hover'; target: Target }
  | { action: 'fill' | 'selectOption'; target: Target; value: string }
  | { action: 'press'; key: string; target?: Target }
  | { action: 'waitFor'; target: Target; state: 'visible' | 'hidden' }
  | { action: 'expectVisible' | 'expectHidden'; target: Target }
  /** Disabled or enabled state of a found element: a button, a form control or an `<option>`. */
  | { action: 'expectDisabled' | 'expectEnabled'; target: Target }
  | { action: 'expectText'; target: Target; text: string; match: TextMatch }
  | { action: 'expectValue'; target: Target; value: string }
  /** `value` is the visible label of the selected option of a native `<select>`, never its value attribute. */
  | { action: 'expectSelectedOption'; target: Target; value: string }
  | { action: 'expectCount'; target: Target; count: number }
  | { action: 'expectUrl'; pathPattern: string }
  | { action: 'expectTitle'; text: string; match: TextMatch };

export type StepAction = Step['action'];

export const STEP_ACTIONS = [
  'goto', 'click', 'fill', 'selectOption', 'check', 'uncheck', 'press', 'hover', 'waitFor',
  'expectVisible', 'expectHidden', 'expectText', 'expectValue', 'expectCount', 'expectUrl', 'expectTitle',
  'expectDisabled', 'expectEnabled', 'expectSelectedOption',
] as const satisfies readonly StepAction[];

export const ASSERTION_ACTIONS: ReadonlySet<StepAction> = new Set<StepAction>([
  'expectVisible', 'expectHidden', 'expectText', 'expectValue', 'expectCount', 'expectUrl', 'expectTitle',
  'expectDisabled', 'expectEnabled', 'expectSelectedOption',
]);

export function isAssertion(step: Step): boolean {
  return ASSERTION_ACTIONS.has(step.action);
}

export const MAX_STEPS_PER_TEST = 30;
export const MAX_STRING_LENGTH = 500;
const MAX_KEY_LENGTH = 50;
const MAX_COUNT = 10_000;
export const MUTATING_SKIPPED_REASON = 'mutating test skipped in read-only mode';
export const NO_POSITIVE_ASSERTION_REASON =
  'no positive assertion: the test needs an expectVisible, expectText, expectValue, expectCount (count of at least 1), expectTitle, expectDisabled, expectEnabled or expectSelectedOption step, so it cannot pass when its targets do not exist';
export const EXPECT_VALUE_ON_SELECT_REASON =
  'expectValue on a select (role combobox or listbox) compares option value attributes, which are not visible in the page snapshots; the plan must use expectSelectedOption with the visible option label';

/** Roles of select-like targets whose `inputValue` is an option value attribute, not what the user sees. */
const SELECT_ROLES: ReadonlySet<string> = new Set(['combobox', 'listbox']);

/**
 * An assertion that can only pass when something real is on the page: a target
 * that must resolve to exactly one element (`expectDisabled` and `expectEnabled`
 * too: a disabled state is only asserted on an element that exists), or the
 * document title. `expectHidden`,
 * `expectCount` of 0 and `expectUrl` also pass when a hallucinated target matches
 * nothing, so they never ground a test on their own.
 */
export function isPositiveAssertion(step: Step): boolean {
  switch (step.action) {
    case 'expectVisible':
    case 'expectText':
    case 'expectValue':
    case 'expectTitle':
    case 'expectDisabled':
    case 'expectEnabled':
    case 'expectSelectedOption':
      return true;
    case 'expectCount':
      return step.count >= 1;
    default:
      return false;
  }
}

function isExpectValueOnSelect(step: Step): boolean {
  return step.action === 'expectValue' && 'role' in step.target && SELECT_ROLES.has(step.target.role);
}

/** A path pattern made only of slashes, wildcards and whitespace matches every URL. */
const TRIVIAL_PATH_PATTERN = /^[\s/*]*$/;

/** The plan does not satisfy the contract; every violation is listed. */
export class PlanValidationError extends Error {
  constructor(readonly violations: string[]) {
    super(`Invalid test plan: ${violations.slice(0, 5).join('; ')}${violations.length > 5 ? `; and ${violations.length - 5} more` : ''}`);
    this.name = 'PlanValidationError';
  }
}

type Fields = Record<string, unknown>;

function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates field by field and collects violations instead of stopping at the first one. */
class Checker {
  readonly violations: string[] = [];

  fail(where: string, message: string): undefined {
    this.violations.push(`${where}: ${message}`);
    return undefined;
  }

  string(value: unknown, where: string, options: { allowEmpty?: boolean } = {}): string | undefined {
    if (typeof value !== 'string') return this.fail(where, 'must be a string');
    if (!options.allowEmpty && value.trim() === '') return this.fail(where, 'must not be empty');
    if (value.length > MAX_STRING_LENGTH) return this.fail(where, `must be at most ${MAX_STRING_LENGTH} characters`);
    return value;
  }

  optionalBoolean(value: unknown, where: string): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') return this.fail(where, 'must be a boolean');
    return value;
  }

  nonNegativeInteger(value: unknown, where: string): number | undefined {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_COUNT) {
      return this.fail(where, `must be an integer between 0 and ${MAX_COUNT}`);
    }
    return value;
  }

  oneOf<T extends string>(value: unknown, allowed: readonly T[], where: string): T | undefined {
    if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
      return this.fail(where, `must be one of ${allowed.join(', ')}`);
    }
    return value as T;
  }
}

const LOCATOR_KEYS = ['role', 'label', 'text', 'placeholder', 'testId'] as const;
const TARGET_KEYS = new Set<string>([...LOCATOR_KEYS, 'name', 'exact', 'nth', 'within']);

function checkLocator(raw: Fields, where: string, c: Checker): Locator | undefined {
  const kinds = LOCATOR_KEYS.filter((key) => raw[key] !== undefined);
  if (kinds.length !== 1) return c.fail(where, `must have exactly one of ${LOCATOR_KEYS.join(', ')}`);
  const kind = kinds[0];
  if (kind !== 'role' && raw.name !== undefined) c.fail(`${where}.name`, 'is only allowed with role');
  if (kind !== 'role' && kind !== 'text' && raw.exact !== undefined) c.fail(`${where}.exact`, 'is only allowed with role or text');
  switch (kind) {
    case 'role': {
      const role = c.oneOf(raw.role, ARIA_ROLES, `${where}.role`);
      const name = raw.name === undefined ? undefined : c.string(raw.name, `${where}.name`);
      const exact = c.optionalBoolean(raw.exact, `${where}.exact`);
      if (role === undefined) return undefined;
      return { role, ...(name !== undefined ? { name } : {}), ...(exact !== undefined ? { exact } : {}) };
    }
    case 'text': {
      const text = c.string(raw.text, `${where}.text`);
      const exact = c.optionalBoolean(raw.exact, `${where}.exact`);
      return text === undefined ? undefined : { text, ...(exact !== undefined ? { exact } : {}) };
    }
    case 'label': {
      const label = c.string(raw.label, `${where}.label`);
      return label === undefined ? undefined : { label };
    }
    case 'placeholder': {
      const placeholder = c.string(raw.placeholder, `${where}.placeholder`);
      return placeholder === undefined ? undefined : { placeholder };
    }
    default: {
      const testId = c.string(raw.testId, `${where}.testId`);
      return testId === undefined ? undefined : { testId };
    }
  }
}

function checkTarget(raw: unknown, where: string, c: Checker, allowWithin: boolean): Target | undefined {
  if (!isRecord(raw)) return c.fail(where, 'must be an object');
  const unexpected = Object.keys(raw).filter((key) => !TARGET_KEYS.has(key) || (key === 'within' && !allowWithin));
  if (unexpected.length > 0) return c.fail(where, `has unsupported fields: ${unexpected.join(', ')}`);
  const locator = checkLocator(raw, where, c);
  const nth = raw.nth === undefined ? undefined : c.nonNegativeInteger(raw.nth, `${where}.nth`);
  const within = raw.within === undefined ? undefined : checkTarget(raw.within, `${where}.within`, c, false);
  if (locator === undefined) return undefined;
  return { ...locator, ...(nth !== undefined ? { nth } : {}), ...(within !== undefined ? { within } : {}) } as Target;
}

const ENCODED_DOT = /%2e/gi;

/** A relative path on the target site: starts with one `/`, no scheme, host, backslash, whitespace or `..`. */
function checkPath(raw: unknown, where: string, c: Checker): string | undefined {
  const path = c.string(raw, where);
  if (path === undefined) return undefined;
  if (!path.startsWith('/') || path.startsWith('//')) return c.fail(where, 'path must be relative to the site root and start with a single /');
  if (/[\\\s\u0000-\u001f\u007f]/.test(path)) return c.fail(where, 'path must not contain backslashes, whitespace or control characters');
  const pathname = path.split(/[?#]/)[0] ?? '';
  const segments = pathname.replace(ENCODED_DOT, '.').split('/');
  if (segments.some((segment) => segment === '..' || segment === '.')) return c.fail(where, 'path must not contain . or .. segments');
  return path;
}

/** Playwright key names such as `Enter`, `ArrowDown`, `a` or `Control+A`. */
const KEY = /^(?:(?:Shift|Control|Alt|Meta|ControlOrMeta)\+)*(?:[A-Za-z][A-Za-z0-9]*|[0-9]|[!-~])$/;

function checkStep(raw: unknown, where: string, c: Checker): Step | undefined {
  if (!isRecord(raw)) return c.fail(where, 'must be an object');
  const action = c.oneOf(raw.action, STEP_ACTIONS, `${where}.action`);
  if (action === undefined) return undefined;
  const target = () => checkTarget(raw.target, `${where}.target`, c, true);
  const all = <T extends Step>(step: { [K in keyof T]: T[K] | undefined }): T | undefined =>
    Object.values(step).some((value) => value === undefined) ? undefined : (step as T);
  switch (action) {
    case 'goto':
      return all({ action, path: checkPath(raw.path, `${where}.path`, c) });
    case 'click':
    case 'check':
    case 'uncheck':
    case 'hover':
    case 'expectVisible':
    case 'expectHidden':
    case 'expectDisabled':
    case 'expectEnabled':
      return all({ action, target: target() });
    case 'fill':
    case 'selectOption':
    case 'expectValue':
      return all({ action, target: target(), value: c.string(raw.value, `${where}.value`, { allowEmpty: true }) });
    case 'expectSelectedOption':
      return all({ action, target: target(), value: c.string(raw.value, `${where}.value`) });
    case 'press': {
      const key = typeof raw.key === 'string' && raw.key.length <= MAX_KEY_LENGTH && KEY.test(raw.key) ? raw.key : c.fail(`${where}.key`, 'must be a Playwright key name such as Enter or Control+A');
      const pressTarget = raw.target === undefined ? undefined : target();
      if (key === undefined || (raw.target !== undefined && pressTarget === undefined)) return undefined;
      return { action, key, ...(pressTarget ? { target: pressTarget } : {}) };
    }
    case 'waitFor':
      return all({ action, target: target(), state: c.oneOf(raw.state, ['visible', 'hidden'] as const, `${where}.state`) });
    case 'expectText':
      return all({ action, target: target(), text: c.string(raw.text, `${where}.text`), match: c.oneOf(raw.match, ['contains', 'equals'] as const, `${where}.match`) });
    case 'expectCount':
      return all({ action, target: target(), count: c.nonNegativeInteger(raw.count, `${where}.count`) });
    case 'expectUrl': {
      const pathPattern = c.string(raw.pathPattern, `${where}.pathPattern`);
      if (pathPattern !== undefined && TRIVIAL_PATH_PATTERN.test(pathPattern)) {
        return c.fail(`${where}.pathPattern`, 'must name a specific path; "/" or wildcards alone match every page');
      }
      return all({ action, pathPattern });
    }
    case 'expectTitle':
      return all({ action, text: c.string(raw.text, `${where}.text`), match: c.oneOf(raw.match, ['contains', 'equals'] as const, `${where}.match`) });
  }
}

function checkTest(raw: unknown, where: string, c: Checker): PlannedTest | undefined {
  if (!isRecord(raw)) return c.fail(where, 'must be an object');
  const criterionId = c.string(raw.criterionId, `${where}.criterionId`);
  const title = c.string(raw.title, `${where}.title`);
  const mutating = typeof raw.mutating === 'boolean' ? raw.mutating : c.fail(`${where}.mutating`, 'must be a boolean');
  if (!Array.isArray(raw.steps)) return c.fail(`${where}.steps`, 'must be an array');
  if (raw.steps.length === 0) return c.fail(`${where}.steps`, 'must have at least one step');
  if (raw.steps.length > MAX_STEPS_PER_TEST) return c.fail(`${where}.steps`, `must have at most ${MAX_STEPS_PER_TEST} steps`);
  const steps = raw.steps.map((step, index) => checkStep(step, `${where}.steps[${index}]`, c));
  if (criterionId === undefined || title === undefined || mutating === undefined || steps.some((step) => step === undefined)) return undefined;
  const valid = steps as Step[];
  if (!valid.some(isAssertion)) return c.fail(`${where}.steps`, 'must contain at least one assertion (expect*) step');
  const prefix = `[${criterionId}]`;
  return { criterionId, title: title.startsWith(prefix) ? title : `${prefix} ${title}`, mutating, steps: valid };
}

function checkUncoverable(raw: unknown, where: string, c: Checker): UncoverableCriterion | undefined {
  if (!isRecord(raw)) return c.fail(where, 'must be an object');
  const criterionId = c.string(raw.criterionId, `${where}.criterionId`);
  const reason = c.string(raw.reason, `${where}.reason`);
  return criterionId === undefined || reason === undefined ? undefined : { criterionId, reason };
}

/**
 * Validates an untrusted plan against the ticket and the environment policy and
 * returns a normalized copy:
 * - shape, closed vocabulary, semantic targets, relative `goto` paths and limits;
 * - coverage: every acceptance criterion exactly once across `tests` and
 *   `uncoverable` (so at most one test per criterion), and no unknown ids;
 * - read-only policy: a test marked `mutating` is moved to `uncoverable`, so it is
 *   never executed and its criterion ends INCONCLUSIVE;
 * - grounding, in every mode: a test without a positive assertion (see
 *   {@link isPositiveAssertion}) is moved to `uncoverable` too. Only that test's
 *   criterion becomes INCONCLUSIVE; rejecting the whole plan would discard every
 *   other valid test of the run;
 * - selects, in every mode: a test with `expectValue` on a `combobox` or
 *   `listbox` role is moved to `uncoverable` as well, because it would compare
 *   option value attributes (often internal codes) that the model cannot see.
 * Throws a {@link PlanValidationError} listing every violation.
 */
export function validateTestPlan(raw: unknown, ticket: Pick<Ticket, 'acceptanceCriteria'>, policy: Pick<EnvironmentPolicy, 'mode'>): TestPlan {
  const c = new Checker();
  if (!isRecord(raw)) throw new PlanValidationError(['plan: must be a JSON object']);
  const tests = Array.isArray(raw.tests) ? raw.tests.map((test, index) => checkTest(test, `tests[${index}]`, c)) : c.fail('tests', 'must be an array');
  const uncoverable = Array.isArray(raw.uncoverable)
    ? raw.uncoverable.map((entry, index) => checkUncoverable(entry, `uncoverable[${index}]`, c))
    : c.fail('uncoverable', 'must be an array');

  if (tests !== undefined && uncoverable !== undefined) {
    const known = new Set(ticket.acceptanceCriteria.map((criterion) => criterion.id));
    // Raw ids, so an otherwise invalid entry does not also report its criterion as missing.
    const mentioned = [...(raw.tests as unknown[]), ...(raw.uncoverable as unknown[])].flatMap((entry) =>
      isRecord(entry) && typeof entry.criterionId === 'string' ? [entry.criterionId] : [],
    );
    const duplicates = [...new Set(mentioned.filter((id, index) => mentioned.indexOf(id) !== index))];
    if (duplicates.length > 0) c.fail('plan', `duplicate criterion ids: ${duplicates.join(', ')}`);
    const unknown = [...new Set(mentioned.filter((id) => !known.has(id)))];
    if (unknown.length > 0) c.fail('plan', `unknown criteria: ${unknown.join(', ')}`);
    const missing = [...known].filter((id) => !mentioned.includes(id));
    if (missing.length > 0) c.fail('plan', `does not account for criteria: ${missing.join(', ')}`);
  }
  if (c.violations.length > 0 || tests === undefined || uncoverable === undefined) throw new PlanValidationError(c.violations);

  const skipReason = (test: PlannedTest): string | undefined => {
    if (policy.mode === 'read-only' && test.mutating) return MUTATING_SKIPPED_REASON;
    if (!test.steps.some(isPositiveAssertion)) return NO_POSITIVE_ASSERTION_REASON;
    if (test.steps.some(isExpectValueOnSelect)) return EXPECT_VALUE_ON_SELECT_REASON;
    return undefined;
  };
  const validTests = tests as PlannedTest[];
  const skipped = validTests.flatMap((test) => {
    const reason = skipReason(test);
    return reason === undefined ? [] : [{ criterionId: test.criterionId, reason }];
  });
  return {
    tests: validTests.filter((test) => skipReason(test) === undefined),
    uncoverable: [...(uncoverable as UncoverableCriterion[]), ...skipped],
  };
}
