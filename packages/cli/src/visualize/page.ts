/**
 * The page `aid visualize` serves: one self-contained HTML document, no build step, no CDN.
 *
 * **Why it carries no spec data.** The shell is static and every value it shows arrives from
 * `/api/graph`. That is what makes live reload a re-fetch instead of a page load, and it keeps
 * spec-controlled text out of the HTML: nothing here is string-interpolated from a spec, and
 * the client writes strings with `textContent` rather than `innerHTML`, so a prompt that
 * contains markup cannot become markup.
 *
 * The website embeds this page in an iframe, where there is no server to fetch from, so
 * `renderPage` can also be handed the document up front. It still arrives as data through
 * `json()`, never as markup, and it is still the client that writes every string with
 * `textContent` -- the embedding changes where the document comes from, not how it is drawn.
 *
 * **Why hand-rolled SVG.** The CLI ships with no runtime dependencies, and a page that loaded
 * a charting library from a CDN would stop working on the network that most needs it -- the
 * locked-down one. The renderer is a painter: every coordinate and every wrapped line comes
 * from `layout.ts`, so this file decides colours and nothing else.
 *
 * **Why the client has no backticks.** Keeping the script free of template literals means this
 * outer template literal needs no escaping, and an unescaped `${` in a generated page is the
 * kind of bug that only shows up as a page that does not load.
 */

import type { VisualDocument } from './document.js';
import { VISUAL_EDGE_KINDS, VISUAL_GROUPS } from './graph.js';

/** Where a page gets the document it draws. */
export interface PageSource {
  /**
   * Draw this instead of fetching `/api/graph`. The website lowers a pasted spec in the
   * browser and has no server behind the page to ask.
   */
  readonly document?: VisualDocument;
  /**
   * Watch the spec over SSE and re-fetch when it changes. The served page does; an embedded
   * one cannot, so it says nothing about being live rather than claiming and holding.
   */
  readonly live?: boolean;
}

/**
 * Colours, mirrored in the stylesheet. A group owns a hue and the legend owns the edge hues;
 * they are declared once here and shipped as data so the client never repeats a literal.
 */
const GROUP_COLORS: Record<string, string> = {
  document: '#94a3b8',
  contract: '#7c8aa5',
  service: '#22d3ee',
  agent: '#a78bfa',
  prompt: '#818cf8',
  model: '#38bdf8',
  tool: '#fbbf24',
  retrieval: '#2dd4bf',
  guardrail: '#fb923c',
  eval: '#34d399',
  infra: '#60a5fa',
};

const EDGE_COLORS: Record<string, string> = {
  flow: '#e2e8f0',
  data: '#22d3ee',
  uses: '#8b5cf6',
  guards: '#f59e0b',
  measures: '#10b981',
  'hands-off': '#ec4899',
  delegates: '#f43f5e',
  deploys: '#3b82f6',
  derives: '#64748b',
  serves: '#f472b6',
  connects: '#7dd3fc',
  records: '#facc15',
};

const EDGE_MEANING: Record<string, string> = {
  flow: 'the step that runs after this one, in the order the spec declares',
  data: 'one step feeds the next inside a pipeline',
  uses: 'a shape names another shape',
  guards: 'a guardrail inspects a prompt, a stage or a tool call',
  measures: 'an eval claims something about a target',
  'hands-off': 'one agent hands the conversation to another',
  delegates: 'an agent runs another agent as a step',
  deploys: 'a deployment serves a pipeline or an agent',
  derives: 'a shape is generated from another',
  serves: 'a declared trigger starts a run on the deployment that serves it',
  connects: 'one box calls another over the wire while a run is in flight',
  records: 'a deployment writes its run record to this audit sink',
};

/**
 * The hue a sequence row takes, by step kind. Rows are the process read in order, so they
 * borrow the inventory's colours: a guardrail row and a guardrail box are the same orange,
 * which is how a reader ties the flow back to the column it came from.
 */
const STEP_GROUPS: Record<string, string> = {
  guard: 'guardrail',
  tool: 'tool',
  retrieve: 'retrieval',
  rerank: 'retrieval',
  generate: 'prompt',
  reduce: 'prompt',
  agent: 'agent',
  map: 'agent',
  emit: 'contract',
  route: 'document',
  branch: 'document',
  parallel: 'document',
};

function json(value: unknown): string {
  // `</` is the only sequence that can close the script element early; JSON never needs it
  // literally, and an escaped solidus parses identically.
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

const THEME = `
  :root {
    color-scheme: dark;
    --bg: #0a0f1e;
    --panel: #101828;
    --line: #1e293b;
    --ink: #e6edf9;
    --muted: #8b9cbb;
    --accent: #4fd1c5;
    --bad: #f87171;
    --warn: #fbbf24;
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column; overflow: hidden;
    background: var(--bg); color: var(--ink);
    font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  header {
    flex: 0 0 auto; display: flex; align-items: center; gap: 16px;
    padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--line);
  }
  header h1 { font-size: 14px; font-weight: 650; margin: 0; letter-spacing: .01em; }
  .tag {
    font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
    padding: 2px 7px; border-radius: 999px;
    border: 1px solid var(--line); color: var(--muted); white-space: nowrap;
  }
  .tag.profile { color: var(--accent); border-color: #16564f; background: #0c2b28; }
  header .spacer { flex: 1; }
  .counts { color: var(--muted); font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .live { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--bad); }
  .dot.on { background: var(--accent); box-shadow: 0 0 0 3px #4fd1c522; }
  button {
    font: inherit; color: var(--ink); background: #16213a;
    border: 1px solid var(--line); border-radius: 6px; padding: 4px 10px; cursor: pointer;
  }
  button:hover { border-color: #33507d; }
  main { flex: 1; display: flex; min-height: 0; position: relative; }
  #tabs {
    flex: 0 0 auto; display: flex; align-items: center; gap: 8px;
    padding: 7px 16px; background: #0c1424; border-bottom: 1px solid var(--line);
  }
  #tabs[hidden] { display: none; }
  #tab-buttons { flex: 0 0 auto; display: flex; gap: 4px; }
  #tabs button { padding: 3px 11px; font-size: 12px; background: transparent; border-color: transparent; color: var(--muted); }
  #tabs button:hover { color: var(--ink); border-color: var(--line); }
  #tabs button.on { background: #16213a; border-color: #33507d; color: var(--ink); }
  #tab-blurb { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #canvas {
    flex: 1; min-width: 0; cursor: grab; touch-action: none;
    background-image: radial-gradient(circle at 1px 1px, #1b2740 1px, transparent 0);
    background-size: 24px 24px;
  }
  #canvas.dragging { cursor: grabbing; }
  aside {
    flex: 0 0 400px; overflow: auto; background: var(--panel);
    border-left: 1px solid var(--line); display: flex; flex-direction: column;
  }
  /* A scrollable region has to be reachable without a mouse, and this one scrolls on its own
     axis, so it takes a tab stop of its own rather than relying on its contents. */
  aside:focus-visible { outline: 2px solid #38bdf8; outline-offset: -2px; }
  aside section { padding: 12px 14px; border-bottom: 1px solid var(--line); }
  aside h2 {
    font-size: 11px; text-transform: uppercase; letter-spacing: .09em;
    color: var(--muted); margin: 0 0 8px; font-weight: 600;
  }
  .hint { color: var(--muted); font-size: 12px; }
  .swatch { width: 10px; height: 10px; border-radius: 3px; flex: 0 0 auto; }
  .legend-row {
    display: flex; align-items: center; gap: 8px; padding: 3px 0;
    cursor: pointer; user-select: none; opacity: .95;
  }
  .legend-row.off { opacity: .35; }
  .legend-row .name { flex: 1; font: 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .legend-row .n { color: var(--muted); font-size: 11px; }
  #subject .label { font-size: 14px; font-weight: 650; word-break: break-word; }
  #subject .detail { color: var(--muted); margin-top: 2px; word-break: break-word; }
  code.path {
    display: inline-block; margin-top: 8px; padding: 3px 7px; border-radius: 5px;
    background: #0c1424; border: 1px solid var(--line); color: #9fe8dd;
    font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all;
  }
  /* Narrow viewports -- a half-screen terminal, or the website's embedded copy on a
     phone -- stack the inspector under the canvas instead of squeezing both. */
  @media (max-width: 900px) {
    main { flex-direction: column; }
    aside {
      flex: 0 0 auto; max-height: 45%; border-left: none;
      border-top: 1px solid var(--line);
    }
  }
  .fact { display: grid; grid-template-columns: 96px 1fr; gap: 8px; padding: 3px 0; }
  .fact .k { color: var(--muted); font-size: 11px; }
  .fact .v {
    font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    word-break: break-word; white-space: pre-wrap;
  }
  #notice {
    position: absolute; inset: 0; overflow: auto; padding: 28px 32px;
    background: #0a0f1ef2; backdrop-filter: blur(2px);
  }
  #notice[hidden] { display: none; }
  #notice h2 { font-size: 15px; margin: 0 0 4px; color: var(--bad); }
  #notice .sub { color: var(--muted); margin-bottom: 18px; max-width: 70ch; }
  .diag {
    border-left: 3px solid var(--bad); background: #1a1020;
    padding: 10px 14px; margin-bottom: 10px; border-radius: 0 6px 6px 0;
  }
  .diag .code { color: var(--bad); font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .diag .msg { margin: 3px 0 0; }
  .diag .at, .diag .hint {
    color: var(--muted); font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    margin-top: 6px; word-break: break-all;
  }
  text { pointer-events: none; user-select: none; }
  .col-title { font-weight: 650; }
  .node { cursor: pointer; }
  .node rect.box { transition: stroke .12s ease; }
  .node.sel rect.box { stroke: #ffffff; stroke-width: 2; }
  .edge { fill: none; }
  .edge.dim { opacity: .06; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .chip {
    font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    padding: 2px 8px; border-radius: 999px; cursor: pointer;
    background: #16213a; border: 1px solid var(--line); color: #bcd0ee;
  }
  .chip:hover { border-color: #33507d; color: #fff; }
  .seq { margin-top: 10px; }
  .seq-head {
    font-size: 11px; text-transform: uppercase; letter-spacing: .09em;
    color: var(--muted); font-weight: 600; margin-bottom: 4px;
  }
  .seq-notes {
    font: 10px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #6f81a3; word-break: break-word; margin-bottom: 6px;
  }
  .seq-rows { display: flex; flex-direction: column; gap: 1px; }
  .seq-row {
    padding: 3px 6px; border-radius: 5px; cursor: pointer;
    border-left: 2px solid transparent;
  }
  .seq-row:hover { background: #16213a; }
  .seq-row.sel { background: #16213a; border-left-color: #4fd1c5; }
  .seq-top { display: flex; align-items: baseline; gap: 6px; }
  .seq-n {
    flex: 0 0 auto; color: #55698f; font: 9px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .seq-text {
    flex: 1; font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    word-break: break-word;
  }
  .seq-flags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
  .flag {
    font: 9px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
    padding: 0 5px; border-radius: 999px; border: 1px solid currentColor; opacity: .9;
  }
  .flag.write, .flag.block { color: #f87171; }
  .flag.approval { color: #fbbf24; }
  .flag.retrieval { color: #2dd4bf; }
  .flag.redact, .flag.mcp { color: #c4b5fd; }
  .seq-detail {
    font: 10px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
    color: #8b9cbb; margin-top: 2px; word-break: break-word;
  }
`;

const SCRIPT = `
(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var GROUP_COLORS = __GROUP_COLORS__;
  var EDGE_COLORS = __EDGE_COLORS__;
  var EDGE_KINDS = __EDGE_KINDS__;
  var EDGE_MEANING = __EDGE_MEANING__;
  var STEP_GROUPS = __STEP_GROUPS__;
  // Present only when the document was handed to the page rather than served to it.
  var BOOT = __BOOT__;

  var state = {
    doc: null,
    revision: -1,
    view: { scale: 1, tx: 0, ty: 0 },
    selected: null,
    hidden: {},
    paths: [],
    nodes: [],
    drag: null,
    tab: 'system',
    bands: []
  };

  var canvas = document.getElementById('canvas');
  var scene = document.getElementById('scene');
  var notice = document.getElementById('notice');
  var noticeList = document.getElementById('notice-list');
  var subject = document.getElementById('subject');
  var legend = document.getElementById('legend-rows');
  var counts = document.getElementById('counts');
  var title = document.getElementById('title');
  var profile = document.getElementById('profile');
  var specTag = document.getElementById('spec-tag');
  var liveDot = document.getElementById('live-dot');
  var liveText = document.getElementById('live-text');
  var tabs = document.getElementById('tabs');
  var tabButtons = document.getElementById('tab-buttons');
  var tabBlurbEl = document.getElementById('tab-blurb');

  function mk(name, attrs) {
    var node = document.createElementNS(NS, name);
    if (attrs) {
      for (var key in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, key)) {
          node.setAttribute(key, String(attrs[key]));
        }
      }
    }
    return node;
  }

  function div(className, text) {
    var node = document.createElement('div');
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function applyView() {
    scene.setAttribute(
      'transform',
      'translate(' + state.view.tx + ',' + state.view.ty + ') scale(' + state.view.scale + ')'
    );
  }

  function fit() {
    if (!state.doc || !state.doc.ok) return;
    var box = canvas.getBoundingClientRect();
    var pad = 44;
    if (box.width < 40 || box.height < 40) return;
    var band = bandBox(state.tab);
    var scale = Math.min(
      (box.width - pad * 2) / band.width,
      (box.height - pad * 2) / band.height,
      1.15
    );
    scale = Math.max(0.12, scale);
    state.view.scale = scale;
    state.view.tx = (box.width - band.width * scale) / 2 - band.x * scale;
    state.view.ty = (box.height - band.height * scale) / 2 - band.y * scale;
    applyView();
  }

  /** The box the current tab frames: one band, or the whole picture for 'all'. */
  function bandBox(layer) {
    var layout = state.doc.layout;
    if (layer !== 'all') {
      for (var i = 0; i < layout.bands.length; i++) {
        if (layout.bands[i].id === layer) return layout.bands[i];
      }
    }
    return { id: 'all', x: 0, y: 0, width: layout.width, height: layout.height };
  }

  function setLive(on) {
    // The embedded page has no server to be connected to, so it carries no live chip at all.
    if (liveDot === null || liveText === null) return;
    liveDot.className = on ? 'dot on' : 'dot';
    liveText.textContent = on ? 'live' : 'disconnected';
  }

  function showNotice(diagnostics) {
    clear(noticeList);
    for (var i = 0; i < diagnostics.length; i++) {
      var diagnostic = diagnostics[i];
      var item = div('diag');
      item.appendChild(div('code', diagnostic.code || 'diagnostic'));
      item.appendChild(div('msg', diagnostic.message || ''));
      if (diagnostic.path && diagnostic.path.length > 0) {
        item.appendChild(div('at', 'at ' + diagnostic.path.join('.')));
      }
      if (diagnostic.hint) item.appendChild(div('hint', 'hint: ' + diagnostic.hint));
      noticeList.appendChild(item);
    }
    if (diagnostics.length === 0) {
      noticeList.appendChild(div('hint', 'The build refused this spec but reported no diagnostic.'));
    }
    notice.hidden = false;
  }

  function drawLegend(doc) {
    clear(legend);
    var totals = {};
    // Every drawn edge, so an architecture-only kind is not reported as zero.
    for (var i = 0; i < doc.layout.edges.length; i++) {
      var kind = doc.layout.edges[i].kind;
      totals[kind] = (totals[kind] || 0) + 1;
    }
    for (var k = 0; k < EDGE_KINDS.length; k++) {
      var name = EDGE_KINDS[k];
      var row = div('legend-row' + (state.hidden[name] ? ' off' : ''));
      row.title = EDGE_MEANING[name] || name;
      var swatch = div('swatch');
      swatch.style.background = EDGE_COLORS[name] || '#64748b';
      row.appendChild(swatch);
      row.appendChild(div('name', name));
      row.appendChild(div('n', String(totals[name] || 0)));
      row.addEventListener('click', toggleKind(name));
      legend.appendChild(row);
    }
  }

  function toggleKind(kind) {
    return function () {
      state.hidden[kind] = !state.hidden[kind];
      applyEdgeVisibility();
      if (state.doc && state.doc.ok) drawLegend(state.doc);
    };
  }

  /**
   * Show or hide one edge.
   *
   * Two independent reasons to hide. The legend hides a whole kind. A band view hides every
   * edge that leaves the visible band: its source box is here and its target box is in a
   * band this view does not draw, so the arrow would end at nothing. The relation is not
   * lost -- the detail panel names the same edges as chips that jump to the target.
   */
  function applyEdgeVisibility() {
    for (var i = 0; i < state.paths.length; i++) {
      var edge = state.paths[i];
      var leavesBand = edge.layer !== edge.toLayer;
      var hide = !!state.hidden[edge.kind] || (leavesBand && state.tab !== 'all');
      edge.el.style.display = hide ? 'none' : '';
    }
  }

  function draw(doc) {
    clear(scene);
    state.paths = [];
    state.nodes = [];
    var layout = doc.layout;

    var defs = mk('defs');
    for (var k = 0; k < EDGE_KINDS.length; k++) {
      var kind = EDGE_KINDS[k];
      var marker = mk('marker', {
        id: 'arrow-' + kind,
        viewBox: '0 0 10 10',
        refX: 9.5,
        refY: 5,
        markerWidth: 9,
        markerHeight: 9,
        markerUnits: 'userSpaceOnUse',
        orient: 'auto'
      });
      marker.appendChild(mk('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: EDGE_COLORS[kind] || '#64748b' }));
      defs.appendChild(marker);
    }
    scene.appendChild(defs);

    // One group per band, each with its decoration, its edges and its boxes in that paint
    // order, so a view tab is a visibility flip on one element rather than a redraw.
    var layerOf = {};
    for (var ln = 0; ln < layout.nodes.length; ln++) {
      layerOf[layout.nodes[ln].node.id] = layout.nodes[ln].layer;
    }
    var bandParts = {};
    var LAYERS = ['system', 'process', 'inventory'];
    state.bands = [];
    for (var lb = 0; lb < LAYERS.length; lb++) {
      var outer = mk('g', { 'data-layer': LAYERS[lb] });
      var parts = { deco: mk('g'), edges: mk('g'), nodes: mk('g') };
      outer.appendChild(parts.deco);
      outer.appendChild(parts.edges);
      outer.appendChild(parts.nodes);
      scene.appendChild(outer);
      bandParts[LAYERS[lb]] = parts;
      state.bands.push({ layer: LAYERS[lb], el: outer });
    }

    function decoLayer(layer) { return (bandParts[layer] || bandParts.process).deco; }
    function edgesLayer(layer) { return (bandParts[layer] || bandParts.process).edges; }
    function nodesLayer(layer) { return (bandParts[layer] || bandParts.process).nodes; }

    for (var tb = 0; tb < layout.bands.length; tb++) {
      var band = layout.bands[tb];
      var bandTitle = mk('text', {
        x: band.x,
        y: band.y - 14,
        fill: '#64748b',
        'font-size': 11,
        'font-weight': 650,
        class: 'band-title'
      });
      bandTitle.textContent = band.title.toUpperCase() + '  ·  ' + band.blurb;
      decoLayer(band.id).appendChild(bandTitle);
    }

    for (var z = 0; z < layout.zones.length; z++) {
      var zone = layout.zones[z];
      var zoneLayer = decoLayer('system');
      zoneLayer.appendChild(
        mk('rect', {
          x: zone.x,
          y: zone.y,
          width: zone.width,
          height: zone.height,
          rx: 12,
          fill: '#0b1320',
          stroke: '#1e3252',
          'stroke-dasharray': '5 4'
        })
      );
      var zoneTitle = mk('text', {
        x: zone.x + 12,
        y: zone.y + 16,
        fill: '#7dd3fc',
        'font-size': 11,
        'font-weight': 650,
        class: 'col-title'
      });
      zoneTitle.textContent = zone.title + ' (' + zone.count + ')';
      var zoneTip = mk('title');
      zoneTip.textContent = zone.blurb;
      zoneTitle.appendChild(zoneTip);
      zoneLayer.appendChild(zoneTitle);
    }

    var laneLayer = decoLayer('process');
    for (var l = 0; l < layout.lanes.length; l++) {
      var lane = layout.lanes[l];
      laneLayer.appendChild(
        mk('rect', {
          x: lane.x,
          y: lane.y,
          width: lane.width,
          height: lane.height,
          rx: 14,
          fill: lane.undeployed ? '#180f14' : '#0a1322',
          stroke: lane.undeployed ? '#7f1d1d' : '#1e3a5f',
          'stroke-dasharray': lane.undeployed ? '6 5' : '0'
        })
      );
      var where = mk('text', {
        x: lane.x + 20,
        y: lane.y + 20,
        fill: lane.undeployed ? '#fca5a5' : '#7dd3fc',
        'font-size': 11,
        'font-weight': 650,
        class: 'lane-where'
      });
      where.textContent = lane.undeployed
        ? 'runs nowhere: no deployment serves this pipeline'
        : 'runs on ' + lane.placements.join('  +  ');
      laneLayer.appendChild(where);
    }

    var columns = decoLayer('inventory');
    for (var c = 0; c < layout.columns.length; c++) {
      var column = layout.columns[c];
      columns.appendChild(
        mk('rect', {
          x: column.x - 10,
          y: column.y - 10,
          width: column.width + 20,
          height: column.height + 20,
          rx: 12,
          fill: '#0d1526',
          stroke: '#1b2740'
        })
      );
      var heading = mk('text', {
        x: column.x,
        y: column.y + 16,
        fill: GROUP_COLORS[column.group] || '#94a3b8',
        'font-size': 12,
        'font-weight': 650,
        class: 'col-title'
      });
      heading.textContent = column.title + ' (' + column.count + ')';
      var blurb = mk('title');
      blurb.textContent = column.blurb;
      heading.appendChild(blurb);
      columns.appendChild(heading);
    }

    for (var e = 0; e < layout.edges.length; e++) {
      var edge = layout.edges[e];
      var path = mk('path', {
        d: edge.d,
        stroke: EDGE_COLORS[edge.kind] || '#64748b',
        'stroke-width': edge.kind === 'flow' ? 2.2 : 1.4,
        'stroke-opacity': edge.kind === 'flow' ? 0.95 : 0.72,
        'marker-end': 'url(#arrow-' + edge.kind + ')',
        'data-kind': edge.kind,
        class: 'edge'
      });
      var tip = mk('title');
      tip.textContent = edge.kind + ': ' + edge.from + ' -> ' + edge.to;
      path.appendChild(tip);
      // An edge is drawn in its source's band, which is also where its tail is. When the two
      // ends stand in different bands the far box is not on screen in a one-band view, so
      // applyEdgeVisibility hides that arrow there and the detail panel names the relation.
      edgesLayer(layerOf[edge.from]).appendChild(path);
      state.paths.push({
        el: path,
        kind: edge.kind,
        from: edge.from,
        to: edge.to,
        layer: edge.layer,
        toLayer: edge.toLayer
      });
    }
    applyEdgeVisibility();

    for (var n = 0; n < layout.nodes.length; n++) {
      nodesLayer(layout.nodes[n].layer).appendChild(buildNode(layout.nodes[n]));
    }
  }

  function buildNode(placed) {
    var node = placed.node;
    var color = GROUP_COLORS[node.group] || '#94a3b8';
    var group = mk('g', { class: 'node', 'data-id': node.id });
    if (node.id === state.selected) group.setAttribute('class', 'node sel');

    group.appendChild(
      mk('rect', {
        x: placed.x,
        y: placed.y,
        width: placed.width,
        height: placed.height,
        rx: 8,
        fill: '#111b2e',
        stroke: color,
        'stroke-opacity': 0.55,
        'stroke-width': 1.2,
        class: 'box'
      })
    );
    group.appendChild(
      mk('rect', {
        x: placed.x,
        y: placed.y,
        width: 3,
        height: placed.height,
        rx: 2,
        fill: color,
        'fill-opacity': 0.9
      })
    );

    var labelCount = 0;
    var i;
    for (i = 0; i < placed.lines.length; i++) {
      if (placed.lines[i].role === 'label') labelCount++;
    }

    var labelIndex = 0;
    var detailIndex = 0;
    var detailTop = placed.y + 9 + labelCount * 16 + 4;
    for (i = 0; i < placed.lines.length; i++) {
      var line = placed.lines[i];
      var isLabel = line.role === 'label';
      var text = mk('text', {
        x: placed.x + 12,
        y: isLabel
          ? placed.y + 9 + 16 * (labelIndex + 0.5)
          : detailTop + 13 * (detailIndex + 0.5),
        fill: isLabel ? '#e6edf9' : '#8b9cbb',
        'font-size': isLabel ? 12 : 10,
        'font-weight': isLabel ? 600 : 400,
        'dominant-baseline': 'middle'
      });
      text.textContent = line.text;
      group.appendChild(text);
      if (isLabel) labelIndex++;
      else detailIndex++;
    }

    var tooltip = mk('title');
    tooltip.textContent = node.label + ' (' + node.kind + ')\\n' + node.path;
    group.appendChild(tooltip);

    group.addEventListener('click', function (event) {
      event.stopPropagation();
      if (state.drag && state.drag.moved) return;
      select(node.id);
    });

    state.nodes.push({ el: group, id: node.id });
    return group;
  }

  function paintSelection() {
    for (var i = 0; i < state.nodes.length; i++) {
      var entry = state.nodes[i];
      var chosen = entry.id === state.selected;
      entry.el.setAttribute('class', chosen ? 'node sel' : 'node');
      // The selected node's own edges stay bright; everything else recedes, which is how a
      // reader follows one path through ninety nodes.
      entry.el.style.opacity = chosen ? '1' : state.selected === null ? '1' : '0.72';
    }
    for (var p = 0; p < state.paths.length; p++) {
      var edge = state.paths[p];
      var touches = edge.from === state.selected || edge.to === state.selected;
      // Run-order edges carry the picture, so they stay heavier than a reference at rest.
      var rest = edge.kind === 'flow' ? 0.95 : 0.72;
      var width = edge.kind === 'flow' ? 2.2 : 1.4;
      edge.el.setAttribute('stroke-opacity', touches ? 1 : state.selected === null ? rest : 0.08);
      edge.el.setAttribute('stroke-width', touches ? 2.2 : width);
    }
  }

  function select(id) {
    state.selected = state.selected === id ? null : id;
    paintSelection();
    renderSubject();
  }

  function setTab(layer, refit) {
    state.tab = layer;
    applyTab();
    drawTabs();
    if (refit) fit();
  }

  /** Show one band and hide the rest; 'all' shows the whole picture at once. */
  function applyTab() {
    for (var i = 0; i < state.bands.length; i++) {
      var band = state.bands[i];
      band.el.style.display = state.tab === 'all' || band.layer === state.tab ? '' : 'none';
    }
    applyEdgeVisibility();
  }

  function tabIds() {
    var layout = state.doc.layout;
    var ids = [];
    for (var i = 0; i < layout.bands.length; i++) ids.push(layout.bands[i].id);
    ids.push('all');
    return ids;
  }

  function tabTitle(layer) {
    if (layer === 'all') return 'everything';
    var bands = state.doc.layout.bands;
    for (var i = 0; i < bands.length; i++) {
      if (bands[i].id === layer) return bands[i].title;
    }
    return layer;
  }

  function tabBlurb(layer) {
    if (layer === 'all') return 'Every band at once, for the whole-picture view.';
    var bands = state.doc.layout.bands;
    for (var i = 0; i < bands.length; i++) {
      if (bands[i].id === layer) return bands[i].blurb;
    }
    return '';
  }

  function drawTabs() {
    clear(tabButtons);
    var ids = tabIds();
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var button = document.createElement('button');
      button.textContent = tabTitle(id);
      button.title = tabBlurb(id);
      if (id === state.tab) button.className = 'on';
      button.addEventListener(
        'click',
        (function (target) {
          return function () { setTab(target, true); };
        })(id)
      );
      tabButtons.appendChild(button);
    }
    tabBlurbEl.textContent = tabBlurb(state.tab);
  }

  /** Open a box: switch to the band it lives in, and put it in the middle of the view. */
  function focusNode(id) {
    var placed = findPlaced(id);
    state.selected = id;
    if (placed !== null) {
      if (state.tab !== 'all' && placed.layer !== state.tab) setTab(placed.layer, true);
      else centerOn(id);
    }
    paintSelection();
    renderSubject();
  }

  function centerOn(id) {
    var placed = findPlaced(id);
    if (placed === null) return;
    var box = canvas.getBoundingClientRect();
    state.view.tx = box.width / 2 - (placed.x + placed.width / 2) * state.view.scale;
    state.view.ty = box.height / 2 - (placed.y + placed.height / 2) * state.view.scale;
    applyView();
  }

  function findPlaced(id) {
    var nodes = state.doc.layout.nodes;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].node.id === id) return nodes[i];
    }
    return null;
  }

  function findSystem(id) {
    var nodes = state.doc.system.nodes;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].id === id) return nodes[i];
    }
    return null;
  }

  /** The architecture box a declaration runs as, if one claims it. */
  function componentOf(id) {
    var nodes = state.doc.system.nodes;
    for (var i = 0; i < nodes.length; i++) {
      var related = nodes[i].related;
      for (var r = 0; r < related.length; r++) {
        if (related[r] === id) return nodes[i];
      }
    }
    return null;
  }

  function layerName(layer) {
    var bands = state.doc.layout.bands;
    for (var i = 0; i < bands.length; i++) {
      if (bands[i].id === layer) return bands[i].title;
    }
    return layer;
  }

  function findSequence(pipelineId) {
    var list = state.doc.sequences || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].pipeline === pipelineId) return list[i];
    }
    return null;
  }

  /** The sequence a selected node belongs to, so a step opens the flow it sits in. */
  function sequencesFor(node, systemNode) {
    if (systemNode !== null) {
      var fromSystem = [];
      for (var s = 0; s < systemNode.sequences.length; s++) {
        var seq = findSequence(systemNode.sequences[s]);
        if (seq !== null) fromSystem.push(seq);
      }
      if (fromSystem.length > 0) return fromSystem;
    }
    if (node.kind === 'pipeline') {
      var own = findSequence(String(node.id).slice('pipeline:'.length));
      if (own !== null) return [own];
    }
    var list = state.doc.sequences || [];
    for (var i = 0; i < list.length; i++) {
      var rows = list[i].rows;
      for (var r = 0; r < rows.length; r++) {
        if (rows[r].nodeId === node.id) return [list[i]];
      }
    }
    return [];
  }

  function stepColor(kind) {
    return GROUP_COLORS[STEP_GROUPS[kind] || 'document'] || '#94a3b8';
  }

  function sequenceRow(row) {
    var chosen = state.selected === row.nodeId;
    var el = div('seq-row' + (chosen ? ' sel' : ''));
    el.style.paddingLeft = 6 + row.depth * 14 + 'px';
    if (!chosen) el.style.borderLeftColor = stepColor(row.kind);

    var top = div('seq-top');
    top.appendChild(div('seq-n', row.path));
    var text = div('seq-text', row.text);
    text.style.color = stepColor(row.kind);
    top.appendChild(text);
    el.appendChild(top);

    if (row.flags.length > 0) {
      var flags = div('seq-flags');
      for (var f = 0; f < row.flags.length; f++) {
        var flag = row.flags[f];
        flags.appendChild(div('flag ' + flag, flag));
      }
      el.appendChild(flags);
    }
    if (row.notes.length > 0) el.appendChild(div('seq-detail', row.notes.join('  ·  ')));

    el.addEventListener('click', function (event) {
      event.stopPropagation();
      focusNode(row.nodeId);
    });
    return el;
  }

  function sequencePanel(seq) {
    var wrap = div('seq');
    wrap.appendChild(div('seq-head', 'request flow · ' + seq.steps + ' steps · ' + seq.trigger));
    if (seq.notes.length > 0) wrap.appendChild(div('seq-notes', seq.notes.join('  ·  ')));
    var rows = div('seq-rows');
    for (var i = 0; i < seq.rows.length; i++) rows.appendChild(sequenceRow(seq.rows[i]));
    wrap.appendChild(rows);
    return wrap;
  }

  function chipSection(title, ids, hintText) {
    var box = div('');
    box.style.marginTop = '10px';
    box.appendChild(div('seq-head', title));
    if (hintText) box.appendChild(div('hint', hintText));
    var chips = div('chips');
    var shown = 0;
    for (var i = 0; i < ids.length; i++) {
      var placed = findPlaced(ids[i]);
      if (placed === null) continue;
      shown++;
      var chip = div('chip', placed.node.label);
      chip.title = placed.node.path;
      chip.addEventListener(
        'click',
        (function (target) {
          return function (event) {
            event.stopPropagation();
            focusNode(target);
          };
        })(ids[i])
      );
      chips.appendChild(chip);
    }
    if (shown === 0) return box;
    box.appendChild(chips);
    return box;
  }

  /**
   * The edges that name one node, grouped by kind and direction.
   *
   * A kind can arrive in both directions (an eval measures a pipeline and a pipeline is
   * measured by it), so direction is part of the grouping key and not just the title.
   */
  function relationGroups(id) {
    var layout = state.doc.layout;
    var groups = [];
    var byKey = {};
    for (var i = 0; i < layout.edges.length; i++) {
      var edge = layout.edges[i];
      var outgoing = edge.from === id;
      if (!outgoing && edge.to !== id) continue;
      var key = edge.kind + (outgoing ? '>' : '<');
      var bucket = byKey[key];
      if (bucket === undefined) {
        bucket = { kind: edge.kind, outgoing: outgoing, ids: [] };
        byKey[key] = bucket;
        groups.push(bucket);
      }
      var other = outgoing ? edge.to : edge.from;
      if (bucket.ids.indexOf(other) === -1) bucket.ids.push(other);
    }
    return groups;
  }

  function renderSubject() {
    clear(subject);
    if (!state.doc || !state.doc.ok) return;
    if (state.selected === null) {
      subject.appendChild(div('label', 'Pick a component'));
      subject.appendChild(
        div('hint', 'The first layer is the architecture: entry, identity, compute, data, and the outside calls a run makes. Click a box and this panel opens it up, down to the order a request moves through it. Drag to pan, scroll to zoom, 0 fits, 1 to 4 switch layers.')
      );
      return;
    }

    var placed = findPlaced(state.selected);
    if (placed === null) return;
    var node = placed.node;

    subject.appendChild(div('label', node.label));
    if (node.detail) subject.appendChild(div('detail', node.detail));
    var path = document.createElement('code');
    path.className = 'path';
    path.textContent = node.path;
    subject.appendChild(path);

    // The two directions of the drill-down: an architecture box names the declarations it
    // stands for, and a declaration names the box it runs as.
    var systemNode = findSystem(node.id);
    if (systemNode !== null) {
      subject.appendChild(
        chipSection('stands for', systemNode.related, 'the declarations this box is one of')
      );
    } else {
      var parent = componentOf(node.id);
      if (parent !== null) {
        subject.appendChild(chipSection('inside', [parent.id], 'the architecture box this runs as'));
      }
    }

    // The other end of every reference this box takes part in. A band view cannot draw an
    // arrow that leaves the band, so the relation is named here instead, and a chip jumps to
    // the box at the other end -- switching band when it has to.
    var relations = relationGroups(node.id);
    for (var r = 0; r < relations.length; r++) {
      var group = relations[r];
      subject.appendChild(
        chipSection(
          group.outgoing ? group.kind + '  \u2192' : '\u2190  ' + group.kind,
          group.ids,
          EDGE_MEANING[group.kind] || 'the other end of this ' + group.kind + ' edge'
        )
      );
    }

    var facts = div('');
    facts.style.marginTop = '12px';
    for (var f = 0; f < node.facts.length; f++) {
      var row = div('fact');
      row.appendChild(div('k', node.facts[f].label));
      row.appendChild(div('v', node.facts[f].value));
      facts.appendChild(row);
    }
    if (node.facts.length === 0) facts.appendChild(div('hint', 'No further keys.'));
    subject.appendChild(facts);

    var sequences = sequencesFor(node, systemNode);
    for (var s = 0; s < sequences.length; s++) subject.appendChild(sequencePanel(sequences[s]));

    var groupName = '';
    for (var j = 0; j < state.doc.graph.groups.length; j++) {
      if (state.doc.graph.groups[j].group === node.group) {
        groupName = state.doc.graph.groups[j].title;
      }
    }
    subject.appendChild(
      div('hint', 'layer: ' + layerName(placed.layer) + '  ·  group: ' + groupName + '  ·  kind: ' + node.kind)
    );
  }

  function apply(doc) {
    var previous = state.doc;
    state.doc = doc;
    state.revision = doc.revision;

    if (!doc.ok) {
      clear(scene);
      state.paths = [];
      state.nodes = [];
      state.bands = [];
      showNotice(doc.diagnostics || []);
      title.textContent = 'refused';
      profile.hidden = true;
      tabs.hidden = true;
      counts.textContent = '';
      clear(subject);
      subject.appendChild(div('label', 'No picture'));
      subject.appendChild(div('hint', 'A spec the build refuses has no graph. Work the diagnostics in order, starting at the top: a spec-level refusal is the document itself, and nothing after it is worth reading until it is fixed.'));
      return;
    }

    notice.hidden = true;
    var fresh = previous === null || !previous.ok || previous.specPath !== doc.specPath;
    draw(doc);
    drawLegend(doc);
    var ids = tabIds();
    if (fresh || ids.indexOf(state.tab) === -1) state.tab = ids.length > 1 ? ids[0] : 'all';
    applyTab();
    drawTabs();
    tabs.hidden = false;
    paintSelection();
    renderSubject();

    var project = doc.graph.project;
    title.textContent = project.name;
    document.title = project.name + ' · aid visualize';
    profile.hidden = false;
    profile.textContent = 'profile: ' + doc.graph.profile;
    specTag.textContent = doc.specPath;
    counts.textContent =
      doc.counts.nodes + ' nodes · ' +
      doc.counts.edges + ' edges · ' +
      doc.counts.steps + ' steps · ' +
      doc.counts.calls + ' calls · spec ' + doc.graph.specVersion;
    if (fresh) fit();
  }

  function load() {
    // A handed-in document is fixed: re-reading it would redraw the same picture, so the
    // embedded page has no refresh control and never calls this.
    if (BOOT !== null) {
      apply(BOOT);
      return Promise.resolve();
    }
    return fetch('/api/graph', { cache: 'no-store' })
      .then(function (response) { return response.json(); })
      .then(apply)
      .catch(function () { setLive(false); });
  }

  canvas.addEventListener('pointerdown', function (event) {
    if (event.button !== 0) return;
    // #canvas is an <svg>, so className is a read-only SVGAnimatedString and assigning to
    // it throws; use classList. The drag is committed first so no cosmetic write can abort it.
    // Pointer capture is deliberately NOT taken here: capturing on pointerdown retargets the
    // following click to this svg, so a click on a node would stop selecting it. It is taken
    // in pointermove, once the gesture has proven to be a drag.
    state.drag = {
      x: event.clientX,
      y: event.clientY,
      tx: state.view.tx,
      ty: state.view.ty,
      moved: false
    };
  });

  canvas.addEventListener('pointermove', function (event) {
    if (!state.drag) return;
    var dx = event.clientX - state.drag.x;
    var dy = event.clientY - state.drag.y;
    if (!state.drag.moved) {
      if (Math.abs(dx) <= 3 && Math.abs(dy) <= 3) return;
      state.drag.moved = true;
      canvas.classList.add('dragging');
      try { canvas.setPointerCapture(event.pointerId); } catch (error) {}
    }
    state.view.tx = state.drag.tx + dx;
    state.view.ty = state.drag.ty + dy;
    applyView();
  });

  function endDrag(event) {
    if (!state.drag) return;
    canvas.classList.remove('dragging');
    try { canvas.releasePointerCapture(event.pointerId); } catch (error) {}
    // Cleared on the next task so the click handler that follows a real click still sees it.
    setTimeout(function () { state.drag = null; }, 0);
  }
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);

  canvas.addEventListener('click', function () {
    // A drag ends in a click too; it must not clear the selection it just panned.
    if (state.drag && state.drag.moved) return;
    if (state.selected !== null) select(state.selected);
  });

  canvas.addEventListener(
    'wheel',
    function (event) {
      event.preventDefault();
      if (!state.doc || !state.doc.ok) return;
      var box = canvas.getBoundingClientRect();
      var px = event.clientX - box.left;
      var py = event.clientY - box.top;
      var next = Math.min(3, Math.max(0.1, state.view.scale * Math.exp(-event.deltaY * 0.0015)));
      var ratio = next / state.view.scale;
      state.view.tx = px - (px - state.view.tx) * ratio;
      state.view.ty = py - (py - state.view.ty) * ratio;
      state.view.scale = next;
      applyView();
    },
    { passive: false }
  );

  document.addEventListener('keydown', function (event) {
    if (event.key === '0' || event.key === 'f') fit();
    if (event.key === 'Escape') {
      if (state.selected !== null) {
        state.selected = null;
        paintSelection();
        renderSubject();
      }
    }
    if (event.key >= '1' && event.key <= '4' && state.doc !== null && state.doc.ok) {
      var ids = tabIds();
      var index = Number(event.key) - 1;
      if (index < ids.length) setTab(ids[index], true);
    }
  });

  document.getElementById('fit').addEventListener('click', fit);
  var refreshButton = document.getElementById('refresh');
  if (refreshButton !== null) refreshButton.addEventListener('click', load);

  window.addEventListener('resize', function () {
    // Only re-fit a picture nobody has touched; a deliberate pan should survive a resize.
    if (state.view.scale === 1 && state.view.tx === 0 && state.view.ty === 0) fit();
  });

  __LIVE_SCRIPT__

  load();
})();
`;

/**
 * The served page's live-reload tail.
 *
 * It is spliced in rather than switched off at runtime: an embedded page has no `/api/events`
 * to open, and asking for one would leave a browser reconnecting to a 404 for as long as the
 * tab is open.
 */
const LIVE_SCRIPT = `  var events = new EventSource('/api/events');
  events.addEventListener('open', function () { setLive(true); });
  events.addEventListener('error', function () { setLive(false); });
  events.addEventListener('message', function (event) {
    var payload;
    try { payload = JSON.parse(event.data); } catch (error) { return; }
    setLive(true);
    if (payload.revision !== state.revision) load();
  });`;

/**
 * The whole page. `__TOKENS__` are substituted rather than built into the template so the
 * client reads the same group and edge tables the server laid the graph out with.
 */
export function renderPage(source: PageSource = {}): string {
  // Live reload is for a page with a server behind it. An embedded page says nothing about
  // being live rather than showing a chip stuck on "connecting".
  const live = source.live ?? source.document === undefined;
  const boot = source.document === undefined ? 'null' : json(source.document);

  const script = SCRIPT.replace('__GROUP_COLORS__', json(GROUP_COLORS))
    .replace('__EDGE_COLORS__', json(EDGE_COLORS))
    .replace('__EDGE_KINDS__', json([...VISUAL_EDGE_KINDS]))
    .replace('__EDGE_MEANING__', json(EDGE_MEANING))
    .replace('__STEP_GROUPS__', json(STEP_GROUPS))
    // A function replacement, so a prompt containing `$&` is not read as a substitution.
    .replace('__BOOT__', () => boot)
    .replace('__LIVE_SCRIPT__', () => (live ? LIVE_SCRIPT : ''));

  const groups = VISUAL_GROUPS.map((group) => `${group.id}: ${group.blurb}`).join('\n');

  const refresh = live ? '<button id="refresh" title="Re-read the spec now">refresh</button>' : '';
  const liveChip = live
    ? '<span class="live"><span class="dot" id="live-dot"></span><span id="live-text">connecting</span></span>'
    : '';
  const noticeSub = live
    ? 'There is no picture to draw, because a diagram of a spec that does not compile would be an approximation of one that does. Fix these and the page reloads by itself.'
    : 'There is no picture to draw, because a diagram of a spec that does not compile would be an approximation of one that does. Fix these and draw it again.';

  return `<!doctype html>
<html lang="en" data-aid-visualize="1">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>aid visualize</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='%230d1526'/><path d='M12 15 L20 10 M12 17 L20 22' stroke='%2364748b' stroke-width='1.8' fill='none'/><circle cx='9' cy='16' r='3.4' fill='%2338bdf8'/><circle cx='23' cy='9' r='3.4' fill='%23a78bfa'/><circle cx='23' cy='23' r='3.4' fill='%2334d399'/></svg>">
<style>${THEME}</style>
</head>
<body>
<header>
  <h1 id="title">aid visualize</h1>
  <span class="tag profile" id="profile" hidden></span>
  <span class="tag" id="spec-tag"></span>
  <span class="counts" id="counts"></span>
  <span class="spacer"></span>
  <button id="fit" title="Fit the whole picture (0)">fit</button>
  ${refresh}
  ${liveChip}
</header>
<div id="tabs" hidden><div id="tab-buttons"></div><span id="tab-blurb"></span></div>
<main>
  <svg id="canvas" xmlns="http://www.w3.org/2000/svg"><g id="scene"></g></svg>
  <div id="notice" hidden>
    <h2>The build refuses this spec</h2>
    <div class="sub">${noticeSub}</div>
    <div id="notice-list"></div>
  </div>
  <aside tabindex="0" aria-label="Inspector, legend and layer meanings">
    <section id="subject"></section>
    <section>
      <h2>Edge kinds</h2>
      <div id="legend-rows"></div>
      <div class="hint" style="margin-top:10px">Click a kind to hide it.</div>
    </section>
    <section>
      <h2>Layers</h2>
      <div class="hint" style="white-space:pre-wrap">Three readings of the same spec, drawn top to bottom. <b>Architecture</b> is the system as it runs: the trigger that starts a request, the identity and gateway in front of it, one box per deployment, the data those deployments reach, and every outbound call. <b>Process</b> is each pipeline as a lane, its steps left to right in the order they run. <b>Inventory</b> is what the process is built from, in a fixed group order:${'\n\n'}${groups}</div>
    </section>
  </aside>
</main>
<script>${script}</script>
</body>
</html>
`;
}
