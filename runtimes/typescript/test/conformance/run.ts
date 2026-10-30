/**
 * Run the shared conformance corpus against the TypeScript runtime, and diff the two
 * runtimes' verdicts.
 *
 * `conformance/corpus.json` at the repository root is the single definition of the
 * behaviour both runtimes must agree on. This file is one of its two consumers: it
 * resolves that same file, executes every case against the real runtime code, and
 * reduces each outcome to a language-neutral verdict.
 *
 * Two modes, because "each runtime agrees with the corpus" and "the runtimes agree
 * with each other" are different claims and only the second one is a conformance
 * suite:
 *
 *     node test/conformance/run.ts [verdicts.json]
 *         Execute the corpus, print `typescript: N/M`, optionally write the verdicts.
 *
 *     node test/conformance/run.ts --compare <python.json> <typescript.json>
 *         Diff the two verdict artefacts. Checks the population, the resolved corpus
 *         path, case-id integrity and every value, so a missing case, an unknown case,
 *         a duplicate case, a different corpus and a single drifted scalar all fail.
 *
 * It imports the built package rather than `src/` because Node's type stripping does
 * not rewrite the runtime's own `./cost.js` internal specifiers, so the built artefact
 * is the only thing a bare `node` process can load. Run `pnpm build` first.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';
import type {
  Capability,
  DistanceMetric,
  GateResult,
  GuardrailDefinition,
  GuardrailVerdict,
  Provider,
  RankedId,
  Step,
  StructuredOutput,
  ToolParameters,
} from '../../dist/index.js';
import {
  ACTION_BLOCK,
  ACTION_ESCALATE,
  AgentHandoffUnsupportedError,
  AgentRuntime,
  AidRuntimeError,
  AssertMetric,
  BaselineGate,
  Budget,
  BudgetExceededError,
  bm25Scores,
  branch,
  CapabilityMismatchError,
  Chunk,
  ConcurrencyLimiter,
  ConfigurationError,
  CostLedger,
  CostProfile,
  checkpointFromJson,
  checkpointsEqual,
  checkpointToJson,
  cite,
  DEPTH_KEY,
  DeepAgentsUnavailableError,
  DeepAgentsVersionMismatchError,
  EvalBaseline,
  EvalCase,
  EvalRun,
  estimateCostUsd,
  FakeProvider,
  FileMemoryStore,
  fromIr,
  fuse,
  GuardrailBlockedError,
  GuardrailEngine,
  INDEX_KEY,
  InProcessMemoryStore,
  ITEM_KEY,
  LedgerEntry,
  LIMITER_KEY,
  lexicalRanking,
  lexicalScore,
  MAX_STEP_DEPTH,
  MetricBaseline,
  MetricRun,
  ModelGateway,
  ModelSpec,
  mapStep,
  Pipeline,
  PipelineContext,
  PRINCIPAL_KEY,
  Principal,
  PromptNotFoundError,
  PromptRegistry,
  PromptRenderError,
  PromptTemplate,
  parallel,
  parseStructured,
  pendingApprovalFrom,
  REDUCED_KEY,
  RESERVED_KEYS,
  RerankSpec,
  RetrievalResult,
  RetrievedItem,
  type RunResult,
  EvalError as RuntimeEvalError,
  reduceStep,
  rerankerFor,
  runStructured,
  ScriptedTurn,
  STEPS_KEY,
  StructuredOutputError,
  similarity,
  Threshold,
  TokenUsage,
  Tool,
  ToolPermissionError,
  UnknownModelAliasError,
  zCritical,
} from '../../dist/index.js';

/** `test/conformance/run.ts` is four levels below the repository root. */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const CORPUS_PATH = join(REPO_ROOT, 'conformance', 'corpus.json');

/**
 * Float comparisons are absolute. The two runtimes differ only in summation order, so
 * a real behavioural difference is orders of magnitude larger than this, and the last
 * digit the corpus pins (six decimal places, see {@link clean}) is still decided by
 * the corpus rather than by floating-point luck.
 */
const TOLERANCE = 1e-9;

/** The precision every finite float is quantised to before it is pinned or compared. */
const PRECISION = 6;

type Json = Record<string, unknown>;
type Handler = (input: Json) => Json | Promise<Json>;

interface Case {
  readonly id: string;
  readonly op: string;
  readonly input: Json;
  readonly expect: unknown;
  /** The runtimes this case applies to; empty means all of them. */
  readonly runtimes: readonly string[];
  /** Why the case is narrowed to a subset, empty when it applies to every runtime. */
  readonly reason: string;
}

interface Corpus {
  readonly cases: readonly Case[];
}

interface Entry {
  readonly id: string;
  readonly status: 'evaluated' | 'scoped-out';
  readonly verdict?: unknown;
  readonly reason?: string;
}

interface Artefact {
  readonly runtime: string;
  readonly corpusPath: string;
  readonly cases: readonly Entry[];
}

// --- reading corpus input -------------------------------------------------------
//
// The corpus is JSON, so every value arrives as `unknown`. These helpers turn a wrong
// shape into a named failure instead of a silently undefined field, which is what
// makes a corpus typo a runner error rather than a false pass.

function asRecord(value: unknown, what: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`corpus field ${what} is not an object`);
  }
  return value as Json;
}

function asArray(value: unknown, what: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`corpus field ${what} is not a list`);
  return value;
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') throw new TypeError(`corpus field ${what} is not a string`);
  return value;
}

function asNumber(value: unknown, what: string): number {
  if (typeof value !== 'number') throw new TypeError(`corpus field ${what} is not a number`);
  return value;
}

function asInt(value: unknown, what: string): number {
  const number = asNumber(value, what);
  if (!Number.isInteger(number)) throw new TypeError(`corpus field ${what} is not an integer`);
  return number;
}

function asStrings(value: unknown, what: string): string[] {
  return asArray(value, what).map((item) => asString(item, what));
}

function asNumbers(value: unknown, what: string): number[] {
  return asArray(value, what).map((item) => asNumber(item, what));
}

function asOptionalNumber(value: unknown): number | undefined {
  return value === null || value === undefined ? undefined : asNumber(value, 'optional');
}

const CAPABILITIES: ReadonlySet<string> = new Set<Capability>([
  'tool-calling',
  'structured-output',
  'streaming',
  'long-context',
  'embeddings',
  'rerank',
]);

function asCapability(value: unknown): Capability {
  const name = asString(value, 'capability');
  if (!CAPABILITIES.has(name)) throw new TypeError(`unknown capability ${name}`);
  return name as Capability;
}

const METRICS: ReadonlySet<string> = new Set<DistanceMetric>(['cosine', 'dot', 'l2']);

function asMetric(value: unknown): DistanceMetric {
  const name = asString(value, 'metric');
  if (!METRICS.has(name)) throw new TypeError(`unknown distance metric ${name}`);
  return name as DistanceMetric;
}

/**
 * A provider that exists only so alias resolution has an adapter to point at.
 *
 * It declares every capability, so a capability gap in a corpus case is always the
 * pinned model's own gap and never an artefact of this stub.
 */
const FAKE_PROVIDER: Provider = {
  name: 'fake',
  capabilities: CAPABILITIES as ReadonlySet<Capability>,
  complete: () => Promise.reject(new Error('the conformance corpus makes no model calls')),
  close: () => Promise.resolve(),
};

// --- building runtime objects ---------------------------------------------------

function cost(payload: unknown): CostProfile {
  const record = asRecord(payload, 'cost');
  return new CostProfile({
    inputPer1kUsd: asNumber(record.inputPer1kUsd, 'cost.inputPer1kUsd'),
    outputPer1kUsd: asNumber(record.outputPer1kUsd, 'cost.outputPer1kUsd'),
  });
}

function spec(payload: unknown): ModelSpec {
  const record = asRecord(payload, 'model spec');
  return new ModelSpec({
    name: asString(record.name, 'spec.name'),
    provider: asString(record.provider, 'spec.provider'),
    cost: cost(record.cost),
    contextWindow: asInt(record.contextWindow, 'spec.contextWindow'),
    maxOutputTokens: asInt(record.maxOutputTokens, 'spec.maxOutputTokens'),
    capabilities: asArray(record.capabilities, 'spec.capabilities').map((value) =>
      asCapability(value),
    ),
  });
}

function gateway(payload: Json): ModelGateway {
  const aliases: Record<string, ModelSpec> = {};
  for (const [alias, entry] of Object.entries(asRecord(payload.aliases, 'aliases'))) {
    aliases[alias] = spec(entry);
  }
  return new ModelGateway({ providers: { fake: FAKE_PROVIDER }, aliases });
}

const Answer = z.object({ answer: z.string(), score: z.number() });

const OUTPUT_TYPES: Readonly<Record<string, StructuredOutput<unknown>>> = {
  Answer: { name: 'Answer', schema: Answer },
};

function outputType(name: string): StructuredOutput<unknown> {
  const found = OUTPUT_TYPES[name];
  if (found === undefined) throw new TypeError(`the corpus names no schema ${name}`);
  return found;
}

// --- error verdicts -------------------------------------------------------------

/**
 * Every error the corpus can observe, in the order to test it. The name on the right
 * is the neutral kind the corpus pins; the class on the left is this runtime's own
 * spelling of it.
 */
type ErrorClass = new (...args: never[]) => AidRuntimeError;

const ERROR_KINDS: readonly (readonly [ErrorClass, string])[] = [
  [UnknownModelAliasError, 'unknown-alias'],
  [CapabilityMismatchError, 'capability-mismatch'],
  [BudgetExceededError, 'budget-exceeded'],
  [PromptNotFoundError, 'prompt-not-found'],
  [PromptRenderError, 'prompt-render'],
  [StructuredOutputError, 'structured-output'],
  [RuntimeEvalError, 'eval'],
];

function errorOf(thrown: unknown): Json {
  if (thrown instanceof AidRuntimeError) {
    for (const [kindOf, kind] of ERROR_KINDS) {
      if (thrown instanceof kindOf) return { kind, message: thrown.message };
    }
  }
  // An error the corpus does not model is a runner bug, not a verdict.
  throw thrown;
}

function errorFrom(call: () => unknown): Json {
  try {
    call();
  } catch (thrown) {
    return errorOf(thrown);
  }
  return { kind: 'no-error', message: '' };
}

// --- operations -----------------------------------------------------------------

function aliasResolve(input: Json): Json {
  try {
    const pinned = gateway(input).resolve(asString(input.alias, 'alias'));
    const model = pinned.model;
    return {
      alias: pinned.alias,
      model: model.name,
      provider: model.provider,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      capabilities: [...model.capabilities].sort(),
      cost: {
        inputPer1kUsd: model.cost.inputPer1kUsd,
        outputPer1kUsd: model.cost.outputPer1kUsd,
      },
    };
  } catch (thrown) {
    return { error: errorOf(thrown) };
  }
}

function aliasUnknown(input: Json): Json {
  const table = gateway(input);
  return { error: errorFrom(() => table.resolve(asString(input.alias, 'alias'))) };
}

function aliasRequire(input: Json): Json {
  const table = gateway(input);
  const required = asArray(input.capabilities, 'capabilities').map((value) => asCapability(value));
  return { error: errorFrom(() => table.require(asString(input.alias, 'alias'), required)) };
}

function aliasTable(input: Json): Json {
  return { aliases: gateway(input).aliases };
}

function budgetEstimate(input: Json): Json {
  const usage = asRecord(input.usage, 'usage');
  const priced = new ModelSpec({
    name: 'priced',
    provider: 'fake',
    cost: cost(input.cost),
    contextWindow: 128000,
    maxOutputTokens: 16384,
  });
  return {
    costUsd: estimateCostUsd(
      priced,
      new TokenUsage({
        inputTokens: asInt(usage.inputTokens, 'usage.inputTokens'),
        outputTokens: asInt(usage.outputTokens, 'usage.outputTokens'),
      }),
    ),
  };
}

function budgetLedger(input: Json): Json {
  const payload = input.budget;
  let budget: Budget | undefined;
  if (payload !== null && payload !== undefined) {
    const record = asRecord(payload, 'budget');
    budget = new Budget({
      maxUsd: asOptionalNumber(record.maxUsd),
      maxTotalTokens: asOptionalNumber(record.maxTotalTokens),
      scope: asString(record.scope, 'budget.scope'),
    });
  }
  const profile = cost(input.cost);
  const ledger = new CostLedger();
  let error: Json = { kind: 'no-error', message: '' };
  for (const charge of asArray(input.charges, 'charges')) {
    const entry = asRecord(charge, 'charge');
    const usage = new TokenUsage({
      inputTokens: asInt(entry.inputTokens, 'charge.inputTokens'),
      outputTokens: asInt(entry.outputTokens, 'charge.outputTokens'),
    });
    try {
      ledger.charge(
        budget,
        new LedgerEntry({
          alias: asString(entry.alias, 'charge.alias'),
          model: asString(entry.model, 'charge.model'),
          provider: asString(entry.provider, 'charge.provider'),
          usage,
          costUsd: profile.costUsd(usage),
        }),
      );
    } catch (thrown) {
      // A refused charge ends the run: the caller stops spending, and the corpus pins
      // the ledger as it stood at the moment of refusal.
      if (!(thrown instanceof BudgetExceededError)) throw thrown;
      error = errorOf(thrown);
      break;
    }
  }
  const summary = ledger.summary();
  const byModel: Record<string, number> = {};
  for (const model of Object.keys(summary.byModel).sort()) {
    byModel[model] = summary.byModel[model] ?? 0;
  }
  return {
    error,
    summary: {
      calls: summary.calls,
      inputTokens: summary.inputTokens,
      outputTokens: summary.outputTokens,
      costUsd: summary.costUsd,
      byModel,
    },
  };
}

function rendered(value: {
  readonly name: string;
  readonly version: string;
  readonly text: string;
}): Json {
  return { name: value.name, version: value.version, text: value.text };
}

function promptRender(input: Json): Json {
  const template = new PromptTemplate({
    name: asString(input.name, 'name'),
    version: asString(input.version, 'version'),
    template: asString(input.template, 'template'),
  });
  try {
    return rendered(template.render(asRecord(input.values, 'values')));
  } catch (thrown) {
    return { error: errorOf(thrown) };
  }
}

function promptLatest(input: Json): Json {
  const registry = new PromptRegistry(
    asArray(input.templates, 'templates').map((entry) => {
      const template = asRecord(entry, 'template');
      return new PromptTemplate({
        name: asString(template.name, 'template.name'),
        version: asString(template.version, 'template.version'),
        template: asString(template.template, 'template.template'),
      });
    }),
  );
  try {
    return rendered(
      registry.render(
        asString(input.name, 'name'),
        asRecord(input.values, 'values') as Record<string, unknown>,
      ),
    );
  } catch (thrown) {
    return { error: errorOf(thrown) };
  }
}

function structuredParse(input: Json): Json {
  const shape = outputType(asString(input.schema, 'schema'));
  try {
    return { value: parseStructured(asString(input.text, 'text'), shape) };
  } catch (thrown) {
    return { error: errorOf(thrown) };
  }
}

async function structuredRepair(input: Json): Promise<Json> {
  const shape = outputType(asString(input.schema, 'schema'));
  const responses = asStrings(input.responses, 'responses');
  const prompts: string[] = [];
  const call = (prompt: string): Promise<string> => {
    prompts.push(prompt);
    const reply = responses[prompts.length - 1];
    if (reply === undefined) throw new Error('the corpus supplied fewer responses than calls');
    return Promise.resolve(reply);
  };
  try {
    const value = await runStructured(call, shape, asString(input.prompt, 'prompt'), {
      retries: asInt(input.retries, 'retries'),
    });
    return { prompts, value };
  } catch (thrown) {
    return { prompts, error: errorOf(thrown) };
  }
}

function ranked(ranking: readonly RankedId[]): Json[] {
  return ranking.map((entry) => ({ chunkId: entry.chunkId, score: entry.score }));
}

function retrievalBm25(input: Json): Json {
  return {
    scores: [
      ...bm25Scores(asStrings(input.documents, 'documents'), asString(input.query, 'query')),
    ],
  };
}

function retrievalRanking(input: Json): Json {
  const ranking = lexicalRanking(
    asStrings(input.documents, 'documents'),
    asStrings(input.ids, 'ids'),
    asString(input.query, 'query'),
    { topK: asInt(input.topK, 'topK') },
  );
  return { ranking: ranked(ranking) };
}

function retrievalRrf(input: Json): Json {
  const rankings = asArray(input.rankings, 'rankings').map((entry) => asStrings(entry, 'ranking'));
  // `k: null` pins the recomputed default rather than restating the constant: a case
  // that passed an explicit 60 would not notice the default changing.
  const fused =
    input.k === null || input.k === undefined
      ? fuse(rankings)
      : fuse(rankings, { k: asInt(input.k, 'k') });
  return { ranking: ranked(fused) };
}

function retrievalSimilarity(input: Json): Json {
  const query = asNumbers(input.query, 'query');
  const candidates = asArray(input.candidates, 'candidates').map((entry) =>
    asNumbers(entry, 'candidate'),
  );
  const scores: Record<string, number[]> = {};
  for (const metric of asStrings(input.metrics, 'metrics')) {
    const distance = asMetric(metric);
    scores[metric] = candidates.map((candidate) =>
      similarity(query, candidate, { metric: distance }),
    );
  }
  return { scores };
}

function retrievalLexical(input: Json): Json {
  const query = asString(input.query, 'query');
  return { scores: asStrings(input.texts, 'texts').map((text) => lexicalScore(query, text)) };
}

function evaluate(input: Json): GateResult {
  const thresholds = asArray(input.thresholds, 'thresholds').map((entry) => {
    const threshold = asRecord(entry, 'threshold');
    const floor = threshold.minMean;
    return new Threshold({
      metric: asString(threshold.metric, 'threshold.metric'),
      minMean: floor === null || floor === undefined ? null : asNumber(floor, 'threshold.minMean'),
      maxRegression: asNumber(threshold.maxRegression, 'threshold.maxRegression'),
      alpha: asNumber(threshold.alpha, 'threshold.alpha'),
    });
  });
  const runPayload = asRecord(input.run, 'run');
  const run = new EvalRun({
    dataset: asString(runPayload.dataset, 'run.dataset'),
    datasetVersion: asString(runPayload.datasetVersion, 'run.datasetVersion'),
    runs: asInt(runPayload.runs, 'run.runs'),
    metrics: asArray(runPayload.metrics, 'run.metrics').map((entry) => {
      const metric = asRecord(entry, 'run metric');
      return new MetricRun({
        metric: asString(metric.metric, 'run metric.metric'),
        values: asNumbers(metric.values, 'run metric.values'),
      });
    }),
  });
  const baselinePayload = asRecord(input.baseline, 'baseline');
  const baseline = new EvalBaseline({
    dataset: asString(baselinePayload.dataset, 'baseline.dataset'),
    datasetVersion: asString(baselinePayload.datasetVersion, 'baseline.datasetVersion'),
    model: asString(baselinePayload.model, 'baseline.model'),
    metrics: asArray(baselinePayload.metrics, 'baseline.metrics').map((entry) => {
      const metric = asRecord(entry, 'baseline metric');
      return new MetricBaseline({
        metric: asString(metric.metric, 'baseline metric.metric'),
        runs: asInt(metric.runs, 'baseline metric.runs'),
        mean: asNumber(metric.mean, 'baseline metric.mean'),
        stdev: asNumber(metric.stdev, 'baseline metric.stdev'),
      });
    }),
  });
  return new BaselineGate(thresholds).evaluate(run, baseline);
}

function gateResult(result: GateResult): Json {
  return {
    passed: result.passed,
    dataset: result.dataset,
    datasetVersion: result.datasetVersion,
    runs: result.runs,
    varying: result.varying,
    results: result.results.map((entry) => ({
      metric: entry.metric,
      passed: entry.passed,
      currentMean: entry.currentMean,
      currentStdev: entry.currentStdev,
      baselineMean: entry.baselineMean,
      baselineStdev: entry.baselineStdev,
      delta: entry.delta,
      z: entry.z,
      alpha: entry.alpha,
      maxRegression: entry.maxRegression,
      rationale: entry.rationale,
    })),
  };
}

function evalGate(input: Json): Json {
  return gateResult(evaluate(input));
}

function evalGateSummary(input: Json): Json {
  const result = evaluate(input);
  return { passed: result.passed, summary: result.summary() };
}

function evalZCritical(input: Json): Json {
  return {
    values: asNumbers(input.alphas, 'alphas').map((alpha) => ({ alpha, z: zCritical(alpha) })),
  };
}

/**
 * Score one case with the `assert` metric.
 *
 * The predicate arrives as the IR's own AST, so the corpus pins that both runtimes read
 * the same tree the same way -- including the trees that must raise rather than score.
 */
async function evalAssert(input: Json): Promise<Json> {
  const entry = asRecord(input.case, 'case');
  const metric = new AssertMetric({
    expr: input.ast as ConstructorParameters<typeof AssertMetric>[0]['expr'],
    message: asString(input.message, 'message'),
  });
  const scored = new EvalCase({
    id: asString(entry.id, 'case.id'),
    input: asString(entry.input, 'case.input'),
    metadata: entry.metadata as Readonly<Record<string, string>> | undefined,
  });
  try {
    const result = await metric.score(scored, asString(input.prediction, 'prediction'));
    return {
      metric: result.metric,
      score: result.score,
      passed: result.passed,
      detail: result.detail,
    };
  } catch (thrown) {
    return { error: errorOf(thrown) };
  }
}

// --- composite steps ------------------------------------------------------------
//
// Transcribed from `runtimes/python/tests/conformance/test_conformance.py`. The verdicts
// were already pinned against the reference runtime, so a difference here is a real
// semantic difference in the port rather than a corpus edit.

/** The names a composite owns plus `steps`; nothing here is a binding it produced. */
const PLUMBING: ReadonlySet<string> = new Set([...RESERVED_KEYS, STEPS_KEY]);

/** The caller a `steps.branch` case decides for, spelled the way a route seeds it. */
function principalOf(data: Json): Principal {
  const spec = asRecord(data.principal ?? {}, 'principal');
  return new Principal({
    roles: asStrings(spec.roles ?? [], 'principal.roles'),
    scopes: asStrings(spec.scopes ?? [], 'principal.scopes'),
    authenticated: spec.authenticated === undefined ? true : Boolean(spec.authenticated),
  });
}

/** The context an emitted route hands a composite: the case's values, then the two the
 * application owns. */
function seeded(data: Json, limiter: ConcurrencyLimiter): PipelineContext {
  const values: Record<string, unknown> = {
    ...asRecord(data.values ?? {}, 'values'),
  };
  values[LIMITER_KEY] = limiter;
  values[PRINCIPAL_KEY] = principalOf(data);
  return new PipelineContext(values);
}

/**
 * What the composite bound, in the order it bound it.
 *
 * The case's own seeded values are excluded too: they are what the composite read, not
 * what it produced, so a verdict cannot be satisfied by echoing its input.
 */
function bound(context: PipelineContext, data: Json): Json {
  const seededNames = new Set(Object.keys(asRecord(data.values ?? {}, 'values')));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context.values)) {
    if (!PLUMBING.has(key) && !seededNames.has(key)) out[key] = value;
  }
  return out;
}

function namedStep(name: string, body: Step): Step {
  Object.defineProperty(body, 'name', { value: name, configurable: true });
  return body;
}

function at<T>(items: readonly T[], index: number, what: string): T {
  const item = items[index];
  if (item === undefined) throw new TypeError(`${what} ${index} is out of range`);
  return item;
}

/**
 * One `branch`: which arm the principal selected, and what that arm bound.
 *
 * A case that declares no alternative is how "neither arm ran" is observed, and the
 * composite binds nothing at all in that case rather than an empty or stale value.
 */
async function stepsBranch(input: Json): Promise<Json> {
  const ran: string[] = [];
  const arm = (which: string, binds: Json): Pipeline =>
    Pipeline.of(
      namedStep(which, (current) => {
        ran.push(which);
        return current.withValues({ ...binds });
      }),
    );

  const alternative = input.elseBinds;
  const composite = branch({
    when: asRecord(input.when, 'when'),
    // biome-ignore lint/suspicious/noThenProperty: the branch shape names its taken arm `then`.
    then: arm('then', asRecord(input.thenBinds ?? {}, 'thenBinds')),
    ...(alternative === undefined || alternative === null
      ? {}
      : { otherwise: arm('otherwise', asRecord(alternative, 'otherwise')) }),
  });
  const result = await Pipeline.of(composite).run(seeded(input, new ConcurrencyLimiter(1)));
  return { ran, bound: bound(result, input) };
}

/**
 * One `parallel`: the ceiling the arms observed, the order they ended in, and the order
 * their bindings reached the context.
 *
 * `after` names the arms an arm waits for, so the reverse-completion case is decided by
 * the corpus instead of by how a machine happens to schedule tasks: the arms really do
 * finish last-declared first, and the merge order is still declaration order.
 * `highWater` is the most arms that ever held a slot at once, which is the only evidence
 * the cap was applied rather than merely passed.
 */
async function stepsParallel(input: Json): Promise<Json> {
  const specs = asArray(input.arms, 'arms').map((arm, index) => asRecord(arm, `arms[${index}]`));
  const inFlight = { now: 0, high: 0 };
  const finished: string[] = [];
  const done = specs.map(() => {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  });

  const arms = specs.map((spec, index) => {
    const name = asString(spec.bind, 'arm.bind');
    const after = spec.after === undefined ? [] : asNumbers(spec.after, 'arm.after');
    return Pipeline.of(
      namedStep(name, async (current) => {
        // Counted from the moment the arm holds a slot, which is before it waits: an arm
        // waiting on a sibling is still one of the arms the cap is holding, so counting
        // only the post-wait region would report a ceiling of one.
        inFlight.now += 1;
        inFlight.high = Math.max(inFlight.high, inFlight.now);
        for (const waitFor of after) await at(done, waitFor, 'arm.after').promise;
        // Yield while holding the slot, so a second arm can take another one and the
        // ceiling is some value above one rather than an artefact of not trying.
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        inFlight.now -= 1;
        finished.push(name);
        at(done, index, 'arm').open();
        return current.withValues({ [name]: name });
      }),
    );
  });

  const composite = parallel({ branches: arms });
  const result = await Pipeline.of(composite).run(
    seeded(input, new ConcurrencyLimiter(asInt(input.limit, 'limit'))),
  );
  return {
    highWater: inFlight.high,
    finished,
    order: Object.keys(bound(result, input)),
  };
}

/**
 * One `map`: the per-item bindings in input order, with the position each ran at.
 *
 * The body binds `at` and `value` from the two keys the composite writes, so the verdict
 * shows both that every item ran once and which position it believed it had.
 */
async function stepsMap(input: Json): Promise<Json> {
  const observe = namedStep('observe', (current) =>
    current.withValues({ at: current.require(INDEX_KEY), value: current.require(ITEM_KEY) }),
  );
  const composite = mapStep({
    over: asString(input.over, 'over'),
    as: asString(input.as, 'as'),
    step: Pipeline.of(observe),
  });
  const result = await Pipeline.of(composite).run(
    seeded(input, new ConcurrencyLimiter(asInt(input.limit, 'limit'))),
  );
  return { bound: bound(result, input) };
}

/**
 * One `reduce`: the collected per-item results in input order.
 *
 * Each iteration yields a number of times that decreases with its position, so the last
 * item ends first and the collected list is still read in input order. `finished` reports
 * the order the iterations actually ended in, so a runtime that collected in completion
 * order fails instead of passing by luck.
 */
async function stepsReduce(input: Json): Promise<Json> {
  const over = asString(input.over, 'over');
  const finished: unknown[] = [];
  const collect = namedStep('collect', async (current) => {
    const index = asInt(current.require(INDEX_KEY), 'index');
    const item = current.require(ITEM_KEY);
    const count = asArray(current.require(over), over).length;
    for (let turn = 0; turn < count - index; turn += 1) {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }
    finished.push(item);
    return current.withValues({ [REDUCED_KEY]: item });
  });
  const composite = reduceStep({
    over,
    as: asString(input.as, 'as'),
    step: Pipeline.of(collect),
  });
  const result = await Pipeline.of(composite).run(
    seeded(input, new ConcurrencyLimiter(asInt(input.limit, 'limit'))),
  );
  return { bound: bound(result, input), finished };
}

/**
 * How deep a nest a runtime allows before it refuses the next level.
 *
 * The nest is one `parallel` per level and the leaf is not a composite at all, so the
 * bound is the family's rather than one kind's: every composite charges the same `depth`
 * key. A refusal is reported as an outcome because refusing is the contract -- a nest
 * past the bound that ran anyway would be the failure.
 */
async function stepsDepth(input: Json): Promise<Json> {
  const levels = asInt(input.levels, 'levels');
  const reached: { depth: number | null } = { depth: null };
  const leaf = namedStep('leaf', (current) => {
    reached.depth = asInt(current.get(DEPTH_KEY, 0), 'depth');
    return current;
  });

  let nested = Pipeline.of(leaf);
  for (let level = 0; level < levels; level += 1) {
    nested = Pipeline.of(parallel({ branches: [nested] }));
  }
  try {
    await nested.run(seeded(input, new ConcurrencyLimiter(1)));
  } catch (error) {
    const reason =
      error instanceof Error && error.message.includes('nested deeper than')
        ? 'max-depth'
        : 'other';
    return { refused: true, maxDepth: MAX_STEP_DEPTH, depth: null, reason };
  }
  return { refused: false, maxDepth: MAX_STEP_DEPTH, depth: reached.depth, reason: null };
}

/**
 * The binding the wiring steps read, shaped like a `retrieve` result.
 *
 * Position is both the chunk index and the incoming rank, so a case can state the order
 * the step was handed and the order it produced without inventing a third vocabulary for
 * either. The scores are placeholders: a `rerank` recomputes them, and a `guard` never
 * reads them.
 */
function retrievalBinding(data: Json): RetrievalResult {
  const items = asStrings(data.items, 'items').map((text, position) => {
    const chunk = new Chunk({
      chunkId: `chunk-${position}`,
      docId: 'handbook',
      uri: 'handbook.md',
      index: position,
      start: 0,
      end: text.length,
      text,
    });
    return new RetrievedItem({ chunk, score: 1, rank: position + 1, citation: cite(chunk) });
  });
  return new RetrievalResult({
    retriever: maybeString(data.retriever, 'handbook'),
    query: maybeString(data.seedQuery, ''),
    items,
  });
}

/** The one named guardrail the step resolves, out of the case's compact fixture. */
function guardrailDefinition(data: Json): GuardrailDefinition {
  const entry = asRecord(data.guardrail, 'guardrail');
  const onFail = asRecord(entry.onFail ?? {}, 'guardrail.onFail');
  return {
    id: asString(entry.id, 'guardrail.id'),
    stages: asStrings(entry.stages, 'guardrail.stages'),
    policies: asStrings(entry.policies, 'guardrail.policies'),
    action: asString(entry.action, 'guardrail.action'),
    redact: asStrings(entry.redact ?? [], 'guardrail.redact'),
    tools: asStrings(entry.tools ?? [], 'guardrail.tools'),
    message: maybeString(onFail.message, ''),
    fallbackPrompt:
      onFail.fallbackPrompt === undefined
        ? undefined
        : asString(onFail.fallbackPrompt, 'guardrail.onFail.fallbackPrompt'),
    log: onFail.log === true,
  };
}

/**
 * One `rerank` step: the binding it rebinds, re-ordered and cut to `topN`.
 *
 * The step rewrites the *items* of the binding it reads and leaves every other field
 * alone, so the verdict reports the whole binding. `items`/`ranks` prove the reranker
 * decided the order and the ceiling held; `query`/`retriever` prove the step rebound the
 * binding it read rather than fabricating an unrelated one. The case's step query
 * deliberately differs from the seeded one, so a step that wrote its own query into the
 * binding fails here instead of passing quietly.
 */
async function stepsRerank(input: Json): Promise<Json> {
  const over = asString(input.over, 'over');
  const boundAs = asString(input.as, 'as');
  const topN = asInt(input.topN, 'topN');
  const query = asString(input.query, 'query');
  const model = asString(input.model, 'model');
  const values: Record<string, unknown> = { ...asRecord(input.values ?? {}, 'values') };
  values[over] = retrievalBinding(input);

  const run: Step = async (current) => {
    const reranker = rerankerFor(new RerankSpec({ model, topN }));
    if (reranker === null) throw new ConfigurationError('a declared rerank model must resolve');
    // The binding owns its query and retriever; `query` above is only the reranker's
    // argument, so the rebound result copies provenance from what was read.
    const seededResult = current.require(over) as RetrievalResult;
    const scored = await reranker.rerank(query, seededResult.items, { topN });
    return current.withValues({
      [boundAs]: new RetrievalResult({
        retriever: seededResult.retriever,
        query: seededResult.query,
        items: scored,
      }),
    });
  };

  const context = seeded({ values, principal: input.principal ?? {} }, new ConcurrencyLimiter(1));
  const bound_ = (await Pipeline.of(run).run(context)).require(boundAs) as RetrievalResult;
  return {
    bound: boundAs,
    items: bound_.items.map((item) => item.chunk.text),
    ranks: bound_.items.map((item) => item.rank),
    query: bound_.query,
    retriever: bound_.retriever,
  };
}

/**
 * The actions that stop a pipeline. `escalate` stops like a `block` because a route has
 * no checkpoint to resume a question from -- the emitted step treats both the same way,
 * and this mirrors it.
 */
const STOPPING_ACTIONS: ReadonlySet<string> = new Set([ACTION_BLOCK, ACTION_ESCALATE]);

/**
 * One `guard` step: the payload its stage is handed, and what the engine decided.
 *
 * The payload is the stage's, not the case's. `input` and `output` hand the rendered
 * text; `retrieval` hands the *texts of the items in the binding* -- the passages a
 * prompt would splice -- which is exactly the projection the emitted step makes. The
 * case's contact detail lives in a passage and nowhere else, so a step that inspected
 * the query instead of the context would pass here, which is why this case is the one
 * that pins the projection.
 *
 * A stopping action is reported as an error rather than a verdict: the emitted step
 * raises, so a refusal is the contract and a run that continued would be the failure.
 */
async function stepsGuard(input: Json): Promise<Json> {
  const stage = asString(input.stage, 'stage');
  const definition = guardrailDefinition(input);
  const engine = new GuardrailEngine(new Map([[definition.id, definition]]));
  let payload: string[] | string;
  let verdict: GuardrailVerdict;
  if (stage === 'retrieval') {
    payload = retrievalBinding(input).items.map((item) => item.chunk.text);
    verdict = engine.checkRetrieval([definition], payload);
  } else if (stage === 'input' || stage === 'output') {
    payload = asString(input.text, 'text');
    verdict =
      stage === 'input'
        ? engine.checkInput([definition], payload)
        : engine.checkOutput([definition], payload);
  } else {
    throw new ConfigurationError(`the guard step has no ${JSON.stringify(stage)} stage`);
  }
  const deciding = verdict.deciding;
  if (deciding !== undefined && STOPPING_ACTIONS.has(deciding.action)) {
    return { error: 'guardrail-blocked', guardrail: deciding.guardrail, stage: deciding.stage };
  }
  return {
    stage: verdict.stage,
    payload,
    fired: verdict.records.map((record) => record.guardrail),
    action: verdict.action ?? null,
  };
}

// --- agents, guardrails, memory ----------------------------------------------------
//
// Transcribed from the Python handlers in
// `runtimes/python/tests/conformance/test_conformance.py`. The corpus spells an agent
// fixture compactly; these handlers expand it into the IR document the spec layer emits,
// so the cases drive the same `fromIr` a generated app does rather than a test-only
// constructor. What a run reached is then reduced to the questions the corpus asks, so a
// verdict never carries a runtime class name.

/** The only provider the agent fixtures name, so a scripted turn is unambiguous. */
const AGENT_PROVIDER = 'fake';
const AGENT_CONTEXT = 128_000;

/** The parameter schema every fixture tool shares; no agent case inspects arguments. */
const QUERY_SCHEMA: ToolParameters = {
  type: 'object',
  properties: { query: { type: 'string' } },
  additionalProperties: false,
};

/** The agent fields the corpus may set, copied through when the fixture names them. */
const AGENT_FIELDS = [
  'maxCostBudget',
  'maxTokensBudget',
  'onBudgetExhausted',
  'engineVersion',
] as const;

function maybeString(value: unknown, fallback: string): string {
  return value === undefined ? fallback : asString(value, 'field');
}

/**
 * Expand the corpus's compact agent fixture into an emitted IR document.
 *
 * The corpus spells money per thousand tokens, like its alias cases do; the IR spells it
 * per million. Converting here keeps one vocabulary in the corpus and one in the IR
 * instead of a third somewhere between them.
 */
function agentDocument(data: Json): Json {
  const models = asArray(data.models ?? [], 'models').map((raw, index) => {
    const entry = asRecord(raw, `models[${index}]`);
    const id = asString(entry.id, 'models[].id');
    return {
      id,
      modelId: `${id}-1`,
      provider: AGENT_PROVIDER,
      capabilities: ['tool-calling'],
      limits: { contextTokens: AGENT_CONTEXT, maxOutputTokens: 4096 },
      costProfile: {
        inputPerMTok: asNumber(entry.inputPer1kUsd ?? 0, 'models[].inputPer1kUsd') * 1000,
        outputPerMTok: asNumber(entry.outputPer1kUsd ?? 0, 'models[].outputPer1kUsd') * 1000,
      },
      fallbacks: asStrings(entry.fallbacks ?? [], 'models[].fallbacks'),
    };
  });
  const prompts = asArray(data.prompts ?? [], 'prompts').map((raw, index) => {
    const entry = asRecord(raw, `prompts[${index}]`);
    return {
      id: asString(entry.id, 'prompts[].id'),
      version: 1,
      template: asString(entry.template, 'prompts[].template'),
      variables: {},
    };
  });
  const tools = asArray(data.tools ?? [], 'tools').map((raw, index) => {
    const entry = asRecord(raw, `tools[${index}]`);
    const name = asString(entry.name, 'tools[].name');
    return {
      id: asString(entry.id, 'tools[].id'),
      name,
      description: maybeString(entry.description, `${name} tool`),
      requiresConfirmation: entry.requiresConfirmation === true,
      sideEffects: 'read',
    };
  });
  const agents = asArray(data.agents ?? [], 'agents').map((raw, index) => {
    const entry = asRecord(raw, `agents[${index}]`);
    const id = asString(entry.id, 'agents[].id');
    const agent: Json = {
      id,
      name: maybeString(entry.name, id),
      instructions: asString(entry.instructions, 'agents[].instructions'),
      model: asString(entry.model, 'agents[].model'),
      maxSteps: asInt(entry.maxSteps, 'agents[].maxSteps'),
      tools: asStrings(entry.tools ?? [], 'agents[].tools'),
      handoffs: asStrings(entry.handoffs ?? [], 'agents[].handoffs'),
      delegates: asStrings(entry.delegates ?? [], 'agents[].delegates'),
      memory: asStrings(entry.memory ?? [], 'agents[].memory'),
      guardrails: asStrings(entry.guardrails ?? [], 'agents[].guardrails'),
      engine: maybeString(entry.engine, 'native'),
    };
    for (const field of AGENT_FIELDS) {
      if (entry[field] !== undefined) agent[field] = entry[field];
    }
    return agent;
  });
  const copied = (field: string): Json[] =>
    asArray(data[field] ?? [], field).map((raw, index) => ({
      ...asRecord(raw, `${field}[${index}]`),
    }));
  return {
    version: '0.2.0',
    models,
    prompts,
    tools,
    memory: copied('memory'),
    guardrails: copied('guardrails'),
    agents,
  };
}

/** One scripted model turn, in the shape the corpus spells one. */
function scriptedTurn(raw: unknown): ScriptedTurn {
  const step = asRecord(raw, 'script[]');
  if (step.tools !== undefined) {
    const pairs = asArray(step.tools, 'script[].tools').map((item, index) => {
      const pair = asArray(item, `script[].tools[${index}]`);
      return [
        asString(at(pair, 0, 'script[].tools'), 'script[].tools[].name'),
        asRecord(at(pair, 1, 'script[].tools'), 'script[].tools[].arguments'),
      ] as const;
    });
    return ScriptedTurn.tools(...pairs);
  }
  if (step.tool !== undefined) {
    return ScriptedTurn.tool(
      asString(step.tool, 'script[].tool'),
      asRecord(step.arguments ?? {}, 'script[].arguments'),
    );
  }
  return ScriptedTurn.answer(maybeString(step.text, ''));
}

/** A runtime over the case's fixture, plus the provider whose calls are the evidence. */
function agentRuntime(data: Json): { runtime: AgentRuntime; provider: FakeProvider } {
  const provider = new FakeProvider({
    name: AGENT_PROVIDER,
    script: asArray(data.script ?? [], 'script').map(scriptedTurn),
  });
  const tools = asArray(data.tools ?? [], 'tools').map((raw, index) => {
    const entry = asRecord(raw, `tools[${index}]`);
    const name = asString(entry.name, 'tools[].name');
    return Tool.of({
      name,
      handler: (args) => `${name}:${typeof args.query === 'string' ? args.query : ''}`,
      description: maybeString(entry.description, `${name} tool`),
      parameters: QUERY_SCHEMA,
    });
  });
  const runtime = AgentRuntime.fromIr(agentDocument(data), {
    providers: { [AGENT_PROVIDER]: provider },
    tools,
    memoryStore: new InProcessMemoryStore(),
  });
  return { runtime, provider };
}

/**
 * What a run reached, in the terms the corpus asks about.
 *
 * `finalAgent` is the whole transfer/delegate distinction in one field: the agent that
 * produced the answer. `path` says how control got there, and `degraded` is where the
 * alias ladder stepped down.
 */
function agentVerdict(result: RunResult): Json {
  return {
    status: result.status,
    finalAgent: result.agentId,
    answer: result.answer,
    path: [...result.path],
    steps: result.steps.map((step) => ({
      agent: step.agentId,
      kind: step.kind,
      alias: step.alias,
      tools: [...step.toolNames],
      target: step.target ?? null,
      degradedFrom: step.degradedFrom ?? null,
    })),
    degraded: result.degraded.map((pair) => [pair[0], pair[1]]),
  };
}

/** The agent a case names, or the `solo` fixture every one of them declares. */
function agentNamed(data: Json): string {
  return maybeString(data.agent, 'solo');
}

/**
 * One run of one agent, to whatever stop condition it reaches.
 *
 * `agent.steps` and `agent.budget` are the same run reduced the same way: the difference
 * the corpus asks about is whether the loop stopped at its ceiling or threw, and the
 * thrown case is the one a verdict names rather than propagates.
 */
async function agentLoop(input: Json): Promise<Json> {
  const { runtime } = agentRuntime(input);
  try {
    return agentVerdict(await runtime.run(agentNamed(input), asString(input.question, 'question')));
  } catch (error) {
    // D1's default: a breached ceiling is a hard failure, not a status.
    if (error instanceof BudgetExceededError) return { error: 'budget-exceeded' };
    throw error;
  }
}

/**
 * One guarded run, reduced to what the guardrails did to it.
 *
 * A `block` is an exception by design, so it is reported as an `error` like a breached
 * budget is; a `flag` and a `redact` are ordinary runs, and their verdict has to show up
 * in the answer or in `guardrails` or they are not observable.
 */
async function agentGuardrail(input: Json): Promise<Json> {
  const { runtime } = agentRuntime(input);
  try {
    const result = await runtime.run(agentNamed(input), asString(input.question, 'question'));
    return {
      status: result.status,
      answer: result.answer,
      guardrails: result.guardrails.map((record) => ({
        guardrail: record.guardrail,
        stage: record.stage,
        action: record.action,
      })),
    };
  } catch (error) {
    if (error instanceof GuardrailBlockedError) {
      return { error: 'guardrail-blocked', guardrail: error.guardrail, stage: error.stage };
    }
    if (error instanceof ToolPermissionError) {
      return { error: 'tool-permission', tool: error.tool };
    }
    throw error;
  }
}

/** Repeated runs against named memory keys, observed by what the model saw. */
async function agentMemory(input: Json): Promise<Json> {
  const { runtime, provider } = agentRuntime(input);
  const answers: string[] = [];
  for (const key of asStrings(input.memoryKeys, 'memoryKeys')) {
    const result = await runtime.run(agentNamed(input), asString(input.question, 'question'), {
      memoryKey: key,
    });
    answers.push(result.answer);
  }
  return { answers, messagesPerRun: provider.calls.map((request) => request.messages.length) };
}

/**
 * Which backend an `engine` selection resolves to, or why the seam refuses.
 *
 * Every refusal reported here is decided by `checkEngine` before a backend is reached,
 * so the verdict does not depend on what the deployment happens to have installed:
 * transfer is native-only, and a `deepagents` agent must name the release this runtime
 * was built against. The clause order is the refusal order, which is why a `deepagents`
 * handoff reports `handoff-unsupported` rather than a version mismatch.
 */
async function agentEngine(input: Json): Promise<Json> {
  const { runtime } = agentRuntime(input);
  const agent = agentNamed(input);
  try {
    return agentVerdict(await runtime.run(agent, asString(input.question, 'question')));
  } catch (error) {
    if (error instanceof AgentHandoffUnsupportedError) {
      return { error: 'handoff-unsupported', agent: error.agent, engine: error.engine };
    }
    if (error instanceof DeepAgentsVersionMismatchError) {
      return { error: 'version-mismatch', agent: error.agent, declared: error.declared };
    }
    if (error instanceof DeepAgentsUnavailableError) {
      return { error: 'engine-unavailable', agent };
    }
    if (error instanceof ConfigurationError) return { error: 'unknown-engine', agent };
    throw error;
  }
}

/**
 * A paused run carried across a serialisation boundary, then resumed.
 *
 * This is the shape the generated `/resume` route relies on: the run stops at a
 * confirming tool or an escalating guardrail, the caller receives the checkpoint as
 * JSON, and `resume` accepts that JSON back. The round trip goes through
 * `JSON.stringify` rather than through the codec alone, because that is the boundary an
 * emitted route actually crosses -- and a field the wire form silently dropped would
 * make every resumed run start from the wrong step.
 */
async function agentResume(input: Json): Promise<Json> {
  const { runtime } = agentRuntime(input);
  const paused = await runtime.run(agentNamed(input), asString(input.question, 'question'));
  const checkpoint = paused.checkpoint;
  if (checkpoint === undefined) return { error: 'did-not-pause', status: paused.status };
  const wire: unknown = JSON.parse(JSON.stringify(checkpointToJson(checkpoint)));
  const restored = checkpointFromJson(asRecord(wire, 'checkpoint wire'));
  const answer = maybeString(input.decision, 'approve');
  if (answer !== 'approve' && answer !== 'reject') {
    throw new TypeError(`corpus field decision is neither approve nor reject: ${answer}`);
  }
  const resumed = await runtime.resume(restored, answer);
  const approval = pendingApprovalFrom(checkpoint);
  return {
    pausedStatus: paused.status,
    channel: approval.channel,
    askTools: approval.calls.map((call) => call.name),
    wireRoundTrip: checkpointsEqual(restored, checkpoint),
    status: resumed.status,
    answer: resumed.answer,
  };
}

/**
 * A file-backed tier read back through a second store on the same path.
 *
 * `InProcessMemoryStore` is covered by `agent.memory`; this is the other backend the
 * emitted document can name, and the difference that matters is durability. A second
 * instance is what a second request -- or a restarted process -- is, so reading through
 * one is the property and not an implementation detail.
 */
async function memoryStore(input: Json): Promise<Json> {
  const scope = asString(input.scope, 'scope');
  const key = asString(input.key, 'key');
  const directory = mkdtempSync(join(tmpdir(), 'aid-memory-'));
  try {
    const path = join(directory, 'memory.json');
    const writer = new FileMemoryStore(path);
    for (const value of asStrings(input.values, 'values')) {
      await writer.append({ scope, key, value });
    }
    const reader = new FileMemoryStore(path);
    return {
      values: await reader.read({ scope, key }),
      otherScopeValues: await reader.read({ scope: 'nobody', key }),
      fileWritten: existsSync(path),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * One `agent` step: what it bound, and where its spend landed.
 *
 * The runtime is built over the *enclosing* gateway, the way the emitted step builds it
 * over `deps.gateway`, so the tokens the agent spends have to appear on that gateway's
 * ledger: `charged` is the whole budget claim in one field. `AgentRuntime.fromIr` would
 * build a gateway of its own, which reports `charged: false` and escapes a pipeline
 * budget while still looking like it has one -- so the spec is resolved here and the
 * gateway is constructed once, outside the runtime.
 */
async function stepsAgent(input: Json): Promise<Json> {
  const spec = fromIr(agentDocument(input));
  const provider = new FakeProvider({
    name: AGENT_PROVIDER,
    script: asArray(input.script ?? [], 'script').map(scriptedTurn),
  });
  const gateway = new ModelGateway({
    providers: { [AGENT_PROVIDER]: provider },
    aliases: Object.fromEntries(spec.models),
  });
  const runtime = new AgentRuntime(spec, gateway, { tools: [] });
  const result = await runtime.run(asString(input.agent, 'agent'), asString(input.text, 'text'));
  const spent = gateway.ledger;
  return {
    status: result.status,
    answer: result.answer,
    calls: provider.calls.length,
    charged: spent.entries.length === provider.calls.length && spent.totalTokens > 0,
  };
}

const OPS: Readonly<Record<string, Handler>> = {
  'alias.resolve': aliasResolve,
  'alias.unknown': aliasUnknown,
  'alias.require': aliasRequire,
  'alias.table': aliasTable,
  'budget.estimate': budgetEstimate,
  'budget.ledger': budgetLedger,
  'prompt.render': promptRender,
  'prompt.latest': promptLatest,
  'structured.parse': structuredParse,
  'structured.repair': structuredRepair,
  'retrieval.bm25': retrievalBm25,
  'retrieval.ranking': retrievalRanking,
  'retrieval.rrf': retrievalRrf,
  'retrieval.similarity': retrievalSimilarity,
  'retrieval.lexical-score': retrievalLexical,
  'eval.z-critical': evalZCritical,
  'eval.gate': evalGate,
  'eval.gate-summary': evalGateSummary,
  'eval.assert': evalAssert,
  'steps.branch': stepsBranch,
  'steps.parallel': stepsParallel,
  'steps.map': stepsMap,
  'steps.reduce': stepsReduce,
  'steps.depth': stepsDepth,
  'steps.rerank': stepsRerank,
  'steps.guard': stepsGuard,
  'steps.agent': stepsAgent,
  'agent.steps': agentLoop,
  'agent.budget': agentLoop,
  'agent.transfer': agentLoop,
  'agent.delegate': agentLoop,
  'agent.guardrail': agentGuardrail,
  'agent.memory': agentMemory,
  'agent.engine': agentEngine,
  'agent.resume': agentResume,
  'memory.store': memoryStore,
};

// --- verdicts -------------------------------------------------------------------

/**
 * Make a verdict JSON-safe and stable across two float implementations.
 *
 * JSON has no spelling for the non-finite numbers. A degenerate distribution produces
 * an infinite z, and that infinite statistic is the behaviour under test, so it is
 * carried as `"inf"` rather than dropped.
 *
 * Finite floats are quantised to six decimal places. The two runtimes are separate
 * summations of the same arithmetic, so their last bits differ; six places is the
 * precision the corpus actually pins, and it is far below any behavioural difference.
 * It also keeps the corpus readable and stops a summation artefact such as
 * `-1.1102230246251565e-16` being pinned as if it were behaviour. `-0.0` is folded
 * into `0.0` for the same reason: the sign is a spelling, not a behaviour.
 */
function clean(value: unknown): unknown {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return 'nan';
    if (value === Number.POSITIVE_INFINITY) return 'inf';
    if (value === Number.NEGATIVE_INFINITY) return '-inf';
    const rounded = Number(value.toFixed(PRECISION));
    return rounded === 0 ? 0 : rounded;
  }
  if (Array.isArray(value)) return value.map((item) => clean(item));
  if (typeof value === 'object' && value !== null) {
    const out: Json = {};
    for (const [key, item] of Object.entries(value)) out[key] = clean(item);
    return out;
  }
  return value;
}

/**
 * Every runtime the corpus is written for. A case may name which of them it applies
 * to; naming none means all of them.
 */
const RUNTIMES = ['python', 'typescript'] as const;

/** This runner's name, as a case spells it. */
const SELF = 'typescript';

/**
 * Why this case is out of scope for `runtime`, or null when it is in scope.
 *
 * A case that says nothing about runtimes is in scope everywhere. A case that narrows
 * the field must leave a reason behind, because "not implemented yet" and "not
 * applicable" are indistinguishable from the outside -- and the difference decides
 * whether the work is finished or merely deferred.
 *
 * The mechanism is deliberately strict in both directions: an unknown runtime name is
 * an error rather than a typo that quietly narrows a case to nothing, a case that
 * scopes itself away from every runtime is an error rather than a no-op, and a case
 * that names a runtime still has to have its op implemented *there* -- `loadCorpus`
 * enforces that, which is what stops scope becoming a way to skip a case a runtime
 * claims to check.
 *
 * The scope is a property of the case and the runtime together, never of the case
 * alone: the comparator asks this question about *another* runtime's artefact, so a
 * scope resolved once for the local runtime would be the wrong answer there.
 */
function scopeFor(entry: Case, runtime: string): string | null {
  if (entry.runtimes.length === 0 || entry.runtimes.includes(runtime)) return null;
  return entry.reason;
}

/** Validates a case's `runtimes`/`reason` fields and returns them normalised. */
function readScope(id: string, item: Json): { runtimes: readonly string[]; reason: string } {
  const declared = item.runtimes;
  if (declared === undefined) return { runtimes: [], reason: '' };
  if (!Array.isArray(declared) || declared.length === 0) {
    throw new Error(`${id}: 'runtimes' must be a non-empty array of runtime names`);
  }
  const bad = declared.filter(
    (name) => typeof name !== 'string' || !(RUNTIMES as readonly string[]).includes(name),
  );
  if (bad.length > 0) {
    throw new Error(
      `${id}: 'runtimes' names ${show(bad)}; expected a subset of ${show([...RUNTIMES])}`,
    );
  }
  const runtimes = declared as string[];
  if (new Set(runtimes).size !== runtimes.length) {
    throw new Error(`${id}: 'runtimes' names a runtime twice: ${show(runtimes)}`);
  }
  if (item.reason !== undefined && typeof item.reason !== 'string') {
    throw new Error(`${id}: 'reason' must be a string`);
  }
  const reason = typeof item.reason === 'string' ? item.reason.trim() : '';
  const leftOut = RUNTIMES.filter((name) => !runtimes.includes(name));
  if (leftOut.length > 0 && reason === '') {
    throw new Error(
      `${id}: scoped away from ${show(leftOut)} without a 'reason'; a case some runtime ` +
        'does not check must say why, or the gap is invisible',
    );
  }
  return { runtimes, reason };
}

/**
 * The corpus this runner resolves.
 *
 * The op check applies to the cases *this* runtime claims. A case scoped to another
 * runtime names an op this runtime may not implement yet, and refusing the whole
 * corpus over it would make adding a case for one runtime impossible without first
 * writing the other -- but a case that names this runtime still has to be runnable
 * here, so scope can never be used to skip a case that was claimed.
 */
function loadCorpus(): Corpus {
  const raw: unknown = JSON.parse(readFileSync(CORPUS_PATH, 'utf8'));
  const record = asRecord(raw, 'corpus');
  const seen = new Set<string>();
  const cases = asArray(record.cases, 'cases').map((entry) => {
    const item = asRecord(entry, 'case');
    const id = asString(item.id, 'case.id');
    const op = asString(item.op, 'case.op');
    if (seen.has(id)) {
      throw new Error(`duplicate case id in the corpus: ${id}`);
    }
    seen.add(id);
    const { runtimes, reason } = readScope(id, item);
    const scoped: Case = {
      id,
      op,
      input: asRecord(item.input, 'case.input'),
      expect: item.expect,
      runtimes,
      reason,
    };
    if (scopeFor(scoped, SELF) === null && !(op in OPS)) {
      throw new Error(`${id}: the corpus names an unknown op ${JSON.stringify(op)}`);
    }
    return scoped;
  });
  return { cases };
}

async function buildVerdicts(corpus: Corpus): Promise<Entry[]> {
  const verdicts: Entry[] = [];
  for (const entry of corpus.cases) {
    // A case that is out of scope is reported as such rather than omitted, so both
    // runtimes' artefacts list the same ids and a population mismatch still means what
    // it says.
    const scopedOut = scopeFor(entry, SELF);
    if (scopedOut !== null) {
      verdicts.push({ id: entry.id, status: 'scoped-out', reason: scopedOut });
      continue;
    }
    const handler = OPS[entry.op];
    if (handler === undefined) throw new TypeError(`the corpus names no op ${entry.op}`);
    verdicts.push({
      id: entry.id,
      status: 'evaluated',
      verdict: clean(await handler(entry.input)),
    });
  }
  return verdicts;
}

// --- comparing ------------------------------------------------------------------

function show(value: unknown): string {
  if (value === undefined) return 'undefined';
  return JSON.stringify(value) ?? String(value);
}

/**
 * The first place `observed` departs from `expected`, or null.
 *
 * Numbers compare within a tolerance because the two runtimes are separate summations
 * of the same arithmetic; everything else compares exactly.
 */
function drift(expected: unknown, observed: unknown, path = '$'): string | null {
  if (typeof expected === 'boolean' || typeof observed === 'boolean') {
    return expected === observed ? null : `${path}: ${show(expected)} != ${show(observed)}`;
  }
  if (typeof expected === 'number' && typeof observed === 'number') {
    if (Math.abs(expected - observed) <= TOLERANCE) return null;
    return `${path}: ${show(expected)} != ${show(observed)}`;
  }
  if (Array.isArray(expected) && Array.isArray(observed)) {
    if (expected.length !== observed.length) {
      return `${path}: ${expected.length} items != ${observed.length} items`;
    }
    for (const [index, left] of expected.entries()) {
      const found = drift(left, observed[index], `${path}[${index}]`);
      if (found !== null) return found;
    }
    return null;
  }
  if (isRecord(expected) && isRecord(observed)) {
    const left = Object.keys(expected).sort();
    const right = Object.keys(observed).sort();
    if (left.join('\u0000') !== right.join('\u0000')) {
      return `${path}: keys [${left.join(', ')}] != [${right.join(', ')}]`;
    }
    for (const key of left) {
      const found = drift(expected[key], observed[key], `${path}.${key}`);
      if (found !== null) return found;
    }
    return null;
  }
  return expected === observed ? null : `${path}: ${show(expected)} != ${show(observed)}`;
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every in-scope case whose observed verdict disagrees with the corpus. */
function report(corpus: Corpus, verdicts: readonly Entry[]): string[] {
  const expected = new Map(corpus.cases.map((entry) => [entry.id, entry.expect]));
  const failures: string[] = [];
  for (const entry of verdicts) {
    if (entry.status !== 'evaluated') continue;
    const found = drift(expected.get(entry.id), entry.verdict);
    if (found !== null) failures.push(`${entry.id}: ${found}`);
  }
  return failures;
}

function readArtefact(path: string, what: string): Artefact {
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const record = asRecord(raw, what);
  return {
    runtime: asString(record.runtime, `${what}.runtime`),
    corpusPath: asString(record.corpusPath, `${what}.corpusPath`),
    cases: asArray(record.cases, `${what}.cases`).map((entry) => {
      const item = asRecord(entry, `${what} case`);
      const id = asString(item.id, `${what} case id`);
      const status = asString(item.status, `${what} case ${id} status`);
      if (status === 'scoped-out') {
        return { id, status, reason: asString(item.reason, `${what} case ${id} reason`) };
      }
      if (status !== 'evaluated') {
        throw new Error(`${what}: case ${id} has status ${JSON.stringify(status)}`);
      }
      return { id, status, verdict: item.verdict };
    }),
  };
}

function firstById(cases: readonly Entry[]): Map<string, Entry> {
  const byId = new Map<string, Entry>();
  for (const entry of cases) if (!byId.has(entry.id)) byId.set(entry.id, entry);
  return byId;
}

/**
 * Structural problems with one runtime's verdict artefact.
 *
 * These are the failures a runtime cannot detect on its own, because on its own it has
 * no independent notion of the expected population: a case the corpus expects but the
 * runner never emitted, an id it invented, or the same id twice all look like a normal
 * run from the inside.
 *
 * A runtime's artefact must also agree with the corpus about what that runtime was
 * asked to evaluate. A runner that skipped a case it was in scope for would otherwise
 * look like a smaller corpus; naming the disagreement keeps "scoped-out" a claim the
 * comparator checks rather than one it takes on trust.
 */
function population(corpus: Corpus, artefact: Artefact): string[] {
  const problems: string[] = [];
  const expected = corpus.cases.map((entry) => entry.id);
  const known = new Set(expected);
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const unknown = new Set<string>();
  for (const entry of artefact.cases) {
    if (seen.has(entry.id)) duplicates.add(entry.id);
    seen.add(entry.id);
    if (!known.has(entry.id)) unknown.add(entry.id);
  }
  for (const id of [...duplicates].sort()) problems.push(`duplicate case id ${id}`);
  for (const id of [...unknown].sort()) problems.push(`unknown case id ${id}`);
  for (const id of expected.filter((entry) => !seen.has(entry)))
    problems.push(`missing case ${id}`);
  for (const entry of corpus.cases) {
    const emitted = artefact.cases.find((item) => item.id === entry.id);
    if (emitted === undefined) continue;
    // The scope is resolved against the artefact's own runtime. Resolving it once for
    // the local runtime is the obvious mistake here, and it has a distinctive symptom:
    // the other runtime is accused of evaluating cases nobody scoped away from it.
    const scopedOut = scopeFor(entry, artefact.runtime);
    if (scopedOut === null && emitted.status !== 'evaluated') {
      problems.push(`${entry.id}: scoped out by ${artefact.runtime} but in scope for it`);
    }
    if (scopedOut !== null && emitted.status !== 'scoped-out') {
      problems.push(`${entry.id}: ${artefact.runtime} evaluated a case scoped away from it`);
    }
  }
  if (artefact.cases.length !== expected.length) {
    problems.push(`${artefact.cases.length} cases but the corpus has ${expected.length}`);
  }
  if (artefact.corpusPath !== CORPUS_PATH) {
    problems.push(`resolved the corpus at ${artefact.corpusPath}, not ${CORPUS_PATH}`);
  }
  return problems.map((problem) => `${artefact.runtime}: ${problem}`);
}

/**
 * The cross-language diff: the claim the conformance suite exists to make.
 *
 * Only cases both runtimes evaluated are compared. A case scoped to one runtime is
 * checked by that runtime alone; comparing it against a runtime that never ran it would
 * be an equality over nothing, which is the failure mode the scoping exists to avoid.
 */
function comparison(corpus: Corpus, python: Artefact, typescript: Artefact): string[] {
  const pythonById = firstById(python.cases);
  const typescriptById = firstById(typescript.cases);
  const problems: string[] = [];
  for (const entry of corpus.cases) {
    const left = pythonById.get(entry.id);
    const right = typescriptById.get(entry.id);
    if (left === undefined || right === undefined) {
      problems.push(`${entry.id}: emitted by only one runtime`);
      continue;
    }
    if (left.status !== 'evaluated' || right.status !== 'evaluated') {
      // Legitimately not comparable. Whether that is *legal* was already decided by
      // `population`, which checks each artefact against its own runtime's scope; this
      // function only says what can be compared.
      continue;
    }
    const cross = drift(left.verdict, right.verdict);
    if (cross !== null) {
      problems.push(`${entry.id}: python != typescript ${cross}`);
      continue;
    }
    // The runtimes agree, so if they also disagree with the corpus the corpus is the
    // thing that moved. Worth saying separately: it is a different fix.
    const stale = drift(entry.expect, left.verdict);
    if (stale !== null)
      problems.push(`${entry.id}: both runtimes disagree with the corpus ${stale}`);
  }
  return problems;
}

// --- entry point ----------------------------------------------------------------

function line(text: string): void {
  process.stdout.write(`${text}\n`);
}

function write(path: string, corpus: Corpus, verdicts: readonly Entry[]): void {
  const payload = { runtime: 'typescript', corpusPath: CORPUS_PATH, cases: verdicts };
  void corpus;
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function runMode(corpus: Corpus, output: string | undefined): Promise<number> {
  const verdicts = await buildVerdicts(corpus);
  const failures = report(corpus, verdicts);
  const total = corpus.cases.length;
  const scoped = verdicts.filter((entry) => entry.status === 'scoped-out');
  const evaluated = total - scoped.length;
  line(`corpus: ${CORPUS_PATH}`);
  // The denominator is what this runtime was asked to evaluate, and the scoped count is
  // printed beside it rather than folded in. A run that silently checked five fewer
  // cases would otherwise report a full pass over a corpus it had shrunk.
  line(
    `typescript: ${evaluated - failures.length}/${evaluated} evaluated (${failures.length} failed), ` +
      `${scoped.length}/${total} scoped to other runtimes`,
  );
  for (const entry of scoped) line(`  out of scope: ${entry.id} -- ${entry.reason ?? ''}`);
  for (const failure of failures) line(`  ${failure}`);
  if (output !== undefined) write(output, corpus, verdicts);
  if (total === 0) {
    line('  the corpus is empty; a run that checks nothing is a failure');
    return 1;
  }
  if (evaluated === 0) {
    line('  every case was scoped away from this runtime; a run that checks nothing is a failure');
    return 1;
  }
  return failures.length === 0 ? 0 : 1;
}

function compareMode(corpus: Corpus, pythonPath: string, typescriptPath: string): number {
  const python = readArtefact(pythonPath, 'python verdicts');
  const typescript = readArtefact(typescriptPath, 'typescript verdicts');
  const problems = [
    ...population(corpus, python),
    ...population(corpus, typescript),
    ...comparison(corpus, python, typescript),
  ];
  const total = corpus.cases.length;
  const pythonById = firstById(python.cases);
  const typescriptById = firstById(typescript.cases);
  const evaluatedBy = (artefact: Artefact): number =>
    artefact.cases.filter((entry) => entry.status === 'evaluated').length;
  const pythonEvaluated = evaluatedBy(python);
  const typescriptEvaluated = evaluatedBy(typescript);
  // What `comparison` actually compared, counted from the same artefacts it read: a case
  // is compared only when both runtimes evaluated it. Deriving the number rather than
  // asserting one keeps this summary honest when the scope says one runtime alone owns a
  // case -- on those the two runtimes are not comparable, and printing `python ==
  // typescript` over the whole corpus would claim an equality nobody computed.
  const bothExpected = corpus.cases.filter(
    (entry) => scopeFor(entry, 'python') === null && scopeFor(entry, 'typescript') === null,
  ).length;
  const compared = corpus.cases.filter(
    (entry) =>
      pythonById.get(entry.id)?.status === 'evaluated' &&
      typescriptById.get(entry.id)?.status === 'evaluated',
  ).length;
  line(`corpus: ${CORPUS_PATH}`);
  // The relation is printed, not decorated: `==` between counts that differ would have
  // the first line of a red job assert the very equality that just failed.
  const relation = pythonEvaluated === typescriptEvaluated ? '==' : '!=';
  line(
    `evaluated: python ${pythonEvaluated}/${total} ${relation} typescript ${typescriptEvaluated}/${total}`,
  );
  line(`compared: ${compared}/${bothExpected} cases in scope for both runtimes`);
  if (total === 0) {
    line('  the corpus is empty; a comparison of nothing is a failure');
    return 1;
  }
  if (bothExpected === 0) {
    line('  no case is in scope for both runtimes; a comparison of nothing is a failure');
    return 1;
  }
  // Every problem is printed before the decision, so a run that fails always names
  // the case that failed. An early exit on the first symptom would report "the sizes
  // differ" and leave the missing id to be guessed at.
  for (const problem of problems) line(`  ${problem}`);
  if (compared !== bothExpected) {
    line(`  compared ${compared} cases but ${bothExpected} are in scope for both runtimes`);
  }
  return problems.length === 0 && compared === bothExpected ? 0 : 1;
}

async function main(argv: readonly string[]): Promise<number> {
  const corpus = loadCorpus();
  if (argv[0] === '--compare') {
    const [pythonPath, typescriptPath] = [argv[1], argv[2]];
    if (pythonPath === undefined || typescriptPath === undefined) {
      line('usage: run.ts --compare <python-verdicts.json> <typescript-verdicts.json>');
      return 2;
    }
    return compareMode(corpus, pythonPath, typescriptPath);
  }
  return runMode(corpus, argv[0]);
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  line(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
