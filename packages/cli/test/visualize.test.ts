import { afterAll, describe, expect, it } from 'vitest';

import { createContext } from '../src/index.js';
import { lowerSpec } from '../src/pipeline.js';
import { templateSpec } from '../src/templates.js';
import { buildVisualDocument } from '../src/visualize/document.js';
import type { VisualGraph, VisualNode } from '../src/visualize/graph.js';
import { buildVisualGraph, VISUAL_GRAPH_VERSION, VISUAL_GROUPS } from '../src/visualize/graph.js';
import type { Layout } from '../src/visualize/layout.js';
import { layoutGraph } from '../src/visualize/layout.js';
import { renderPage } from '../src/visualize/page.js';
import { startVisualServer } from '../src/visualize/server.js';
import type { Project } from './helpers.js';
import { aid, diagnosticsOf, EXAMPLE_SPEC, project, SPEC_PATH } from './helpers.js';

const created: Project[] = [];
function scratch(specText?: string): Project {
  const made = project(specText);
  created.push(made);
  return made;
}

afterAll(() => {
  for (const made of created) made.close();
});

function graphOf(specText: string = EXAMPLE_SPEC): VisualGraph {
  const lowered = lowerSpec(specText, SPEC_PATH);
  if (!lowered.ok) throw new Error('the fixture has to build for this file to mean anything');
  return buildVisualGraph(lowered.ir);
}

function contextFor(root: string) {
  return createContext({ cwd: root, stdout: () => {}, stderr: () => {} });
}

describe('buildVisualGraph', () => {
  const graph = graphOf();

  it('drops nothing and repeats nothing', () => {
    const ids = graph.nodes.map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('project');
  });

  it('files every node under a column that will be drawn, in the declared order', () => {
    const columns = VISUAL_GROUPS.map((group) => group.id);
    expect(graph.groups.map((group) => group.group)).toEqual(columns);
    for (const node of graph.nodes) {
      expect(columns).toContain(node.group);
    }
  });

  it('routes every edge between nodes it actually drew', () => {
    const ids = new Set(graph.nodes.map((node) => node.id));
    const dangling = graph.edges.filter((edge) => !ids.has(edge.from) || !ids.has(edge.to));
    expect(dangling).toEqual([]);
  });

  it('is a pure function of the IR, because the picture is asserted on', () => {
    expect(graphOf()).toStrictEqual(graph);
  });
});

describe('layoutGraph', () => {
  const graph = graphOf();
  const layout = layoutGraph(graph);

  it('gives every node one finite position', () => {
    expect(layout.nodes.map((placed) => placed.node.id)).toEqual(
      graph.nodes.map((node) => node.id),
    );
    for (const placed of layout.nodes) {
      for (const value of [placed.x, placed.y, placed.width, placed.height]) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it('routes every edge with a drawable path', () => {
    expect(layout.edges.length).toBe(graph.edges.length);
    for (const edge of layout.edges) {
      expect(edge.d).toMatch(/^M\s*-?[\d.]/);
      expect(edge.d).not.toContain('NaN');
    }
  });

  it('is deterministic, so two runs of the same spec land in the same place', () => {
    expect(layoutGraph(graphOf())).toStrictEqual(layout);
  });

  it('puts no two boxes on top of each other', () => {
    const boxes = layout.nodes;
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i] as (typeof boxes)[number];
        const b = boxes[j] as (typeof boxes)[number];
        const apart =
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y;
        expect(apart, `${a.node.id} overlaps ${b.node.id}`).toBe(true);
      }
    }
  });
});

interface GraphJson {
  readonly spec: string;
  readonly profile: string;
  readonly counts: { readonly nodes: number; readonly edges: number };
  readonly graph: VisualGraph;
  readonly layout: Layout;
}

describe('aid visualize --json', () => {
  it('prints the graph and its geometry without binding a port', () => {
    const made = scratch();
    const run = aid(made, ['visualize', '--json']);

    expect(run.code).toBe(0);
    const report = run.json<GraphJson & Record<string, unknown>>();
    expect(report.spec).toBe(SPEC_PATH);
    expect(report.counts.nodes).toBe(report.graph.nodes.length);
    expect(report.counts.edges).toBe(report.graph.edges.length);
    expect(report.layout.nodes.length).toBe(report.graph.nodes.length);
    // Serving is the other mode; a `--json` run that reported a port would claim it listened.
    expect('port' in report).toBe(false);
  });

  it('answers a spec the build refuses with the gates own diagnostics', () => {
    const made = scratch(
      templateSpec('support-copilot', 'demo').replace('profile: standard', 'profile: enterprise'),
    );
    const run = aid(made, ['visualize', '--json']);

    expect(run.code).toBe(1);
    expect(run.json<{ ok: boolean }>().ok).toBe(false);
    // The enterprise profile is not a label: without them the build refuses, and the picture
    // is refused with it rather than drawn from a spec that does not compile.
    expect(diagnosticsOf(run).map((entry) => entry.code)).toContain('ir/profile-identity');
  });

  it('refuses a spec that does not parse at all', () => {
    const made = scratch('this: [is not a spec');

    const run = aid(made, ['visualize', '--json']);

    expect(run.code).toBe(1);
    expect(diagnosticsOf(run).length).toBeGreaterThan(0);
  });
});

describe('aid visualize --port', () => {
  it.each(['abc', '0', '70000', '-1', ''])('refuses %j before it reads the spec', (port) => {
    const made = scratch();

    const run = aid(made, ['visualize', '--port', port, '--json']);

    expect(run.code).toBe(2);
    expect(diagnosticsOf(run).map((entry) => entry.code)).toEqual(['cli/visualize-port-invalid']);
  });
});

describe('the server the page is served from', () => {
  it('serves the shell, the graph and a 404, then stops', async () => {
    const made = scratch();
    const context = contextFor(made.root);
    const server = startVisualServer({
      specPath: SPEC_PATH,
      port: 0,
      load: () => buildVisualDocument(context, SPEC_PATH),
    });

    try {
      const { url } = await server.ready;

      const graph = await fetch(`${url}/api/graph`);
      expect(graph.status).toBe(200);
      expect(graph.headers.get('content-type')).toContain('application/json');
      const body = (await graph.json()) as {
        ok: boolean;
        revision: number;
        counts: GraphJson['counts'];
      };
      expect(body.ok).toBe(true);
      expect(body.revision).toBe(0);

      const page = await fetch(`${url}/`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      const html = await page.text();
      expect(html).toContain('data-aid-visualize');
      // The shell carries no spec data and no unsubstituted placeholder: every value it
      // shows has to arrive over the wire, which is what makes a redraw a refetch.
      expect(html).not.toMatch(/__[A-Z_]+__/);
      expect(html).not.toContain('http://example.invalid');

      const missing = await fetch(`${url}/nope`);
      expect(missing.status).toBe(404);
    } finally {
      await server.close();
    }
  });

  it('reports a taken port as a diagnostic instead of throwing', async () => {
    const made = scratch();
    const context = contextFor(made.root);
    const load = () => buildVisualDocument(context, SPEC_PATH);
    const first = startVisualServer({ specPath: SPEC_PATH, port: 0, load });
    const { port } = await first.ready;
    const second = startVisualServer({ specPath: SPEC_PATH, port, load });

    try {
      await expect(second.ready).rejects.toMatchObject({ code: 'cli/visualize-port-unavailable' });
    } finally {
      await second.close();
      await first.close();
    }
  });
});

/** A pipeline that branches, so the picture has arms to enter and a join to leave. */
function branchedSpec(): string {
  return templateSpec('support-copilot', 'demo').replace(
    `          as: reply
      - emit:
          event: Reply`,
    `          as: reply
      - branch:
          when: "hasRole('agent')"
          then:
            - guard:
                guardrail: message_injection
                stage: input
                text: "{{ event.message }}"
          else:
            - guard:
                guardrail: message_injection
                stage: input
                text: "{{ event.message }}"
      - emit:
          event: Reply`,
  );
}

/** The least graph `layoutGraph` accepts: two pipelines, one of which a batch job names. */
function twoPipelineGraph(): VisualGraph {
  const node = (
    id: string,
    kind: string,
    group: 'service' | 'infra',
    label: string,
    detail?: string,
  ): VisualNode => ({ id, kind, group, label, detail, path: id, facts: [] });
  return {
    graphVersion: VISUAL_GRAPH_VERSION,
    specVersion: '0.0.0',
    irVersion: '0.0.0',
    profile: 'standard',
    project: { name: 'demo', namespace: 'demo', targets: ['py-fastapi'] },
    groups: [],
    nodes: [
      node('project', 'project', 'service', 'demo'),
      node('pipeline:served', 'pipeline', 'service', 'served'),
      node('step:served/0', 'step:emit', 'service', 'emit'),
      node('pipeline:nightly', 'pipeline', 'service', 'nightly'),
      node('step:nightly/0', 'step:emit', 'service', 'emit'),
      node('deployment:api', 'deployment', 'infra', 'api', 'container · aws'),
      node('deployment:batch', 'deployment', 'infra', 'batch', 'batch · aws'),
    ],
    edges: [
      { from: 'deployment:batch', to: 'pipeline:nightly', kind: 'deploys' },
      { from: 'step:served/0', to: 'project', kind: 'uses' },
    ],
  };
}

describe('the process the diagram draws', () => {
  const graph = graphOf(branchedSpec());
  const layout = layoutGraph(graph);
  const from = (id: string): string[] =>
    graph.edges.filter((edge) => edge.kind === 'flow' && edge.from === id).map((edge) => edge.to);

  it('draws the declared order of the steps, not just that they belong to a pipeline', () => {
    expect(from('step:answer_message/0')).toEqual(['step:answer_message/1']);
  });

  it('enters every arm of a branch, and rejoins them on the step that follows', () => {
    // Which arm is listed first is the graph's stable sort, not the spec's; both must be
    // entered, and both must reach the step that follows.
    expect(from('step:answer_message/1').sort()).toEqual([
      'step:answer_message/1.else.0',
      'step:answer_message/1.then.0',
    ]);
    for (const arm of ['1.then.0', '1.else.0']) {
      expect(from(`step:answer_message/${arm}`)).toEqual(['step:answer_message/2']);
    }
  });

  it('puts run order left to right, and stacks the arms of one step into its column', () => {
    const x = (id: string): number =>
      layout.nodes.find((placed) => placed.node.id === `step:answer_message/${id}`)?.x ??
      Number.NaN;
    const y = (id: string): number =>
      layout.nodes.find((placed) => placed.node.id === `step:answer_message/${id}`)?.y ??
      Number.NaN;

    expect(x('0')).toBeLessThan(x('1'));
    expect(x('1')).toBeLessThan(x('1.then.0'));
    expect(x('1.then.0')).toBe(x('1.else.0'));
    expect(y('1.then.0')).not.toBe(y('1.else.0'));
    expect(x('1.else.0')).toBeLessThan(x('2'));
  });

  it('heads each lane with where it runs, read off the deployment the spec declares', () => {
    expect(layout.lanes.length).toBe(1);
    const [lane] = layout.lanes;
    expect(lane?.pipeline).toBe('pipeline:answer_message');
    expect(lane?.steps).toBe(5);
    expect(lane?.undeployed).toBe(false);
    expect(lane?.placements.join()).toContain('api');
  });

  it('keeps the whole process inside its lane', () => {
    const [lane] = layout.lanes;
    if (lane === undefined) throw new Error('the fixture declares a pipeline');
    for (const placed of layout.nodes) {
      if (!placed.node.id.startsWith('step:')) continue;
      expect(placed.x).toBeGreaterThanOrEqual(lane.x);
      expect(placed.y).toBeGreaterThanOrEqual(lane.y);
      expect(placed.x + placed.width).toBeLessThanOrEqual(lane.x + lane.width);
      expect(placed.y + placed.height).toBeLessThanOrEqual(lane.y + lane.height);
    }
  });

  it('serves every pipeline from a deployment that names none, and only one when it does', () => {
    const lanes = layoutGraph(twoPipelineGraph()).lanes;
    const byId = new Map(lanes.map((lane) => [lane.pipeline, lane]));

    // A deployment that answers requests cannot name a pipeline, so it runs the whole
    // service: absence of a `deploys` edge means every pipeline, not none.
    expect(byId.get('pipeline:served')?.placements).toEqual(['api (container · aws)']);
    // A batch job names exactly one, so it serves that one and leaves the other alone.
    expect(byId.get('pipeline:nightly')?.placements).toEqual([
      'api (container · aws)',
      'batch (batch · aws)',
    ]);
    expect(byId.get('pipeline:served')?.undeployed).toBe(false);
  });

  it('draws a pipeline no deployment serves, and says so, instead of dropping it', () => {
    const graph = twoPipelineGraph();
    const lanes = layoutGraph({
      ...graph,
      nodes: graph.nodes.filter((n) => n.id !== 'deployment:api'),
    }).lanes;

    expect(lanes.map((lane) => lane.pipeline)).toEqual(['pipeline:served', 'pipeline:nightly']);
    expect(lanes[0]?.placements).toEqual([]);
    expect(lanes[0]?.undeployed).toBe(true);
    expect(lanes[1]?.undeployed).toBe(false);
  });
});

describe('the page the reader gets', () => {
  const html = renderPage();

  it('says what a run-order edge means, and colours it like one', () => {
    expect(html).toContain('"flow":');
    expect(html).toContain('the step that runs after this one');
  });

  it('draws the lane band and never writes the read-only SVG className', () => {
    expect(html).toContain('lane-where');
    // `#canvas` is an <svg>, so its `className` is a read-only SVGAnimatedString: assigning
    // it throws and takes the first drag with it. The canvas has to go through classList.
    expect(html).not.toMatch(/canvas\.className\s*=/);
    expect(html).toContain("canvas.classList.add('dragging')");
  });
});

describe('aid visualize dispatch', () => {
  it('is named in the command list', () => {
    const made = scratch();

    const run = aid(made, ['--help']);

    expect(run.code).toBe(0);
    expect(run.stdout).toContain('visualize');
  });
});
