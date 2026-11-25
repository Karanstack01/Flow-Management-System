/**
 * Claude for AI reports (Settings › Connections › Anthropic). One plain Messages API call per
 * report: a fixed system prompt, the admin's prompt and a compact table of records.
 */
import Anthropic from '@anthropic-ai/sdk';
import type { AnthropicConfig, AnthropicSecrets } from '@fms/core';

export class AiError extends Error {
  /** Worth trying again later (rate limit, overload, network). */
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface AiAnswer {
  text: string;
  /** The model that wrote the answer (a fallback model when the first one declined). */
  model: string;
  /** The answer hit the length limit. */
  truncated: boolean;
}

/** Models with server-side refusal fallbacks (Claude Haiku 5.5 has none). */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

export async function askClaude(conn: { config: AnthropicConfig; secrets: AnthropicSecrets }, req: { system: string; prompt: string; maxTokens?: number }): Promise<AiAnswer> {
  const client = new Anthropic({ apiKey: conn.secrets.apiKey, maxRetries: 2 });
  try {
    const response = await client.beta.messages.create({
      model: conn.config.model,
      max_tokens: req.maxTokens ?? 16000,
      // If the model declines on a safety policy, the API retries on a fallback model in the same call.
      ...(FALLBACK_MODELS.has(conn.config.model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
      output_config: { effort: conn.config.effort },
      system: req.system,
      messages: [{ role: 'user', content: req.prompt }],
    });
    if (response.stop_reason === 'refusal') {
      const why = response.stop_details?.explanation || response.stop_details?.category;
      throw new AiError(`The AI declined to answer${why ? ` (${why})` : ''}. Rephrase the prompt or send fewer fields.`, false);
    }
    const text = response.content
      .flatMap((b) => (b.type === 'text' ? [b.text] : []))
      .join('\n')
      .trim();
    if (!text) throw new AiError('The AI returned an empty answer', true);
    return { text, model: response.model, truncated: response.stop_reason === 'max_tokens' };
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (e instanceof Anthropic.AuthenticationError) throw new AiError('Anthropic refused the API key — check it in Settings › Connections', false);
    if (e instanceof Anthropic.PermissionDeniedError) throw new AiError(`Anthropic: this key may not use ${conn.config.model}`, false);
    if (e instanceof Anthropic.BadRequestError) throw new AiError(`Anthropic rejected the request: ${e.message}`, false);
    if (e instanceof Anthropic.RateLimitError) throw new AiError('Anthropic rate limit reached — the report is tried again later', true);
    if (e instanceof Anthropic.APIError) throw new AiError(`Anthropic error ${e.status ?? ''}: ${e.message}`, (e.status ?? 500) >= 500);
    throw new AiError(`Could not reach Anthropic: ${(e as Error).message}`, true);
  }
}
