/**
 * Where every node and edge sits, computed once on the server and shipped with the graph.
 *
 * **Why it is not the browser's job.** A layout that runs in the DOM cannot be asserted on
 * without a DOM, and the picture is the deliverable here: if two runs of `aid visualize`
 * over the same spec drew different diagrams, comparing two customers would mean comparing
 * two drawings. So this module measures its own text with a fixed character budget instead
 * of asking a browser for a font metric, which makes the answer a pure function of the
 * graph document -- no wall clock, no font, no viewport.
 *
 * **Why three bands.** The picture answers three different questions, and none of them
 * belongs in another's column order.
 *
 * The top band is the architecture: the deployments, the triggers in front of them, the
 * stores and providers they call, and the wires between. That is what a reviewer of a
 * distributed system reads first -- "what is this made of, what does it call, where does it
 * live" -- and no per-construction table can answer it.
 *
 * The middle band is the process: one lane per pipeline, steps laid left to right in the
 * order they run, with the deployments that serve them printed in the lane header -- that
 * is "what happens, and where".
 *
 * The bottom band is the inventory: the groups in their fixed order, because "prompt uses
 * model guards output" is the reading a reviewer does about the materials rather than
 * about the run.
 *
 * Vertical order inside a lane is the depth of the step in the flow, and inside a column it
 * is document order, so a node does not move when an unrelated part of the spec changes.
 *
 * The cost of measuring text by character count is that the estimate is not exact: a line
 * of wide glyphs may overflow its box slightly. That is a cosmetic imperfection in a
 * picture and it is the right trade against a diagram that is not reproducible.
 */

import type { SystemGraph, SystemNode, SystemZoneId } from './architecture.js';
import { SYSTEM_ZONES } from './architecture.js';
import type {
  VisualEdge,
  VisualEdgeKind,
  VisualGraph,
  VisualGroupId,
  VisualNode,
} from './graph.js';
import { VISUAL_GROUPS } from './graph.js';

/** Column geometry. One number change here moves every picture, so none are inline. */
const COLUMN_WIDTH = 248;
const COLUMN_GAP = 56;
const MARGIN = 32;
const HEADER_HEIGHT = 44;
const NODE_GAP = 10;

/**
 * Lane geometry. A lane is one pipeline seen as a process: a header that names where it is
 * served, the pipeline box, then one column per step depth.
 */
const LANE_PAD = 20;
const LANE_HEADER = 32;
const LANE_GAP = 30;
const BAND_GAP = 56;
const LANE_MIN_WIDTH = 560;
const STEP_WIDTH = 200;
const STEP_GAP_X = 44;
const STEP_GAP_Y = 14;
const LANE_ROW_GAP = 16;

/** Text insets and line heights inside a node box. */
const PAD_X = 12;
const PAD_Y = 9;
const LABEL_SIZE = 12;
const LABEL_LINE = 16;
const DETAIL_SIZE = 10;
const DETAIL_LINE = 13;
const DETAIL_GAP = 4;

const MAX_LABEL_LINES = 2;
const MAX_DETAIL_LINES = 3;

/** How far an edge's arrowhead stops short of the box it points at. */
const ARROW_GAP = 9;

/** Average glyph width as a fraction of the font size, for a monospace-ish sans stack. */
const GLYPH_RATIO = 0.58;

const TEXT_WIDTH = COLUMN_WIDTH - PAD_X * 2;
const LABEL_LIMIT = Math.max(8, Math.floor(TEXT_WIDTH / (LABEL_SIZE * GLYPH_RATIO)));
const DETAIL_LIMIT = Math.max(8, Math.floor(TEXT_WIDTH / (DETAIL_SIZE * GLYPH_RATIO)));

/** One wrapped line of text in a node box. */
export interface LayoutLine {
  readonly text: string;
  readonly role: 'label' | 'detail';
}

/** Which band a placed node belongs to. The renderer and the drill-down both key on it. */
export type LayoutLayer = 'system' | 'process' | 'inventory';

export interface LayoutNode {
  readonly node: VisualNode;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The text after wrapping, so the renderer measures nothing. */
  readonly lines: readonly LayoutLine[];
  /** The band this box stands in, so the page can show one band and hide the others. */
  readonly layer: LayoutLayer;
}

/** One band of the picture, with the heading the view tabs and the band title share. */
export interface LayoutBand {
  readonly id: LayoutLayer;
  readonly title: string;
  readonly blurb: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A column of the architecture band: the systems that play one role.
 *
 * Zones are the architectural reading of a spec. They are not groups, because a group
 * answers "what kind of thing is this declared as" and a zone answers "where does it stand
 * when the service runs" -- the same store is a `store:` node in the inventory and a box in
 * the data zone here.
 */
export interface LayoutZone {
  readonly zone: SystemZoneId;
  readonly title: string;
  readonly blurb: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly count: number;
}

export interface LayoutColumn {
  readonly group: VisualGroupId;
  readonly title: string;
  readonly blurb: string;
  readonly x: number;
  readonly width: number;
  readonly y: number;
  readonly height: number;
  readonly count: number;
}

export interface LayoutEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: VisualEdgeKind;
  /** Present when the edge names what it carries. */
  readonly label?: string;
  /** The SVG path, already rounded, so the renderer emits a `d` attribute and nothing more. */
  readonly d: string;
  /** The band the source box stands in, which is the band group this edge is drawn into. */
  readonly layer: LayoutLayer;
  /**
   * The band the target box stands in.
   *
   * Equal to `layer` for a link inside one band, which is every run-order arrow. The two
   * differ for a reference that leaves its band -- a step naming the tool it calls, an eval
   * measuring a pipeline. The page shows one band at a time, so an edge that leaves the
   * visible band has nowhere to point; the renderer drops it there and the detail panel
   * names the same relation as a chip instead.
   */
  readonly toLayer: LayoutLayer;
}

/** One pipeline as a process, inside a box that also says where it is served. */
export interface LayoutLane {
  readonly pipeline: string;
  readonly title: string;
  /** One entry per deployment that names this pipeline, formatted for the header. */
  readonly placements: readonly string[];
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** How many steps the lane draws, so the header can print the count. */
  readonly steps: number;
  /** True when no deployment names the pipeline. The picture says so rather than omitting it. */
  readonly undeployed: boolean;
}

export interface Layout {
  readonly width: number;
  readonly height: number;
  /** Every band the picture drew, top to bottom, in the order the view tabs list them. */
  readonly bands: readonly LayoutBand[];
  /** The architecture band's zone columns, left to right in fixed zone order. */
  readonly zones: readonly LayoutZone[];
  /** The process band, top to bottom in document order. */
  readonly lanes: readonly LayoutLane[];
  /** The inventory band, left to right in fixed group order. */
  readonly columns: readonly LayoutColumn[];
  readonly nodes: readonly LayoutNode[];
  readonly edges: readonly LayoutEdge[];
}

/**
 * Break `text` onto lines of at most `limit` characters.
 *
 * Words are kept whole where they fit and hard-broken where they do not, because the
 * identifiers in a spec (`issue_refund`, `warranty_evidence`) are the ones that overflow
 * and truncating them at the box edge is exactly where they stop being readable. Beyond
 * `maxLines` the tail is dropped and the last line is marked, so a truncated box never
 * looks like a complete one.
 */
function wrap(text: string, limit: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter((word) => word !== '');
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current === '' ? word : `${current} ${word}`;
    if (candidate.length <= limit) {
      current = candidate;
      continue;
    }
    if (current !== '') lines.push(current);
    let rest = word;
    while (rest.length > limit) {
      lines.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
    current = rest;
  }
  if (current !== '') lines.push(current);
  if (lines.length === 0) lines.push('');

  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  const last = kept[maxLines - 1] ?? '';
  kept[maxLines - 1] =
    last.length >= limit ? `${last.slice(0, Math.max(0, limit - 1))}…` : `${last}…`;
  return kept;
}

function measure(node: VisualNode): { lines: LayoutLine[]; height: number } {
  const labelLines = wrap(node.label, LABEL_LIMIT, MAX_LABEL_LINES);
  const detailLines =
    node.detail === undefined ? [] : wrap(node.detail, DETAIL_LIMIT, MAX_DETAIL_LINES);

  const lines: LayoutLine[] = [
    ...labelLines.map((text): LayoutLine => ({ text, role: 'label' })),
    ...detailLines.map((text): LayoutLine => ({ text, role: 'detail' })),
  ];

  const height =
    PAD_Y * 2 +
    labelLines.length * LABEL_LINE +
    (detailLines.length === 0 ? 0 : DETAIL_GAP + detailLines.length * DETAIL_LINE);

  return { lines, height };
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * The cubic from a node's right edge to the target's left edge.
 *
 * A single formula covers all three cases. Forward, it is the usual horizontal S-curve.
 * Backward or within one column, the control points keep their sign, so the curve leaves
 * to the right and arrives from the left -- a loop that reads as "and back again" rather
 * than a straight line that would claim the two nodes are adjacent.
 */
function edgePath(
  fromBox: { x: number; y: number; width: number; height: number },
  toBox: { x: number; y: number; width: number; height: number },
  offset: number,
): string {
  const fromX = fromBox.x + fromBox.width;
  const fromY = fromBox.y + fromBox.height / 2 + offset;
  const toX = toBox.x - ARROW_GAP;
  const toY = toBox.y + toBox.height / 2 + offset;
  const reach = Math.max(36, Math.min(160, Math.abs(toX - fromX) * 0.45));
  return [
    `M ${round(fromX)} ${round(fromY)}`,
    `C ${round(fromX + reach)} ${round(fromY)},`,
    `${round(toX - reach)} ${round(toY)},`,
    `${round(toX)} ${round(toY)}`,
  ].join(' ');
}

/**
 * The cubic from one band to the other, leaving the bottom or the top edge.
 *
 * Only used when the two boxes do not share a vertical range, which is exactly the case of
 * a step and the tool it names: they are in the same process but not in the same row, and
 * the sideways curve above would draw them as consecutive.
 */
function bandPath(fromBox: Box, toBox: Box, offset: number): string {
  const down = toBox.y >= fromBox.y;
  const fromX = fromBox.x + fromBox.width / 2 + offset;
  const fromY = down ? fromBox.y + fromBox.height : fromBox.y;
  const toX = toBox.x + toBox.width / 2 + offset;
  const toY = down ? toBox.y - ARROW_GAP : toBox.y + toBox.height + ARROW_GAP;
  const reach = Math.max(28, Math.min(140, Math.abs(toY - fromY) * 0.45));
  const sign = down ? 1 : -1;
  return [
    `M ${round(fromX)} ${round(fromY)}`,
    `C ${round(fromX)} ${round(fromY + sign * reach)},`,
    `${round(toX)} ${round(toY - sign * reach)},`,
    `${round(toX)} ${round(toY)}`,
  ].join(' ');
}

/**
 * A perpendicular offset per edge, so two kinds joining the same pair both stay visible.
 *
 * `graph.ts` deduplicates on `kind` as well as endpoints, so `uses` and `guards` between
 * the same two shapes survive as two edges and would otherwise be drawn exactly on top of
 * each other. Spreading them is a presentation decision and belongs here.
 */
function offsetsFor(edges: readonly VisualEdge[]): number[] {
  const byPair = new Map<string, number[]>();
  edges.forEach((edge, index) => {
    const key = `${edge.from}\u0000${edge.to}`;
    const bucket = byPair.get(key);
    if (bucket === undefined) byPair.set(key, [index]);
    else bucket.push(index);
  });

  const offsets = edges.map(() => 0);
  for (const bucket of byPair.values()) {
    if (bucket.length < 2) continue;
    bucket.forEach((index, position) => {
      offsets[index] = round((position - (bucket.length - 1) / 2) * 11);
    });
  }
  return offsets;
}

type Box = { x: number; y: number; width: number; height: number };

/** The steps of one pipeline, and the column and row each occupies inside its lane. */
interface PipelineFlow {
  readonly pipeline: VisualNode;
  readonly steps: readonly VisualNode[];
  /** How many columns right of the lane's first step column a step sits. */
  readonly depth: ReadonlyMap<string, number>;
  /** Which row inside its depth column a step occupies. */
  readonly row: ReadonlyMap<string, number>;
  /** The tallest box in each row, so a row clears the tallest thing standing in it. */
  readonly rowHeights: readonly number[];
  readonly columns: number;
  readonly rowCount: number;
}

/** The heading each band carries, so the view tabs and the band title cannot disagree. */
const BAND_META: Readonly<Record<LayoutLayer, { readonly title: string; readonly blurb: string }>> =
  {
    system: {
      title: 'Architecture',
      blurb:
        'What the service is made of when it runs: triggers, identity, deployments, and every store, provider and sink they call.',
    },
    process: {
      title: 'Process',
      blurb: 'Each pipeline as a lane, in run order, with the deployments that serve it.',
    },
    inventory: {
      title: 'Inventory',
      blurb: 'Every declared construction, in the fixed column order.',
    },
  };

/** The architecture band: zone columns of system boxes, all as tall as the tallest zone. */
interface ZoneLayout {
  readonly zones: readonly LayoutZone[];
  readonly nodes: readonly LayoutNode[];
  readonly edges: readonly LayoutEdge[];
  readonly band: LayoutBand | undefined;
}

/**
 * Lay out the architecture band above `top`.
 *
 * Zones are columns in fixed order, and the systems inside a zone stack vertically in
 * document order, which is the order `architecture.ts` emits them: triggers in pipeline
 * order, then deployments, then the external systems in provider order. A zone the spec
 * does not use is not drawn, for the same reason an unused inventory group is not a
 * column: an empty stripe would imply something was meant to fill it.
 *
 * Stacks are vertically centred on the tallest of them rather than top-aligned, so a lone
 * deployment sits level with the row of systems beside it instead of floating at the top of
 * the band. Every number here is derived from the graph, so the geometry stays a pure
 * function of the document.
 */
function layoutSystem(system: SystemGraph, top: number): ZoneLayout {
  const nodes: LayoutNode[] = [];
  const zones: LayoutZone[] = [];
  const boxes = new Map<string, Box>();

  const used = SYSTEM_ZONES.map((zone) => ({
    zone,
    members: system.nodes.filter((node): node is SystemNode => node.zone === zone.id),
  })).filter((entry) => entry.members.length > 0);

  if (used.length === 0) return { zones: [], nodes: [], edges: [], band: undefined };

  const measured = new Map<string, { lines: LayoutLine[]; height: number }>();
  const stacks = new Map<SystemZoneId, number>();
  let tallest = 0;
  for (const entry of used) {
    let stack = 0;
    entry.members.forEach((node, index) => {
      const box = measure(node);
      measured.set(node.id, box);
      stack += box.height + (index === 0 ? 0 : NODE_GAP);
    });
    stacks.set(entry.zone.id, stack);
    tallest = Math.max(tallest, stack);
  }

  const bodyTop = top + HEADER_HEIGHT;
  let columnX = MARGIN;
  for (const entry of used) {
    const stack = stacks.get(entry.zone.id) ?? 0;
    let cursorY = bodyTop + round((tallest - stack) / 2);
    for (const node of entry.members) {
      const box = measured.get(node.id);
      if (box === undefined) continue;
      const placed: Box = { x: columnX, y: cursorY, width: COLUMN_WIDTH, height: box.height };
      boxes.set(node.id, placed);
      nodes.push({ node, ...placed, lines: box.lines, layer: 'system' });
      cursorY += box.height + NODE_GAP;
    }
    zones.push({
      zone: entry.zone.id,
      title: entry.zone.title,
      blurb: entry.zone.blurb,
      x: columnX,
      y: top,
      width: COLUMN_WIDTH,
      height: HEADER_HEIGHT + tallest,
      count: entry.members.length,
    });
    columnX += COLUMN_WIDTH + COLUMN_GAP;
  }

  const offsets = offsetsFor(system.edges);
  const edges: LayoutEdge[] = [];
  system.edges.forEach((edge, index) => {
    const fromBox = boxes.get(edge.from);
    const toBox = boxes.get(edge.to);
    // The same rule as the other bands: an endpoint this band does not draw drops the edge,
    // so the picture never shows an arrow to nowhere.
    if (fromBox === undefined || toBox === undefined) return;
    const offset = offsets[index] ?? 0;
    const crossesBand =
      toBox.y >= fromBox.y + fromBox.height || toBox.y + toBox.height <= fromBox.y;
    edges.push({
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      ...(edge.label === undefined ? {} : { label: edge.label }),
      d: crossesBand ? bandPath(fromBox, toBox, offset) : edgePath(fromBox, toBox, offset),
      layer: 'system',
      toLayer: 'system',
    });
  });

  const last = zones[zones.length - 1];
  return {
    zones,
    nodes,
    edges,
    band: {
      id: 'system',
      title: BAND_META.system.title,
      blurb: BAND_META.system.blurb,
      x: MARGIN,
      y: top,
      width: last === undefined ? MARGIN * 2 : last.x + last.width - MARGIN,
      height: HEADER_HEIGHT + tallest,
    },
  };
}

/** The whole picture: the architecture band, the process band, then the inventory band. */
export function layoutGraph(graph: VisualGraph, system?: SystemGraph): Layout {
  const nodes: LayoutNode[] = [];
  const boxes = new Map<string, Box>();
  const lanes: LayoutLane[] = [];
  // The architecture band is laid out first because the other two stack below it, and the
  // bands must not depend on each other's contents to know where they start.
  const zoneLayout = system === undefined ? undefined : layoutSystem(system, MARGIN);

  // Where a pipeline is served, read off the `deploys` edges the graph already carries, so
  // the header cannot disagree with the arrows: both come from one edge set. A deployment
  // that names no `pipeline` targets the service, which contains every pipeline, so it
  // serves them all; naming one narrows it to that pipeline.
  const pipelines = graph.nodes.filter((node) => node.kind === 'pipeline');
  const deployments = graph.nodes.filter((node) => node.kind === 'deployment');
  const served = new Map<string, string[]>();
  for (const deployment of deployments) served.set(deployment.id, []);
  for (const edge of graph.edges) {
    if (edge.kind !== 'deploys') continue;
    const bucket = served.get(edge.from);
    if (bucket !== undefined) bucket.push(edge.to);
  }

  const placements = new Map<string, string[]>();
  for (const deployment of deployments) {
    const name =
      deployment.detail === undefined
        ? deployment.label
        : `${deployment.label} (${deployment.detail})`;
    const named = served.get(deployment.id) ?? [];
    const targets = named.length > 0 ? named : pipelines.map((node) => node.id);
    for (const target of targets) {
      const bucket = placements.get(target);
      if (bucket === undefined) placements.set(target, [name]);
      else bucket.push(name);
    }
  }

  const flowOf = (pipeline: VisualNode): PipelineFlow => {
    const prefix = `step:${pipeline.id.slice('pipeline:'.length)}/`;
    const steps = graph.nodes.filter((node) => node.id.startsWith(prefix));
    const isStep = new Set(steps.map((node) => node.id));

    // Incoming run-order edges, restricted to one pipeline. A `flow` edge is only emitted
    // between steps that already run in this order, so this pass infers nothing.
    const preds = new Map<string, string[]>();
    for (const edge of graph.edges) {
      if (edge.kind !== 'flow') continue;
      if (!isStep.has(edge.from) || !isStep.has(edge.to)) continue;
      const bucket = preds.get(edge.to);
      if (bucket === undefined) preds.set(edge.to, [edge.from]);
      else bucket.push(edge.from);
    }

    // Depth is the longest path from an entry, so a step sits one column right of the
    // furthest step that can reach it. The guard makes a cycle cost a column rather than a
    // hang: the build emits none, and terminating should not depend on that being true.
    const depth = new Map<string, number>();
    const settling = new Set<string>();
    const depthOf = (id: string): number => {
      const known = depth.get(id);
      if (known !== undefined) return known;
      if (settling.has(id)) return 0;
      settling.add(id);
      let best = 0;
      for (const pred of preds.get(id) ?? []) best = Math.max(best, depthOf(pred) + 1);
      settling.delete(id);
      depth.set(id, best);
      return best;
    };
    for (const step of steps) depthOf(step.id);

    // One row per step sharing a depth, in document order, so two arms of a branch stack
    // instead of landing on one box.
    const row = new Map<string, number>();
    const rowHeights: number[] = [];
    const filled = new Map<number, number>();
    let deepest = 0;
    for (const step of steps) {
      const at = depth.get(step.id) ?? 0;
      const index = filled.get(at) ?? 0;
      filled.set(at, index + 1);
      row.set(step.id, index);
      rowHeights[index] = Math.max(rowHeights[index] ?? 0, measure(step).height);
      deepest = Math.max(deepest, at);
    }

    let rowCount = 0;
    for (const value of row.values()) rowCount = Math.max(rowCount, value + 1);

    return {
      pipeline,
      steps,
      depth,
      row,
      rowHeights,
      columns: steps.length === 0 ? 0 : deepest + 1,
      rowCount,
    };
  };

  const flows = graph.nodes.filter((node) => node.kind === 'pipeline').map(flowOf);

  // Every lane is as wide as the widest process in it, so two lanes compare column by
  // column the same way two specs compare group by group.
  let widest = LANE_MIN_WIDTH;
  for (const flow of flows) {
    const needed = flow.columns * (STEP_WIDTH + STEP_GAP_X) - STEP_GAP_X;
    widest = Math.max(widest, needed);
  }
  const laneWidth = widest + LANE_PAD * 2;

  const systemBand = zoneLayout?.band;
  let cursorY =
    systemBand === undefined ? MARGIN : round(systemBand.y + systemBand.height + BAND_GAP);

  for (const flow of flows) {
    const measuredPipeline = measure(flow.pipeline);
    const innerLeft = MARGIN + LANE_PAD;

    const pipelineBox: Box = {
      x: innerLeft,
      y: cursorY + LANE_HEADER,
      width: laneWidth - LANE_PAD * 2,
      height: measuredPipeline.height,
    };
    boxes.set(flow.pipeline.id, pipelineBox);
    nodes.push({
      node: flow.pipeline,
      ...pipelineBox,
      lines: measuredPipeline.lines,
      layer: 'process',
    });

    const gridTop = pipelineBox.y + pipelineBox.height + LANE_ROW_GAP;
    for (const step of flow.steps) {
      const at = flow.depth.get(step.id) ?? 0;
      const index = flow.row.get(step.id) ?? 0;
      let dropped = 0;
      for (let above = 0; above < index; above += 1) {
        dropped += (flow.rowHeights[above] ?? 0) + STEP_GAP_Y;
      }
      const measured = measure(step);
      const box: Box = {
        x: innerLeft + at * (STEP_WIDTH + STEP_GAP_X),
        y: gridTop + dropped,
        width: STEP_WIDTH,
        height: measured.height,
      };
      boxes.set(step.id, box);
      nodes.push({ node: step, ...box, lines: measured.lines, layer: 'process' });
    }

    let gridHeight = 0;
    for (let index = 0; index < flow.rowCount; index += 1) {
      gridHeight += (flow.rowHeights[index] ?? 0) + (index === 0 ? 0 : STEP_GAP_Y);
    }

    const servedBy = placements.get(flow.pipeline.id) ?? [];
    const height =
      LANE_HEADER +
      pipelineBox.height +
      (gridHeight === 0 ? 0 : LANE_ROW_GAP + gridHeight) +
      LANE_PAD;

    lanes.push({
      pipeline: flow.pipeline.id,
      title: flow.pipeline.label,
      placements: servedBy,
      x: MARGIN,
      y: cursorY,
      width: laneWidth,
      height,
      steps: flow.steps.length,
      undeployed: servedBy.length === 0,
    });

    cursorY += height + LANE_GAP;
  }

  const bandTop = lanes.length === 0 ? MARGIN : cursorY - LANE_GAP + BAND_GAP;

  const columns: LayoutColumn[] = [];
  let columnX = MARGIN;

  for (const group of VISUAL_GROUPS) {
    // Steps and pipelines live in the process band, so the inventory band holds the rest.
    const members = graph.nodes.filter(
      (node) =>
        node.group === group.id && node.kind !== 'pipeline' && !node.kind.startsWith('step:'),
    );
    // A group the spec does not use is not a column: an empty stripe would imply the spec
    // was supposed to fill it. The order of the remaining columns still follows the fixed
    // group order, which is what makes two pictures comparable.
    if (members.length === 0) continue;

    let cursor = bandTop + HEADER_HEIGHT;
    for (const node of members) {
      const measured = measure(node);
      const box: Box = { x: columnX, y: cursor, width: COLUMN_WIDTH, height: measured.height };
      boxes.set(node.id, box);
      nodes.push({ node, ...box, lines: measured.lines, layer: 'inventory' });
      cursor += measured.height + NODE_GAP;
    }

    columns.push({
      group: group.id,
      title: group.title,
      blurb: group.blurb,
      x: columnX,
      y: bandTop,
      width: COLUMN_WIDTH,
      height: HEADER_HEIGHT + (cursor - NODE_GAP - (bandTop + HEADER_HEIGHT)),
      count: members.length,
    });

    columnX += COLUMN_WIDTH + COLUMN_GAP;
  }

  // The renderer draws in this order, and every table that reads a layout keys on it, so the
  // document order of `graph.nodes` is restored after the bands have been walked. System
  // boxes are not members of `graph.nodes`, so they follow the inventory in zone order and
  // keep the order `layoutSystem` gave them.
  const order = new Map<string, number>();
  graph.nodes.forEach((node, index) => {
    order.set(node.id, index);
  });
  for (const placed of zoneLayout?.nodes ?? []) {
    order.set(placed.node.id, order.size);
    nodes.push(placed);
  }
  nodes.sort((a, b) => (order.get(a.node.id) ?? 0) - (order.get(b.node.id) ?? 0));

  const offsets = offsetsFor(graph.edges);
  const layerOf = new Map<string, LayoutLayer>();
  for (const placed of nodes) layerOf.set(placed.node.id, placed.layer);
  const edges: LayoutEdge[] = [];
  graph.edges.forEach((edge, index) => {
    const fromBox = boxes.get(edge.from);
    const toBox = boxes.get(edge.to);
    // An endpoint that is not drawn is not an error: `graph.ts` only emits edges between
    // nodes it also emitted, and a link to a shape this picture has no place for would be a
    // drawing limitation. Dropping the edge keeps the picture honest about what it shows.
    if (fromBox === undefined || toBox === undefined) return;
    const offset = offsets[index] ?? 0;
    // A link into the other band leaves from an edge, not from a side: a step and the tool
    // it calls are above and below each other, and a sideways curve would read as sequence.
    const crossesBand =
      toBox.y >= fromBox.y + fromBox.height || toBox.y + toBox.height <= fromBox.y;
    edges.push({
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      ...(edge.label === undefined ? {} : { label: edge.label }),
      d: crossesBand ? bandPath(fromBox, toBox, offset) : edgePath(fromBox, toBox, offset),
      layer: layerOf.get(edge.from) ?? 'inventory',
      toLayer: layerOf.get(edge.to) ?? 'inventory',
    });
  });
  // The architecture band routed its own edges, inside its own boxes: the bands share no
  // node, so there is no edge to route twice and no offset to negotiate between them.
  edges.push(...(zoneLayout?.edges ?? []));

  const bands: LayoutBand[] = [];
  if (systemBand !== undefined) bands.push(systemBand);

  /** The bounding box of a band's own containers, which is what the view tabs scroll to. */
  const bounds = (items: readonly { x: number; y: number; width: number; height: number }[]) => {
    let top = Number.POSITIVE_INFINITY;
    let left = Number.POSITIVE_INFINITY;
    let low = 0;
    let high = 0;
    for (const item of items) {
      top = Math.min(top, item.y);
      left = Math.min(left, item.x);
      low = Math.max(low, item.y + item.height);
      high = Math.max(high, item.x + item.width);
    }
    return { x: left, y: top, width: round(high - left), height: round(low - top) };
  };

  if (lanes.length > 0) bands.push({ id: 'process', ...BAND_META.process, ...bounds(lanes) });
  if (columns.length > 0) {
    bands.push({ id: 'inventory', ...BAND_META.inventory, ...bounds(columns) });
  }

  let bottom = MARGIN;
  let right = MARGIN;
  for (const placed of nodes) {
    bottom = Math.max(bottom, placed.y + placed.height);
    right = Math.max(right, placed.x + placed.width);
  }
  for (const lane of lanes) {
    bottom = Math.max(bottom, lane.y + lane.height);
    right = Math.max(right, lane.x + lane.width);
  }
  for (const column of columns) {
    bottom = Math.max(bottom, column.y + column.height);
    right = Math.max(right, column.x + column.width);
  }

  return {
    width: round(right + MARGIN),
    height: round(bottom + MARGIN),
    bands,
    zones: zoneLayout?.zones ?? [],
    lanes,
    columns,
    nodes,
    edges,
  };
}
