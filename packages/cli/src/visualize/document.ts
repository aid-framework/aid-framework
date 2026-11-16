/**
 * The one document `aid visualize` produces, on all of its surfaces: the served page, `--json`,
 * and the website's in-browser visualiser.
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

import type { TargetCapabilityDeclarations } from '@aid-framework/ir';

import type { CliDiagnostic } from '../diagnostics.js';
import { lowerSpecWithCapabilities } from '../lower.js';
import type { PipelineSequence, SystemGraph } from './architecture.js';
import { buildSequences, buildSystemGraph } from './architecture.js';
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
  /** Boxes in the architecture band, and the calls between them. */
  readonly systems: number;
  readonly calls: number;
}

export interface VisualDocumentReady {
  readonly ok: true;
  readonly specPath: string;
  readonly graph: VisualGraph;
  /** The architecture band: deployments and the systems they call. */
  readonly system: SystemGraph;
  /** One request path per pipeline, in declared run order. */
  readonly sequences: readonly PipelineSequence[];
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

/**
 * Build the document from spec text already in hand.
 *
 * Text plus capability declarations is everything the document needs, which is what lets the
 * website run this: a page has no filesystem and no installed generators, so it supplies the
 * text a visitor pasted and the declarations the build captures. `document-node.ts` is the
 * CLI's caller, which supplies the same two things from a path.
 */
export function visualDocumentFrom(
  text: string,
  specPath: string,
  capabilities: TargetCapabilityDeclarations,
): VisualDocument {
  const lowered = lowerSpecWithCapabilities(text, specPath, capabilities);
  if (!lowered.ok) return { ok: false, specPath, diagnostics: lowered.diagnostics };

  const graph = buildVisualGraph(lowered.ir);
  const system = buildSystemGraph(lowered.ir);
  const sequences = buildSequences(lowered.ir);
  return {
    ok: true,
    specPath,
    graph,
    system,
    sequences,
    layout: layoutGraph(graph, system),
    counts: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      steps: graph.nodes.filter((node) => node.kind.startsWith('step:')).length,
      groups: graph.groups.filter((group) => group.count > 0).length,
      systems: system.nodes.length,
      calls: system.edges.length,
    },
    warnings: lowered.diagnostics,
  };
}
