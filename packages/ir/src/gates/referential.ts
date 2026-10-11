/**
 * Gate 1 — referential integrity (§7.1).
 *
 * Every reference resolves, and resolves to the right *kind*: a `tool` step naming
 * a prompt is an error, not a lookup miss. Bindings are defined before use and
 * unique within one pipeline scope, prompt placeholders and variables agree, and
 * a model's fallback chain terminates.
 */

import { templatePlaceholders } from '../build.js';
import { IR_DIAGNOSTIC_CODES, type IrDiagnostic } from '../diagnostics.js';
import type { IR, PipelineShape, StepInputValue, StepShape, TypeRef } from '../shapes.js';
import { type GateOptions, type GateResult, reporter, type SuppressedCheck } from './contract.js';

/** The id namespaces a reference can name. */
const NAMESPACES = [
  'types',
  'models',
  'prompts',
  'tools',
  'stores',
  'retrievers',
  'pipelines',
] as const;

type Namespace = (typeof NAMESPACES)[number];

interface Scope {
  names: Record<Namespace, Set<string>>;
}

/**
 * The spec declares no pipeline input schema in v0.1, so a step input that reads a
 * request field cannot be checked against anything. That is a genuine gap, not a
 * pass, so it is reported as suppressed rather than left silent.
 */
const SUPPRESSED: SuppressedCheck[] = [
  {
    check: 'referential/request-input-fields',
    reason:
      'the spec DSL declares no pipeline input schema in v0.1, so a reference to an incoming request field (rather than to a prior step binding) cannot be validated against a declaration',
  },
];

export function referentialGate(ir: IR, options: GateOptions): GateResult {
  const diagnostics: IrDiagnostic[] = [];
  const report = reporter(options);
  const scope: Scope = {
    names: {
      types: new Set(ir.types.map((entry) => entry.id)),
      models: new Set(ir.models.map((entry) => entry.id)),
      prompts: new Set(ir.prompts.map((entry) => entry.id)),
      tools: new Set(ir.tools.map((entry) => entry.id)),
      stores: new Set(ir.stores.map((entry) => entry.id)),
      retrievers: new Set(ir.retrievers.map((entry) => entry.id)),
      pipelines: new Set(ir.pipelines.map((entry) => entry.id)),
    },
  };

  checkTypeGraph(ir, diagnostics, report);
  checkModels(ir, scope, diagnostics, report);
  checkPrompts(ir, scope, diagnostics, report);
  checkTools(ir, diagnostics, report);
  checkRetrieval(ir, scope, diagnostics, report);
  checkPipelines(ir, scope, diagnostics, report);
  checkEvals(ir, scope, diagnostics, report);

  return { diagnostics, suppressed: SUPPRESSED };
}

type Reporter = ReturnType<typeof reporter>;

/** Reports a missed reference, distinguishing "wrong kind" from "does not exist". */
function reportRef(
  name: string,
  expected: Namespace,
  scope: Scope,
  path: (string | number)[],
  diagnostics: IrDiagnostic[],
  report: Reporter,
): void {
  const singular = expected.slice(0, -1);
  const foreign = NAMESPACES.find((kind) => kind !== expected && scope.names[kind].has(name));
  if (foreign !== undefined) {
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.refKindMismatch,
        message: `the referential gate rejected this reference: "${name}" is a ${foreign.slice(0, -1)}, but a ${singular} is required here`,
        path,
        hint: `reference an existing ${singular}, or rename "${name}"`,
      }),
    );
    return;
  }
  diagnostics.push(
    report.error({
      code: IR_DIAGNOSTIC_CODES.refUnresolved,
      message: `the referential gate rejected this reference: no ${singular} named "${name}" exists`,
      path,
      hint: 'declare it, or correct the name',
    }),
  );
}

function reportTypeRef(
  ref: TypeRef,
  path: (string | number)[],
  diagnostics: IrDiagnostic[],
  report: Reporter,
): void {
  if (ref.kind !== 'named' || ref.resolved) return;
  diagnostics.push(
    report.error({
      code: IR_DIAGNOSTIC_CODES.typeUnresolved,
      message: `the referential gate rejected this reference: type "${ref.name}" has no definition`,
      path,
      hint: 'declare it under types, or use a primitive type',
    }),
  );
}

function checkTypeGraph(ir: IR, diagnostics: IrDiagnostic[], report: Reporter): void {
  for (const type of ir.types) {
    type.fields.forEach((field, index) => {
      reportTypeRef(field.type, ['types', type.id, 'fields', index, 'type'], diagnostics, report);
    });
  }

  const cycle = findTypeCycle(ir);
  if (cycle === undefined) return;
  diagnostics.push(
    report.error({
      code: IR_DIAGNOSTIC_CODES.typeCycle,
      message: `the referential gate rejected this type: it participates in a reference cycle (${cycle.join(' -> ')})`,
      path: ['types', cycle[0] ?? ''],
      hint: 'a type graph must be acyclic so a generator can order declarations',
    }),
  );
}

/** Depth-first search returning the first cycle of a directed graph as `[a, b, a]`. */
function firstCycle(edges: Map<string, string[]>): string[] | undefined {
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): string[] | undefined => {
    const seen = state.get(id);
    if (seen === 'done') return undefined;
    if (seen === 'visiting') return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 'visiting');
    stack.push(id);
    for (const next of edges.get(id) ?? []) {
      if (!edges.has(next)) continue;
      const found = visit(next);
      if (found !== undefined) return found;
    }
    stack.pop();
    state.set(id, 'done');
    return undefined;
  };

  for (const id of edges.keys()) {
    const found = visit(id);
    if (found !== undefined) return found;
  }
  return undefined;
}

function findTypeCycle(ir: IR): string[] | undefined {
  return firstCycle(
    new Map(
      ir.types.map((type) => [
        type.id,
        type.fields.flatMap((field) => (field.type.kind === 'named' ? [field.type.name] : [])),
      ]),
    ),
  );
}

function checkModels(ir: IR, scope: Scope, diagnostics: IrDiagnostic[], report: Reporter): void {
  for (const model of ir.models) {
    model.fallbacks.forEach((alias, index) => {
      if (scope.names.models.has(alias)) return;
      reportRef(
        alias,
        'models',
        scope,
        ['models', model.id, 'fallbacks', index],
        diagnostics,
        report,
      );
    });
  }

  const cycle = firstCycle(new Map(ir.models.map((model) => [model.id, model.fallbacks])));
  if (cycle === undefined) return;
  diagnostics.push(
    report.error({
      code: IR_DIAGNOSTIC_CODES.fallbackCycle,
      message: `the referential gate rejected this fallback chain: it cycles (${cycle.join(' -> ')})`,
      path: ['models', cycle[0] ?? '', 'fallbacks'],
      hint: 'a fallback chain must terminate at a model that declares no fallbacks',
    }),
  );
}

function checkPrompts(ir: IR, scope: Scope, diagnostics: IrDiagnostic[], report: Reporter): void {
  for (const prompt of ir.prompts) {
    if (!scope.names.models.has(prompt.model)) {
      reportRef(
        prompt.model,
        'models',
        scope,
        ['prompts', prompt.id, 'model'],
        diagnostics,
        report,
      );
    }
    if (prompt.output.schema !== undefined) {
      reportTypeRef(
        prompt.output.schema,
        ['prompts', prompt.id, 'output', 'schema'],
        diagnostics,
        report,
      );
    }

    const declared = new Set(prompt.variables.map((variable) => variable.name));
    const used = templatePlaceholders(prompt.template);
    for (const placeholder of used) {
      if (declared.has(placeholder)) continue;
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.promptVariableUndeclared,
          message: `the referential gate rejected this placeholder: prompt "${prompt.id}" uses "{{${placeholder}}}" but declares no variable named "${placeholder}"`,
          path: ['prompts', prompt.id, 'template'],
          hint: 'declare it under prompts.<id>.variables, or remove the placeholder',
        }),
      );
    }
    for (const variable of prompt.variables) {
      if (used.includes(variable.name)) continue;
      diagnostics.push(
        report.warn({
          code: IR_DIAGNOSTIC_CODES.promptVariableUnused,
          message: `the referential gate flagged this variable: prompt "${prompt.id}" declares "${variable.name}" but its template never uses "{{${variable.name}}}"`,
          path: ['prompts', prompt.id, 'variables', variable.name],
        }),
      );
    }
  }
}

function checkTools(ir: IR, diagnostics: IrDiagnostic[], report: Reporter): void {
  for (const tool of ir.tools) {
    reportTypeRef(tool.input, ['tools', tool.id, 'input'], diagnostics, report);
    reportTypeRef(tool.output, ['tools', tool.id, 'output'], diagnostics, report);
  }
}

/**
 * A retriever's own references: the store it writes to and reads from, the model that
 * embeds for it, and the model that reranks (when one is declared).
 *
 * The embedding model is held to a second condition the other references do not have:
 * it must *declare* `embeddings`, because the IR derives the `embeddings` collection
 * from exactly that declaration, and an embedder that cannot produce vectors would
 * otherwise only fail at retrieval time, in the runtime, on a real query.
 */
function checkRetrieval(ir: IR, scope: Scope, diagnostics: IrDiagnostic[], report: Reporter): void {
  const models = new Map(ir.models.map((model) => [model.id, model]));
  for (const retriever of ir.retrievers) {
    const base = ['retrievers', retriever.id];
    if (!scope.names.stores.has(retriever.store)) {
      reportRef(retriever.store, 'stores', scope, [...base, 'store'], diagnostics, report);
    }

    const embedModel = models.get(retriever.embedModel);
    if (embedModel === undefined) {
      reportRef(
        retriever.embedModel,
        'models',
        scope,
        [...base, 'embedModel'],
        diagnostics,
        report,
      );
    } else if (!embedModel.capabilities.includes('embeddings')) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.modelCapabilityMissing,
          message: `the referential gate rejected this embedding model: retriever "${retriever.id}" embeds with model "${embedModel.id}", which does not declare the "embeddings" capability`,
          path: [...base, 'embedModel'],
          hint: 'declare "embeddings" on the model, or point embedModel at a model that does',
        }),
      );
    }

    if (retriever.rerank !== undefined && !scope.names.models.has(retriever.rerank.model)) {
      reportRef(
        retriever.rerank.model,
        'models',
        scope,
        [...base, 'rerank', 'model'],
        diagnostics,
        report,
      );
    }
  }
}

function checkPipelines(ir: IR, scope: Scope, diagnostics: IrDiagnostic[], report: Reporter): void {
  for (const pipeline of ir.pipelines) {
    checkPipelineSteps(pipeline, ir, scope, diagnostics, report);
  }
}

function checkPipelineSteps(
  pipeline: PipelineShape,
  ir: IR,
  scope: Scope,
  diagnostics: IrDiagnostic[],
  report: Reporter,
): void {
  const bound = new Map<string, number>();
  const allBindings = new Set<string>();
  for (const step of pipeline.steps) {
    if (step.kind !== 'emit') allBindings.add(step.as);
  }

  pipeline.steps.forEach((step, index) => {
    const base = ['pipelines', pipeline.id, 'steps', index];

    if (step.kind === 'generate') {
      if (scope.names.prompts.has(step.prompt)) {
        checkPromptInput(step, ir, base, diagnostics, report);
      } else {
        reportRef(step.prompt, 'prompts', scope, [...base, 'prompt'], diagnostics, report);
      }
    } else if (step.kind === 'tool') {
      if (!scope.names.tools.has(step.tool)) {
        reportRef(step.tool, 'tools', scope, [...base, 'tool'], diagnostics, report);
      }
    } else if (step.kind === 'retrieve') {
      if (!scope.names.retrievers.has(step.retriever)) {
        reportRef(step.retriever, 'retrievers', scope, [...base, 'retriever'], diagnostics, report);
      }
    } else if (!scope.names.types.has(step.event)) {
      reportRef(step.event, 'types', scope, [...base, 'event'], diagnostics, report);
    }

    if (step.kind === 'emit') return;

    const previous = bound.get(step.as);
    if (previous !== undefined) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.bindingDuplicate,
          message: `the referential gate rejected this binding: "${step.as}" is already bound by step ${previous} in pipeline "${pipeline.id}"`,
          path: [...base, 'as'],
          hint: 'a binding name is unique within one pipeline scope',
        }),
      );
    }

    for (const { path, value } of stepReferences(step)) {
      for (const root of referencedRoots(value)) {
        if (bound.has(root) || !allBindings.has(root)) continue;
        diagnostics.push(
          report.error({
            code: IR_DIAGNOSTIC_CODES.bindingForwardReference,
            message: `the referential gate rejected this reference: "${root}" is bound by a later step of pipeline "${pipeline.id}"`,
            path: [...base, ...path],
            hint: 'bindings are defined before use',
          }),
        );
      }
    }

    bound.set(step.as, index);
  });
}

/** Where one step's references live, so the forward-reference rule covers every kind. */
function stepReferences(step: StepShape): { path: (string | number)[]; value: StepInputValue }[] {
  if (step.kind === 'emit') return [];
  if (step.kind === 'retrieve') {
    return [{ path: ['query'], value: { kind: 'template', template: step.query } }];
  }
  const references = Object.entries(step.input).map(([key, value]) => ({
    path: ['input', key],
    value,
  }));
  if (step.kind === 'generate' && step.context !== undefined) {
    references.push({ path: ['context'], value: { kind: 'reference', path: [step.context] } });
  }
  return references;
}

/**
 * A required prompt variable with no default has to be supplied by the step, or
 * the generated call has nothing to render the placeholder from.
 *
 * A retrieved context is one of the ways a step supplies one: `context` names the
 * binding whose items are inlined into the prompt, so a variable with that name is
 * fed by it. That is the only channel the retrieved items reach the prompt through.
 */
function checkPromptInput(
  step: StepShape & { kind: 'generate' },
  ir: IR,
  base: (string | number)[],
  diagnostics: IrDiagnostic[],
  report: Reporter,
): void {
  const prompt = ir.prompts.find((entry) => entry.id === step.prompt);
  if (prompt === undefined) return;
  for (const variable of prompt.variables) {
    if (!variable.required || variable.default !== undefined) continue;
    if (Object.hasOwn(step.input, variable.name)) continue;
    if (step.context === variable.name) continue;
    diagnostics.push(
      report.error({
        code: IR_DIAGNOSTIC_CODES.promptInputMissing,
        message: `the referential gate rejected this step: prompt "${prompt.id}" requires "${variable.name}", which this step's input does not supply`,
        path: [...base, 'input'],
        hint: `add "${variable.name}" to the step input, give the variable a default, or mark it optional`,
      }),
    );
  }
}

function referencedRoots(value: StepInputValue): string[] {
  if (value.kind === 'reference') {
    const root = value.path[0];
    return root === undefined ? [] : [root];
  }
  return value.kind === 'template' ? templatePlaceholders(value.template) : [];
}

function checkEvals(ir: IR, scope: Scope, diagnostics: IrDiagnostic[], report: Reporter): void {
  for (const evalShape of ir.evals) {
    const path = ['evals', evalShape.id, 'target'];
    if (!evalShape.target.valid) {
      diagnostics.push(
        report.error({
          code: IR_DIAGNOSTIC_CODES.evalTargetInvalid,
          message: `the referential gate rejected this target: "${evalShape.target.qualified}" is not a "kind:id" pair naming a known kind`,
          path,
          hint: 'Phase 0 accepts "pipeline:<id>" or "prompt:<id>"',
        }),
      );
    } else {
      const expected: Namespace = evalShape.target.kind === 'pipeline' ? 'pipelines' : 'prompts';
      if (!scope.names[expected].has(evalShape.target.id)) {
        reportRef(evalShape.target.id, expected, scope, path, diagnostics, report);
      }
    }

    evalShape.metrics.forEach((metric, index) => {
      const metricPath = ['evals', evalShape.id, 'metrics', index];
      if (metric.kind === 'json-schema') {
        reportTypeRef(metric.schema, [...metricPath, 'schema'], diagnostics, report);
      }
      if (metric.kind !== 'tool-trace') return;
      metric.expect.forEach((name, position) => {
        if (scope.names.tools.has(name)) return;
        diagnostics.push(
          report.error({
            code: IR_DIAGNOSTIC_CODES.metricToolUnresolved,
            message: `the referential gate rejected this tool-trace expectation: no tool named "${name}" exists`,
            path: [...metricPath, 'expect', position],
          }),
        );
      });
    });
  }
}
