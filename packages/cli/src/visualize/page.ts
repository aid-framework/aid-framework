/**
 * The page `aid visualize` serves: one self-contained HTML document, no build step, no CDN.
 *
 * **Why it carries no spec data.** The shell is static and every value it shows arrives from
 * `/api/graph`. That is what makes live reload a re-fetch instead of a page load, and it keeps
 * spec-controlled text out of the HTML: nothing here is string-interpolated from a spec, and
 * the client writes strings with `textContent` rather than `innerHTML`, so a prompt that
 * contains markup cannot become markup.
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

import { VISUAL_EDGE_KINDS, VISUAL_GROUPS } from './graph.js';

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
  #canvas {
    flex: 1; min-width: 0; cursor: grab; touch-action: none;
    background-image: radial-gradient(circle at 1px 1px, #1b2740 1px, transparent 0);
    background-size: 24px 24px;
  }
  #canvas.dragging { cursor: grabbing; }
  aside {
    flex: 0 0 344px; overflow: auto; background: var(--panel);
    border-left: 1px solid var(--line); display: flex; flex-direction: column;
  }
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
`;

const SCRIPT = `
(function () {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  var GROUP_COLORS = __GROUP_COLORS__;
  var EDGE_COLORS = __EDGE_COLORS__;
  var EDGE_KINDS = __EDGE_KINDS__;
  var EDGE_MEANING = __EDGE_MEANING__;

  var state = {
    doc: null,
    revision: -1,
    view: { scale: 1, tx: 0, ty: 0 },
    selected: null,
    hidden: {},
    paths: [],
    nodes: [],
    drag: null
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
    var scale = Math.min(
      (box.width - pad * 2) / state.doc.layout.width,
      (box.height - pad * 2) / state.doc.layout.height,
      1.15
    );
    scale = Math.max(0.12, scale);
    state.view.scale = scale;
    state.view.tx = (box.width - state.doc.layout.width * scale) / 2;
    state.view.ty = (box.height - state.doc.layout.height * scale) / 2;
    applyView();
  }

  function setLive(on) {
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
    for (var i = 0; i < doc.graph.edges.length; i++) {
      var kind = doc.graph.edges[i].kind;
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
      for (var i = 0; i < state.paths.length; i++) {
        var entry = state.paths[i];
        if (entry.kind === kind) {
          entry.el.style.display = state.hidden[kind] ? 'none' : '';
        }
      }
      if (state.doc && state.doc.ok) drawLegend(state.doc);
    };
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

    var laneLayer = mk('g');
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
    scene.appendChild(laneLayer);

    var columns = mk('g');
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
    scene.appendChild(columns);

    var edgeLayer = mk('g');
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
      if (state.hidden[edge.kind]) path.style.display = 'none';
      edgeLayer.appendChild(path);
      state.paths.push({ el: path, kind: edge.kind, from: edge.from, to: edge.to });
    }
    scene.appendChild(edgeLayer);

    var nodeLayer = mk('g');
    for (var n = 0; n < layout.nodes.length; n++) {
      nodeLayer.appendChild(buildNode(layout.nodes[n]));
    }
    scene.appendChild(nodeLayer);
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

  function renderSubject() {
    clear(subject);
    if (!state.doc || !state.doc.ok) return;
    if (state.selected === null) {
      var groupTitles = {};
      for (var g = 0; g < state.doc.graph.groups.length; g++) {
        groupTitles[state.doc.graph.groups[g].group] = state.doc.graph.groups[g].title;
      }
      subject.appendChild(div('label', 'Click a node'));
      subject.appendChild(
        div('hint', 'Every box is a shape in the spec, and every line is a reference the build already resolved. Drag to pan, scroll to zoom, press 0 to fit.')
      );
      return;
    }

    var found = null;
    var nodes = state.doc.layout.nodes;
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].node.id === state.selected) {
        found = nodes[i].node;
        break;
      }
    }
    if (found === null) return;

    var head = div('label', found.label);
    subject.appendChild(head);
    if (found.detail) subject.appendChild(div('detail', found.detail));
    var path = document.createElement('code');
    path.className = 'path';
    path.textContent = found.path;
    subject.appendChild(path);

    var facts = div('');
    facts.style.marginTop = '12px';
    for (var f = 0; f < found.facts.length; f++) {
      var row = div('fact');
      row.appendChild(div('k', found.facts[f].label));
      row.appendChild(div('v', found.facts[f].value));
      facts.appendChild(row);
    }
    if (found.facts.length === 0) facts.appendChild(div('hint', 'No further keys.'));
    subject.appendChild(facts);

    var groupName = '';
    for (var j = 0; j < state.doc.graph.groups.length; j++) {
      if (state.doc.graph.groups[j].group === found.group) groupName = state.doc.graph.groups[j].title;
    }
    subject.appendChild(div('hint', 'group: ' + groupName + '  ·  kind: ' + found.kind));
  }

  function apply(doc) {
    var previous = state.doc;
    state.doc = doc;
    state.revision = doc.revision;

    if (!doc.ok) {
      clear(scene);
      state.paths = [];
      state.nodes = [];
      showNotice(doc.diagnostics || []);
      title.textContent = 'refused';
      profile.hidden = true;
      counts.textContent = '';
      clear(subject);
      subject.appendChild(div('label', 'No picture'));
      subject.appendChild(div('hint', 'A spec the build refuses has no graph. Fix the diagnostics on the left; the page reloads the moment the spec stops being wrong.'));
      return;
    }

    notice.hidden = true;
    var fresh = previous === null || !previous.ok || previous.specPath !== doc.specPath;
    draw(doc);
    drawLegend(doc);
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
      doc.counts.steps + ' steps · spec ' + doc.graph.specVersion;
    if (fresh) fit();
  }

  function load() {
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
    if (event.key === 'Escape') select(state.selected === null ? '' : state.selected);
  });

  document.getElementById('fit').addEventListener('click', fit);
  document.getElementById('refresh').addEventListener('click', load);

  window.addEventListener('resize', function () {
    // Only re-fit a picture nobody has touched; a deliberate pan should survive a resize.
    if (state.view.scale === 1 && state.view.tx === 0 && state.view.ty === 0) fit();
  });

  var events = new EventSource('/api/events');
  events.addEventListener('open', function () { setLive(true); });
  events.addEventListener('error', function () { setLive(false); });
  events.addEventListener('message', function (event) {
    var payload;
    try { payload = JSON.parse(event.data); } catch (error) { return; }
    setLive(true);
    if (payload.revision !== state.revision) load();
  });

  load();
})();
`;

/**
 * The whole page. `__TOKENS__` are substituted rather than built into the template so the
 * client reads the same group and edge tables the server laid the graph out with.
 */
export function renderPage(): string {
  const script = SCRIPT.replace('__GROUP_COLORS__', json(GROUP_COLORS))
    .replace('__EDGE_COLORS__', json(EDGE_COLORS))
    .replace('__EDGE_KINDS__', json([...VISUAL_EDGE_KINDS]))
    .replace('__EDGE_MEANING__', json(EDGE_MEANING));

  const groups = VISUAL_GROUPS.map((group) => `${group.id}: ${group.blurb}`).join('\n');

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
  <button id="refresh" title="Re-read the spec now">refresh</button>
  <span class="live"><span class="dot" id="live-dot"></span><span id="live-text">connecting</span></span>
</header>
<main>
  <svg id="canvas" xmlns="http://www.w3.org/2000/svg"><g id="scene"></g></svg>
  <div id="notice" hidden>
    <h2>The build refuses this spec</h2>
    <div class="sub">There is no picture to draw, because a diagram of a spec that does not compile would be an approximation of one that does. Fix these and the page reloads by itself.</div>
    <div id="notice-list"></div>
  </div>
  <aside>
    <section id="subject"></section>
    <section>
      <h2>Edge kinds</h2>
      <div id="legend-rows"></div>
      <div class="hint" style="margin-top:10px">Click a kind to hide it.</div>
    </section>
    <section>
      <h2>Two bands</h2>
      <div class="hint" style="white-space:pre-wrap">The top band is the process. One lane per pipeline, its steps left to right in the order they run, headed by the deployments that serve it. The bottom band is what that process is built from, in a fixed group order:${'\n\n'}${groups}</div>
    </section>
  </aside>
</main>
<script>${script}</script>
</body>
</html>
`;
}
