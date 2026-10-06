import type { BetaMessage, BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { PlanValidationError, validateTestPlan, type TestPlan } from '../../domain/test-plan.js';
import type { GenerationInput, TestGenerator } from '../../ports/test-generator.js';
import { buildPlanPrompt, PLAN_OUTPUT_SCHEMA, toDomainPlan } from './plan-prompt.js';

/** Test generation failed; upstream this becomes an INCONCLUSIVE verdict. */
export class GenerationError extends Error {
  /** HTTP status of the underlying API error, when there was one (401/403 mean a setup problem). */
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'GenerationError';
    this.status = status;
  }
}

/** The subset of the Anthropic client used here, so tests can inject a fake. */
export interface MessagesStreamClient {
  beta: {
    messages: {
      stream(params: BetaMessageStreamParams): { finalMessage(): Promise<BetaMessage> };
    };
  };
}

export interface ClaudeTestGeneratorOptions {
  /** An `Anthropic` instance satisfies this interface. */
  client: MessagesStreamClient;
  model: string;
  maxTokens?: number;
}

export const DEFAULT_MAX_TOKENS = 64_000;
/** Server-side refusal fallback: `fallbacks: "default"` requires this exact beta header. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * Generates a declarative test plan with Claude, grounded in the captured aria
 * snapshots. The plan is data: it is validated here and interpreted by the
 * runner; no model-written code is ever executed.
 */
export class ClaudeTestGenerator implements TestGenerator {
  private readonly client: MessagesStreamClient;

  constructor(private readonly options: ClaudeTestGeneratorOptions) {
    this.client = options.client;
  }

  async generate(input: GenerationInput): Promise<TestPlan> {
    const prompt = buildPlanPrompt(input);
    let message: BetaMessage;
    try {
      // Adaptive thinking is always on for this model; depth is set with effort.
      // No temperature, budget, prefill or forced tool_choice: they are rejected.
      message = await this.client.beta.messages
        .stream({
          model: this.options.model,
          max_tokens: this.options.maxTokens ?? DEFAULT_MAX_TOKENS,
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
          system: [{ type: 'text', text: prompt.system, cache_control: { type: 'ephemeral' } }],
          messages: [{ role: 'user', content: prompt.user }],
          output_config: { effort: 'high', format: { type: 'json_schema', schema: PLAN_OUTPUT_SCHEMA } },
        })
        .finalMessage();
    } catch (error) {
      if (error instanceof GenerationError) throw error;
      const status = (error as { status?: unknown } | null)?.status;
      throw new GenerationError(
        `Claude request failed: ${error instanceof Error ? error.message : String(error)}`,
        typeof status === 'number' ? status : undefined,
      );
    }

    if (message.stop_reason === 'refusal') throw new GenerationError('Claude declined to generate tests (stop_reason: refusal)');
    if (message.stop_reason === 'max_tokens') throw new GenerationError('Claude output was truncated (stop_reason: max_tokens)');

    const text = message.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('')
      .trim();
    if (text === '') throw new GenerationError(`Claude returned no text output (stop_reason: ${String(message.stop_reason)})`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new GenerationError('Claude output is not valid JSON');
    }
    try {
      return validateTestPlan(toDomainPlan(parsed), input.ticket, input.policy);
    } catch (error) {
      if (error instanceof PlanValidationError) throw new GenerationError(error.message);
      throw error;
    }
  }
}
