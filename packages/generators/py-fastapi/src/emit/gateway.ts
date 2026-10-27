/**
 * `app/generated/gateway/`: provider construction, model pinning, and the gateway.
 *
 * Every model in the IR becomes one *alias* in the runtime's gateway, and the alias's
 * `ModelSpec` is the pin: the wire model id, the provider key it is served from, the
 * per-1k cost the runtime's ledger charges, the context window, the output cap and the
 * capability set the runtime can negotiate against.
 *
 * Two of those are translations rather than copies, and both matter:
 *
 * - The IR prices per **million** tokens and the runtime per **thousand**, so a cost
 *   is divided exactly once, here.
 * - The IR's capability names are its own vocabulary and the runtime's are four
 *   members, so a pinned model advertises the *intersection*: a spec can declare
 *   `vision` without the generated app claiming it can see.
 */

import type { IR, ModelShape } from '@aid/ir';

import { modelCapabilities, providerAdapter } from '../names.js';
import { INDENT, MAX_LINE, pythonNumber, pythonString } from '../python.js';
import { assemble, dictBlock, HEADER, importFrom, tupleLiteral } from '../template.js';
import type { EmittedFile } from './file.js';
import { GENERATED_ROOT, generated } from './file.js';
import { orderedModels } from './order.js';
import { pythonDoc } from './text.js';

export const GATEWAY_INIT_PATH = `${GENERATED_ROOT}/gateway/__init__.py`;
export const GATEWAY_MODELS_PATH = `${GENERATED_ROOT}/gateway/models.py`;

/** The output cap used when a spec declares none; the runtime requires a positive one. */
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;

/**
 * The runtime prices per 1k tokens and the IR per 1M, so this is the one conversion.
 *
 * The result is rounded to twelve significant digits before it is spelled out: the
 * division is exact for some inputs and not for others, and a shortest-round-trip
 * rendering of the inexact ones (`0.00030000000000000003`) would put a formatting
 * artifact in generated code that a reviewer has to reason about.
 */
export function perThousand(perMillion: number): number {
  return Number((perMillion / 1000).toPrecision(12));
}

export function outputCap(model: ModelShape): number {
  const declared = model.limits.maxOutputTokens;
  const cap = declared === undefined ? DEFAULT_MAX_OUTPUT_TOKENS : declared;
  return Math.min(cap, model.limits.contextTokens);
}

/** Provider keys the IR's models resolve to, in a stable order. */
export function providerKeys(ir: IR): string[] {
  return [...new Set(orderedModels(ir).map((model) => model.provider))].sort();
}

/** The environment variable a provider's key is read from, if the spec names one. */
function apiKeyEnv(ir: IR, provider: string): string | undefined {
  const declared = ir.models
    .filter((model) => model.provider === provider)
    .map((model) => model.apiKeyEnv)
    .filter((name): name is string => name !== undefined);
  return [...new Set(declared)].sort()[0];
}

/**
 * One provider entry: one argument per line, so a long key never joins a keyword.
 *
 * The entry sits inside `return {` in a function body, so it is indented two levels --
 * the key at the dict's own indent, each argument one deeper, the close back at the
 * key. Emitting the arguments on one line instead would produce a line the formatter
 * reflows, and a reflowed file is one whose recorded hash no longer matches.
 */
function providerEntry(ir: IR, provider: string): string {
  const adapter = providerAdapter(provider);
  const env = apiKeyEnv(ir, provider);
  const arguments_: string[] = [];
  if (adapter === 'OpenAICompatibleProvider') {
    arguments_.push(`${INDENT}${INDENT}${INDENT}name=${pythonString(provider)},`);
    if (env !== undefined) {
      arguments_.push(`${INDENT}${INDENT}${INDENT}api_key=os.environ.get(${pythonString(env)}),`);
    }
  }
  const head = `${INDENT}${INDENT}${pythonString(provider)}: ${adapter}(`;
  if (arguments_.length === 0) return `${head}),`;
  return [head, ...arguments_, `${INDENT}${INDENT}),`].join('\n');
}

/**
 * The `capabilities=` argument, wrapped when the member list would overrun the line.
 *
 * A model that gains a capability grows this line, so the long form has to exist
 * rather than be discovered as a lint failure in generated output.
 */
function capabilitiesArgument(members: readonly string[]): string[] {
  const oneLine = `${INDENT}${INDENT}capabilities=frozenset({${members.join(', ')}}),`;
  if (oneLine.length <= MAX_LINE) return [oneLine];
  return [
    `${INDENT}${INDENT}capabilities=frozenset(`,
    `${INDENT}${INDENT}${INDENT}{`,
    ...members.map((member) => `${INDENT}${INDENT}${INDENT}${INDENT}${member},`),
    `${INDENT}${INDENT}${INDENT}}`,
    `${INDENT}${INDENT}),`,
  ];
}

export function emitGatewayModels(ir: IR): EmittedFile {
  const models = orderedModels(ir);
  const providers = providerKeys(ir);

  const aliases: string[] = [];
  for (const model of models) {
    const adapter = providerAdapter(model.provider);
    const advertised =
      adapter === undefined ? [] : modelCapabilities(adapter, model.capabilities ?? []).advertised;
    const cost =
      model.costProfile === undefined
        ? 'CostProfile(input_per_1k_usd=0.0, output_per_1k_usd=0.0)'
        : `CostProfile(input_per_1k_usd=${pythonNumber(perThousand(model.costProfile.inputPerMTok))}, output_per_1k_usd=${pythonNumber(perThousand(model.costProfile.outputPerMTok))})`;
    const members = advertised;
    aliases.push(
      [
        `${INDENT}${pythonString(model.id)}: ModelSpec(`,
        `${INDENT}${INDENT}name=${pythonString(model.modelId)},`,
        `${INDENT}${INDENT}provider=${pythonString(model.provider)},`,
        `${INDENT}${INDENT}cost=${cost},`,
        `${INDENT}${INDENT}context_window=${model.limits.contextTokens},`,
        `${INDENT}${INDENT}max_output_tokens=${outputCap(model)},`,
        ...capabilitiesArgument(members),
        `${INDENT}),`,
      ].join('\n'),
    );
  }

  /* Only aliases that declare one; the step reads `FALLBACKS.get(alias, ())`. */
  const fallbacks = models
    .filter((model) => (model.fallbacks ?? []).length > 0)
    .map((model) => {
      const declared = [...new Set(model.fallbacks ?? [])].sort();
      const key = `${pythonString(model.id)}: `;
      return `${INDENT}${key}${tupleLiteral(
        declared.map((id) => pythonString(id)),
        INDENT,
        key,
        ',',
      )},`;
    });

  const runtimeNames = ['Capability', 'CostProfile', 'ModelSpec', 'Provider'];
  const adapters = [...new Set(providers.map((provider) => providerAdapter(provider)))].sort();
  for (const adapter of adapters) {
    if (adapter !== undefined) runtimeNames.push(adapter);
  }

  return generated(
    GATEWAY_MODELS_PATH,
    assemble([
      HEADER,
      pythonDoc(
        "The spec's models, pinned: one alias per model, with the cost converted to the " +
          "runtime's per-1k pricing and the capability set narrowed to what the runtime " +
          'can express.',
      ),
      'import os',
      importFrom('aid_runtime', runtimeNames),
      dictBlock('ALIASES: dict[str, ModelSpec] =', aliases),
      dictBlock('FALLBACKS: dict[str, tuple[str, ...]] =', fallbacks),
      [
        'def default_providers() -> dict[str, Provider]:',
        pythonDoc(
          'One provider per provider key the spec uses. An OpenAI-compatible provider ' +
            'reads its key from the environment variable the spec names, or from none when ' +
            'the spec names none.',
          INDENT,
        ),
        `${INDENT}return {`,
        ...providers.map((provider) => providerEntry(ir, provider)),
        `${INDENT}}`,
      ].join('\n'),
    ]),
  );
}

export function emitGatewayInit(): EmittedFile {
  return generated(
    GATEWAY_INIT_PATH,
    assemble([
      HEADER,
      pythonDoc(
        "The model gateway: the app's one door to every model it uses, and the seam a " +
          'test replaces to run without a network.',
      ),
      importFrom('collections.abc', ['Mapping']),
      importFrom('aid_runtime', ['ModelGateway', 'Provider']),
      'from .models import ALIASES, default_providers',
      [
        'def build_gateway(*, providers: Mapping[str, Provider] | None = None) -> ModelGateway:',
        pythonDoc(
          'A gateway over the pinned aliases. Pass `providers` to substitute adapters -- ' +
            "a test passes a fake one -- or omit it to use the spec's own providers.",
          INDENT,
        ),
        `${INDENT}selected = default_providers() if providers is None else providers`,
        `${INDENT}return ModelGateway(selected, ALIASES)`,
      ].join('\n'),
    ]),
  );
}
