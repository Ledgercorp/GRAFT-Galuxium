// Capability Graph — typed nodes and edges over a genome: modules, endpoints, middleware,
// dependencies, environment, entities, services, tests, side effects and behaviors, plus
// the relationships between them. A well-structured in-memory model, not a database.
import { stableHash } from '../capability/contract.js';

export const GRAPH_VERSION = '1.0.0';
export const NODE_KINDS = Object.freeze(['capability', 'module', 'endpoint', 'middleware', 'dependency', 'runtime', 'service', 'environment', 'entity', 'side-effect', 'test', 'behavior']);
export const EDGE_KINDS = Object.freeze(['contains', 'defines', 'provides', 'requires', 'reads', 'writes', 'causes', 'relates', 'proves', 'exercises', 'guards', 'assumes']);

export function buildCapabilityGraph(genome) {
  const nodes = new Map();
  const edges = [];
  const node = (id, kind, label, data = {}) => { if (!nodes.has(id)) nodes.set(id, { ...data, id, kind, label }); return id; };
  const edge = (from, to, kind, data = {}) => { edges.push({ ...data, from, to, kind }); };

  const cap = node(`capability:${genome.identity.slug}`, 'capability', genome.identity.name, { category: genome.identity.category, capabilityId: genome.identity.capabilityId });
  for (const b of genome.purpose.behaviors) edge(cap, node(`behavior:${b.id}`, 'behavior', b.text), 'contains');
  for (const mod of genome.dependentModules) edge(cap, node(`module:${mod.file}`, 'module', mod.file, { role: mod.role, sha256: mod.sha256 }), 'contains');
  const middleware = genome.entrypoints.filter((e) => e.kind === 'middleware');
  for (const mw of middleware) edge(cap, node(mw.id, 'middleware', mw.name, { description: mw.description }), 'provides');
  for (const e of genome.entrypoints.filter((x) => x.kind === 'http-endpoint')) {
    node(e.id, 'endpoint', `${e.method} ${e.path}`, { role: e.role, method: e.method, path: e.path, purpose: e.purpose });
    edge(cap, e.id, 'contains');
    const owner = genome.dependentModules.find((m) => /route|auth/.test(m.role) || /routes?\//.test(m.file));
    if (owner) edge(`module:${owner.file}`, e.id, 'defines');
    const guarded = genome.inputs.find((i) => i.source === e.id)?.credential;
    if (guarded) for (const mw of middleware) edge(mw.id, e.id, 'guards');
  }
  for (const d of genome.dependentLibraries.packages) edge(cap, node(`dependency:${d.name}`, 'dependency', d.name, { reason: d.reason, required: d.required !== false }), 'requires');
  for (const r of genome.dependentLibraries.runtime) edge(cap, node(`runtime:${r.name}`, 'runtime', `${r.name} ${r.range}`, { range: r.range, reason: r.reason }), 'requires');
  for (const s of genome.dependentLibraries.services) edge(cap, node(`service:${s.name || s.kind}`, 'service', s.name || s.kind, s), 'requires');
  for (const v of genome.environment) edge(cap, node(`env:${v.name}`, 'environment', v.name, { required: v.required, default: v.default }), 'requires', { required: v.required });
  for (const ent of genome.dataDependencies.entities) node(`entity:${ent.name}`, 'entity', ent.name, { fields: (ent.fields || []).map((f) => f.name), source: ent.source || null });
  for (const rel of genome.dataDependencies.relationships) {
    const [fromEntity] = String(rel.from).split('.'), [toEntity] = String(rel.to).split('.');
    if (nodes.has(`entity:${fromEntity}`) && nodes.has(`entity:${toEntity}`)) edge(`entity:${fromEntity}`, `entity:${toEntity}`, 'relates', { via: rel.from, relation: rel.kind });
  }
  for (const fx of genome.sideEffects) {
    node(fx.id, 'side-effect', `${fx.op} ${fx.entity || fx.target}`, { op: fx.op, effectKind: fx.kind });
    edge(fx.by, fx.id, 'causes');
    if (fx.kind === 'persistence' && nodes.has(`entity:${fx.entity}`)) edge(fx.id, `entity:${fx.entity}`, fx.op === 'read' ? 'reads' : 'writes');
  }
  for (const t of genome.verificationExpectations.tests) {
    node(`test:${t.id}`, 'test', t.id, { required: t.required, testKind: t.kind });
    if (nodes.has(`behavior:${t.proves}`)) edge(`test:${t.id}`, `behavior:${t.proves}`, 'proves');
  }
  // Which tests exercise which endpoints comes from the genome's observedBy trail.
  for (const e of genome.entrypoints.filter((x) => x.kind === 'http-endpoint')) {
    for (const t of new Set(e.observedBy || [])) if (nodes.has(`test:${t}`)) edge(`test:${t}`, e.id, 'exercises');
  }
  for (const a of genome.securityProperties.assumptions) edge(cap, node(`assumption:${a.id}`, 'behavior', a.text, { security: true }), 'assumes');

  const graph = { graphVersion: GRAPH_VERSION, capability: cap, nodes: [...nodes.values()], edges };
  graph.graphId = stableHash({ graphVersion: GRAPH_VERSION, nodes: graph.nodes.map((n) => [n.id, n.kind]), edges: edges.map((e) => [e.from, e.to, e.kind]) });
  graph.stats = graphStats(graph);
  return graph;
}

export function graphStats(graph) {
  const byKind = {};
  for (const n of graph.nodes) byKind[n.kind] = (byKind[n.kind] || 0) + 1;
  const edgesByKind = {};
  for (const e of graph.edges) edgesByKind[e.kind] = (edgesByKind[e.kind] || 0) + 1;
  return { nodes: graph.nodes.length, edges: graph.edges.length, byKind, edgesByKind };
}

export function neighbors(graph, id, { kind = null, direction = 'out' } = {}) {
  const ids = new Set();
  for (const e of graph.edges) {
    if ((direction === 'out' || direction === 'both') && e.from === id && (!kind || e.kind === kind)) ids.add(e.to);
    if ((direction === 'in' || direction === 'both') && e.to === id && (!kind || e.kind === kind)) ids.add(e.from);
  }
  return graph.nodes.filter((n) => ids.has(n.id));
}

export function validateCapabilityGraph(graph) {
  const errors = [];
  if (!graph || graph.graphVersion !== GRAPH_VERSION) return { ok: false, errors: [`graphVersion must be ${GRAPH_VERSION}`] };
  const ids = new Set();
  for (const n of graph.nodes || []) {
    if (!NODE_KINDS.includes(n.kind)) errors.push(`node ${n.id} has unknown kind ${n.kind}`);
    if (ids.has(n.id)) errors.push(`duplicate node ${n.id}`);
    ids.add(n.id);
  }
  for (const e of graph.edges || []) {
    if (!EDGE_KINDS.includes(e.kind)) errors.push(`edge ${e.from}->${e.to} has unknown kind ${e.kind}`);
    if (!ids.has(e.from)) errors.push(`edge references unknown node ${e.from}`);
    if (!ids.has(e.to)) errors.push(`edge references unknown node ${e.to}`);
  }
  if (!ids.has(graph.capability)) errors.push('graph has no capability node');
  return { ok: errors.length === 0, errors };
}
