/**
 * The spec as a picture: every IR node and every reference the build already resolved,
 * in the order a reader should meet them.
 *
 * This module is a *view* of the IR and nothing else. It re-derives no gate, re-resolves
 * no reference and reads no file: a node exists because the IR holds a shape, and an edge
 * exists because one shape already carries another shape's id. That matters more than it
 * looks. A visualiser that inferred its own edges would draw a diagram of a spec that
 * never ran, and the diagram would be the most convincing thing in the room.
 *
 * Consequences of staying a pure view:
 *
 * - A spec the build refuses has no IR, so it has no graph. `aid visualize` shows the
 *   refusals instead of a partial picture, because a partial picture is an approximation
 *   and the gates exist to refuse those.
 * - Layout is derived here from document order only, never from a font measurement or a
 *   wall clock, so the same spec always produces the same coordinates. That is the same
 *   property `aid gen --check` relies on for the generated tree, applied to a picture.
 * - Nothing in this file knows about HTTP, the DOM or the terminal, so `graph.test.ts`
 *   can assert on the whole document without starting a server.
 */

import type {
  AgentShape,
  AgentStateShape,
  DeploymentShape,
  EvalShape,
  GuardrailShape,
  IR,
  MemoryShape,
  ModelShape,
  PipelineShape,
  PromptShape,
  RetrieverShape,
  StepShape,
  ToolShape,
  VectorStoreShape,
} from '@aid-framework/ir';
import { isManagedRetriever } from '@aid-framework/ir';

/** Bumped when a reader of `--json` would need to change. Not the spec or IR version. */
export const VISUAL_GRAPH_VERSION = 1;

/**
 * The columns of the diagram, left to right in the order the data flows.
 *
 * The order is fixed rather than derived from what the spec declares, so two customers
 * specs of the same framework version compare column by column. A spec with no evals
 * therefore has an empty eval column, but the eval column never moves to the left.
 */
export const VISUAL_GROUPS = [
  {
    id: 'document',
    title: 'Document',
    blurb: 'Project identity, versions, targets and the durable run store.',
  },
  {
    id: 'contract',
    title: 'Contract',
    blurb: 'Named types the prompts and tools pass between them.',
  },
  {
    id: 'service',
    title: 'Service',
    blurb: 'Pipelines and their ordered steps, including the composite ones.',
  },
  {
    id: 'agent',
    title: 'Agents',
    blurb: 'Agent loops, the bounds on each, and the decisions they ask.',
  },
  {
    id: 'prompt',
    title: 'Prompts',
    blurb: 'Templates, the model each pins, and the guardrails each declares.',
  },
  {
    id: 'model',
    title: 'Models',
    blurb: 'Pinned models with priced limits, and the embeddings derived from them.',
  },
  {
    id: 'tool',
    title: 'Tools',
    blurb: 'Tool contracts, their side effects, and the MCP gateways that federate them.',
  },
  {
    id: 'retrieval',
    title: 'Retrieval',
    blurb: 'Retrievers, managed knowledge bases, vector stores and memory.',
  },
  {
    id: 'guardrail',
    title: 'Guardrails',
    blurb: 'Policy engines, the stages they inspect, and the decision they ask.',
  },
  {
    id: 'eval',
    title: 'Evals and gates',
    blurb: 'Which target each claim measures, the metric that decides, and the ceiling.',
  },
  {
    id: 'infra',
    title: 'Infrastructure',
    blurb: 'Deployments, their delivery controls, and the observability they emit.',
  },
] as const;

export type VisualGroupId = (typeof VISUAL_GROUPS)[number]['id'];

/**
 * The closed set of edge kinds.
 *
 * `data` is the only one that runs between two steps of the same pipeline; the rest go
 * from a shape to the shape it names. A reader filters on this, so it is a union and not
 * a free string.
 */
export const VISUAL_EDGE_KINDS = [
  'data',
  'uses',
  'guards',
  'measures',
  'hands-off',
  'delegates',
  'deploys',
  'derives',
] as const;

export type VisualEdgeKind = (typeof VISUAL_EDGE_KINDS)[number];

export interface VisualFact {
  readonly label: string;
  readonly value: string;
}

export interface VisualNode {
  /** Unique across the document and stable across runs: `<kind>:<id>`. */
  readonly id: string;
  readonly kind: string;
  readonly group: VisualGroupId;
  readonly label: string;
  /** One line of secondary text, when the shape has a natural subtitle. */
  readonly detail?: string;
  /** The spec path a reader can open to change this, e.g. `agents.triage_agent`. */
  readonly path: string;
  readonly facts: readonly VisualFact[];
}

export interface VisualEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: VisualEdgeKind;
  /** What the edge carries, when naming it is more useful than the kind alone. */
  readonly label?: string;
}

export interface VisualGroupCount {
  readonly group: VisualGroupId;
  readonly title: string;
  readonly blurb: string;
  readonly count: number;
}

export interface VisualGraph {
  readonly graphVersion: number;
  readonly specVersion: string;
  readonly irVersion: string;
  readonly profile: string;
  readonly project: {
    readonly name: string;
    readonly namespace: string;
    readonly description?: string;
    readonly targets: readonly string[];
  };
  /** Every group in column order, with the number of nodes it holds. */
  readonly groups: readonly VisualGroupCount[];
  readonly nodes: readonly VisualNode[];
  /** Every reference, deduplicated and sorted, so the document is stable. */
  readonly edges: readonly VisualEdge[];
}

/** A fact whose value is absent is not a fact. Keeps `undefined` out of the document. */
type FactInput = readonly [label: string, value: string | number | boolean | undefined];

function compact(inputs: readonly FactInput[]): VisualFact[] {
  const facts: VisualFact[] = [];
  for (const [label, value] of inputs) {
    if (value === undefined) continue;
    const text = typeof value === 'string' ? value : String(value);
    if (text === '') continue;
    facts.push({ label, value: text });
  }
  return facts;
}

const list = (values: readonly string[]): string | undefined =>
  values.length === 0 ? undefined : values.join(', ');

/** `12,345` rather than `12345`, because the diagram is read and not parsed. */
function withSeparators(value: number): string {
  const digits = String(Math.trunc(Math.abs(value)));
  let out = '';
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) out += ',';
    out += digits[index] ?? '';
  }
  return value < 0 ? `-${out}` : out;
}

const money = (value: number): string =>
  `${value < 0 ? '-' : ''}$${(Math.round(Math.abs(value) * 1_000_000) / 1_000_000).toString()}`;

/** Builds the document. The only entry point; it never throws and never reads a file. */
export function buildVisualGraph(ir: IR): VisualGraph {
  const nodes: VisualNode[] = [];
  const add = (node: VisualNode): void => {
    nodes.push(node);
  };

  const edges: VisualEdge[] = [];
  const seen = new Set<string>();
  const link = (from: string, to: string, kind: VisualEdgeKind, label?: string): void => {
    const key = `${kind}\u0000${from}\u0000${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, kind, ...(label === undefined ? {} : { label }) });
  };

  // The document column opens with what the picture is a picture of.
  add({
    id: 'project',
    kind: 'project',
    group: 'document',
    label: ir.project.name,
    detail: `${ir.profile} profile · spec ${ir.specVersion} · IR ${ir.irVersion}`,
    path: 'project',
    facts: compact([
      ['namespace', ir.project.namespace],
      ['description', ir.project.description],
      ['profile', ir.profile],
      ['specVersion', ir.specVersion],
      ['irVersion', ir.irVersion],
      ['targets', list(ir.project.targets)],
      ['requiredCapabilities', list(ir.requiredCapabilities)],
    ]),
  });

  // A durable run store is shared by every agent that pauses, so it is drawn once and
  // keyed by its connection and retention settings rather than by which agent named it.
  const stateIds = new Map<string, string>();
  const stateIdFor = (state: AgentStateShape): string => {
    const key = JSON.stringify([
      state.kind,
      state.urlEnv,
      state.ttlHours ?? null,
      state.signingKeyEnv ?? null,
      state.checkpointTtlMinutes ?? null,
    ]);
    const existing = stateIds.get(key);
    if (existing !== undefined) return existing;
    const id = stateIds.size === 0 ? 'state' : `state:${stateIds.size + 1}`;
    stateIds.set(key, id);
    add(stateNode(state, id));
    return id;
  };
  if (ir.state !== undefined) stateIdFor(ir.state);

  for (const type of ir.types) {
    add({
      id: `type:${type.id}`,
      kind: 'type',
      group: 'contract',
      label: type.id,
      detail: `${type.fields.length} field${type.fields.length === 1 ? '' : 's'}`,
      path: `types.${type.id}`,
      facts: compact([
        ['description', type.description],
        ...type.fields.map(
          (field) =>
            [
              field.name,
              `${field.type.list ? 'list of ' : ''}${field.type.name}${field.required ? '' : '?'}`,
            ] as const,
        ),
      ]),
    });
  }

  // Pipelines and their steps share one column: a step belongs to the pipeline above it,
  // and separating them would make the reader reassemble a nesting the IR already has.
  for (const pipeline of ir.pipelines) {
    add(pipelineNode(pipeline));
    walkSteps(ir, pipeline, add, link);
  }

  for (const agent of ir.agents) {
    add(agentNode(agent));
    // The build resolves the project store into every agent that declares none, so this
    // pass is also where an agent's own store first becomes a node. Registering it here
    // rather than at link time keeps the connect pass a pure lookup.
    if (agent.state !== undefined) stateIdFor(agent.state);
  }

  for (const decision of ir.decisions) {
    add({
      id: decision.identity,
      kind: 'decision',
      group: 'agent',
      label: decision.id,
      detail: `${decision.type} question · ${decision.onError} on error`,
      path: `decisions.${decision.id}`,
      facts: compact([
        ['description', decision.description],
        ['model', decision.model],
        ['type', decision.type],
        ['onError', decision.onError],
        [
          'criteria',
          decision.criteria === undefined
            ? undefined
            : Array.isArray(decision.criteria)
              ? decision.criteria.join(' · ')
              : Object.keys(decision.criteria).join(', '),
        ],
      ]),
    });
  }

  for (const prompt of ir.prompts) {
    add(promptNode(prompt));
  }

  for (const model of ir.models) {
    add(modelNode(model));
  }

  for (const embedding of ir.embeddings) {
    add({
      id: `embedding:${embedding.id}`,
      kind: 'embedding',
      group: 'model',
      label: `${embedding.id} (derived)`,
      detail: `${embedding.provider}/${embedding.modelId}`,
      path: `models.${embedding.id}`,
      facts: compact([
        ['dimensions', embedding.dimensions],
        [
          'inputPerMTok',
          embedding.costProfile === undefined
            ? undefined
            : money(embedding.costProfile.inputPerMTok),
        ],
      ]),
    });
    // An embedding is not declared; it is derived from a model that can produce one. The
    // edge is the whole reason this column is worth drawing.
    link(`embedding:${embedding.id}`, `model:${embedding.id}`, 'derives');
  }

  for (const tool of ir.tools) {
    add(toolNode(tool));
  }

  for (const gateway of ir.gateways) {
    add({
      id: `gateway:${gateway.id}`,
      kind: 'gateway',
      group: 'tool',
      label: gateway.id,
      detail: `gateway · ${gateway.authorizer.kind} auth`,
      path: `gateways.${gateway.id}`,
      facts: compact([
        ['description', gateway.description],
        ['authorizer', gateway.authorizer.kind],
        ['targets', list(gateway.targets.map((target) => target.id))],
      ]),
    });
  }

  for (const retriever of ir.retrievers) {
    add(retrieverNode(retriever));
  }

  for (const knowledgeBase of ir.knowledgeBases) {
    add({
      id: `knowledgeBase:${knowledgeBase.id}`,
      kind: 'knowledge-base',
      group: 'retrieval',
      label: knowledgeBase.id,
      detail: `${knowledgeBase.engine} knowledge base`,
      path: `knowledgeBases.${knowledgeBase.id}`,
      facts: compact([
        ['dataSource', `${knowledgeBase.dataSource.kind} ${knowledgeBase.dataSource.uri}`],
        [
          'chunking',
          `${knowledgeBase.chunking.strategy} ${knowledgeBase.chunking.size}/${knowledgeBase.chunking.overlap}`,
        ],
        ['embedModel', knowledgeBase.embedModel],
        ['filterable', list(knowledgeBase.filterable)],
        ['vectorStore', knowledgeBase.vectorStore.kind],
      ]),
    });
  }

  for (const store of ir.stores) {
    add(storeNode(store));
  }

  for (const memory of ir.memory) {
    add(memoryNode(memory));
  }

  for (const guardrail of ir.guardrails) {
    add(guardrailNode(guardrail));
  }

  for (const evalShape of ir.evals) {
    add(evalNode(evalShape));
  }

  for (const deployment of ir.deployments) {
    add(deploymentNode(deployment));
  }

  add({
    id: 'observability',
    kind: 'observability',
    group: 'infra',
    label: 'observability',
    detail: ir.observability.trace
      ? `tracing on · ${ir.observability.export ?? 'none'}`
      : 'tracing off',
    path: 'observability',
    facts: compact([
      ['trace', String(ir.observability.trace)],
      ['export', ir.observability.export],
      ['endpointEnv', ir.observability.endpointEnv],
      ['redact', list(ir.observability.redact)],
      ['alerts', list((ir.observability.alerts ?? []).map((alert) => alert.id))],
      ['feedback', list((ir.observability.feedback?.signals ?? []).map((signal) => signal.kind))],
      ['feedbackRedact', list(ir.observability.feedback?.redact ?? [])],
      ['feedbackRetentionDays', ir.observability.feedback?.retentionDays],
      ['feedbackPersistent', ir.observability.feedback?.persistent],
    ]),
  });

  // Edges. Every one names a reference the IR already resolved, so a gate has already
  // agreed that the target exists; a link whose endpoint is not drawn would be a hole in
  // the picture, so the known set is checked rather than trusted.
  const known = new Set(nodes.map((node) => node.id));
  const connect = (from: string, to: string, kind: VisualEdgeKind, label?: string): void => {
    if (from === to) return;
    if (!known.has(from) || !known.has(to)) return;
    link(from, to, kind, label);
  };

  for (const prompt of ir.prompts) {
    connect(prompt.identity, `model:${prompt.model}`, 'uses', 'model');
    for (const guardrail of prompt.guardrails) {
      connect(`guardrail:${guardrail}`, prompt.identity, 'guards');
    }
    for (const evalId of prompt.evals) connect(`eval:${evalId}`, prompt.identity, 'measures');
  }

  for (const agent of ir.agents) {
    const id = `agent:${agent.id}`;
    connect(id, promptRef(ir, agent.instructions), 'uses', 'instructions');
    connect(id, `model:${agent.model}`, 'uses', 'model');
    for (const tool of agent.tools) connect(id, `tool:${tool}`, 'uses');
    for (const retriever of agent.retrievers) connect(id, `retriever:${retriever}`, 'uses');
    for (const memory of agent.memory) connect(id, `memory:${memory}`, 'uses');
    for (const guardrail of agent.guardrails) connect(id, `guardrail:${guardrail}`, 'guards');
    for (const handoff of agent.handoffs) connect(id, `agent:${handoff}`, 'hands-off');
    for (const delegate of agent.delegates) connect(`agent:${delegate}`, id, 'delegates');
    if (agent.state !== undefined) {
      connect(id, stateIds.get(stateKey(agent.state)) ?? 'state', 'uses', 'durable state');
    }
  }

  for (const decision of ir.decisions) {
    connect(decision.identity, `model:${decision.model}`, 'uses', 'model');
  }

  for (const tool of ir.tools) {
    const mcp = tool.handler.kind === 'mcp' ? tool.handler.mcp : undefined;
    if (mcp !== undefined) connect(`tool:${tool.id}`, `gateway:${mcp.server}`, 'uses', 'gateway');
  }

  for (const retriever of ir.retrievers) {
    const id = `retriever:${retriever.id}`;
    if (isManagedRetriever(retriever)) {
      connect(id, `knowledgeBase:${retriever.knowledgeBase}`, 'uses');
    } else {
      connect(id, `embedding:${retriever.embedModel}`, 'uses', 'embed');
      connect(id, `store:${retriever.store}`, 'uses');
    }
  }

  for (const knowledgeBase of ir.knowledgeBases) {
    connect(
      `knowledgeBase:${knowledgeBase.id}`,
      `embedding:${knowledgeBase.embedModel}`,
      'uses',
      'embed',
    );
  }

  for (const memory of ir.memory) {
    const id = `memory:${memory.id}`;
    if (memory.summarizeModel !== undefined) connect(id, `model:${memory.summarizeModel}`, 'uses');
    const backend = memory.store ?? memory.backend;
    if (backend !== undefined && backend !== 'in-process') connect(id, `store:${backend}`, 'uses');
  }

  for (const guardrail of ir.guardrails) {
    const id = `guardrail:${guardrail.id}`;
    if (guardrail.decision !== undefined) {
      connect(id, `decision:${guardrail.decision}`, 'uses', 'asks');
    }
    for (const tool of guardrail.tools) connect(id, `tool:${tool}`, 'guards');
    if (guardrail.onFail.fallbackPrompt !== undefined) {
      connect(id, promptRef(ir, guardrail.onFail.fallbackPrompt), 'uses', 'fallback');
    }
  }

  for (const evalShape of ir.evals) {
    const id = `eval:${evalShape.id}`;
    if (evalShape.target.valid) connect(id, targetNodeId(evalShape, ir), 'measures');
    for (const metric of evalShape.metrics) {
      if (metric.kind === 'tool-trace') {
        for (const name of metric.expect) connect(id, `tool:${name}`, 'measures');
      }
      if (metric.kind === 'forbidden-tool') {
        for (const name of metric.forbid) connect(id, `tool:${name}`, 'measures');
      }
      if (metric.kind === 'decision') connect(id, `decision:${metric.decision}`, 'measures');
      if (metric.kind === 'llm-judge' && metric.model !== undefined) {
        connect(id, `model:${metric.model}`, 'measures', 'judge');
      }
    }
    const promotion = evalShape.gate.promotion;
    if (promotion !== undefined) {
      connect(
        id,
        `prompt:${promotion.baseline.prompt}@${promotion.baseline.version}`,
        'measures',
        'promotion baseline',
      );
    }
  }

  for (const deployment of ir.deployments) {
    const id = `deployment:${deployment.id}`;
    if (deployment.pipeline !== undefined)
      connect(id, `pipeline:${deployment.pipeline}`, 'deploys');
    const gateway = deployment.runtime?.gateway;
    if (gateway !== undefined) connect(id, `gateway:${gateway}`, 'uses', 'runtime gateway');
  }

  const counts = new Map<VisualGroupId, number>();
  for (const node of nodes) counts.set(node.group, (counts.get(node.group) ?? 0) + 1);

  edges.sort((left, right) => {
    const from = left.from.localeCompare(right.from);
    if (from !== 0) return from;
    const to = left.to.localeCompare(right.to);
    if (to !== 0) return to;
    return left.kind.localeCompare(right.kind);
  });

  return {
    graphVersion: VISUAL_GRAPH_VERSION,
    specVersion: ir.specVersion,
    irVersion: ir.irVersion,
    profile: ir.profile,
    project: {
      name: ir.project.name,
      namespace: ir.project.namespace,
      ...(ir.project.description === undefined ? {} : { description: ir.project.description }),
      targets: [...ir.project.targets],
    },
    groups: VISUAL_GROUPS.map((group) => ({
      group: group.id,
      title: group.title,
      blurb: group.blurb,
      count: counts.get(group.id) ?? 0,
    })),
    nodes,
    edges,
  };
}

/** The map key `stateIdFor` indexes a declaration by. Shared so the two cannot drift. */
function stateKey(state: AgentStateShape): string {
  return JSON.stringify([
    state.kind,
    state.urlEnv,
    state.ttlHours ?? null,
    state.signingKeyEnv ?? null,
    state.checkpointTtlMinutes ?? null,
  ]);
}

/**
 * The node id for a prompt named by bare id.
 *
 * `PromptShape.identity` embeds `@<version>`, and the shapes that reference a prompt by
 * id alone (`agent.instructions`, `guardrail.onFail.fallbackPrompt`) do not carry that
 * version. There is exactly one prompt per id in the IR, so looking it up here is a read
 * of the document rather than a resolution the gates would have had to make.
 */
function promptRef(ir: IR, id: string): string {
  const prompt = ir.prompts.find((candidate) => candidate.id === id);
  return prompt === undefined ? `prompt:${id}` : prompt.identity;
}

/** The node an eval targets. `target.kind` names the collection and `target.id` the member. */
function targetNodeId(shape: EvalShape, ir: IR): string {
  switch (shape.target.kind) {
    case 'prompt':
      return promptRef(ir, shape.target.id);
    case 'agent':
      return `agent:${shape.target.id}`;
    case 'pipeline':
      return `pipeline:${shape.target.id}`;
  }
}

function pipelineNode(pipeline: PipelineShape): VisualNode {
  const trigger = pipeline.trigger;
  const triggerText =
    trigger.kind === 'http'
      ? `${trigger.method.toUpperCase()} ${trigger.path}`
      : trigger.kind === 'schedule'
        ? `schedule ${trigger.schedule}`
        : trigger.kind === 'event'
          ? `event ${trigger.event}`
          : 'manual';
  return {
    id: `pipeline:${pipeline.id}`,
    kind: 'pipeline',
    group: 'service',
    label: pipeline.id,
    detail: triggerText,
    path: `pipelines.${pipeline.id}`,
    facts: compact([
      ['description', pipeline.description],
      ['trigger', triggerText],
      ['steps', pipeline.steps.length],
      ['retries', pipeline.errorPolicy.retries],
      ['fallback', pipeline.errorPolicy.fallback],
      ['deadLetter', pipeline.errorPolicy.deadLetter],
      ['trace', String(pipeline.observability.trace)],
    ]),
  };
}

/**
 * Walks a pipeline's steps, drawing each one and the data it consumes.
 *
 * The binding map is what makes a data edge possible: `step.as` names what a step
 * produced, and a `reference` input or an `over` field names a binding something earlier
 * bound. Copies of the map are handed to nested arms, so a binding made inside a branch
 * cannot leak out of it.
 *
 * The referential gate has already refused a reference to a binding that is not in scope,
 * so a lookup that misses here is not a spec error this function may report. It is a shape
 * this drawing does not understand, and it draws nothing rather than guessing.
 */
function walkSteps(
  ir: IR,
  pipeline: PipelineShape,
  add: (node: VisualNode) => void,
  link: (from: string, to: string, kind: VisualEdgeKind, label?: string) => void,
): void {
  const visit = (
    steps: readonly StepShape[],
    parentPath: string,
    bindings: ReadonlyMap<string, string>,
  ): void => {
    const scope = new Map(bindings);
    steps.forEach((step, index) => {
      const path = `${parentPath}${index}`;
      const id = `step:${pipeline.id}/${path}`;
      add({
        id,
        kind: `step:${step.kind}`,
        group: 'service',
        label: `${path} ${step.kind}`,
        ...(stepDetail(step) === undefined ? {} : { detail: stepDetail(step) }),
        path: `pipelines.${pipeline.id}.steps.${path}`,
        facts: stepFacts(step),
      });
      link(`pipeline:${pipeline.id}`, id, 'uses', 'step');

      const produced = 'as' in step && typeof step.as === 'string' ? step.as : undefined;
      const source = (name: string): void => {
        const from = scope.get(name);
        if (from !== undefined) link(from, id, 'data', name);
      };

      switch (step.kind) {
        case 'generate': {
          link(id, promptRef(ir, step.prompt), 'uses', 'prompt');
          for (const value of Object.values(step.input)) {
            if (value.kind === 'reference') source(value.path[0] ?? '');
          }
          if (step.context !== undefined) source(step.context);
          break;
        }
        case 'tool': {
          link(id, `tool:${step.tool}`, 'uses', 'tool');
          for (const value of Object.values(step.input)) {
            if (value.kind === 'reference') source(value.path[0] ?? '');
          }
          break;
        }
        case 'retrieve':
          link(id, `retriever:${step.retriever}`, 'uses', 'retriever');
          break;
        case 'rerank':
          source(step.over);
          break;
        case 'guard':
          link(id, `guardrail:${step.guardrail}`, 'guards', step.stage);
          break;
        case 'agent':
          link(id, `agent:${step.agent}`, 'uses', 'agent');
          break;
        case 'route': {
          link(id, `decision:${step.decision}`, 'uses', 'decision');
          for (const label of Object.keys(step.on)) {
            visit(step.on[label] ?? [], `${path}.on.${label}.`, scope);
          }
          if (step.default !== undefined) visit(step.default, `${path}.default.`, scope);
          break;
        }
        case 'branch':
          visit(step.then, `${path}.then.`, scope);
          visit(step.else, `${path}.else.`, scope);
          break;
        case 'parallel':
          step.branches.forEach((branch, arm) => {
            visit(branch, `${path}.arm${arm}.`, scope);
          });
          break;
        case 'map':
          source(step.over);
          visit([step.step], `${path}.step.`, scope);
          break;
        case 'reduce':
          source(step.over);
          link(id, promptRef(ir, step.prompt), 'uses', 'prompt');
          break;
        case 'emit':
          break;
      }

      if (produced !== undefined) scope.set(produced, id);
    });
  };

  visit(pipeline.steps, '', new Map());
}

function stepDetail(step: StepShape): string | undefined {
  switch (step.kind) {
    case 'generate':
      return `→ ${step.prompt}${step.context === undefined ? '' : ` · context ${step.context}`}`;
    case 'retrieve':
      return `→ ${step.retriever}`;
    case 'tool':
      return `→ ${step.tool}${step.requiresApproval === true ? ' · needs approval' : ''}`;
    case 'emit':
      return `event ${step.event}`;
    case 'branch':
      return `${step.then.length} then · ${step.else.length} else`;
    case 'parallel':
      return `${step.branches.length} arm${step.branches.length === 1 ? '' : 's'}`;
    case 'map':
      return `over ${step.over}`;
    case 'reduce':
      return `over ${step.over} → ${step.prompt}`;
    case 'rerank':
      return `over ${step.over} · top ${step.topN}`;
    case 'guard':
      return `${step.guardrail} at ${step.stage}`;
    case 'agent':
      return `→ ${step.agent}`;
    case 'route':
      return `→ ${step.decision}`;
  }
}

function stepFacts(step: StepShape): VisualFact[] {
  const facts: VisualFact[] = [];
  if ('as' in step && typeof step.as === 'string') facts.push({ label: 'as', value: step.as });
  if (step.kind === 'generate' || step.kind === 'tool') {
    for (const [key, value] of Object.entries(step.input)) {
      if (value.kind === 'literal') facts.push({ label: key, value: JSON.stringify(value.value) });
      else if (value.kind === 'reference')
        facts.push({ label: key, value: `← ${value.path.join('.')}` });
      else facts.push({ label: key, value: value.template });
    }
  }
  if (step.kind === 'route') facts.push({ label: 'arms', value: Object.keys(step.on).join(', ') });
  if (step.kind === 'guard') facts.push({ label: 'stage', value: step.stage });
  return facts;
}

function promptNode(prompt: PromptShape): VisualNode {
  const schema = prompt.output.schema?.name;
  return {
    id: prompt.identity,
    kind: 'prompt',
    group: 'prompt',
    label: prompt.id,
    detail: `v${prompt.version} → ${prompt.model}`,
    path: `prompts.${prompt.id}`,
    facts: compact([
      ['version', prompt.version],
      ['model', prompt.model],
      ['output', schema === undefined ? prompt.output.kind : `${prompt.output.kind} ${schema}`],
      ['variables', list(prompt.variables.map((variable) => variable.name))],
      [
        'sensitive',
        list(
          prompt.variables
            .filter((variable) => variable.sensitive === true)
            .map((variable) => variable.name),
        ),
      ],
      ['guardrails', list(prompt.guardrails)],
      ['evals', list(prompt.evals)],
      ['examples', prompt.examples.length === 0 ? undefined : prompt.examples.length],
      ['temperature', prompt.params.temperature],
      ['maxTokens', prompt.params.maxTokens],
    ]),
  };
}

function modelNode(model: ModelShape): VisualNode {
  const cost =
    model.costProfile === undefined
      ? undefined
      : `${money(model.costProfile.inputPerMTok)} in / ${money(model.costProfile.outputPerMTok)} out per MTok`;
  const semantic = model.cache?.semantic;
  return {
    id: model.identity,
    kind: 'model',
    group: 'model',
    label: model.id,
    detail: `${model.provider}/${model.modelId}`,
    path: `models.${model.id}`,
    facts: compact([
      ['description', model.description],
      ['capabilities', list(model.capabilities)],
      ['contextTokens', withSeparators(model.limits.contextTokens)],
      ['maxOutputTokens', model.limits.maxOutputTokens],
      ['rpm', model.limits.rpm],
      ['tpm', model.limits.tpm],
      ['costProfile', cost],
      ['costProfileId', model.costProfileId],
      ['fallbacks', list(model.fallbacks)],
      ['promptCache', model.cache?.prompt],
      [
        'semanticCache',
        semantic === undefined
          ? undefined
          : `≥ ${semantic.threshold} · ${semantic.ttlSeconds}s ttl`,
      ],
      ['baseUrl', model.baseUrl],
      ['apiKeyEnv', model.apiKeyEnv],
    ]),
  };
}

function toolNode(tool: ToolShape): VisualNode {
  const mcp = tool.handler.mcp;
  const handler =
    tool.handler.kind === 'mcp'
      ? `mcp ${mcp?.server ?? '?'}/${mcp?.tool ?? '?'}`
      : `${tool.handler.kind} ${tool.handler.symbol ?? ''}`.trim();
  return {
    id: tool.identity,
    kind: 'tool',
    group: 'tool',
    label: tool.id,
    detail: `${tool.sideEffects}${tool.requiresConfirmation ? ' · needs confirmation' : ''}`,
    path: `tools.${tool.id}`,
    facts: compact([
      ['description', tool.description],
      ['handler', handler],
      ['sideEffects', tool.sideEffects],
      ['requiresConfirmation', String(tool.requiresConfirmation)],
      ['idempotency', tool.idempotency],
      ['timeoutMs', tool.timeoutMs],
      ['retries', tool.retries],
      ['auth', tool.auth === undefined ? undefined : 'declared policy'],
    ]),
  };
}

function agentNode(agent: AgentShape): VisualNode {
  return {
    id: `agent:${agent.id}`,
    kind: 'agent',
    group: 'agent',
    label: agent.id,
    detail: `${agent.maxSteps} steps · ${agent.model}`,
    path: `agents.${agent.id}`,
    facts: compact([
      ['name', agent.name],
      ['instructions', agent.instructions],
      ['model', agent.model],
      ['maxSteps', agent.maxSteps],
      ['maxTokensBudget', agent.maxTokensBudget],
      ['maxCostBudget', agent.maxCostBudget === undefined ? undefined : money(agent.maxCostBudget)],
      ['onBudgetExhausted', agent.onBudgetExhausted],
      [
        'engine',
        agent.engineVersion === undefined ? agent.engine : `${agent.engine}@${agent.engineVersion}`,
      ],
      ['tools', list(agent.tools)],
      ['retrievers', list(agent.retrievers)],
      ['memory', list(agent.memory)],
      ['guardrails', list(agent.guardrails)],
      ['handoffs', list(agent.handoffs)],
      ['delegates', list(agent.delegates)],
      ['humanInTheLoop', agent.humanInTheLoop?.channel],
      [
        'state',
        agent.state === undefined ? undefined : `${agent.state.kind} via ${agent.state.urlEnv}`,
      ],
    ]),
  };
}

function stateNode(state: AgentStateShape, id: string): VisualNode {
  return {
    id,
    kind: 'state',
    group: 'document',
    label: 'durable run store',
    detail: `${state.kind} · ${state.urlEnv}`,
    path: 'state',
    facts: compact([
      ['kind', state.kind],
      ['urlEnv', state.urlEnv],
      ['ttlHours', state.ttlHours],
      ['signingKeyEnv', state.signingKeyEnv],
      ['checkpointTtlMinutes', state.checkpointTtlMinutes],
    ]),
  };
}

function retrieverNode(retriever: RetrieverShape): VisualNode {
  const rerank =
    retriever.rerank === undefined
      ? undefined
      : `${retriever.rerank.model} · top ${retriever.rerank.topN}`;
  if (isManagedRetriever(retriever)) {
    return {
      id: `retriever:${retriever.id}`,
      kind: 'retriever',
      group: 'retrieval',
      label: retriever.id,
      detail: `managed · ${retriever.knowledgeBase}`,
      path: `retrievers.${retriever.id}`,
      facts: compact([
        ['kind', 'managed'],
        ['knowledgeBase', retriever.knowledgeBase],
        ['topK', retriever.topK],
        ['rerank', rerank],
        ['filters', list(retriever.filters ?? [])],
      ]),
    };
  }
  return {
    id: `retriever:${retriever.id}`,
    kind: 'retriever',
    group: 'retrieval',
    label: retriever.id,
    detail: `local · ${retriever.source.kind}`,
    path: `retrievers.${retriever.id}`,
    facts: compact([
      ['source', `${retriever.source.kind} ${retriever.source.uri}`],
      ['glob', retriever.source.glob],
      [
        'chunking',
        `${retriever.chunking.strategy} ${retriever.chunking.size}/${retriever.chunking.overlap}`,
      ],
      ['embedModel', retriever.embedModel],
      ['store', retriever.store],
      ['metric', `${retriever.index.metric}${retriever.index.hybrid ? ' · hybrid' : ''}`],
      ['topK', retriever.topK],
      ['rerank', rerank],
      ['refresh', retriever.refresh.schedule ?? retriever.refresh.mode],
      ['filters', list(retriever.filters ?? [])],
    ]),
  };
}

function storeNode(store: VectorStoreShape): VisualNode {
  return {
    id: `store:${store.id}`,
    kind: 'store',
    group: 'retrieval',
    label: store.id,
    detail: store.kind,
    path: `stores.${store.id}`,
    facts: compact([
      ['kind', store.kind],
      ['dimensions', store.dimensions],
      ['uri', store.uri],
    ]),
  };
}

function memoryNode(memory: MemoryShape): VisualNode {
  return {
    id: `memory:${memory.id}`,
    kind: 'memory',
    group: 'retrieval',
    label: memory.id,
    detail: `${memory.kind} · ${memory.scope}`,
    path: `memory.${memory.id}`,
    facts: compact([
      ['kind', memory.kind],
      ['scope', memory.scope],
      ['tokenBudget', memory.tokenBudget],
      ['summarizeModel', memory.summarizeModel],
      ['store', memory.store],
      ['backend', memory.backend],
      ['ttl', memory.ttl],
      ['redact', list(memory.redact)],
    ]),
  };
}

function guardrailNode(guardrail: GuardrailShape): VisualNode {
  return {
    id: `guardrail:${guardrail.id}`,
    kind: 'guardrail',
    group: 'guardrail',
    label: guardrail.id,
    detail: `${guardrail.engine} · ${guardrail.action}`,
    path: `guardrails.${guardrail.id}`,
    facts: compact([
      ['engine', guardrail.engine],
      ['stages', list(guardrail.stages)],
      ['policies', list(guardrail.policies)],
      ['action', guardrail.action],
      ['decision', guardrail.decision],
      ['redact', list(guardrail.redact)],
      ['tools', guardrail.tools.length === 0 ? 'every tool' : list(guardrail.tools)],
      ['minConfidence', guardrail.minConfidence],
      ['onFail', guardrail.onFail.message],
      ['fallbackPrompt', guardrail.onFail.fallbackPrompt],
    ]),
  };
}

function evalNode(shape: EvalShape): VisualNode {
  const unique = [...new Set(shape.metrics.map((metric) => metric.kind))];
  const promotion = shape.gate.promotion;
  return {
    id: `eval:${shape.id}`,
    kind: 'eval',
    group: 'eval',
    label: shape.id,
    detail: `measures ${shape.target.qualified}`,
    path: `evals.${shape.id}`,
    facts: compact([
      ['description', shape.description],
      ['target', shape.target.qualified],
      ['dataset', shape.dataset.uri ?? shape.dataset.source],
      ['metrics', unique.join(', ')],
      ['gate.maxRegression', shape.gate.maxRegression],
      ['gate.minMean', shape.gate.minMean],
      ['gate.samples', shape.gate.samples],
      ['costBudget', shape.costBudget === undefined ? undefined : money(shape.costBudget)],
      ['latencyBudgetP95Ms', shape.latencyBudgetP95Ms],
      [
        'promotion',
        promotion === undefined
          ? undefined
          : `drop ≤ ${promotion.allowedQualityDrop} · ${promotion.baseline.prompt}@${promotion.baseline.version}`,
      ],
      [
        'promotionApproval',
        promotion === undefined || promotion.approval === undefined
          ? undefined
          : `${promotion.approval.by.join(', ')} in ${promotion.approval.record}`,
      ],
    ]),
  };
}

function deploymentNode(deployment: DeploymentShape): VisualNode {
  const placement =
    deployment.cloud === undefined
      ? 'cloud chosen by the CLI'
      : `${deployment.cloud}${deployment.region === undefined ? '' : ` · ${deployment.region}`}`;
  const network = deployment.network;
  const kubernetesNamespace = deployment.kubernetes?.namespace;
  return {
    id: `deployment:${deployment.id}`,
    kind: 'deployment',
    group: 'infra',
    label: deployment.id,
    detail: `${deployment.target} · ${placement}`,
    path: `deployments.${deployment.id}`,
    facts: compact([
      ['target', deployment.target],
      ['cloud', deployment.cloud],
      ['region', deployment.region],
      [
        'audit',
        deployment.audit === undefined
          ? undefined
          : `${deployment.audit.sink}${deployment.audit.retentionDays === undefined ? '' : ` ${deployment.audit.retentionDays}d`}`,
      ],
      [
        'identity',
        deployment.identity === undefined
          ? undefined
          : `${deployment.identity.kind} ${deployment.identity.issuer}`.trim(),
      ],
      ['network.ingress', network?.ingress],
      ['network.egress', network?.egress],
      ['network.allowFrom', list(network?.allowFrom ?? [])],
      [
        'approvals',
        deployment.approvals === undefined
          ? undefined
          : `${deployment.approvals.require.join(', ')} (${deployment.approvals.minApprovers})`,
      ],
      ['secrets', list(deployment.secrets)],
      ['image', deployment.image?.registry],
      ['runtime', deployment.runtime?.platform],
      ['pipeline', deployment.pipeline],
      ['kubernetes.namespace', kubernetesNamespace],
      ['streaming', String(deployment.streaming)],
      ['concurrency', deployment.concurrency],
    ]),
  };
}
