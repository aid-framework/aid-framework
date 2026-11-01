import { describe, expect, it } from 'vitest';

import { buildDeployPlan, buildIR, DEPLOY_PLAN_VERSION } from '../src/index.js';

/**
 * A spec the IR admits, carrying one of each thing the plan has to derive. Tests vary
 * exactly one field so a failure names its own cause.
 */
function spec(overrides: Record<string, unknown> = {}) {
  return {
    specVersion: '0.2',
    project: { name: 'planner', namespace: 'acme' },
    models: {
      chat: {
        provider: 'openai',
        modelId: 'gpt-4o-mini',
        apiKeyEnv: 'OPENAI_API_KEY',
        capabilities: ['json-schema'],
      },
      embed: { provider: 'fake', modelId: 'fake-embed', capabilities: ['embeddings'] },
    },
    prompts: {
      chat_prompt: { version: 1, model: 'chat', template: 'Answer the question.' },
    },
    stores: { docs: { kind: 'pgvector', uri: 'env:PGVECTOR_URL', dimensions: 1536 } },
    retrievers: {
      handbook: {
        source: { kind: 'file', uri: './docs', glob: '**/*.md' },
        chunking: { strategy: 'recursive', size: 800, overlap: 100, keepMetadata: [] },
        embedModel: 'embed',
        store: 'docs',
        index: { metric: 'cosine', hybrid: false },
        topK: 5,
        refresh: { mode: 'full', schedule: '0 2 * * *' },
      },
    },
    agents: {
      assistant: {
        name: 'Assistant',
        instructions: 'chat_prompt',
        model: 'chat',
        maxSteps: 2,
        maxCostBudget: 12,
        maxTokensBudget: 100_000,
      },
    },
    deployments: {
      api: {
        target: 'container',
        secrets: ['DEPLOY_TOKEN'],
        env: [
          { name: 'LOG_LEVEL', value: 'info' },
          { name: 'EXTRA_SECRET', secret: true },
        ],
      },
    },
    ...overrides,
  };
}

function planOf(overrides: Record<string, unknown> = {}) {
  const { ir, diagnostics } = buildIR(spec(overrides));
  return { plan: buildDeployPlan(ir), ir, diagnostics };
}

describe('buildDeployPlan', () => {
  it('derives one service per deployment with only shape, never scale', () => {
    const { plan, ir, diagnostics } = planOf({
      deployments: {
        api: {
          target: 'container',
          concurrency: 4,
          autoscale: { min: 2, max: 8, metric: 'cpu' },
          secrets: [],
        },
      },
    });
    expect(diagnostics).toEqual([]);

    // Non-vacuity: the IR really carries the sizes the plan must drop.
    expect(ir.deployments[0]?.autoscale).toEqual({ min: 2, max: 8, metric: 'cpu' });
    expect(ir.deployments[0]?.concurrency).toBe(4);

    const service = plan.services[0];
    expect(service?.id).toBe('api');
    expect(service?.target).toBe('container');
    expect(service?.streaming).toBe(false);
    // The key set is the contract: no `autoscale`, no `concurrency`, no sizing field
    // can appear without this assertion failing first.
    expect(Object.keys(service ?? {}).sort()).toEqual([
      'endpoints',
      'env',
      'id',
      'ingest',
      'providers',
      'secrets',
      'streaming',
      'target',
    ]);
    expect(JSON.stringify(plan)).not.toContain('autoscale');
    expect(plan.planVersion).toBe(DEPLOY_PLAN_VERSION);
    expect(plan.project).toEqual({ name: 'planner', namespace: 'acme' });
  });

  it('derives routes from HTTP pipelines only', () => {
    const { plan } = planOf({
      pipelines: {
        answer: {
          description: 'Answer',
          trigger: { http: { method: 'post', path: '/answer' } },
          steps: [{ prompt: { prompt: 'chat_prompt' } }],
        },
      },
    });
    expect(plan.services[0]?.endpoints).toEqual([
      { pipeline: 'answer', method: 'post', path: '/answer' },
    ]);
  });

  it('splits literal env from secret references across all three sources', () => {
    const { plan } = planOf();
    const service = plan.services[0];
    expect(service?.env).toEqual([
      { name: 'EXTRA_SECRET', secret: true, from: 'deployment' },
      { name: 'LOG_LEVEL', secret: false, from: 'deployment', value: 'info' },
      { name: 'OPENAI_API_KEY', secret: true, from: 'model' },
      { name: 'PGVECTOR_URL', secret: true, from: 'store' },
    ]);
    // Every secret-bearing name, and no value, is what the platform resolves.
    expect(service?.secrets).toEqual([
      'DEPLOY_TOKEN',
      'EXTRA_SECRET',
      'OPENAI_API_KEY',
      'PGVECTOR_URL',
    ]);
    expect(service?.providers).toEqual(['fake', 'openai']);
    expect(service?.ingest).toEqual(['handbook']);
  });

  it('lets a deployment declaration win over a derived name', () => {
    const { plan } = planOf({
      deployments: {
        api: {
          target: 'container',
          secrets: [],
          // The same name a model would derive, declared explicitly as a literal.
          env: [{ name: 'OPENAI_API_KEY', value: 'dev-placeholder' }],
        },
      },
    });
    const variables = plan.services[0]?.env ?? [];
    expect(variables.filter((variable) => variable.name === 'OPENAI_API_KEY')).toEqual([
      { name: 'OPENAI_API_KEY', secret: false, from: 'deployment', value: 'dev-placeholder' },
    ]);
    // Precedence over the variable does not hide the model's need for a secret.
    expect(plan.services[0]?.secrets).toContain('OPENAI_API_KEY');
  });

  it('gives a store a secret reference, not a uri, and flags the vector extension', () => {
    const { plan } = planOf();
    expect(plan.stores).toEqual([
      {
        id: 'docs',
        kind: 'pgvector',
        secretRef: 'PGVECTOR_URL',
        requiresExtension: 'vector',
        retrievers: ['handbook'],
      },
    ]);
  });

  it('does not copy a literal store uri into the plan', () => {
    const { plan } = planOf({
      stores: { cache: { kind: 'qdrant', uri: 'http://localhost:6333' } },
    });
    expect(plan.stores[0]).toEqual({ id: 'cache', kind: 'qdrant', retrievers: [] });
  });

  it('carries alarm metrics without the budget values behind them', () => {
    const { plan } = planOf();
    expect(plan.alarms).toEqual([
      { id: 'alarm-assistant-cost', metric: 'agent.cost', source: 'assistant' },
      { id: 'alarm-assistant-tokens', metric: 'agent.tokens', source: 'assistant' },
    ]);
    // 12 and 100000 are the agent's budgets; neither may reach the plan.
    expect(JSON.stringify(plan.alarms)).not.toContain('12');
    expect(JSON.stringify(plan.alarms)).not.toContain('100000');
  });

  it('derives eval alarm hooks from eval budgets', () => {
    const { plan } = planOf({
      agents: {},
      evals: {
        quality: {
          target: 'pipeline:answer',
          dataset: { source: 'file', uri: 'evals/quality.json' },
          metrics: [
            { kind: 'retrieval', expectDocs: ['a.md'], k: 3 },
            { kind: 'cost', max: 5 },
            { kind: 'latency', maxMs: 2000 },
          ],
          gate: { ci: false, maxRegression: 0.05, samples: 1 },
        },
      },
      pipelines: {
        answer: {
          trigger: { http: { method: 'post', path: '/answer' } },
          steps: [
            { retrieve: { retriever: 'handbook', query: '{{ event.question }}' } },
            { prompt: { prompt: 'chat_prompt' } },
          ],
        },
      },
    });
    expect(plan.alarms).toEqual([
      { id: 'alarm-quality-cost', metric: 'eval.cost', source: 'quality' },
      { id: 'alarm-quality-latency', metric: 'eval.latency.p95', source: 'quality' },
    ]);
  });

  it('plans an ingest task per retriever and an eval task per eval', () => {
    const { plan } = planOf();
    expect(plan.tasks).toEqual([
      {
        id: 'ingest-handbook',
        kind: 'ingest',
        source: 'handbook',
        schedule: '0 2 * * *',
      },
    ]);
  });

  it('plans nothing for an empty IR', () => {
    const { ir } = buildIR({ specVersion: '0.1', project: { name: 'empty' } });
    expect(buildDeployPlan(ir)).toEqual({
      planVersion: DEPLOY_PLAN_VERSION,
      project: { name: 'empty', namespace: 'empty' },
      services: [],
      stores: [],
      tasks: [],
      alarms: [],
    });
  });

  it('contains no account id, CIDR, domain, or sizing number', () => {
    const { plan } = planOf({
      deployments: {
        api: {
          target: 'container',
          concurrency: 4,
          autoscale: { min: 2, max: 8, metric: 'cpu' },
          secrets: [],
        },
      },
      stores: { docs: { kind: 'pgvector', uri: 'env:PGVECTOR_URL', dimensions: 1536 } },
    });
    const text = JSON.stringify(plan);
    expect(text).not.toMatch(/\b\d{12}\b/); // cloud account id
    expect(text).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\/\d{1,2}\b/); // CIDR
    expect(text).not.toMatch(/https?:\/\//); // endpoint, never a domain
    expect(text).not.toContain('1536');
  });

  it('is deterministic', () => {
    const { ir } = buildIR(spec());
    expect(JSON.stringify(buildDeployPlan(ir))).toBe(JSON.stringify(buildDeployPlan(ir)));
  });
});
