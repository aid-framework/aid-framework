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
 * **Why two bands.** The picture answers two different questions, and they do not belong in
 * one column order. The top band is the process: one lane per pipeline, steps laid left to
 * right in the order they run, with the deployments that serve them printed in the lane
 * header -- that is "what happens, and where it lives". The bottom band is the inventory:
 * the groups in their fixed order, because "prompt uses model guards output" is the reading
 * a reviewer does about the materials rather than about the run.
 *
 * Vertical order inside a lane is the depth of the step in the flow, and inside a column it
 * is document order, so a node does not move when an unrelated part of the spec changes.
 *
 * The cost of measuring text by character count is that the estimate is not exact: a line
 * of wide glyphs may overflow its box slightly. That is a cosmetic imperfection in a
 * picture and it is the right trade against a diagram that is not reproducible.
 */

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

export interface LayoutNode {
  readonly node: VisualNode;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** The text after wrapping, so the renderer measures nothing. */
  readonly lines: readonly LayoutLine[];
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

/** The whole picture: the process band, then the inventory band, with edges routed. */
export function layoutGraph(graph: VisualGraph): Layout {
  const nodes: LayoutNode[] = [];
  const boxes = new Map<string, Box>();
  const lanes: LayoutLane[] = [];

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

  let cursorY = MARGIN;

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
    nodes.push({ node: flow.pipeline, ...pipelineBox, lines: measuredPipeline.lines });

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
      nodes.push({ node: step, ...box, lines: measured.lines });
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
      nodes.push({ node, ...box, lines: measured.lines });
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
  // document order of `graph.nodes` is restored after the two bands have been walked.
  const order = new Map<string, number>();
  graph.nodes.forEach((node, index) => {
    order.set(node.id, index);
  });
  nodes.sort((a, b) => (order.get(a.node.id) ?? 0) - (order.get(b.node.id) ?? 0));

  const offsets = offsetsFor(graph.edges);
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
    });
  });

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
    lanes,
    columns,
    nodes,
    edges,
  };
}
