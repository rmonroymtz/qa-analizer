import { describe, expect, it } from 'vitest';
import { buildGenerationPrompt, GENERATION_OUTPUT_SCHEMA } from '../../../src/adapters/anthropic/generation-prompt.js';
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

describe('buildGenerationPrompt', () => {
  it('puts the ticket, numbered criteria, policy, base URL and every snapshot in the user message', () => {
    const { user } = buildGenerationPrompt(input());
    expect(user).toContain('SHOP-42');
    expect(user).toContain('Show the discount badge on sale products');
    expect(user).toContain('Products on sale must display a badge.');
    expect(user).toContain('AC-1: Sale products show a "Sale" badge');
    expect(user).toContain('AC-2: Regular products show no badge');
    expect(user).toContain('full');
    expect(user).toContain('https://shop.example.com');
    expect(user).toContain('- heading "Products" [level=1]');
    expect(user).toContain('https://shop.example.com/sale');
    expect(user).toContain('Title: Sale');
    expect(user).toMatch(/```yaml\n- link "Sale"\n```/);
  });

  it('keeps the system prompt stable across tickets and modes', () => {
    const a = buildGenerationPrompt(input());
    const b = buildGenerationPrompt(input({ ticket: { ...input().ticket, key: 'OTHER-1' }, policy: { mode: 'read-only', allowedMutations: [] } }));
    expect(a.system).toBe(b.system);
    expect(a.system).not.toContain('SHOP-42');
  });

  it('states the generation rules in the system prompt', () => {
    const { system } = buildGenerationPrompt(input());
    expect(system).toContain("import { test, expect } from './qa-fixtures';");
    expect(system).toContain('[AC-n]');
    expect(system).toContain('getByRole');
    expect(system).toContain('uncoverable');
    expect(system).toContain('relative URLs');
  });

  it('includes the read-only rules only for read-only policy', () => {
    const full = buildGenerationPrompt(input()).user;
    const readOnly = buildGenerationPrompt(input({ policy: { mode: 'read-only', allowedMutations: ['/login'] } })).user;
    expect(readOnly).toContain('READ-ONLY');
    expect(readOnly).toMatch(/never submit forms/i);
    expect(full).not.toContain('READ-ONLY');
    expect(full).not.toMatch(/never submit forms/i);
  });

  it('tells Claude not to write login steps only when authenticated', () => {
    expect(buildGenerationPrompt(input({ authenticated: true })).user).toMatch(/already authenticated/i);
    expect(buildGenerationPrompt(input({ authenticated: false })).user).not.toMatch(/already authenticated/i);
  });

  it('defines a strict JSON schema for the suite', () => {
    expect(GENERATION_OUTPUT_SCHEMA.required).toEqual(['specCode', 'criteria', 'uncoverable']);
    expect(GENERATION_OUTPUT_SCHEMA.additionalProperties).toBe(false);
  });
});
