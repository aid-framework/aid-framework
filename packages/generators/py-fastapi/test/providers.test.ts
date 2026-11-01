/**
 * Provider selection, end to end through the spec and the planner.
 *
 * The interesting property is not "the adapter is wired" but the pair that makes the
 * wiring trustworthy: a provider the adapters serve plans, and a provider nothing
 * serves is refused before an unrunnable app is written. `anthropic` is the case that
 * changed -- the gate that used to refuse it now accepts it -- so it is the one the
 * positive tests use.
 */

import { SERVED_PROVIDERS } from '@aid-framework/ir';
import { describe, expect, it } from 'vitest';

import { modelCapabilities, type ProviderAdapter } from '../src/names.js';
import { buildForSpecText, exampleSpecText, fileMap, lowerForSpecText } from './helpers.js';

/**
 * The committed example, with every OpenAI model repointed at Anthropic.
 *
 * Rewriting the example rather than authoring a second spec keeps the fixture honest:
 * the spec that runs in CI is still the one the tests plan.
 */
function anthropicSpecText(): string {
  return exampleSpecText()
    .replaceAll('provider: openai', 'provider: anthropic')
    .replaceAll('modelId: gpt-4o-mini', 'modelId: claude-3-5-sonnet-latest')
    .replaceAll('apiKeyEnv: OPENAI_API_KEY', 'apiKeyEnv: ANTHROPIC_API_KEY');
}

function files(source = anthropicSpecText()): Map<string, string> {
  return fileMap(buildForSpecText(source).plan.files);
}

describe('provider selection', () => {
  it('serves anthropic alongside openai and the deterministic fake', () => {
    expect([...SERVED_PROVIDERS].sort()).toEqual(
      ['anthropic', 'fake', 'openai', 'openai-compatible'].sort(),
    );
  });

  it('plans a model whose provider is anthropic', () => {
    // This is the regression that matters: before the adapter existed, this spec was
    // refused by the normalize gate with `providerUnsupported`.
    const spec = anthropicSpecText();
    const ir = lowerForSpecText(spec);

    expect(ir.models.find((model) => model.id === 'fast')?.provider).toBe('anthropic');
    expect(buildForSpecText(spec).plan.files.length).toBeGreaterThan(0);
  });

  it('emits the anthropic adapter with the key variable the spec names', () => {
    const models = files().get('app/generated/gateway/models.py');
    expect(models).toBeDefined();
    expect(models).toContain('"anthropic": AnthropicProvider(');
    expect(models).toContain('name="anthropic"');
    expect(models).toContain('api_key=os.environ.get("ANTHROPIC_API_KEY")');
    expect(models).not.toContain('OpenAICompatibleProvider(');
  });

  it('imports the adapter from the runtime instead of defining one', () => {
    const models = files().get('app/generated/gateway/models.py');
    expect(models).toContain('AnthropicProvider');
    // The generated module is a table of pinned models; adapters come from the runtime.
    expect(models).not.toContain('class AnthropicProvider');
  });

  it('refuses a provider no adapter serves, naming the ones that ship', () => {
    // `bedrock` is in the IR's wider vocabulary but the spec layer refuses it first,
    // which is the right order: a caller learns the closed set before the IR is built.
    const spec = exampleSpecText().replaceAll('provider: openai', 'provider: bedrock');

    expect(() => lowerForSpecText(spec)).toThrow(/must be one of/);
    expect(() => lowerForSpecText(spec)).toThrow(/anthropic/);
  });
});

describe('adapter capabilities', () => {
  it('drops embeddings for anthropic instead of advertising an endpoint that does not exist', () => {
    const reported = modelCapabilities('AnthropicProvider' as ProviderAdapter, [
      'embeddings',
      'json-schema',
      'tool-calling',
      'streaming',
    ]);

    expect(reported.advertised).toEqual([
      'Capability.STREAMING',
      'Capability.STRUCTURED_OUTPUT',
      'Capability.TOOL_CALLING',
    ]);
    expect(reported.dropped).toEqual(['embeddings']);
  });

  it('keeps embeddings for the openai-compatible adapter, which does have the endpoint', () => {
    const reported = modelCapabilities('OpenAICompatibleProvider' as ProviderAdapter, [
      'embeddings',
    ]);

    expect(reported.advertised).toEqual(['Capability.EMBEDDINGS']);
    expect(reported.dropped).toEqual([]);
  });

  it('refuses an anthropic model that declares embeddings instead of planning one', () => {
    // Omitting `EMBEDDINGS` from the adapter table only keeps the pinned spec honest.
    // It does not stop the IR from deriving an embedding entry from the declared
    // capability, and `embedder_for` picks the OpenAI wire for every non-fake provider,
    // so without this refusal the app would POST to an endpoint Anthropic does not have.
    const spec = anthropicSpecText().replace(
      '    capabilities: [json-schema, tools, streaming]',
      '    capabilities: [json-schema, tools, streaming, embeddings]',
    );

    expect(() => buildForSpecText(spec)).toThrow(/unsupported-capability/);
    expect(() => buildForSpecText(spec)).toThrow(/embeddings endpoint/);
  });

  it('still plans an embeddings model on a provider that serves the endpoint', () => {
    const spec = exampleSpecText().replace(
      '  embed:\n    provider: fake\n    modelId: text-embedding-3-small',
      '  embed:\n    provider: openai\n    modelId: text-embedding-3-small\n    apiKeyEnv: OPENAI_API_KEY',
    );

    expect(() => buildForSpecText(spec)).not.toThrow();
  });

  it('does not advertise embeddings on the pinned anthropic model', () => {
    const models = files().get('app/generated/gateway/models.py') ?? '';
    const pinned = aliasBlock(models, 'fast');

    expect(pinned).toContain('provider="anthropic"');
    expect(pinned).toContain('Capability.TOOL_CALLING');
    // The fake embedder in the same table still advertises embeddings; only the
    // Anthropic entry must not, because the Messages API has no such endpoint.
    expect(pinned).not.toContain('Capability.EMBEDDINGS');
  });
});

/** One alias's entry in `ALIASES`, which the emitter writes four spaces deep. */
function aliasBlock(models: string, alias: string): string {
  const head = `    "${alias}": ModelSpec(`;
  const start = models.indexOf(head);
  if (start === -1) throw new Error(`alias ${alias} is not pinned in models.py`);
  const end = models.indexOf('\n    ),', start + head.length);
  if (end === -1) throw new Error(`alias ${alias} has no closing entry`);
  return models.slice(start, end);
}
