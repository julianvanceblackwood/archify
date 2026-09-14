// Bridge: module graph → Archify `architecture` IR (schema_version 1).
//
// Archify has no auto-layout, so the bridge assigns a layered grid: sources on
// top, sinks at the bottom, cycles broken by DFS back-edge removal. Every
// component is `backend` unless `bridge.types` maps a module id to another
// Archify type — Bauify never infers semantic color from names.
//
// The IR declares `quality_profile: standard` by default: a module map folded
// from a real dependency graph is usually non-planar, and Archify's showcase
// profile rejects every crossing. Set bridge.qualityProfile to "showcase" for
// sparse graphs.
//
// Evidence mode is opt-in by facts, not by flag: when the repository has a
// 40-hex revision and a github.com origin, the IR carries `meta.repository`
// and per-component `sources` so Archify's repository-evidence checks can
// verify them; otherwise the IR is source-free.

const MAX_NODES = 12;
const CELL_W = 190;
const CELL_H = 64;
const GAP_X = 40;
const ORIGIN_X = 40;
const ORIGIN_Y = 80;
const LANE_STEP = 24;
const LABEL_OFFSET_X = 70;
const MIN_GAP_Y = 160;
const GITHUB_HTTPS = /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/;
const ARCHIFY_ID = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export function toArchify(graph, config = {}) {
  const options = { maxNodes: MAX_NODES, minWeight: 1, qualityProfile: 'standard', types: {}, title: null, ...(config.bridge || {}) };
  const folding = foldToBudget(graph.modules, graph.edges, options.maxNodes);
  const { modules, folded } = folding;
  // Weak edges can be hidden to keep a dense map readable; the card says so.
  const hidden = folding.edges.filter((e) => e.weight < options.minWeight);
  const edges = folding.edges.filter((e) => e.weight >= options.minWeight);
  recount(modules, edges);
  const layers = layerModules(modules, edges);
  const geometry = placeAndRoute(modules, edges, layers);

  const repository = evidenceRepository(graph.repository);
  const prefix = graph.repository.root && graph.repository.root !== '.' ? `${graph.repository.root}/` : '';

  const components = modules.map((m) => {
    const cell = geometry.cells.get(m.id);
    const component = {
      id: archifyId(m.id),
      type: options.types[m.id] || 'backend',
      label: m.label.slice(0, 48),
      sublabel: `${m.files} file${m.files === 1 ? '' : 's'} · ${m.loc} LOC`,
      row: cell.row,
      col: cell.col,
      size: [CELL_W, CELL_H],
    };
    if (m.fanIn + m.fanOut > 0) component.tag = `in ${m.fanIn} · out ${m.fanOut}`;
    if (repository && m.entry.length) component.sources = m.entry.slice(0, 3).map((p) => ({ path: `${prefix}${p}`, label: p.slice(p.lastIndexOf('/') + 1) }));
    return component;
  }).sort((a, b) => a.row - b.row || a.col - b.col);

  const connections = geometry.routes.map((r) => ({
    id: `${archifyId(r.from)}-to-${archifyId(r.to)}`,
    from: archifyId(r.from),
    to: archifyId(r.to),
    label: `${r.weight} import${r.weight === 1 ? '' : 's'}`,
    fromSide: r.fromSide,
    toSide: r.toSide,
    via: r.via,
    labelAt: r.labelAt,
  }));

  const cards = [
    {
      dot: 'cyan',
      title: 'How to read this map',
      items: [
        'Nodes are modules folded from files; edges are static import relationships.',
        `${graph.modules.length} modules and ${graph.edges.length} edges in the full graph; ${components.length} nodes shown.`,
        `Unresolved: ${graph.unresolved.external} external, ${graph.unresolved.outside} outside, ${graph.unresolved.unknown} unknown, ${graph.unresolved.opaque} computed.`,
      ],
    },
  ];
  if (folded.length) cards.push({ dot: 'slate', title: 'Folded into parent modules', items: folded.slice(0, 8) });
  if (hidden.length) cards.push({ dot: 'amber', title: 'Edges not drawn', items: [`${hidden.length} relationship${hidden.length === 1 ? '' : 's'} with fewer than ${options.minWeight} imports are omitted from the drawing (bridge.minWeight).`] });
  if (graph.excluded.files) cards.push({ dot: 'violet', title: 'Not shown', items: [`${graph.excluded.files} files with role ${graph.excluded.roles.join(' / ')} are excluded from the module graph.`] });

  const ir = {
    schema_version: 1,
    diagram_type: 'architecture',
    meta: {
      title: options.title || titleFor(graph.repository),
      quality_profile: options.qualityProfile,
    },
    layout: { mode: 'grid', origin: [ORIGIN_X, ORIGIN_Y], cols: geometry.cols, gapX: GAP_X, gapY: geometry.gapY, cellW: CELL_W, cellH: CELL_H },
    components,
    connections,
    cards,
  };
  if (repository) ir.meta.repository = repository;
  return { ir, evidence: Boolean(repository), folded: folded.length, layers: layers.length, cols: geometry.cols };
}

function evidenceRepository(repo) {
  if (!repo || !/^[a-f0-9]{40}$/.test(repo.revision || '')) return null;
  const url = normalizeGithub(repo.url);
  return url ? { url, revision: repo.revision } : null;
}

function normalizeGithub(url) {
  if (!url) return null;
  const ssh = url.match(/^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  const https = ssh ? `https://github.com/${ssh[1]}/${ssh[2]}` : url.replace(/\.git\/?$/, '').replace(/\/$/, '');
  return GITHUB_HTTPS.test(https) ? https : null;
}

function titleFor(repo) {
  const url = repo && repo.url ? normalizeGithub(repo.url) : null;
  if (url) return `${url.split('/').pop()} — module map`;
  return 'Module map';
}

function archifyId(id) {
  return ARCHIFY_ID.test(id) ? id : `m-${id}`;
}

// Fold child modules (deepest paths first) into their parent until the node
// budget is met; if that is not enough, keep the highest-degree modules and
// collect the rest into one `other` node.
function foldToBudget(modules, edges, maxNodes) {
  let current = modules.map((m) => ({ ...m }));
  let currentEdges = edges.map((e) => ({ ...e }));
  const folded = [];
  const byId = () => new Map(current.map((m) => [m.id, m]));

  // Fold whole sibling groups (all children of one parent path) at a time, the
  // deepest parent first, so a parent never ends up with half its children shown.
  while (current.length > maxNodes) {
    const parents = new Map();
    for (const m of current) {
      if (!m.path.includes('/')) continue;
      const parentPath = m.path.slice(0, m.path.lastIndexOf('/'));
      (parents.get(parentPath) || parents.set(parentPath, []).get(parentPath)).push(m);
    }
    if (!parents.size) break;
    const [parentPath, children] = [...parents.entries()].sort((a, b) => b[0].split('/').length - a[0].split('/').length || compareText(a[0], b[0]))[0];
    const parentId = moduleIdFor(parentPath);
    let parent = byId().get(parentId);
    if (!parent) { parent = { id: parentId, label: parentPath, path: parentPath, files: 0, loc: 0, fanIn: 0, fanOut: 0, instability: null, entry: [] }; current.push(parent); }
    for (const child of [...children].sort((a, b) => compareText(a.id, b.id))) {
      parent.files += child.files; parent.loc += child.loc;
      parent.entry = [...parent.entry, ...child.entry].slice(0, 3);
      current = current.filter((m) => m.id !== child.id);
      currentEdges = remap(currentEdges, child.id, parentId);
      folded.push(`${child.label} → ${parent.label}`);
    }
    recount(current, currentEdges);
  }

  if (current.length > maxNodes) {
    const ranked = [...current].sort((a, b) => (b.fanIn + b.fanOut) - (a.fanIn + a.fanOut) || compareText(a.id, b.id));
    const keep = new Set(ranked.slice(0, maxNodes - 1).map((m) => m.id));
    const other = { id: 'other', label: 'other modules', path: '', files: 0, loc: 0, fanIn: 0, fanOut: 0, instability: null, entry: [] };
    for (const m of current) if (!keep.has(m.id)) { other.files += m.files; other.loc += m.loc; folded.push(`${m.label} → other`); currentEdges = remap(currentEdges, m.id, 'other'); }
    current = [...current.filter((m) => keep.has(m.id)), other];
    recount(current, currentEdges);
  }

  current.sort((a, b) => compareText(a.id, b.id));
  return { modules: current, edges: currentEdges, folded };
}

function moduleIdFor(key) {
  return key === '' ? 'root' : key.replace(/[^A-Za-z0-9_]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

function remap(edges, fromId, toId) {
  const merged = new Map();
  for (const e of edges) {
    const from = e.from === fromId ? toId : e.from;
    const to = e.to === fromId ? toId : e.to;
    if (from === to) continue;
    const key = `${from} ${to}`;
    if (!merged.has(key)) merged.set(key, { from, to, weight: 0, kinds: {}, evidence: [] });
    const m = merged.get(key);
    m.weight += e.weight;
    for (const [k, v] of Object.entries(e.kinds)) m.kinds[k] = (m.kinds[k] || 0) + v;
    m.evidence = [...m.evidence, ...e.evidence].slice(0, 5);
  }
  return [...merged.values()].sort((a, b) => compareText(a.from, b.from) || compareText(a.to, b.to));
}

function recount(modules, edges) {
  for (const m of modules) { m.fanIn = 0; m.fanOut = 0; }
  const map = new Map(modules.map((m) => [m.id, m]));
  for (const e of edges) { map.get(e.from).fanOut += 1; map.get(e.to).fanIn += 1; }
  for (const m of modules) m.instability = m.fanIn + m.fanOut === 0 ? null : Math.round((m.fanOut / (m.fanIn + m.fanOut)) * 1000) / 1000;
}

// Place one module per column (so vertical runs never meet a node) and route
// every edge as bottom → lane → top: a vertical stub out of the source, one
// horizontal segment in a private lane inside the gap directly below the
// source row, then a vertical run into the target. Back edges (target above
// the source) leave from the top and use the gap above the source row.
function placeAndRoute(modules, edges, layers) {
  const rowOf = new Map();
  layers.forEach((layer, row) => { for (const m of layer) rowOf.set(m.id, row); });
  const order = columnOrder(modules);
  const cells = new Map(order.map((id, col) => [id, { row: rowOf.get(id), col }]));
  const cols = Math.max(order.length, 1);

  // Lane allocation per gap. Gap g lies between row g and row g + 1.
  // Within a gap, order lanes so that a lane never crosses another edge's
  // vertical stub or final run when the column intervals allow it: an edge
  // whose source column lies inside another edge's span goes above it; an edge
  // whose target column lies inside another's span goes below it. Nested
  // intervals cannot satisfy both and are the residual crossings.
  const byGap = new Map();
  const routes = edges.map((e) => {
    const from = cells.get(e.from);
    const to = cells.get(e.to);
    const forward = to.row > from.row;
    const gap = forward ? from.row : from.row - 1;
    const route = { ...e, forward, gap, lane: 0, fromCol: from.col, toCol: to.col };
    (byGap.get(gap) || byGap.set(gap, []).get(gap)).push(route);
    return route;
  });
  const laneCounts = new Map();
  for (const [gap, group] of byGap) {
    orderLanes(group);
    group.forEach((r, lane) => { r.lane = lane; });
    laneCounts.set(gap, group.length);
  }
  const maxLanes = Math.max(0, ...laneCounts.values());
  const gapY = Math.max(MIN_GAP_Y, LANE_STEP * (maxLanes + 1) + 16);
  const stepY = CELL_H + gapY;
  const stepX = CELL_W + GAP_X;
  const centerX = (c) => ORIGIN_X + c * stepX + CELL_W / 2;
  const rowTop = (r) => ORIGIN_Y + r * stepY;
  const laneY = (gap, lane) => rowTop(gap) + CELL_H + LANE_STEP * (lane + 1);

  return {
    cells,
    cols,
    gapY,
    routes: routes.map((r) => {
      const y = laneY(r.gap, r.lane);
      const x0 = centerX(r.fromCol);
      const x1 = centerX(r.toCol);
      // Label sits on the lane just beside the source column, where no other
      // column's vertical stub can run.
      const labelX = x0 + Math.sign(x1 - x0) * LABEL_OFFSET_X;
      return {
        from: r.from, to: r.to, weight: r.weight,
        fromSide: r.forward ? 'bottom' : 'top',
        toSide: r.forward ? 'top' : 'bottom',
        via: [[x0, y], [x1, y]],
        labelAt: [labelX, y],
      };
    }),
  };
}

// Columns run from the most stable module (pure sinks, instability 0) on the
// left to the least stable (pure sources) on the right. Lanes therefore run
// right-to-left toward sinks, and a source's stub rarely sits inside another
// lane's span, which is what keeps the lane ordering below conflict-free.
function columnOrder(modules) {
  const key = (m) => (m.instability === null ? 2 : m.instability);
  return [...modules]
    .sort((a, b) => key(a) - key(b) || b.fanIn - a.fanIn || compareText(a.id, b.id))
    .map((m) => m.id);
}

function orderLanes(group) {
  const inside = (col, r) => col > Math.min(r.fromCol, r.toCol) && col < Math.max(r.fromCol, r.toCol);
  const span = (r) => Math.abs(r.toCol - r.fromCol);
  // above[i] = set of j that must be above i.
  const n = group.length;
  const mustBeAbove = group.map(() => new Set());
  for (let i = 0; i < n; i += 1) for (let j = 0; j < n; j += 1) {
    if (i === j) continue;
    const a = group[i]; const b = group[j];
    if (inside(b.fromCol, a) && !inside(b.toCol, a)) mustBeAbove[i].add(j); // b above a
    if (inside(b.toCol, a) && !inside(b.fromCol, a)) mustBeAbove[j].add(i); // b below a
  }
  // Kahn ordering with a deterministic tie-break: shorter span first (higher lane).
  const placed = [];
  const remaining = new Set(group.map((_, i) => i));
  while (remaining.size) {
    const ready = [...remaining].filter((i) => [...mustBeAbove[i]].every((j) => !remaining.has(j)));
    const pick = (ready.length ? ready : [...remaining]).sort((i, j) => span(group[i]) - span(group[j]) || compareText(group[i].to, group[j].to) || compareText(group[i].from, group[j].from))[0];
    placed.push(group[pick]);
    remaining.delete(pick);
  }
  group.splice(0, n, ...placed);
}

// Longest-path layering over the DAG obtained by dropping DFS back edges.
function layerModules(modules, edges) {
  const ids = modules.map((m) => m.id).sort(compareText);
  const out = new Map(ids.map((id) => [id, []]));
  for (const e of edges) out.get(e.from).push(e.to);
  for (const list of out.values()) list.sort(compareText);

  const state = new Map();
  const forward = new Map(ids.map((id) => [id, []]));
  const visit = (id) => {
    state.set(id, 1);
    for (const next of out.get(id)) {
      if (state.get(next) === 1) continue; // back edge: dropped for layering only
      forward.get(id).push(next);
      if (!state.has(next)) visit(next);
    }
    state.set(id, 2);
  };
  // Start from modules with no incoming edges (by id order), then anything left.
  const incoming = new Map(ids.map((id) => [id, 0]));
  for (const e of edges) incoming.set(e.to, incoming.get(e.to) + 1);
  for (const id of ids.filter((i) => incoming.get(i) === 0)) if (!state.has(id)) visit(id);
  for (const id of ids) if (!state.has(id)) visit(id);

  const depth = new Map(ids.map((id) => [id, 0]));
  const order = [];
  const topo = (id, seen) => { if (seen.has(id)) return; seen.add(id); for (const n of forward.get(id)) topo(n, seen); order.push(id); };
  const seen = new Set();
  for (const id of ids) topo(id, seen);
  for (const id of order.reverse()) for (const n of forward.get(id)) depth.set(n, Math.max(depth.get(n), depth.get(id) + 1));

  const byId = new Map(modules.map((m) => [m.id, m]));
  const layers = [];
  for (const id of ids) { const d = depth.get(id); (layers[d] ||= []).push(byId.get(id)); }
  return layers.filter(Boolean).map((l) => l.sort((a, b) => compareText(a.id, b.id)));
}

function compareText(a, b) { return a < b ? -1 : a > b ? 1 : 0; }
