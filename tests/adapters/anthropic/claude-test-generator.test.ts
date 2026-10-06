import { describe, expect, it } from 'vitest';
import { ClaudeTestGenerator, GenerationError, type MessagesStreamClient } from '../../../src/adapters/anthropic/claude-test-generator.js';
import { PLAN_OUTPUT_SCHEMA } from '../../../src/adapters/anthropic/plan-prompt.js';
import type { TestPlan } from '../../../src/domain/test-plan.js';
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

/** The structured output, in the wire format of PLAN_OUTPUT_SCHEMA. */
const wirePlan = {
  tests: [
    {
      criterionId: 'AC-1',
      title: '[AC-1] Badge shown',
      mutating: false,
      steps: [
        { action: 'goto', path: '/sale' },
        { action: 'expectVisible', target: { by: 'text', value: 'Sale', exact: true } },
      ],
    },
  ],
  uncoverable: [{ criterionId: 'AC-2', reason: 'Placing an order mutates data in read-only mode' }],
};

const domainPlan: TestPlan = {
  tests: [
    {
      criterionId: 'AC-1',
      title: '[AC-1] Badge shown',
      mutating: false,
      steps: [
        { action: 'goto', path: '/sale' },
        { action: 'expectVisible', target: { text: 'Sale', exact: true } },
      ],
    },
  ],
  uncoverable: [{ criterionId: 'AC-2', reason: 'Placing an order mutates data in read-only mode' }],
};

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
  it('sends the documented request shape and returns the validated plan', async () => {
    const { client, calls } = fakeClient({
      stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify(wirePlan) }],
    });
    const generator = new ClaudeTestGenerator({ client, model: 'claude-opus-5-5' });

    await expect(generator.generate(generationInput)).resolves.toEqual(domainPlan);

    const params = calls[0] ?? {};
    expect(params.model).toBe('claude-opus-5-5');
    expect(params.max_tokens).toBe(64_000);
    expect(params.output_config).toEqual({ effort: 'high', format: { type: 'json_schema', schema: PLAN_OUTPUT_SCHEMA } });
    expect(params.fallbacks).toBe('default');
    expect(params.betas).toEqual(['server-side-fallback-2026-07-01']);
    for (const forbidden of ['thinking', 'temperature', 'tool_choice', 'top_p', 'top_k']) {
      expect(params).not.toHaveProperty(forbidden);
    }
    const messages = params.messages as { role: string }[];
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
  });

  it('rejects an invalid plan with a GenerationError that lists the violations', async () => {
    const invalid = { ...wirePlan, tests: [{ ...wirePlan.tests[0], steps: [{ action: 'goto', path: 'https://evil.example.com/' }] }] };
    const { client } = fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(invalid) }] });
    const generation = new ClaudeTestGenerator({ client, model: 'm' }).generate(generationInput);
    await expect(generation).rejects.toBeInstanceOf(GenerationError);
    await expect(new ClaudeTestGenerator({ client, model: 'm' }).generate(generationInput)).rejects.toThrow(/Invalid test plan: .*path/);
    await expect(new ClaudeTestGenerator({ client, model: 'm' }).generate(generationInput)).rejects.toMatchObject({ status: undefined });
  });

  it('moves a mutating test to uncoverable under the read-only policy', async () => {
    const mutating = { ...wirePlan, tests: [{ ...wirePlan.tests[0], mutating: true }] };
    const { client } = fakeClient({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(mutating) }] });
    const plan = await new ClaudeTestGenerator({ client, model: 'm' }).generate(generationInput);
    expect(plan.tests).toEqual([]);
    expect(plan.uncoverable.map((entry) => entry.criterionId)).toEqual(['AC-2', 'AC-1']);
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

  it('keeps the HTTP status of an API error', async () => {
    const client: MessagesStreamClient = {
      beta: { messages: { stream: () => ({ finalMessage: async () => { throw Object.assign(new Error('invalid x-api-key'), { status: 401 }); } }) } },
    };
    await expect(new ClaudeTestGenerator({ client, model: 'm' }).generate(generationInput)).rejects.toMatchObject({ status: 401 });
  });
});
