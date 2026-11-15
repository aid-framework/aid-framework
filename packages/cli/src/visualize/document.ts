/**
 * The one document `aid visualize` produces, on both surfaces: the page and `--json`.
 *
 * It is the same read-and-lower pipeline `aid validate` and `aid review` use, then the graph
 * and its layout. Nothing here re-implements a gate, which is the whole point: a visualiser
 * that decided for itself whether a spec was buildable would sooner or later draw a diagram
 * of a spec the compiler refuses, and the diagram would be the more convincing artifact.
 *
 * A spec the build refuses has no document to draw, so it produces the refusals instead. That
 * is not a degraded mode: it is the honest answer, and in the browser it is the more useful
 * one, because the page is watched and reports the fix the moment the spec stops being wrong.
 */

import type { CliContext } from '../context.js';
import type { CliDiagnostic } from '../diagnostics.js';
import { lowerSpec, readSpec } from '../pipeline.js';
import type { VisualGraph } from './graph.js';
import { buildVisualGraph } from './graph.js';
import type { Layout } from './layout.js';
import { layoutGraph } from './layout.js';

/** The numbers worth printing before someone looks at the picture. */
export interface VisualCounts {
  readonly nodes: number;
  readonly edges: number;
  readonly steps: number;
  readonly groups: number;
}

export interface VisualDocumentReady {
  readonly ok: true;
  readonly specPath: string;
  readonly graph: VisualGraph;
  readonly layout: Layout;
  readonly counts: VisualCounts;
  /** Build-time warnings the gates accepted, carried so the page can show them. */
  readonly warnings: readonly CliDiagnostic[];
}

export interface VisualDocumentRefused {
  readonly ok: false;
  readonly specPath: string;
  readonly diagnostics: readonly CliDiagnostic[];
}

export type VisualDocument = VisualDocumentReady | VisualDocumentRefused;

export function buildVisualDocument(context: CliContext, specPath: string): VisualDocument {
  const read = readSpec(context, specPath);
  if (!read.ok) return { ok: false, specPath, diagnostics: read.diagnostics };

  const lowered = lowerSpec(read.text, specPath);
  if (!lowered.ok) return { ok: false, specPath, diagnostics: lowered.diagnostics };

  const graph = buildVisualGraph(lowered.ir);
  return {
    ok: true,
    specPath,
    graph,
    layout: layoutGraph(graph),
    counts: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      steps: graph.nodes.filter((node) => node.kind.startsWith('step:')).length,
      groups: graph.groups.filter((group) => group.count > 0).length,
    },
    warnings: lowered.diagnostics,
  };
}
