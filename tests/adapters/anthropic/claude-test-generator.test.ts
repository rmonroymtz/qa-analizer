import { describe, expect, it } from 'vitest';
import {
  ClaudeTestGenerator,
  GenerationError,
  validateGeneratedSuite,
  type MessagesStreamClient,
} from '../../../src/adapters/anthropic/claude-test-generator.js';
import type { Ticket } from '../../../src/domain/ticket.js';
import type { GenerationInput } from '../../../src/ports/test-generator.js';

const ticket: Ticket = {
  key: 'SHOP-42',
  summary: 'Badge',
  description: '',
  acceptanceCriteria: [
    { id: 'AC-1', text: 'Badge shown' },
    { id: 'AC-2', text: 'Order can be placed' },
  ],
  url: 'https://acme.atlassian.net/browse/SHOP-42',
};

const SPEC = [
  "import { test, expect } from './qa-fixtures';",
  '',
  "test('[AC-1] Badge shown', async ({ page }) => {",
  "  await page.goto('/sale');",
  "  await expect(page.getByText('Sale'), 'badge is visible').toBeVisible();",
  '});',
].join('\n');

const validSuite = {
  specCode: SPEC,
  criteria: [{ criterionId: 'AC-1', testTitle: '[AC-1] Badge shown' }],
  uncoverable: [{ criterionId: 'AC-2', reason: 'Placing an order mutates data in read-only mode' }],
};

describe('validateGeneratedSuite', () => {
  it('accepts a suite that covers every criterion', () => {
    expect(validateGeneratedSuite(validSuite, ticket)).toEqual(validSuite);
  });

  it('rejects a non-object or a wrongly shaped payload', () => {
    expect(() => validateGeneratedSuite(null, ticket)).toThrow(GenerationError);
    expect(() => validateGeneratedSuite({ ...validSuite, specCode: 3 }, ticket)).toThrow(GenerationError);
    expect(() => validateGeneratedSuite({ ...validSuite, criteria: 'x' }, ticket)).toThrow(GenerationError);
    expect(() => validateGeneratedSuite({ ...validSuite, uncoverable: [{ criterionId: 'AC-2' }] }, ticket)).toThrow(GenerationError);
  });

  it('rejects a suite that omits a criterion', () => {
    expect(() => validateGeneratedSuite({ ...validSuite, uncoverable: [] }, ticket)).toThrow(/AC-2/);
  });

  it('rejects unknown criterion ids', () => {
    const suite = { ...validSuite, criteria: [...validSuite.criteria, { criterionId: 'AC-9', testTitle: '[AC-9] x' }] };
    expect(() => validateGeneratedSuite(suite, ticket)).toThrow(/AC-9/);
  });

  it('requires the qa-fixtures import', () => {
    const suite = { ...validSuite, specCode: SPEC.replace("import { test, expect } from './qa-fixtures';", '') };
    expect(() => validateGeneratedSuite(suite, ticket)).toThrow(/qa-fixtures/);
  });

  it.each([
    ['require(', "const fs = require('fs');"],
    ['child_process', "// uses child_process"],
    ['process.env', 'const t = process.env.SECRET;'],
    ['dynamic import', "const m = await import('node:fs');"],
    ['other import', "import fs from 'node:fs';"],
    ['playwright import', "import { test } from '@playwright/test';"],
  ])('rejects unsafe spec code: %s', (_label, line) => {
    const suite = { ...validSuite, specCode: `${SPEC}\n${line}` };
    expect(() => validateGeneratedSuite(suite, ticket)).toThrow(GenerationError);
  });

  it('accepts the import with double quotes and no semicolon', () => {
    const suite = { ...validSuite, specCode: SPEC.replace("import { test, expect } from './qa-fixtures';", 'import { test, expect } from "./qa-fixtures"') };
    expect(validateGeneratedSuite(suite, ticket).specCode).toContain('qa-fixtures');
  });
});

const generationInput: GenerationInput = {
  ticket,
  snapshots: [{ url: 'https://shop.example.com/', title: 'Home', ariaSnapshot: '- heading "Home"' }],
  baseUrl: 'https://shop.example.com',
  policy: { mode: 'read-only', allowedMutations: [] },
  authenticated: false,
};

function fakeClient(message: { stop_reason: string | null; content: unknown[] }) {
  const calls: Record<string, unknown>[] = [];
  const client: MessagesStreamClient = {
    beta: {
      messages: {
        stream: (params) => {
          calls.push(params as unknown as Record<string, unknown>);
          return { finalMessage: async () => message as never };
        },
      },
    },
  };
  return { client, calls };
}

describe('ClaudeTestGenerator', () => {
  it('sends the documented request shape and returns the validated suite', async () => {
    const { client, calls } = fakeClient({
      stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(validSuite) }],
    });
    const generator = new ClaudeTestGenerator({ client, model: 'claude-opus-5-5' });

    await expect(generator.generate(generationInput)).resolves.toEqual(validSuite);

    const params = calls[0] ?? {};
    expect(params.model).toBe('claude-opus-5-5');
    expect(params.max_tokens).toBe(64_000);
    expect(params.output_config).toMatchObject({ effort: 'high', format: { type: 'json_schema' } });
    expect(params.fallbacks).toBe('default');
    expect(params.betas).toEqual(['server-side-fallback-2026-07-01']);
    for (const forbidden of ['thinking', 'temperature', 'tool_choice', 'top_p', 'top_k']) {
      expect(params).not.toHaveProperty(forbidden);
    }
    const messages = params.messages as { role: string }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
  });

  it.each(['refusal', 'max_tokens'])('throws GenerationError on stop_reason %s', async (stopReason) => {
    const { client } = fakeClient({ stop_reason: stopReason, content: [{ type: 'text', text: '{"partial":' }] });
    const generator = new ClaudeTestGenerator({ client, model: 'm' });
    await expect(generator.generate(generationInput)).rejects.toThrow(GenerationError);
    await expect(generator.generate(generationInput)).rejects.toThrow(stopReason);
  });

  it('throws GenerationError on a non-JSON or empty response', async () => {
    const notJson = new ClaudeTestGenerator({ client: fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'nope' }] }).client, model: 'm' });
    await expect(notJson.generate(generationInput)).rejects.toThrow(GenerationError);
    const empty = new ClaudeTestGenerator({ client: fakeClient({ stop_reason: 'end_turn', content: [] }).client, model: 'm' });
    await expect(empty.generate(generationInput)).rejects.toThrow(GenerationError);
  });

  it('wraps API errors in GenerationError', async () => {
    const client: MessagesStreamClient = {
      beta: { messages: { stream: () => ({ finalMessage: async () => { throw new Error('529 overloaded'); } }) } },
    };
    const generator = new ClaudeTestGenerator({ client, model: 'm' });
    await expect(generator.generate(generationInput)).rejects.toThrow(/529 overloaded/);
    await expect(generator.generate(generationInput)).rejects.toBeInstanceOf(GenerationError);
  });
});
