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

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';
import type {
  Capability,
  DistanceMetric,
  GateResult,
  Provider,
  RankedId,
  StructuredOutput,
} from '../../dist/index.js';
import {
  AidRuntimeError,
  BaselineGate,
  Budget,
  BudgetExceededError,
  bm25Scores,
  CapabilityMismatchError,
  CostLedger,
  CostProfile,
  EvalBaseline,
  EvalRun,
  estimateCostUsd,
  fuse,
  LedgerEntry,
  lexicalRanking,
  lexicalScore,
  MetricBaseline,
  MetricRun,
  ModelGateway,
  ModelSpec,
  PromptNotFoundError,
  PromptRegistry,
  PromptRenderError,
  PromptTemplate,
  parseStructured,
  runStructured,
  StructuredOutputError,
  similarity,
  Threshold,
  TokenUsage,
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
