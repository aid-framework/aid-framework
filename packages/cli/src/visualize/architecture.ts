/**
 * The layer above the picture: what exists outside the process, and which of those
 * boxes talk to each other over the wire.
 *
 * `graph.ts` draws a spec's *declarations* — one column per construction. This module
 * draws a spec's *topology* — deployments, the stores and providers they call, the
 * triggers that start a run — which is the first thing a reviewer of a distributed
 * system needs and the last thing a per-construction table can show. The inventory
 * columns are still there; this is a second, smaller graph drawn above them.
 *
 * It stays a pure view for the same reason `graph.ts` does. Every box is a shape the IR
 * holds, every arrow is a reference one shape already carries for another shape's id,
 * and the gates have already agreed those references resolve. Nothing here reads a file,
 * runs a gate, or guesses a dependency that no field states. Consequences worth naming:
 *
 * - A model no pipeline reaches has no provider arrow, because no request goes there.
 *   Declaring a model is not calling it, and an architecture picture that drew the call
 *   would be the most convincing wrong thing in the room.
 * - A secrets store is not a box. The spec declares secret *names* on a deployment and
 *   never the store that holds them, so drawing one would be an assumption about the
 *   platform. Same for the private network: `network.private` is a fact on the
 *   deployment, not an arrow to something the document cannot name.
 * - `sequences` is the request path, assembled from the declared step order. It is a
 *   reading of the spec, not a trace: `aid trace export` is what records what ran.
 */

import type { DeploymentShape, IR, StepShape, ToolShape } from '@aid-framework/ir';
import { formatPolicyExpr, isManagedRetriever } from '@aid-framework/ir';
import type { FactInput, VisualEdge, VisualNode } from './graph.js';
import { compact, describeTrigger, list } from './graph.js';

/**
 * The columns of the architecture layer, left to right in request order.
 *
 * Fixed rather than derived from what the spec happens to declare, for the same reason
 * the inventory columns are: two customers' specs compare column by column, and a spec
 * with no audit sink has an empty External column rather than a narrower picture.
 */
export const SYSTEM_ZONES = [
  {
    id: 'entry',
    title: 'Entry',
    blurb: 'The trigger declared on each pipeline: what starts a run and how it arrives.',
  },
  {
    id: 'identity',
    title: 'Identity',
    blurb: 'Who the caller is, and the runtime gateway that authenticates them.',
  },
  {
    id: 'compute',
    title: 'Compute',
    blurb: 'One box per deployment: the process the service actually runs as, and where.',
  },
  {
    id: 'data',
    title: 'Data',
    blurb: 'Stores, knowledge bases and run state the deployments read and write at run time.',
  },
  {
    id: 'external',
    title: 'External',
    blurb: 'Model providers, MCP servers, audit sinks and trace collectors.',
  },
] as const;

export type SystemZoneId = (typeof SYSTEM_ZONES)[number]['id'];

export interface SystemZoneCount {
  readonly zone: SystemZoneId;
  readonly title: string;
  readonly blurb: string;
  readonly count: number;
}

/**
 * A box in the architecture layer.
 *
 * `group` stays a real inventory group so a reader filtering on groups does not need a
 * second vocabulary; `zone` is what places the box here. `related` names the
 * inventory nodes this box corresponds to, which is what the drill-down follows, and
 * `sequences` names the pipelines whose request path passes through it — both computed
 * once here so the browser only ever filters.
 */
export interface SystemNode extends VisualNode {
  readonly zone: SystemZoneId;
  readonly related: readonly string[];
  readonly sequences: readonly string[];
}

export interface SystemGraph {
  readonly zones: readonly SystemZoneCount[];
  readonly nodes: readonly SystemNode[];
  /** Deduplicated and sorted, so the same spec always produces the same document. */
  readonly edges: readonly VisualEdge[];
}

/**
 * One line of a request path.
 *
 * `nodeId` is the id of the step box in the process band, so clicking a row selects the
 * step that produced it rather than a copy of it. `notes` carries only what a field
 * declares — a guardrail's action or the fields it redacts, a tool's side effects, a
 * model pin — never a stage, a redaction or an approval the spec does not name.
 */
export interface SequenceRow {
  readonly nodeId: string;
  readonly path: string;
  readonly kind: string;
  readonly text: string;
  readonly notes: readonly string[];
  /** `approval`, `redact`, `block`, `write`, `mcp`: what a reader should not miss. */
  readonly flags: readonly string[];
  readonly depth: number;
}

/** A pipeline's request path, as the declared step order reads. */
export interface PipelineSequence {
  readonly pipeline: string;
  readonly nodeId: string;
  readonly trigger: string;
  readonly steps: number;
  readonly notes: readonly string[];
  readonly rows: readonly SequenceRow[];
}

/** What a pipeline can reach, by collection. Filled in by `collectSteps`, closed below. */
interface Reach {
  prompts: Set<string>;
  models: Set<string>;
  tools: Set<string>;
  retrievers: Set<string>;
  agents: Set<string>;
  guardrails: Set<string>;
  memories: Set<string>;
  stores: Set<string>;
  knowledgeBases: Set<string>;
}

function emptyReach(): Reach {
  return {
    prompts: new Set(),
    models: new Set(),
    tools: new Set(),
    retrievers: new Set(),
    agents: new Set(),
    guardrails: new Set(),
    memories: new Set(),
    stores: new Set(),
    knowledgeBases: new Set(),
  };
}

function reachSize(reach: Reach): number {
  return (
    reach.prompts.size +
    reach.models.size +
    reach.tools.size +
    reach.retrievers.size +
    reach.agents.size +
    reach.guardrails.size +
    reach.memories.size +
    reach.stores.size +
    reach.knowledgeBases.size
  );
}

/** Every shape named directly by a step, before prompt and agent expansion. */
function collectSteps(steps: readonly StepShape[], reach: Reach): void {
  for (const step of steps) {
    switch (step.kind) {
      case 'generate':
        reach.prompts.add(step.prompt);
        break;
      case 'reduce':
        reach.prompts.add(step.prompt);
        break;
      case 'tool':
        reach.tools.add(step.tool);
        break;
      case 'retrieve':
        reach.retrievers.add(step.retriever);
        break;
      case 'guard':
        reach.guardrails.add(step.guardrail);
        break;
      case 'agent':
        reach.agents.add(step.agent);
        break;
      case 'route':
        for (const arm of Object.values(step.on)) collectSteps(arm, reach);
        if (step.default !== undefined) collectSteps(step.default, reach);
        break;
      case 'branch':
        collectSteps(step.then, reach);
        collectSteps(step.else, reach);
        break;
      case 'parallel':
        for (const arm of step.branches) collectSteps(arm, reach);
        break;
      case 'map':
        collectSteps([step.step], reach);
        break;
      case 'emit':
      case 'rerank':
        break;
    }
  }
}

/**
 * Closes a reach set over the references the shapes themselves carry: a step names a
 * prompt, the prompt names a model, an agent names prompts, tools and retrievers, and a
 * retriever names a store. Runs to a fixpoint because an agent can hand off to another
 * agent, which brings its own tools. The iteration cap is a cycle guard, not a limit any
 * real spec reaches: the referential gate has already refused an unresolvable reference.
 */
function closeReach(ir: IR, reach: Reach): void {
  const prompts = new Map(ir.prompts.map((shape) => [shape.id, shape]));
  const agents = new Map(ir.agents.map((shape) => [shape.id, shape]));
  const retrievers = new Map(ir.retrievers.map((shape) => [shape.id, shape]));
  const memories = new Map(ir.memory.map((shape) => [shape.id, shape]));

  let previous = -1;
  let rounds = 0;
  while (previous !== reachSize(reach) && rounds < 64) {
    previous = reachSize(reach);
    rounds += 1;

    for (const id of [...reach.prompts]) {
      const prompt = prompts.get(id);
      if (prompt === undefined) continue;
      reach.models.add(prompt.model);
      for (const guardrail of prompt.guardrails) reach.guardrails.add(guardrail);
    }

    for (const id of [...reach.agents]) {
      const agent = agents.get(id);
      if (agent === undefined) continue;
      reach.prompts.add(agent.instructions);
      reach.models.add(agent.model);
      for (const tool of agent.tools) reach.tools.add(tool);
      for (const retriever of agent.retrievers) reach.retrievers.add(retriever);
      for (const guardrail of agent.guardrails) reach.guardrails.add(guardrail);
      for (const memory of agent.memory) reach.memories.add(memory);
      // A handoff or a delegation is another agent, so the run can reach its tools too.
      for (const next of agent.handoffs) reach.agents.add(next);
      for (const next of agent.delegates) reach.agents.add(next);
    }

    for (const id of [...reach.retrievers]) {
      const retriever = retrievers.get(id);
      if (retriever === undefined) continue;
      if (isManagedRetriever(retriever)) reach.knowledgeBases.add(retriever.knowledgeBase);
      else reach.stores.add(retriever.store);
    }

    // Memory is in-process unless it names a backend, and `in-process` is a word rather
    // than a store id, so only a real store id becomes a box.
    for (const id of [...reach.memories]) {
      const memory = memories.get(id);
      if (memory === undefined) continue;
      const backend = memory.store ?? memory.backend;
      if (backend !== undefined && backend !== 'in-process') reach.stores.add(backend);
    }
  }
}

/** `collection:id` → the pipelines that reach it. The index every `sequences` reads. */
type ReachIndex = Map<string, string[]>;

function markReach(index: ReachIndex, reach: Reach, pipeline: string): void {
  const collections: readonly [string, Set<string>][] = [
    ['prompt', reach.prompts],
    ['model', reach.models],
    ['tool', reach.tools],
    ['retriever', reach.retrievers],
    ['agent', reach.agents],
    ['guardrail', reach.guardrails],
    ['memory', reach.memories],
    ['store', reach.stores],
    ['knowledgeBase', reach.knowledgeBases],
  ];
  for (const [collection, ids] of collections) {
    for (const id of ids) {
      const key = `${collection}:${id}`;
      const pipelines = index.get(key);
      if (pipelines === undefined) index.set(key, [pipeline]);
      else if (!pipelines.includes(pipeline)) pipelines.push(pipeline);
    }
  }
}

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  openai: 'OpenAI API',
  'openai-compatible': 'OpenAI-compatible endpoint',
  anthropic: 'Anthropic API',
  azure: 'Azure OpenAI',
  bedrock: 'AWS Bedrock',
  google: 'Google AI',
  gemini: 'Google Gemini',
  ollama: 'Ollama (self-hosted)',
  vllm: 'vLLM (self-hosted)',
  fake: 'fake provider (test)',
  custom: 'custom provider',
};

const providerLabel = (provider: string): string => PROVIDER_LABELS[provider] ?? provider;

const sysId = (kind: string, id: string): string => `system:${kind}:${id}`;

const unique = (values: readonly string[]): string[] => [...new Set(values)];

/** Builds the architecture layer. Never throws, never reads a file. */
export function buildSystemGraph(ir: IR): SystemGraph {
  const nodes: SystemNode[] = [];
  const edges: VisualEdge[] = [];
  const seen = new Set<string>();

  const add = (node: SystemNode): void => {
    nodes.push(node);
  };
  const link = (from: string, to: string, kind: VisualEdge['kind'], label?: string): void => {
    if (from === to) return;
    const key = `${kind}\u0000${from}\u0000${to}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ from, to, kind, ...(label === undefined ? {} : { label }) });
  };

  const reachIndex: ReachIndex = new Map();
  for (const pipeline of ir.pipelines) {
    const reach = emptyReach();
    collectSteps(pipeline.steps, reach);
    closeReach(ir, reach);
    markReach(reachIndex, reach, pipeline.id);
  }
  const sequencesOf = (key: string): string[] => [...(reachIndex.get(key) ?? [])];
  const reachedByAnyPipeline = (key: string): boolean => reachIndex.has(key);

  const tools = new Map<string, ToolShape>(ir.tools.map((shape) => [shape.id, shape]));

  // --- Entry: one box per pipeline, because the trigger is declared on the pipeline. ---
  for (const pipeline of ir.pipelines) {
    add({
      id: sysId('trigger', pipeline.id),
      kind: 'trigger',
      group: 'service',
      zone: 'entry',
      label: describeTrigger(pipeline),
      detail: pipeline.id,
      path: `pipelines.${pipeline.id}.trigger`,
      facts: compact([
        ['trigger', pipeline.trigger.kind],
        ['pipeline', pipeline.id],
        ['steps', pipeline.steps.length],
        ['retries', pipeline.errorPolicy.retries],
        ['deadLetter', pipeline.errorPolicy.deadLetter],
      ]),
      related: [`pipeline:${pipeline.id}`],
      sequences: [pipeline.id],
    });
  }

  // --- Identity: the declared issuer, and the runtime gateway in front of it. ---
  const identityNodes = new Map<string, string>();
  for (const deployment of ir.deployments) {
    const identity = deployment.identity;
    if (identity === undefined) continue;
    const key = JSON.stringify([identity.kind, identity.issuer, identity.audience ?? null]);
    const existing = identityNodes.get(key);
    const nodeId = existing ?? sysId('identity', `${deployment.id}`);
    if (existing === undefined) {
      identityNodes.set(key, nodeId);
      add({
        id: nodeId,
        kind: 'identity',
        group: 'infra',
        zone: 'identity',
        label: identity.issuer,
        detail: `${identity.kind} identity provider`,
        path: `deployments.${deployment.id}.identity`,
        facts: compact([
          ['kind', identity.kind],
          ['issuer', identity.issuer],
          ['audience', identity.audience],
          ['verifiedBy', identity.verifiedBy],
          ['deployments', list([deployment.id])],
        ]),
        related: [`deployment:${deployment.id}`],
        sequences: [],
      });
    }
  }

  const gateways = new Map(ir.gateways.map((shape) => [shape.id, shape]));
  for (const deployment of ir.deployments) {
    const gatewayId = deployment.runtime?.gateway;
    if (gatewayId === undefined) continue;
    const nodeId = sysId('gateway', gatewayId);
    const gateway = gateways.get(gatewayId);
    if (!nodes.some((node) => node.id === nodeId)) {
      add({
        id: nodeId,
        kind: 'gateway',
        group: 'infra',
        zone: 'identity',
        label: gatewayId,
        detail:
          gateway === undefined ? 'runtime gateway' : `gateway · ${gateway.authorizer.kind} auth`,
        path: `gateways.${gatewayId}`,
        facts: compact([
          ['authorizer', gateway?.authorizer.kind],
          [
            'discoveryUrl',
            gateway?.authorizer.kind === 'jwt' ? gateway.authorizer.discoveryUrl : undefined,
          ],
          ['targets', list((gateway?.targets ?? []).map((target) => target.source.kind))],
        ]),
        related: [`gateway:${gatewayId}`, `deployment:${deployment.id}`],
        sequences: [],
      });
    }
  }

  // --- Compute: one box per deployment, with the delivery controls as facts. ---
  const pipelineIds = ir.pipelines.map((pipeline) => pipeline.id);
  for (const deployment of ir.deployments) {
    add(deploymentSystemNode(deployment, pipelineIds));
  }

  // --- Data: only what a served pipeline actually reaches. ---
  const dataNodes: string[] = [];
  for (const store of ir.stores) {
    const key = `store:${store.id}`;
    if (!reachedByAnyPipeline(key)) continue;
    const nodeId = sysId('store', store.id);
    dataNodes.push(nodeId);
    add({
      id: nodeId,
      kind: 'store',
      group: 'retrieval',
      zone: 'data',
      label: store.id,
      detail: store.uri === undefined ? store.kind : `${store.kind} · ${store.uri}`,
      path: `stores.${store.id}`,
      facts: compact([
        ['kind', store.kind],
        ['uri', store.uri],
        ['dimensions', store.dimensions],
        ['pipelines', list(sequencesOf(key))],
      ]),
      related: [`store:${store.id}`],
      sequences: sequencesOf(key),
    });
  }

  for (const knowledgeBase of ir.knowledgeBases) {
    const key = `knowledgeBase:${knowledgeBase.id}`;
    if (!reachedByAnyPipeline(key)) continue;
    const nodeId = sysId('knowledgeBase', knowledgeBase.id);
    dataNodes.push(nodeId);
    add({
      id: nodeId,
      kind: 'knowledgeBase',
      group: 'retrieval',
      zone: 'data',
      label: knowledgeBase.id,
      detail: `${knowledgeBase.engine} knowledge base`,
      path: `knowledgeBases.${knowledgeBase.id}`,
      facts: compact([
        ['engine', knowledgeBase.engine],
        ['dataSource', `${knowledgeBase.dataSource.kind} ${knowledgeBase.dataSource.uri}`],
        [
          'vectorStore',
          knowledgeBase.vectorStore.kind === 'provisioned'
            ? 'provisioned by this build'
            : knowledgeBase.vectorStore.arn,
        ],
        ['pipelines', list(sequencesOf(key))],
      ]),
      related: [`knowledgeBase:${knowledgeBase.id}`],
      sequences: sequencesOf(key),
    });
  }

  // The durable run store is one box per distinct declaration, because two agents that
  // declare the same store are the same store. `stateKey` mirrors the inventory's dedupe.
  if (ir.state !== undefined) {
    const state = ir.state;
    add({
      id: sysId('state', 'run'),
      kind: 'state',
      group: 'document',
      zone: 'data',
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
      related: ['state'],
      sequences: ir.pipelines.map((pipeline) => pipeline.id),
    });
  }

  // --- External: providers actually called, MCP servers, audit sinks, trace collector. ---
  const providerNodes = new Map<string, string>();
  const modelsByProvider = new Map<string, string[]>();
  for (const model of ir.models) {
    if (!reachedByAnyPipeline(`model:${model.id}`)) continue;
    const group = modelsByProvider.get(model.provider) ?? [];
    group.push(model.id);
    modelsByProvider.set(model.provider, group);
  }
  for (const embedding of ir.embeddings) {
    const used = ir.retrievers.some(
      (retriever) =>
        reachedByAnyPipeline(`retriever:${retriever.id}`) &&
        !isManagedRetriever(retriever) &&
        retriever.embedModel === embedding.id,
    );
    if (!used) continue;
    const group = modelsByProvider.get(embedding.provider) ?? [];
    if (!group.includes(embedding.id)) group.push(embedding.id);
    modelsByProvider.set(embedding.provider, group);
  }
  for (const [provider, ids] of [...modelsByProvider].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const nodeId = sysId('provider', provider);
    providerNodes.set(provider, nodeId);
    add({
      id: nodeId,
      kind: 'provider',
      group: 'model',
      zone: 'external',
      label: providerLabel(provider),
      detail: `${ids.length} model${ids.length === 1 ? '' : 's'} pinned here`,
      path: `models.${ids[0] ?? ''}.provider`,
      facts: compact([
        ['provider', provider],
        ['models', list(ids)],
        [
          'pipelines',
          list(
            unique(ids.flatMap((id) => sequencesOf(`model:${id}`))).sort((left, right) =>
              left.localeCompare(right),
            ),
          ),
        ],
      ]),
      related: ids.map((id) => `model:${id}`),
      sequences: unique(ids.flatMap((id) => sequencesOf(`model:${id}`))),
    });
  }

  const mcpServers = new Map<string, string[]>();
  for (const tool of ir.tools) {
    if (tool.handler.kind !== 'mcp') continue;
    if (!reachedByAnyPipeline(`tool:${tool.id}`)) continue;
    const server = tool.handler.mcp?.server;
    if (server === undefined) continue;
    const group = mcpServers.get(server) ?? [];
    group.push(tool.id);
    mcpServers.set(server, group);
  }
  for (const [server, ids] of [...mcpServers].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    add({
      id: sysId('mcp', server),
      kind: 'mcp',
      group: 'tool',
      zone: 'external',
      label: server,
      detail: `MCP server · ${ids.length} tool${ids.length === 1 ? '' : 's'}`,
      path: `tools.${ids[0] ?? ''}.handler.mcp.server`,
      facts: compact([
        ['server', server],
        ['tools', list(ids)],
        ['sideEffects', list(unique(ids.map((id) => tools.get(id)?.sideEffects ?? 'none')))],
      ]),
      related: ids.map((id) => `tool:${id}`),
      sequences: unique(ids.flatMap((id) => sequencesOf(`tool:${id}`))),
    });
  }

  const auditSinks = new Set<string>();
  for (const deployment of ir.deployments) {
    const sink = deployment.audit?.sink;
    if (sink === undefined) continue;
    auditSinks.add(sink);
    if (!nodes.some((node) => node.id === sysId('audit', sink))) {
      add({
        id: sysId('audit', sink),
        kind: 'audit',
        group: 'infra',
        zone: 'external',
        label: sink,
        detail: 'audit sink',
        path: `deployments.${deployment.id}.audit.sink`,
        facts: compact([
          ['sink', sink],
          [
            'retentionDays',
            list(
              unique(
                ir.deployments
                  .filter((candidate) => candidate.audit?.sink === sink)
                  .map((candidate) => String(candidate.audit?.retentionDays ?? '')),
              ).filter((value) => value !== ''),
            ),
          ],
        ]),
        related: ir.deployments
          .filter((candidate) => candidate.audit?.sink === sink)
          .map((candidate) => `deployment:${candidate.id}`),
        sequences: [],
      });
    }
  }

  const otlp = ir.observability.export === 'otlp';
  if (otlp) {
    add({
      id: sysId('otlp', 'collector'),
      kind: 'otel',
      group: 'infra',
      zone: 'external',
      label: 'OTel collector',
      detail: ir.observability.endpointEnv ?? 'otlp export',
      path: 'observability',
      facts: compact([
        ['export', ir.observability.export],
        ['endpointEnv', ir.observability.endpointEnv],
        ['redact', list(ir.observability.redact)],
        ['trace', String(ir.observability.trace)],
      ]),
      related: ['observability'],
      sequences: ir.pipelines.map((pipeline) => pipeline.id),
    });
  }

  // --- Wires. A deployment is the process, so it is what calls out. ---
  const sources =
    ir.deployments.length === 0
      ? ir.pipelines.map((pipeline) => ({
          id: sysId('trigger', pipeline.id),
          pipelines: [pipeline.id],
        }))
      : ir.deployments.map((deployment) => ({
          id: sysId('deployment', deployment.id),
          pipelines: ir.pipelines
            .filter((pipeline) => servesPipeline(deployment, pipeline.id))
            .map((pipeline) => pipeline.id),
        }));

  for (const pipeline of ir.pipelines) {
    const triggerId = sysId('trigger', pipeline.id);
    for (const source of sources) {
      if (source.pipelines.includes(pipeline.id)) link(triggerId, source.id, 'serves');
    }
  }

  for (const deployment of ir.deployments) {
    const from = sysId('deployment', deployment.id);
    const served =
      deployment.pipeline === undefined
        ? ir.pipelines.map((pipeline) => pipeline.id)
        : [deployment.pipeline];

    const identity = deployment.identity;
    if (identity !== undefined) {
      const key = JSON.stringify([identity.kind, identity.issuer, identity.audience ?? null]);
      const nodeId = identityNodes.get(key);
      if (nodeId !== undefined) link(nodeId, from, 'connects', 'token');
    }

    const gatewayId = deployment.runtime?.gateway;
    if (gatewayId !== undefined) link(sysId('gateway', gatewayId), from, 'connects', 'forwards');

    for (const [provider, ids] of modelsByProvider) {
      const reached = ids.filter((id) =>
        sequencesOf(`model:${id}`).some((p) => served.includes(p)),
      );
      if (reached.length === 0) continue;
      const to = providerNodes.get(provider);
      if (to !== undefined) link(from, to, 'connects', list(reached));
    }

    for (const store of ir.stores) {
      if (reachedByAnyPipeline(`store:${store.id}`))
        link(from, sysId('store', store.id), 'connects');
    }
    for (const knowledgeBase of ir.knowledgeBases) {
      if (reachedByAnyPipeline(`knowledgeBase:${knowledgeBase.id}`)) {
        link(from, sysId('knowledgeBase', knowledgeBase.id), 'connects');
      }
    }
    for (const server of mcpServers.keys()) link(from, sysId('mcp', server), 'connects');
    if (deployment.audit !== undefined) {
      link(
        from,
        sysId('audit', deployment.audit.sink),
        'records',
        `${deployment.audit.retentionDays}d retention`,
      );
    }
    if (otlp) link(from, sysId('otlp', 'collector'), 'connects', 'otlp');
    if (ir.state !== undefined) link(from, sysId('state', 'run'), 'connects', 'run state');
  }

  edges.sort((left, right) => {
    const from = left.from.localeCompare(right.from);
    if (from !== 0) return from;
    const to = left.to.localeCompare(right.to);
    if (to !== 0) return to;
    return left.kind.localeCompare(right.kind);
  });

  const counts = new Map<SystemZoneId, number>();
  for (const node of nodes) counts.set(node.zone, (counts.get(node.zone) ?? 0) + 1);

  return {
    zones: SYSTEM_ZONES.map((zone) => ({
      zone: zone.id,
      title: zone.title,
      blurb: zone.blurb,
      count: counts.get(zone.id) ?? 0,
    })),
    nodes,
    edges,
  };
}

/**
 * Whether a deployment serves a pipeline.
 *
 * A deployment that names `pipeline` serves only that one; one that names none serves the
 * whole app. The `serves` arrow, the `served by` note on a flow, and the flow a compute box
 * opens all read this one rule, so the picture cannot say a deployment runs something its
 * box then claims to know nothing about.
 */
function servesPipeline(deployment: DeploymentShape, pipelineId: string): boolean {
  return deployment.pipeline === undefined || deployment.pipeline === pipelineId;
}

/** The facts a deployment box shows. Delivery controls live here, not on an arrow. */
function deploymentSystemNode(
  deployment: DeploymentShape,
  pipelineIds: readonly string[],
): SystemNode {
  const served = pipelineIds.filter((id) => servesPipeline(deployment, id));
  const placement =
    deployment.cloud === undefined && deployment.region === undefined
      ? undefined
      : `${deployment.cloud ?? 'cloud?'} · ${deployment.region ?? 'region?'}`;
  return {
    id: sysId('deployment', deployment.id),
    kind: 'deployment',
    group: 'infra',
    zone: 'compute',
    label: deployment.id,
    detail: placement ?? `${deployment.target} target`,
    path: `deployments.${deployment.id}`,
    facts: compact([
      ['target', deployment.target],
      ['cloud', deployment.cloud],
      ['region', deployment.region],
      ['namespace', deployment.kubernetes?.namespace],
      ['image', deployment.image?.registry],
      ['platform', deployment.runtime?.platform],
      ['gateway', deployment.runtime?.gateway],
      ['streaming', String(deployment.streaming)],
      ['concurrency', deployment.concurrency],
      ['autoscale', deployment.autoscale === undefined ? undefined : 'declared'],
      [
        'network',
        deployment.network === undefined
          ? undefined
          : `${deployment.network.private ? 'private' : 'public'} · egress ${deployment.network.egress}`,
      ],
      ['allowFrom', list(deployment.network?.allowFrom ?? [])],
      ['audit', deployment.audit?.sink],
      ['auditRetentionDays', deployment.audit?.retentionDays],
      ['identity', deployment.identity?.kind],
      ['approvals', list(deployment.approvals?.require ?? [])],
      ['minApprovers', deployment.approvals?.minApprovers],
      ['secrets', list(deployment.secrets)],
      ['pipeline', deployment.pipeline],
    ]),
    related: [`deployment:${deployment.id}`, ...served.map((id) => `pipeline:${id}`)],
    sequences: served,
  };
}

/**
 * The request path of every pipeline, assembled from the declared step order.
 *
 * This is the answer to "what happens when a request arrives": the steps in order, what
 * each one calls, and the guardrail, redaction, approval and retrieval facts the spec
 * declares at that point. It is assembled here rather than in the browser so the same
 * reading is available to `--json` and to a test.
 */
export function buildSequences(ir: IR): PipelineSequence[] {
  const prompts = new Map(ir.prompts.map((shape) => [shape.id, shape]));
  const guardrails = new Map(ir.guardrails.map((shape) => [shape.id, shape]));
  const tools = new Map(ir.tools.map((shape) => [shape.id, shape]));
  const retrievers = new Map(ir.retrievers.map((shape) => [shape.id, shape]));
  const agents = new Map(ir.agents.map((shape) => [shape.id, shape]));

  return ir.pipelines.map((pipeline) => {
    const rows: SequenceRow[] = [];

    const push = (row: SequenceRow): void => {
      rows.push(row);
    };

    const walk = (steps: readonly StepShape[], parentPath: string, depth: number): void => {
      steps.forEach((step, index) => {
        const path = `${parentPath}${index}`;
        const nodeId = `step:${pipeline.id}/${path}`;
        const notes: string[] = [];
        const flags: string[] = [];
        let text = `${path} ${step.kind}`;

        switch (step.kind) {
          case 'generate': {
            const prompt = prompts.get(step.prompt);
            text = `${step.prompt} → ${step.model}`;
            notes.push(`binds ${step.as}`);
            if (step.context !== undefined) notes.push(`context ${step.context}`);
            if (prompt !== undefined) {
              notes.push(`pinned ${prompt.model} · identity ${prompt.identity}`);
              for (const id of prompt.guardrails) {
                const guardrail = guardrails.get(id);
                notes.push(
                  guardrail === undefined
                    ? `guarded by ${id}`
                    : `guarded by ${id} (${guardrail.stages.join(', ')})`,
                );
              }
            }
            break;
          }
          case 'tool': {
            const tool = tools.get(step.tool);
            text = `${step.tool} → ${step.as}`;
            if (tool !== undefined) {
              notes.push(`side effects: ${tool.sideEffects}`);
              if (tool.sideEffects !== 'none' && tool.sideEffects !== 'read') flags.push('write');
              if (tool.timeoutMs !== undefined) notes.push(`timeout ${tool.timeoutMs}ms`);
              if (tool.retries !== undefined) notes.push(`retries ${tool.retries}`);
              if (tool.idempotency !== undefined) notes.push(`idempotency ${tool.idempotency}`);
              if (tool.handler.kind === 'mcp') flags.push('mcp');
              if (tool.requiresConfirmation) {
                notes.push('tool requires confirmation');
                flags.push('approval');
              }
            }
            if (step.requiresApproval === true) {
              notes.push('run pauses for a human before this step');
              flags.push('approval');
            }
            break;
          }
          case 'retrieve': {
            const retriever = retrievers.get(step.retriever);
            text = `${step.retriever} → ${step.as}`;
            notes.push(`query: ${step.query}`);
            if (retriever !== undefined) {
              if (isManagedRetriever(retriever))
                notes.push(`knowledge base ${retriever.knowledgeBase}`);
              else notes.push(`store ${retriever.store}`);
              notes.push(`top ${retriever.topK}`);
              if (retriever.rerank !== undefined) {
                notes.push(`rerank ${retriever.rerank.model} · top ${retriever.rerank.topN}`);
              }
            }
            flags.push('retrieval');
            break;
          }
          case 'guard': {
            const guardrail = guardrails.get(step.guardrail);
            text = `${step.guardrail} · ${step.stage}`;
            if (guardrail !== undefined) {
              notes.push(`action ${guardrail.action}`);
              if (guardrail.action === 'redact') {
                notes.push(`redacts ${guardrail.redact.join(', ')}`);
                flags.push('redact');
              }
              if (guardrail.action === 'block') flags.push('block');
              if (guardrail.policies.length > 0)
                notes.push(`policies ${guardrail.policies.join(', ')}`);
              if (guardrail.decision !== undefined) notes.push(`decision ${guardrail.decision}`);
              if (guardrail.tools.length > 0) notes.push(`tools ${guardrail.tools.join(', ')}`);
              notes.push(`onFail: ${guardrail.onFail.message}`);
              if (guardrail.onFail.fallbackPrompt !== undefined) {
                notes.push(`fallback prompt ${guardrail.onFail.fallbackPrompt}`);
              }
            }
            break;
          }
          case 'agent': {
            const agent = agents.get(step.agent);
            text = `${step.agent} → ${step.as}`;
            if (agent !== undefined) {
              notes.push(`${agent.model} · max ${agent.maxSteps} steps`);
              if (agent.maxTokensBudget !== undefined) {
                notes.push(`max ${agent.maxTokensBudget} tokens`);
              }
              if (agent.maxCostBudget !== undefined) notes.push(`max $${agent.maxCostBudget}`);
              if (agent.onBudgetExhausted !== undefined) {
                notes.push(`on budget exhausted: ${agent.onBudgetExhausted}`);
              }
              if (agent.tools.length > 0) notes.push(`tools ${agent.tools.join(', ')}`);
              if (agent.guardrails.length > 0) {
                notes.push(`guardrails ${agent.guardrails.join(', ')}`);
              }
              if (agent.humanInTheLoop !== undefined) {
                notes.push(`pauses on ${agent.humanInTheLoop.channel}`);
                flags.push('approval');
              }
            }
            break;
          }
          case 'route': {
            text = `${step.decision} · ${Object.keys(step.on).length} arm${
              Object.keys(step.on).length === 1 ? '' : 's'
            }`;
            for (const [label, arm] of Object.entries(step.on)) {
              notes.push(`arm ${label}: ${arm.length} step${arm.length === 1 ? '' : 's'}`);
            }
            if (step.default !== undefined) {
              notes.push(
                `default: ${step.default.length} step${step.default.length === 1 ? '' : 's'}`,
              );
            }
            break;
          }
          case 'branch':
            text = `branch · ${step.then.length} then / ${step.else.length} else`;
            notes.push(`when ${formatPolicyExpr(step.when)}`);
            break;
          case 'parallel':
            text = `parallel · ${step.branches.length} arm${step.branches.length === 1 ? '' : 's'}`;
            break;
          case 'map':
            text = `map over ${step.over} as ${step.as}`;
            break;
          case 'reduce':
            text = `reduce over ${step.over} → ${step.prompt}`;
            notes.push(`binds ${step.as} · ${step.model}`);
            break;
          case 'rerank':
            text = `rerank over ${step.over} · top ${step.topN}`;
            notes.push(`model ${step.model}`);
            break;
          case 'emit':
            text = `emit ${step.event}`;
            break;
        }

        push({
          nodeId,
          path,
          kind: step.kind,
          text,
          notes,
          flags: unique(flags),
          depth,
        });

        switch (step.kind) {
          case 'route':
            for (const [label, arm] of Object.entries(step.on)) {
              walk(arm, `${path}.on.${label}.`, depth + 1);
            }
            if (step.default !== undefined) walk(step.default, `${path}.default.`, depth + 1);
            break;
          case 'branch':
            walk(step.then, `${path}.then.`, depth + 1);
            walk(step.else, `${path}.else.`, depth + 1);
            break;
          case 'parallel':
            for (const [index, arm] of step.branches.entries()) {
              walk(arm, `${path}.arm${index}.`, depth + 1);
            }
            break;
          case 'map':
            walk([step.step], `${path}.step.`, depth + 1);
            break;
          default:
            break;
        }
      });
    };

    walk(pipeline.steps, '', 0);

    const servedBy = ir.deployments
      .filter((deployment) => servesPipeline(deployment, pipeline.id))
      .map((deployment) => deployment.id);

    return {
      pipeline: pipeline.id,
      nodeId: `pipeline:${pipeline.id}`,
      trigger: describeTrigger(pipeline),
      steps: rows.length,
      notes: compact([
        ['trigger', describeTrigger(pipeline)],
        ['served by', servedBy.length === 0 ? undefined : list(servedBy)],
        ['tracing', String(pipeline.observability.trace)],
        ['retries', pipeline.errorPolicy.retries],
        ['fallback under', pipeline.errorPolicy.fallback],
        ['dead letter', pipeline.errorPolicy.deadLetter],
        ['trace redact', list(ir.observability.redact)],
        ['feedback', list((ir.observability.feedback?.signals ?? []).map((signal) => signal.kind))],
      ]).map((fact) => `${fact.label}: ${fact.value}`),
      rows,
    };
  });
}

/** Kept for the type of a fact list, so a future caller cannot drift from `compact`. */
export type SystemFactInput = FactInput;
