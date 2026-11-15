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
 * **Why columns.** The groups are already ordered left to right by data flow, so a column
 * per group puts "prompt uses model guards output" on one horizontal line, which is the
 * reading a reviewer actually does. Vertical order inside a column is document order, so a
 * node does not move when an unrelated part of the spec changes.
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

export interface Layout {
  readonly width: number;
  readonly height: number;
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

/** The whole picture: columns in group order, nodes stacked in document order, edges routed. */
export function layoutGraph(graph: VisualGraph): Layout {
  const columns: LayoutColumn[] = [];
  const nodes: LayoutNode[] = [];
  const boxes = new Map<string, { x: number; y: number; width: number; height: number }>();

  let columnX = MARGIN;
  let tallest = 0;

  for (const group of VISUAL_GROUPS) {
    const members = graph.nodes.filter((node) => node.group === group.id);
    // A group the spec does not use is not a column: an empty stripe would imply the spec
    // was supposed to fill it. The order of the remaining columns still follows the fixed
    // group order, which is what makes two pictures comparable.
    if (members.length === 0) continue;

    let cursorY = MARGIN + HEADER_HEIGHT;
    for (const node of members) {
      const measured = measure(node);
      const box = {
        x: columnX,
        y: cursorY,
        width: COLUMN_WIDTH,
        height: measured.height,
      };
      boxes.set(node.id, box);
      nodes.push({ node, ...box, lines: measured.lines });
      cursorY += measured.height + NODE_GAP;
    }

    const contentHeight = cursorY - NODE_GAP - (MARGIN + HEADER_HEIGHT);
    const height = HEADER_HEIGHT + contentHeight;
    columns.push({
      group: group.id,
      title: group.title,
      blurb: group.blurb,
      x: columnX,
      y: MARGIN,
      width: COLUMN_WIDTH,
      height,
      count: members.length,
    });

    tallest = Math.max(tallest, height);
    columnX += COLUMN_WIDTH + COLUMN_GAP;
  }

  const offsets = offsetsFor(graph.edges);
  const edges: LayoutEdge[] = [];
  graph.edges.forEach((edge, index) => {
    const fromBox = boxes.get(edge.from);
    const toBox = boxes.get(edge.to);
    // An endpoint that is not drawn is not an error: `graph.ts` only emits edges between
    // nodes it also emitted, and a link to a shape this picture has no column for would be
    // a drawing limitation. Dropping the edge keeps the picture honest about what it shows.
    if (fromBox === undefined || toBox === undefined) return;
    edges.push({
      from: edge.from,
      to: edge.to,
      kind: edge.kind,
      ...(edge.label === undefined ? {} : { label: edge.label }),
      d: edgePath(fromBox, toBox, offsets[index] ?? 0),
    });
  });

  const width = columns.length === 0 ? MARGIN * 2 : columnX - COLUMN_GAP + MARGIN;

  return {
    width: round(width),
    height: round(MARGIN * 2 + tallest),
    columns,
    nodes,
    edges,
  };
}
