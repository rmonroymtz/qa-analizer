import type { BetaMessage, BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { Ticket } from '../../domain/ticket.js';
import type { GeneratedSuite, GenerationInput, TestGenerator } from '../../ports/test-generator.js';
import { buildGenerationPrompt, GENERATION_OUTPUT_SCHEMA } from './generation-prompt.js';

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

const FIXTURES_IMPORT_LINE = /^\s*import\s*\{\s*test\s*,\s*expect\s*\}\s*from\s*(['"])\.\/qa-fixtures\1\s*;?\s*$/;
const FORBIDDEN_TOKENS = ['require(', 'child_process', 'process.env'];
/**
 * Modifiers that change what a passing run means (`fail`, `fixme`) or silently
 * drop other tests (`only`), including the `test.describe.*` variants.
 */
const FORBIDDEN_MODIFIER = /\btest\s*(?:\.\s*describe\s*)?\.\s*(fail|fixme|only)\b/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function entries<K extends string>(value: unknown, field: string, keys: readonly K[]): Record<K, string>[] {
  if (!Array.isArray(value)) throw new GenerationError(`Generated suite: "${field}" must be an array`);
  return value.map((item, index) => {
    if (!isRecord(item) || keys.some((key) => typeof item[key] !== 'string')) {
      throw new GenerationError(`Generated suite: ${field}[${index}] must have string fields ${keys.join(', ')}`);
    }
    return Object.fromEntries(keys.map((key) => [key, item[key] as string])) as Record<K, string>;
  });
}

/** Minimal static safety check on AI-generated code before it is executed. */
function checkSpecSafety(specCode: string): void {
  for (const token of FORBIDDEN_TOKENS) {
    if (specCode.includes(token)) throw new GenerationError(`Generated spec rejected: it contains "${token}"`);
  }
  const modifier = specCode.match(FORBIDDEN_MODIFIER);
  if (modifier) throw new GenerationError(`Generated spec rejected: it uses test.${modifier[1]}`);
  if (/\bimport\s*\(/.test(specCode)) throw new GenerationError('Generated spec rejected: it contains a dynamic import()');
  const importLines = specCode.split('\n').filter((line) => /^\s*import\b/.test(line));
  const foreign = importLines.find((line) => !FIXTURES_IMPORT_LINE.test(line));
  if (foreign !== undefined) throw new GenerationError(`Generated spec rejected: only the qa-fixtures import is allowed, found "${foreign.trim()}"`);
  if (importLines.length === 0) throw new GenerationError('Generated spec rejected: it must import { test, expect } from ./qa-fixtures');
}

/**
 * Checks the parsed model output: shape, criterion coverage (every id accounted
 * for exactly once across `criteria` and `uncoverable`, no unknown ids) and the
 * static safety rules.
 */
export function validateGeneratedSuite(raw: unknown, ticket: Ticket): GeneratedSuite {
  if (!isRecord(raw)) throw new GenerationError('Generated suite must be a JSON object');
  if (typeof raw.specCode !== 'string' || raw.specCode.trim() === '') {
    throw new GenerationError('Generated suite: "specCode" must be a non-empty string');
  }
  const criteria = entries(raw.criteria, 'criteria', ['criterionId', 'testTitle'] as const);
  const uncoverable = entries(raw.uncoverable, 'uncoverable', ['criterionId', 'reason'] as const);

  const known = new Set(ticket.acceptanceCriteria.map((criterion) => criterion.id));
  const mentioned = [...criteria, ...uncoverable].map((entry) => entry.criterionId);
  // Each criterion is either tested or uncoverable, exactly once.
  const duplicates = [...new Set(mentioned.filter((id, index) => mentioned.indexOf(id) !== index))];
  if (duplicates.length > 0) throw new GenerationError(`Generated suite has duplicate criterion ids: ${duplicates.join(', ')}`);
  const unknown = mentioned.filter((id) => !known.has(id));
  if (unknown.length > 0) throw new GenerationError(`Generated suite references unknown criteria: ${[...new Set(unknown)].join(', ')}`);
  const missing = [...known].filter((id) => !mentioned.includes(id));
  if (missing.length > 0) throw new GenerationError(`Generated suite does not account for criteria: ${missing.join(', ')}`);

  checkSpecSafety(raw.specCode);
  return { specCode: raw.specCode, criteria, uncoverable };
}

/** Generates a Playwright spec with Claude, grounded in the captured aria snapshots. */
export class ClaudeTestGenerator implements TestGenerator {
  private readonly client: MessagesStreamClient;

  constructor(private readonly options: ClaudeTestGeneratorOptions) {
    this.client = options.client;
  }

  async generate(input: GenerationInput): Promise<GeneratedSuite> {
    const prompt = buildGenerationPrompt(input);
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
          output_config: { effort: 'high', format: { type: 'json_schema', schema: GENERATION_OUTPUT_SCHEMA } },
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
    return validateGeneratedSuite(parsed, input.ticket);
  }
}
