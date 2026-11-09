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

function files(source: string): Map<string, string> {
  return fileMap(buildForSpecText(source).plan.files);
}

function models(source: string): string {
  return files(source).get(MODELS) ?? '';
}

/**
 * The example repointed at Vertex AI.
 *
 * `specVersion` moves to 0.6 because that is the first version whose provider
 * vocabulary includes `google`; the OpenAI key variable moves with the OpenAI provider,
 * because Vertex resolves a bearer token instead.
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

/** The `defaultProviders()` entry for one provider, up to the line's end. */
function providerEntry(text: string, key: string): string {
  const start = text.indexOf(`\n    ${key}: `);
  if (start === -1) throw new Error(`provider ${key} is not in defaultProviders()`);
  const end = text.indexOf('\n', start + 1);
  return text.slice(start + 1, end === -1 ? undefined : end);
}

describe('provider selection', () => {
  it('serves anthropic, bedrock, gemini and google alongside openai and the deterministic fake', () => {
    expect([...SERVED_PROVIDERS].sort()).toEqual(
      ['anthropic', 'bedrock', 'gemini', 'google', 'fake', 'openai', 'openai-compatible'].sort(),
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

  it('plans a google model and emits the unkeyed Vertex adapter', () => {
    const text = models(vertexSpecText());

    expect(providerEntry(text, 'google')).toBe(
      "    google: new VertexProvider({ name: 'google' }),",
    );
    expect(text).toMatch(/import \{[^}]*VertexProvider/u);
    // Vertex authenticates with a bearer token, so the entry carries no credential.
    expect(providerEntry(text, 'google')).not.toContain('apiKey');
    expect(text).not.toContain('keyedVertexProvider');
  });

  it('plans a gemini model and emits the keyed Gemini adapter', () => {
    const text = models(geminiSpecText());

    expect(providerEntry(text, 'gemini')).toBe(
      "    gemini: keyedGeminiProvider('gemini', 'GEMINI_API_KEY'),",
    );
    expect(text).toMatch(/import \{[^}]*GeminiProvider/u);
    expect(text).toContain('function keyedGeminiProvider(');
    expect(text).not.toContain('VertexProvider');
  });

  it('refuses a provider outside the spec vocabulary, naming the ones that ship', () => {
    // The spec layer refuses it first, which is the right order: a caller learns the
    // closed set before an IR is built, and the message names the whole set.
    const spec = exampleSpecText().replaceAll('provider: openai', 'provider: azure');

    expect(() => buildForSpecText(spec)).toThrow(/must be one of/u);
    expect(() => buildForSpecText(spec)).toThrow(/google/u);
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

  it('advertises bedrock embeddings, which InvokeModel serves', () => {
    const spec = bedrockSpecText().replace(
      'capabilities: [json-schema, tools]',
      'capabilities: [json-schema, tools, embeddings]',
    );

    expect(models(spec)).toMatch(/capabilities: \[[^\]]*'embeddings'/u);
  });

  it('refuses Vertex streaming, which this target cannot carry', () => {
    // Python's adapter decodes Vertex SSE; the TypeScript provider seam is
    // request/response only, so the target must not advertise what it cannot frame.
    const spec = vertexSpecText().replace(
      'capabilities: [json-schema, tools]',
      'capabilities: [json-schema, tools, streaming]',
    );

    expect(() => buildForSpecText(spec)).toThrow(/model-capability-unsupported/u);
    expect(() => buildForSpecText(spec)).toThrow(/VertexProvider/u);
  });

  it('advertises Vertex embeddings, which :predict serves', () => {
    const spec = vertexSpecText().replace(
      'capabilities: [json-schema, tools]',
      'capabilities: [json-schema, tools, embeddings]',
    );

    expect(models(spec)).toMatch(/capabilities: \[[^\]]*'embeddings'/u);
  });

  it('refuses gemini streaming, which this target cannot carry', () => {
    const spec = geminiSpecText().replace(
      'capabilities: [json-schema, tools]',
      'capabilities: [json-schema, tools, streaming]',
    );

    expect(() => buildForSpecText(spec)).toThrow(/model-capability-unsupported/u);
    expect(() => buildForSpecText(spec)).toThrow(/GeminiProvider/u);
  });

  it('advertises gemini embeddings, which :batchEmbedContents serves', () => {
    // `GeminiEmbedder` answers on `:batchEmbedContents` with the same key the chat
    // adapter uses, so the capability is real even though `GeminiProvider` itself
    // never issues the call.
    const spec = geminiSpecText().replace(
      'capabilities: [json-schema, tools]',
      'capabilities: [json-schema, tools, embeddings]',
    );

    expect(models(spec)).toMatch(/capabilities: \[[^\]]*'embeddings'/u);
  });
});

/**
 * Swapping the adapter must not change the shape of the app.
 *
 * Three files may move, and each for a reason: `models.ts` resolves the adapter,
 * `agents.ts` carries the model's identity and cost, and `evals.yml` preflights a
 * credential only when the spec named one -- Vertex and Converse resolve theirs from
 * the environment or the execution role, so there is no secret name to check.
 */
function differingFiles(left: Map<string, string>, right: Map<string, string>): string[] {
  const keys = new Set([...left.keys(), ...right.keys()]);
  return [...keys].filter((key) => left.get(key) !== right.get(key)).sort();
}

describe('provider conformance', () => {
  it('moves only the model identity and the credential preflight, never the pipeline', () => {
    const openai = files(exampleSpecText());
    const openaiWorkflow = openai.get('.github/workflows/evals.yml') ?? '';
    expect(openaiWorkflow).toContain('id: creds');

    const cases = [
      { spec: vertexSpecText(), notice: 'Application Default Credentials' },
      { spec: bedrockSpecText(), notice: 'AWS SDK chain' },
    ];
    for (const { spec, notice } of cases) {
      const other = files(spec);
      expect(differingFiles(openai, other)).toEqual([
        '.github/workflows/evals.yml',
        'app/generated/agents.ts',
        'app/generated/gateway/models.ts',
      ]);

      // `agents.ts` is the same file with a different model: the line count is
      // unchanged and exactly the identity, wire id, and cost lines move.
      const agents = (source: Map<string, string>) =>
        (source.get('app/generated/agents.ts') ?? '').split('\n');
      const before = agents(openai);
      const after = agents(other);
      expect(after).toHaveLength(before.length);
      const moved = before.filter((line, index) => line !== after[index]);
      expect(moved).toHaveLength(3);
      expect(moved.join('\n')).toMatch(/costProfile|modelId|provider/u);

      // A keyless provider has no variable to probe, so the credential check becomes a
      // notice naming the ambient credential the run needs.
      const workflow = other.get('.github/workflows/evals.yml') ?? '';
      expect(workflow).toContain('::notice::');
      expect(workflow).toContain(notice);
      expect(workflow).not.toContain('id: creds');
    }
  });
});

describe('gemini credential preflight', () => {
  it('preflights the variable the spec named, because the provider is keyed', () => {
    const gemini = files(geminiSpecText());
    const workflow = gemini.get('.github/workflows/evals.yml') ?? '';

    expect(workflow).toContain('id: creds');
    expect(workflow).toContain('GEMINI_API_KEY');
    expect(workflow).not.toContain('::notice::');
    expect(differingFiles(files(exampleSpecText()), gemini)).toEqual([
      '.github/workflows/evals.yml',
      'app/generated/agents.ts',
      'app/generated/gateway/models.ts',
    ]);
  });
});
