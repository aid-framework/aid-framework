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
  it('serves anthropic, bedrock, gemini and google alongside openai and the deterministic fake', () => {
    expect([...SERVED_PROVIDERS].sort()).toEqual(
      ['anthropic', 'bedrock', 'gemini', 'google', 'fake', 'openai', 'openai-compatible'].sort(),
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

  it('refuses a provider outside the spec vocabulary, naming the ones that ship', () => {
    // `azure` and `ollama` are in the IR's wider vocabulary but the spec layer refuses
    // them first, which is the right order: a caller learns the closed set before the
    // IR is built, and the message lists every spelling the adapter set serves.
    const spec = exampleSpecText().replaceAll('provider: openai', 'provider: azure');

    expect(() => lowerForSpecText(spec)).toThrow(/must be one of/);
    expect(() => lowerForSpecText(spec)).toThrow(/anthropic/);
    expect(() => lowerForSpecText(spec)).toThrow(/google/);
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

/**
 * The committed example, with the primary model repointed at Bedrock.
 *
 * The wire id is one the catalog prices, so the cost gate resolves a real profile
 * instead of an unpriced model, and it contains the `:` the adapter percent-encodes
 * in the `/model/{id}/converse` path.
 */
function bedrockSpecText(): string {
  return exampleSpecText()
    .replace(
      '    provider: openai\n    modelId: gpt-4o-mini\n    apiKeyEnv: OPENAI_API_KEY',
      '    provider: bedrock\n    modelId: anthropic.claude-3-5-haiku-20241022-v1:0',
    )
    .replace('    costProfile: openai-gpt-4o-mini', '    costProfile: bedrock-claude-3-5-haiku');
}

describe('bedrock provider', () => {
  it('plans a bedrock model that names no api key variable', () => {
    const spec = bedrockSpecText();
    const fast = lowerForSpecText(spec).models.find((model) => model.id === 'fast');

    expect(fast?.provider).toBe('bedrock');
    expect(fast?.apiKeyEnv).toBeUndefined();
    expect(buildForSpecText(spec).plan.files.length).toBeGreaterThan(0);
  });

  it('emits the Converse adapter with a name and no credential argument', () => {
    const models = files(bedrockSpecText()).get('app/generated/gateway/models.py') ?? '';

    expect(models).toContain('"bedrock": BedrockProvider(');
    expect(models).toContain('name="bedrock"');
    // `BedrockProvider` takes no `api_key`; passing one would be a TypeError at import.
    const start = models.indexOf('"bedrock": BedrockProvider(');
    expect(models.slice(start, models.indexOf('),', start))).not.toContain('api_key');
    // The example's second openai model still resolves to the OpenAI wire, so the bedrock
    // entry above is not the whole provider map.
    expect(models).toContain('"openai": OpenAICompatibleProvider(');
  });

  it('imports the adapter from the runtime', () => {
    const models = files(bedrockSpecText()).get('app/generated/gateway/models.py') ?? '';

    expect(models).toMatch(/from aid_runtime import \([^)]*BedrockProvider/);
    expect(models).not.toContain('class BedrockProvider');
  });

  it('advertises the streaming it decodes from the event stream', () => {
    const models = files(bedrockSpecText()).get('app/generated/gateway/models.py') ?? '';
    const pinned = aliasBlock(models, 'fast');

    expect(pinned).toContain('Capability.STRUCTURED_OUTPUT');
    expect(pinned).toContain('Capability.TOOL_CALLING');
    expect(pinned).toContain('Capability.STREAMING');
  });

  it('plans a streaming deployment instead of refusing it', () => {
    // `/converse-stream` is a binary event stream, which the runtime adapter decodes and
    // checksums, so a Bedrock-pinned model advertises `STREAMING` and the emitted route's
    // `gateway.stream()` call is served rather than raising on the first request.
    expect(buildForSpecText(bedrockSpecText()).plan.files.length).toBeGreaterThan(0);
    expect(() => buildForSpecText(bedrockSpecText())).not.toThrow(/unsupported-streaming/);
  });

  it('advertises the embeddings Titan serves over InvokeModel', () => {
    const spec = bedrockSpecText().replace(
      '    capabilities: [json-schema, tools, streaming]',
      '    capabilities: [json-schema, tools, embeddings]',
    );

    const models = files(spec).get('app/generated/gateway/models.py') ?? '';
    expect(aliasBlock(models, 'fast')).toContain('Capability.EMBEDDINGS');
  });
});

/**
 * The example repointed at Vertex AI.
 *
 * Two edits are not rewrites of the models block: `specVersion` has to move to 0.6
 * because that is the first version whose provider vocabulary includes `google`, and
 * the OpenAI key variable goes with the OpenAI provider -- Vertex resolves a bearer
 * token from the environment or the metadata server instead.
 */
function vertexSpecText(): string {
  return exampleSpecText()
    .replace('specVersion: "0.2"', 'specVersion: "0.6"')
    .replace(
      '    provider: openai\n    modelId: gpt-4o-mini\n    apiKeyEnv: OPENAI_API_KEY',
      '    provider: google\n    modelId: gemini-2.5-flash',
    )
    .replace('    costProfile: openai-gpt-4o-mini', '    costProfile: google-gemini-2-5-flash');
}

describe('google provider', () => {
  it('plans a Vertex model that names no api key variable', () => {
    const spec = vertexSpecText();
    const fast = lowerForSpecText(spec).models.find((model) => model.id === 'fast');

    expect(fast?.provider).toBe('google');
    expect(fast?.apiKeyEnv).toBeUndefined();
    expect(buildForSpecText(spec).plan.files.length).toBeGreaterThan(0);
  });

  it('emits the Vertex adapter with a name and no credential argument', () => {
    const models = files(vertexSpecText()).get('app/generated/gateway/models.py') ?? '';

    expect(models).toContain('"google": VertexProvider(');
    expect(models).toContain('name="google"');
    // `VertexProvider` takes no `api_key`; a key read from the spec would be a
    // credential the app carried but never used.
    const start = models.indexOf('"google": VertexProvider(');
    expect(models.slice(start, models.indexOf('),', start))).not.toContain('api_key');
  });

  it('imports the adapter from the runtime', () => {
    const models = files(vertexSpecText()).get('app/generated/gateway/models.py') ?? '';

    expect(models).toMatch(/from aid_runtime import \([^)]*VertexProvider/);
    expect(models).not.toContain('class VertexProvider');
  });

  it('advertises streaming, because the Vertex adapter decodes SSE', () => {
    const models = files(vertexSpecText()).get('app/generated/gateway/models.py') ?? '';
    const pinned = aliasBlock(models, 'fast');

    expect(pinned).toContain('Capability.STREAMING');
    expect(pinned).toContain('Capability.STRUCTURED_OUTPUT');
    expect(pinned).toContain('Capability.TOOL_CALLING');
  });

  it('advertises the embeddings Vertex serves over :predict', () => {
    const spec = vertexSpecText().replace(
      '    capabilities: [json-schema, tools, streaming]',
      '    capabilities: [json-schema, tools, embeddings]',
    );

    const models = files(spec).get('app/generated/gateway/models.py') ?? '';
    expect(aliasBlock(models, 'fast')).toContain('Capability.EMBEDDINGS');
  });
});

/**
 * The example repointed at the Gemini API.
 *
 * `specVersion` moves to 0.10 because that is the first version whose provider
 * vocabulary includes `gemini`. Unlike Vertex, this provider authenticates with an API
 * key, so the key variable travels with it.
 */
function geminiSpecText(): string {
  return exampleSpecText()
    .replace('specVersion: "0.2"', 'specVersion: "0.10"')
    .replace(
      '    provider: openai\n    modelId: gpt-4o-mini\n    apiKeyEnv: OPENAI_API_KEY',
      '    provider: gemini\n    modelId: gemini-2.5-flash\n    apiKeyEnv: GEMINI_API_KEY',
    )
    .replace('    costProfile: openai-gpt-4o-mini', '    costProfile: google-gemini-2-5-flash');
}

describe('gemini provider', () => {
  it('plans a Gemini model that keeps the api key variable', () => {
    const spec = geminiSpecText();
    const fast = lowerForSpecText(spec).models.find((model) => model.id === 'fast');

    expect(fast?.provider).toBe('gemini');
    expect(fast?.apiKeyEnv).toBe('GEMINI_API_KEY');
    expect(buildForSpecText(spec).plan.files.length).toBeGreaterThan(0);
  });

  it('emits the Gemini adapter with the key variable the spec names', () => {
    const models = files(geminiSpecText()).get('app/generated/gateway/models.py') ?? '';

    expect(models).toContain('"gemini": GeminiProvider(');
    expect(models).toContain('name="gemini"');
    expect(models).toContain('api_key=os.environ.get("GEMINI_API_KEY")');
    expect(models).not.toContain('VertexProvider');
  });

  it('imports the adapter from the runtime', () => {
    const models = files(geminiSpecText()).get('app/generated/gateway/models.py') ?? '';

    expect(models).toMatch(/from aid_runtime import \([^)]*GeminiProvider/);
    expect(models).not.toContain('class GeminiProvider');
  });

  it('advertises streaming, because the Gemini adapter decodes SSE', () => {
    const models = files(geminiSpecText()).get('app/generated/gateway/models.py') ?? '';
    const pinned = aliasBlock(models, 'fast');

    expect(pinned).toContain('Capability.STREAMING');
    expect(pinned).toContain('Capability.STRUCTURED_OUTPUT');
    expect(pinned).toContain('Capability.TOOL_CALLING');
  });

  it('serves embeddings through the Gemini embedding endpoint', () => {
    const spec = geminiSpecText()
      .replace(
        '    provider: fake\n    modelId: text-embedding-3-small\n    capabilities: [embeddings]',
        [
          '    provider: gemini',
          '    modelId: gemini-embedding-001',
          '    apiKeyEnv: GEMINI_API_KEY',
          '    capabilities: [embeddings]',
          '    costProfile: gemini-gemini-embedding-001',
        ].join('\n'),
      )
      .replace('    dimensions: 1536', '    dimensions: 3072');

    const models = files(spec).get('app/generated/gateway/models.py') ?? '';
    expect(aliasBlock(models, 'embed')).toContain('Capability.EMBEDDINGS');

    const bindings = files(spec).get('app/generated/retrieval/bindings.py') ?? '';
    expect(bindings).toContain('gemini-embedding-001');
    expect(bindings).toContain('3072');
  });
});

/**
 * Swapping the adapter must not change the shape of the app.
 *
 * The provider the spec names reaches the gateway models table that resolves it, and -- only
 * when the spec declares an `agent:` eval -- that eval's module, because an offline recording
 * is keyed by provider and the module names the credential each provider needs to record one.
 * Everything else -- pipelines, tools, prompts, retrieval, HTTP, Docker -- is derived from the
 * spec's business declarations and is indifferent to the wire protocol. One further file moves
 * only when the adapter changes what the app can do: the `observability.py` reconciliation
 * records served capabilities, not declared ones.
 */
function differingFiles(left: Map<string, string>, right: Map<string, string>): string[] {
  const keys = new Set([...left.keys(), ...right.keys()]);
  return [...keys].filter((key) => left.get(key) !== right.get(key)).sort();
}

describe('provider conformance', () => {
  it('moves only the models table when the provider changes', () => {
    const openai = files(exampleSpecText());
    const vertex = files(vertexSpecText());

    // Vertex and OpenAI serve the same capability set for this spec, so even the
    // reconciliation is byte-identical.
    expect(differingFiles(openai, vertex)).toEqual([
      'app/generated/evals/refund_trajectory.py',
      'app/generated/gateway/models.py',
    ]);
  });

  it('moves only the models table and the credential preflight for Gemini', () => {
    // Gemini is keyed like OpenAI, so the eval workflow's credential probe follows the
    // spec-named variable. No other file moves: the served capability set is the same.
    expect(differingFiles(files(exampleSpecText()), files(geminiSpecText()))).toEqual([
      '.github/workflows/evals.yml',
      'app/generated/evals/refund_trajectory.py',
      'app/generated/gateway/models.py',
    ]);
  });

  it('wires the declared stream for the pinned alias instead of recording a shortfall', () => {
    // The adapter decodes `/converse-stream`, so no declared capability is dropped: the
    // pinned alias' wired set is the declaration, `streaming` included.
    const observability = files(bedrockSpecText()).get('app/generated/observability.py') ?? '';
    // The report wraps once it outgrows the line budget, so the two halves are asserted
    // by shape rather than by pinning one layout.
    const models = observability.slice(
      observability.indexOf('"models":'),
      observability.indexOf('"observability":'),
    );

    expect(models).toContain('"Capability.STREAMING"');
    const unrepresentable = models.slice(models.indexOf('"unrepresentable":'));
    expect(unrepresentable).toContain('"fast": []');
    expect(unrepresentable).not.toContain('Capability.STREAMING');
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
