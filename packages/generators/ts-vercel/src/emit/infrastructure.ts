/**
 * `generated/gateway/models.ts`, `generated/gateway/index.ts`, `generated/deps.ts` and
 * `generated/observability.ts`.
 *
 * The gateway is the seam every generated app is testable through: `deps.ts` resolves a
 * singleton that a test (or the example's fake gateway) replaces wholesale, and the
 * model table is plain data so a cost or capability change is a one-line diff.
 */

import type { IR, ModelShape } from '@aid-framework/ir';
import {
  literal,
  modelCapabilities,
  propertyKey,
  providerAdapter,
  stringLiteral,
} from '../names.js';
import { hasAgents } from './agents.js';
import { type EmittedFile, generated, paths } from './file.js';
import {
  type Entry,
  type ImportName,
  importStatement,
  lines,
  localExportStatement,
  moduleText,
  objectLiteral,
  tsValue,
} from './text.js';

const RUNTIME = '@aid-framework/runtime';

function costExpression(model: ModelShape): string {
  const profile = model.costProfile;
  const input = profile === undefined ? 0 : profile.inputPerMTok / 1000;
  const output = profile === undefined ? 0 : profile.outputPerMTok / 1000;
  return `new CostProfile({ inputPer1kUsd: ${literal(input)}, outputPer1kUsd: ${literal(output)} })`;
}

function modelExpression(model: ModelShape): string {
  const { advertised } = modelCapabilities(model.capabilities);
  const capabilities =
    advertised.length === 0
      ? '[]'
      : `[${advertised.map((capability) => stringLiteral(capability)).join(', ')}] as const`;
  const fields: Entry[] = [
    ['name', stringLiteral(model.modelId)],
    ['provider', stringLiteral(model.provider)],
    ['cost', costExpression(model)],
    ['contextWindow', literal(model.limits.contextTokens)],
    ['maxOutputTokens', literal(model.limits.maxOutputTokens ?? model.params.maxTokens ?? 1024)],
    ['capabilities', capabilities],
  ];
  return `new ModelSpec(${objectLiteral(fields, '  ')})`;
}

export function emitGatewayModels(ir: IR): EmittedFile {
  const aliases = ir.models
    .map((model) => `  ${propertyKey(model.id)}: ${modelExpression(model)},`)
    .join('\n');
  const fallbacks = ir.models
    .filter((model) => model.fallbacks.length > 0)
    .map(
      (model) => `  ${propertyKey(model.id)}: [${model.fallbacks.map(stringLiteral).join(', ')}],`,
    )
    .join('\n');

  const providers = ir.models
    .filter((model) => providerAdapter(model.provider) !== undefined)
    .map((model) => {
      const adapter = providerAdapter(model.provider);
      if (adapter === 'FakeProvider') return `    fake: new FakeProvider(),`;
      const apiKey = model.apiKeyEnv;
      if (apiKey === undefined) {
        return `    ${propertyKey(model.provider)}: new OpenAICompatibleProvider({ name: ${stringLiteral(
          model.provider,
        )} }),`;
      }
      return `    ${propertyKey(model.provider)}: keyedProvider(${stringLiteral(
        model.provider,
      )}, ${stringLiteral(apiKey)}),`;
    });

  const header = importStatement(RUNTIME, [
    { name: 'CostProfile', type: false },
    { name: 'FakeProvider', type: false },
    { name: 'ModelSpec', type: false },
    { name: 'OpenAICompatibleProvider', type: false },
    { name: 'Provider', type: true },
  ]);

  const needsKeyed = providers.some((line) => line.includes('keyedProvider('));
  const body = [
    ...(needsKeyed
      ? [
          '/**',
          ' * An adapter whose credential comes from the environment variable the spec named.',
          ' * The option is omitted rather than set to `undefined` when the variable is unset,',
          ' * so the provider fails at call time with its own message instead of at import time.',
          ' */',
          'function keyedProvider(name: string, apiKeyEnv: string): OpenAICompatibleProvider {',
          '  const apiKey = process.env[apiKeyEnv];',
          '  return new OpenAICompatibleProvider(apiKey === undefined ? { name } : { name, apiKey });',
          '}',
          '',
        ]
      : []),
    '/** Every model alias the IR declares, resolved to a runtime model specification. */',
    'export const ALIASES: Readonly<Record<string, ModelSpec>> = {',
    aliases,
    '};',
    '',
    'export const FALLBACKS: Readonly<Record<string, readonly string[]>> = {',
    fallbacks.length === 0 ? '};' : `${fallbacks}\n};`,
    '',
    '/**',
    ' * The provider adapters a generated app talks to by default. Each one reads its',
    ' * credential from the environment variable the spec named, never from a literal.',
    ' */',
    'export function defaultProviders(): Readonly<Record<string, Provider>> {',
    '  return {',
    ...dedupe(providers),
    '  };',
    '}',
  ]
    .filter((line) => line.length > 0)
    .join('\n');

  return generated(paths.gatewayModels, moduleText(header, body));
}

function dedupe(lines: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of lines) {
    if (seen.has(line)) continue;
    seen.add(line);
    result.push(line);
  }
  return result;
}

export function emitGatewayIndex(ir: IR): EmittedFile {
  void ir;
  const header = [
    importStatement(RUNTIME, [
      { name: 'ModelGateway', type: false },
      { name: 'Provider', type: true },
    ]),
    importStatement('./models.js', [
      { name: 'ALIASES', type: false },
      { name: 'FALLBACKS', type: false },
      { name: 'defaultProviders', type: false },
    ]),
  ].join('\n');
  const body = [
    localExportStatement(['ALIASES', 'FALLBACKS', 'defaultProviders']),
    '',
    'export interface BuildGatewayOptions {',
    '  readonly providers?: Readonly<Record<string, Provider>>;',
    '}',
    '',
    '/** Build the gateway every generated call goes through. */',
    'export function buildGateway(options: BuildGatewayOptions = {}): ModelGateway {',
    '  return new ModelGateway({',
    '    providers: options.providers ?? defaultProviders(),',
    '    aliases: ALIASES,',
    '  });',
    '}',
  ].join('\n');
  return generated(paths.gatewayIndex, moduleText(header, body));
}

export function emitDeps(ir: IR): EmittedFile {
  const hasRetrieval = ir.retrievers.length > 0;
  const withAgents = hasAgents(ir);
  const runtimeImports: ImportName[] = [
    { name: 'ConfigurationError', type: false },
    { name: 'ModelGateway', type: true },
    { name: 'PromptRegistry', type: true },
    { name: 'Retriever', type: true },
    // The agent loop takes `Tool` objects, not the executor, so when this app declares an
    // agent the executor is built *from* the list rather than beside it: one adapter set
    // with two views, so an agent and a `tool` step cannot execute different objects.
    { name: 'ToolExecutor', type: !withAgents },
  ];
  if (withAgents) runtimeImports.push({ name: 'Tool', type: true });
  const header = [
    importStatement(RUNTIME, runtimeImports),
    importStatement('./gateway/index.js', [{ name: 'buildGateway', type: false }]),
    importStatement('./prompts/index.js', [{ name: 'buildPrompts', type: false }]),
  ];
  if (hasRetrieval) {
    header.push(
      importStatement('./retrieval/index.js', [{ name: 'buildRetrievers', type: false }]),
    );
  }
  header.push(
    importStatement('./tools/index.js', [
      withAgents ? { name: 'buildTools', type: false } : { name: 'buildExecutor', type: false },
    ]),
  );

  const body = lines(
    'export interface BuildDepsOptions {',
    '  readonly gateway?: ModelGateway;',
    '  readonly prompts?: PromptRegistry;',
    '  readonly tools?: ToolExecutor;',
    withAgents && '  /** The same adapters `tools` wraps; the agent loop needs them by value. */',
    withAgents && '  readonly toolList?: readonly Tool[];',
    hasRetrieval && '  readonly retrievers?: ReadonlyMap<string, Retriever>;',
    '}',
    '',
    '/**',
    ' * The wiring a generated pipeline needs. Everything a test wants to replace is a',
    ' * constructor argument, so no module-level singleton has to be monkey-patched.',
    ' */',
    'export class Deps {',
    '  readonly gateway: ModelGateway;',
    '  readonly prompts: PromptRegistry;',
    '  readonly tools: ToolExecutor;',
    withAgents && '  readonly toolList: readonly Tool[];',
    hasRetrieval && '  private readonly _retrievers: ReadonlyMap<string, Retriever>;',
    '',
    '  constructor(init: Required<BuildDepsOptions>) {',
    '    this.gateway = init.gateway;',
    '    this.prompts = init.prompts;',
    '    this.tools = init.tools;',
    withAgents && '    this.toolList = init.toolList;',
    hasRetrieval && '    this._retrievers = init.retrievers;',
    '  }',
    hasRetrieval && [
      '',
      '  /** One bound retriever, or a configuration error naming the missing id. */',
      '  retriever(id: string): Retriever {',
      '    const found = this._retrievers.get(id);',
      '    if (found === undefined) {',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: this is emitted source, not interpolation
      '      throw new ConfigurationError(`no retriever ${JSON.stringify(id)} is bound`);',
      '    }',
      '    return found;',
      '  }',
    ],
    '}',
    '',
    'let singleton: Deps | undefined;',
    '',
    '/** Build a fresh `Deps`; every seam defaults to the generated wiring. */',
    'export function buildDeps(options: BuildDepsOptions = {}): Deps {',
    withAgents && '  const toolList = options.toolList ?? buildTools();',
    '  return new Deps({',
    '    gateway: options.gateway ?? buildGateway(),',
    '    prompts: options.prompts ?? buildPrompts(),',
    withAgents
      ? '    tools: options.tools ?? new ToolExecutor(toolList),'
      : '    tools: options.tools ?? buildExecutor(),',
    withAgents && '    toolList,',
    hasRetrieval && '    retrievers: options.retrievers ?? buildRetrievers(),',
    '  });',
    '}',
    '',
    '/** The process-wide wiring, built once. */',
    'export function getDeps(): Deps {',
    '  singleton ??= buildDeps();',
    '  return singleton;',
    '}',
    '',
    '/**',
    ' * Replace the process-wide wiring, or clear it with `undefined` so the next',
    ' * `getDeps()` rebuilds from the environment. This is the seam a host or a test uses',
    ' * to run a generated pipeline against a fake provider; nothing in production calls it.',
    ' */',
    'export function setDeps(deps: Deps | undefined): void {',
    '  singleton = deps;',
    '}',
  )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');

  return generated(paths.deps, moduleText(header.join('\n'), body));
}

export function emitObservability(ir: IR): EmittedFile {
  const declared = ir.models
    .map((model) => model)
    .flatMap((model) => model.capabilities)
    .filter((capability, index, all) => all.indexOf(capability) === index);
  const modelWired: Record<string, string[]> = {};
  const unrepresentable: Record<string, string[]> = {};
  for (const model of ir.models) {
    const { advertised, dropped } = modelCapabilities(model.capabilities);
    modelWired[model.id] = [...advertised];
    if (dropped.length > 0) unrepresentable[model.id] = dropped;
  }

  const payload = {
    capabilities: {
      declared: [...declared].sort(),
      modelWired,
      targetWired: [...TARGET_WIRED],
      unwired: [...declared].filter((capability) => !wireable(capability)),
    },
    emitsAgainst: { structuredOutput: 'zod', tracing: 'otel-genai' },
    generator: '@aid-framework/generator-ts-vercel',
    irVersion: ir.irVersion,
    models: { advertised: modelWired, unrepresentable },
    observability: { redact: [...ir.observability.redact], trace: ir.observability.trace },
    target: 'ts-vercel',
  };

  const body = [
    '/**',
    ' * What this app was generated from and which capabilities it actually wires. A',
    ' * capability listed under `unwired` is one no emitter binds: it is reported rather',
    ' * than silently dropped.',
    ' */',
    'export function generatedCapabilities(): Record<string, unknown> {',
    `  return ${tsValue(payload, '  ')};`,
    '}',
  ].join('\n');

  return generated(paths.observability, moduleText(body));
}

const TARGET_WIRED = [
  'http-trigger',
  'json-schema',
  'tool-calling',
  'otel',
  'embeddings',
  'rerank',
  'guardrails',
  'agents',
  'cursor-memory',
] as const;

function wireable(capability: string): boolean {
  return (TARGET_WIRED as readonly string[]).includes(capability);
}
