/**
 * Provider selection on the TypeScript target.
 *
 * The regression this file exists for is the seam, not the adapter: `providerAdapter`
 * used to know only `fake` and the OpenAI-compatible wire, so a spec asking for
 * `anthropic` or `bedrock` either lost its adapter or was refused. Both now resolve,
 * and each one has to emit the constructor its protocol needs -- the Messages
 * adapter is keyed, the Converse adapter is not.
 */

import { SERVED_PROVIDERS } from '@aid-framework/ir';
import { describe, expect, it } from 'vitest';

import { buildForSpecText, exampleSpecText, fileMap } from './helpers.js';

const MODELS = 'app/generated/gateway/models.ts';

/** The committed example, with the primary model repointed at Anthropic. */
function anthropicSpecText(): string {
  return exampleSpecText()
    .replaceAll('provider: openai', 'provider: anthropic')
    .replaceAll('modelId: gpt-4o-mini', 'modelId: claude-3-5-sonnet-latest')
    .replaceAll('apiKeyEnv: OPENAI_API_KEY', 'apiKeyEnv: ANTHROPIC_API_KEY')
    .replaceAll('costProfile: openai-gpt-4o-mini', 'costProfile: anthropic-claude-3-5-sonnet');
}

/**
 * The same example with the primary model on Bedrock.
 *
 * The wire id is catalogued, so the cost gate resolves a profile, and it contains the
 * `:` the adapter percent-encodes in the `/model/{id}/converse` path.
 */
function bedrockSpecText(): string {
  return exampleSpecText()
    .replace(
      '    provider: openai\n    modelId: gpt-4o-mini\n    apiKeyEnv: OPENAI_API_KEY',
      '    provider: bedrock\n    modelId: anthropic.claude-3-5-haiku-20241022-v1:0',
    )
    .replace('    costProfile: openai-gpt-4o-mini', '    costProfile: bedrock-claude-3-5-haiku');
}

function models(source: string): string {
  return fileMap(buildForSpecText(source).plan.files).get(MODELS) ?? '';
}

/** The `defaultProviders()` entry for one provider, up to the line's end. */
function providerEntry(text: string, key: string): string {
  const start = text.indexOf(`\n    ${key}: `);
  if (start === -1) throw new Error(`provider ${key} is not in defaultProviders()`);
  const end = text.indexOf('\n', start + 1);
  return text.slice(start + 1, end === -1 ? undefined : end);
}

describe('provider selection', () => {
  it('serves anthropic and bedrock alongside openai and the deterministic fake', () => {
    expect([...SERVED_PROVIDERS].sort()).toEqual(
      ['anthropic', 'bedrock', 'fake', 'openai', 'openai-compatible'].sort(),
    );
  });

  it('plans an anthropic model and emits the keyed Messages adapter', () => {
    const text = models(anthropicSpecText());

    expect(providerEntry(text, 'anthropic')).toBe(
      "    anthropic: keyedAnthropicProvider('anthropic', 'ANTHROPIC_API_KEY'),",
    );
    expect(text).toContain('function keyedAnthropicProvider(');
    expect(text).toMatch(/import \{[^}]*AnthropicProvider/u);
    // The adapter that only understands the OpenAI wire must not be the one emitted.
    expect(providerEntry(text, 'anthropic')).not.toContain('OpenAICompatibleProvider');
  });

  it('plans a bedrock model and emits the unkeyed Converse adapter', () => {
    const text = models(bedrockSpecText());

    expect(providerEntry(text, 'bedrock')).toBe(
      "    bedrock: new BedrockProvider({ name: 'bedrock' }),",
    );
    expect(text).toMatch(/import \{[^}]*BedrockProvider/u);
    // Converse authenticates with the execution role, so the entry carries no credential.
    expect(providerEntry(text, 'bedrock')).not.toContain('apiKey');
    expect(text).not.toContain('keyedBedrockProvider');
  });

  it('keeps the OpenAI-compatible adapter for the openai spelling', () => {
    const text = models(exampleSpecText());

    expect(providerEntry(text, 'openai')).toBe(
      "    openai: keyedProvider('openai', 'OPENAI_API_KEY'),",
    );
    expect(text).not.toContain('BedrockProvider');
    expect(text).not.toContain('AnthropicProvider');
  });

  it('refuses a provider no adapter serves, naming the ones that ship', () => {
    // The spec layer refuses it first, which is the right order: a caller learns the
    // closed set before an IR is built, and the message names the whole set.
    const spec = exampleSpecText().replaceAll('provider: openai', 'provider: google');

    expect(() => buildForSpecText(spec)).toThrow(/must be one of/u);
    expect(() => buildForSpecText(spec)).toThrow(/bedrock/u);
  });
});

describe('adapter capabilities', () => {
  it('refuses bedrock streaming rather than advertising a frame it cannot decode', () => {
    const spec = bedrockSpecText().replace(
      'capabilities: [json-schema, tools]',
      'capabilities: [json-schema, tools, streaming]',
    );

    expect(() => buildForSpecText(spec)).toThrow(/model-capability-unsupported/u);
    expect(() => buildForSpecText(spec)).toThrow(/BedrockProvider/u);
  });

  it('refuses bedrock embeddings, which Converse has no endpoint for', () => {
    const spec = bedrockSpecText().replace(
      'capabilities: [json-schema, tools]',
      'capabilities: [json-schema, tools, embeddings]',
    );

    expect(() => buildForSpecText(spec)).toThrow(/model-capability-unsupported/u);
  });
});
