import { describe, expect, it } from 'vitest';
import { buildPlanPrompt, PLAN_OUTPUT_SCHEMA, toDomainPlan } from '../../../src/adapters/anthropic/plan-prompt.js';
import { ARIA_ROLES } from '../../../src/domain/test-plan.js';
import type { GenerationInput } from '../../../src/ports/test-generator.js';

function input(overrides: Partial<GenerationInput> = {}): GenerationInput {
  return {
    ticket: {
      key: 'SHOP-42',
      summary: 'Show the discount badge on sale products',
      description: 'Products on sale must display a badge.',
      acceptanceCriteria: [
        { id: 'AC-1', text: 'Sale products show a "Sale" badge' },
        { id: 'AC-2', text: 'Regular products show no badge' },
      ],
      url: 'https://acme.atlassian.net/browse/SHOP-42',
    },
    snapshots: [
      { url: 'https://shop.example.com/products', title: 'Products', ariaSnapshot: '- heading "Products" [level=1]' },
      { url: 'https://shop.example.com/sale', title: 'Sale', ariaSnapshot: '- link "Sale"' },
    ],
    baseUrl: 'https://shop.example.com',
    policy: { mode: 'full', allowedMutations: [] },
    authenticated: false,
    ...overrides,
  };
}

/** Every object in the schema, depth first. */
function objectsIn(schema: unknown): Record<string, unknown>[] {
  if (typeof schema !== 'object' || schema === null) return [];
  const node = schema as Record<string, unknown>;
  const children = Object.values(node).flatMap((value) => (Array.isArray(value) ? value.flatMap(objectsIn) : objectsIn(value)));
  return node.type === 'object' ? [node, ...children] : children;
}

describe('buildPlanPrompt', () => {
  it('puts the ticket, numbered criteria, policy, base URL and every snapshot in the user message', () => {
    const { user } = buildPlanPrompt(input());
    expect(user).toContain('SHOP-42');
    expect(user).toContain('Products on sale must display a badge.');
    expect(user).toContain('AC-1: Sale products show a "Sale" badge');
    expect(user).toContain('AC-2: Regular products show no badge');
    expect(user).toContain('Policy mode: full');
    expect(user).toContain('https://shop.example.com');
    expect(user).toMatch(/```yaml\n- link "Sale"\n```/);
  });

  it('keeps the system prompt stable across tickets and modes', () => {
    const a = buildPlanPrompt(input());
    const b = buildPlanPrompt(input({ ticket: { ...input().ticket, key: 'OTHER-1' }, policy: { mode: 'read-only', allowedMutations: [] } }));
    expect(a.system).toBe(b.system);
    expect(a.system).not.toContain('SHOP-42');
  });

  it('states the plan rules in the system prompt', () => {
    const { system } = buildPlanPrompt(input());
    expect(system).toContain('[AC-n]');
    expect(system).toContain('uncoverable');
    expect(system).toContain('mutating');
    expect(system).toMatch(/aria snapshot/i);
    expect(system).toMatch(/untrusted/i);
    expect(system).toMatch(/relative path/i);
    expect(system).not.toContain('qa-fixtures');
    expect(system).toContain('Every test needs at least one positive assertion');
    expect(system).toMatch(/expectHidden, expectCount with a count of 0 and expectUrl never count as positive/);
    expect(system).toMatch(/never "\/" or wildcards alone/);
  });

  it('includes the read-only rules only for read-only policy', () => {
    const full = buildPlanPrompt(input()).user;
    const readOnly = buildPlanPrompt(input({ policy: { mode: 'read-only', allowedMutations: ['/login'] } })).user;
    expect(readOnly).toContain('READ-ONLY');
    expect(readOnly).toMatch(/uncoverable/);
    expect(full).not.toContain('READ-ONLY');
  });

  it('tells Claude not to plan login steps only when authenticated', () => {
    expect(buildPlanPrompt(input({ authenticated: true })).user).toMatch(/already authenticated/i);
    expect(buildPlanPrompt(input({ authenticated: false })).user).not.toMatch(/already authenticated/i);
  });

  it('flags a snapshot captured while first-party requests were still pending', () => {
    const { user, system } = buildPlanPrompt(
      input({
        snapshots: [
          { url: 'https://shop.example.com/p/42', title: 'Product', ariaSnapshot: '- text: Fetching Data...', loadIncomplete: { pendingRequests: ['/api/products/42'] } },
          { url: 'https://shop.example.com/sale', title: 'Sale', ariaSnapshot: '- link "Sale"' },
        ],
      }),
    );
    expect(user).toContain('Load incomplete: captured while first-party requests were still pending (/api/products/42)');
    expect(user.match(/Load incomplete/g)).toHaveLength(1);
    expect(system).toMatch(/load incomplete/i);
    expect(system).toMatch(/not coverable|uncoverable/);
  });

  it('adds no load note to complete snapshots', () => {
    expect(buildPlanPrompt(input()).user).not.toContain('Load incomplete');
  });

  it('wraps ticket and snapshot content as untrusted data', () => {
    const { user } = buildPlanPrompt(input());
    expect(user).toMatch(/<untrusted_ticket>[\s\S]*SHOP-42[\s\S]*<\/untrusted_ticket>/);
    expect(user).toMatch(/<untrusted_snapshots>[\s\S]*- link "Sale"[\s\S]*<\/untrusted_snapshots>/);
  });
});

describe('PLAN_OUTPUT_SCHEMA', () => {
  it('only uses features that structured outputs supports', () => {
    const text = JSON.stringify(PLAN_OUTPUT_SCHEMA);
    for (const unsupported of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems', 'pattern', '$ref']) {
      expect(text).not.toContain(`"${unsupported}"`);
    }
    for (const object of objectsIn(PLAN_OUTPUT_SCHEMA)) expect(object.additionalProperties).toBe(false);
  });

  it('constrains actions with an enum and lists the roles in the prompt', () => {
    const text = JSON.stringify(PLAN_OUTPUT_SCHEMA);
    expect(text).toContain('"expectVisible"');
    expect(buildPlanPrompt(input()).system).toContain(ARIA_ROLES.join(', '));
    expect(PLAN_OUTPUT_SCHEMA.required).toEqual(['tests', 'uncoverable']);
  });

  it('keeps the optional property count within the structured outputs limit', () => {
    const optional = objectsIn(PLAN_OUTPUT_SCHEMA).reduce((total, object) => {
      const properties = Object.keys((object.properties ?? {}) as object);
      const required = (object.required ?? []) as string[];
      return total + properties.filter((name) => !required.includes(name)).length;
    }, 0);
    expect(optional).toBeLessThanOrEqual(24);
  });
});

describe('toDomainPlan', () => {
  it('maps wire targets to semantic locators', () => {
    const raw = {
      tests: [
        {
          criterionId: 'AC-1',
          title: '[AC-1] x',
          mutating: false,
          steps: [
            { action: 'click', target: { by: 'role', value: 'button', name: 'Buy', exact: true, nth: 0, within: { by: 'label', value: 'Cart', exact: true } } },
            { action: 'expectVisible', target: { by: 'text', value: 'Thanks', exact: false } },
            { action: 'fill', target: { by: 'placeholder', value: 'Email' }, value: 'a@b.c' },
            { action: 'expectHidden', target: { by: 'testId', value: 'spinner' } },
            { action: 'press', key: 'Enter' },
          ],
        },
      ],
      uncoverable: [],
    };
    expect(toDomainPlan(raw)).toEqual({
      tests: [
        {
          criterionId: 'AC-1',
          title: '[AC-1] x',
          mutating: false,
          steps: [
            { action: 'click', target: { role: 'button', name: 'Buy', exact: true, nth: 0, within: { label: 'Cart' } } },
            { action: 'expectVisible', target: { text: 'Thanks', exact: false } },
            { action: 'fill', target: { placeholder: 'Email' }, value: 'a@b.c' },
            { action: 'expectHidden', target: { testId: 'spinner' } },
            { action: 'press', key: 'Enter' },
          ],
        },
      ],
      uncoverable: [],
    });
  });

  it('passes malformed input through unchanged for the validator to reject', () => {
    expect(toDomainPlan('nope')).toBe('nope');
    const odd = { tests: [{ steps: [{ action: 'click', target: { by: 'css', value: '#a' } }] }], uncoverable: [] };
    expect(toDomainPlan(odd)).toEqual({ tests: [{ steps: [{ action: 'click', target: { by: 'css', value: '#a' } }] }], uncoverable: [] });
  });
});
