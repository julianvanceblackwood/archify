// graphs + bridge + run: hand-verified module graph for the synthetic fixture,
// bridge invariants, and the Archify self-bootstrap layering (skipped without
// an Archify checkout). Archify's own validator is the acceptance gate for the
// bridge output when the checkout is present.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { ARCHIFY_AVAILABLE, ARCHIFY_PACKAGE, ARCHIFY_ROOT, BAUIFY_ROOT, runCli } from './helpers.mjs';
import { buildModuleGraph } from '../graphs/module.mjs';
import { toArchify } from '../bridge/to-archify.mjs';

const FIXTURE = path.join(BAUIFY_ROOT, 'test', 'fixtures', 'ts-basic');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'bauify-pipeline-'));
const SKIP = ARCHIFY_AVAILABLE ? false : 'set BAUIFY_ARCHIFY_ROOT to a tt-a1i/archify checkout';

function archifyValidate(irPath, repoRoot) {
  const args = [path.join(ARCHIFY_PACKAGE, 'bin', 'archify.mjs'), 'validate', 'architecture', irPath, '--quality', 'standard', '--json'];
  if (repoRoot) args.push('--repo-root', repoRoot);
  const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch { /* fall through */ }
  return { status: result.status, json, stderr: result.stderr };
}

test('run: the synthetic fixture folds into a hand-verified two-module graph', () => {
  const result = runCli(['run', FIXTURE, '--out', OUT, '--json']);
  assert.equal(result.status, 0, result.stdout);
  const graph = JSON.parse(fs.readFileSync(path.join(OUT, 'module-graph.json'), 'utf8'));
  assert.deepEqual(graph.excluded, { roles: ['generated', 'test'], files: 2 });
  assert.deepEqual(graph.modules.map((m) => [m.id, m.files, m.fanIn, m.fanOut, m.instability]), [
    ['src', 1, 0, 1, 1],
    ['src-lib', 2, 1, 0, 0],
  ]);
  // src/index.mjs → helper (static + export) and lazy (dynamic): three file edges, one module edge.
  assert.deepEqual(graph.edges.map((e) => [e.from, e.to, e.weight, e.kinds]), [
    ['src', 'src-lib', 3, { dynamic: 1, eager: 2, export: 1, lazy: 1, static: 1 }],
  ]);
  assert.equal(graph.edges[0].evidence.length, 3);
  assert.deepEqual(result.json.bridge, { components: 2, connections: 1, evidence: true, folded: 0, layers: 2 });
});

test('graphs: explicit groups win over depth, and a deeper package folds into its depth-level ancestor', () => {
  const facts = JSON.parse(fs.readFileSync(path.join(OUT, 'raw-facts.json'), 'utf8'));
  const grouped = buildModuleGraph(facts, { modules: { groups: { everything: ['src/**'] } } });
  assert.deepEqual(grouped.modules.map((m) => m.id), ['everything']);
  assert.deepEqual(grouped.edges, []);
  const depth1 = buildModuleGraph(facts, { modules: { depth: 1 } });
  assert.deepEqual(depth1.modules.map((m) => m.id), ['src']);
});

test('bridge: evidence is carried only with a 40-hex revision and a github.com origin', () => {
  const graph = JSON.parse(fs.readFileSync(path.join(OUT, 'module-graph.json'), 'utf8'));
  const withEvidence = toArchify({ ...graph, repository: { ...graph.repository, revision: 'a'.repeat(40), url: 'git@github.com:acme/widgets.git' } });
  assert.deepEqual(withEvidence.ir.meta.repository, { url: 'https://github.com/acme/widgets', revision: 'a'.repeat(40) });
  assert.ok(withEvidence.ir.components.every((c) => Array.isArray(c.sources) && c.sources.length >= 1));
  const noGit = toArchify({ ...graph, repository: { ...graph.repository, revision: null, url: null } });
  assert.equal(noGit.evidence, false);
  assert.equal(noGit.ir.meta.repository, undefined);
  assert.ok(noGit.ir.components.every((c) => c.sources === undefined));
  const notGithub = toArchify({ ...graph, repository: { ...graph.repository, revision: 'b'.repeat(40), url: 'https://gitlab.com/acme/widgets.git' } });
  assert.equal(notGithub.evidence, false);
});

test('bridge: folds to the node budget, keeps one column per node, and never emits self edges', () => {
  const modules = [];
  const edges = [];
  for (let i = 0; i < 20; i += 1) {
    modules.push({ id: `pkg-m${i}`, label: `pkg/m${i}`, path: `pkg/m${i}`, files: 1, loc: 10, fanIn: 0, fanOut: 0, instability: null, entry: [`pkg/m${i}/index.mjs`] });
  }
  modules.push({ id: 'core', label: 'core', path: 'core', files: 1, loc: 10, fanIn: 0, fanOut: 0, instability: null, entry: ['core/index.mjs'] });
  for (let i = 0; i < 20; i += 1) edges.push({ from: `pkg-m${i}`, to: 'core', weight: 1, kinds: { static: 1 }, evidence: [{ file: `pkg/m${i}/index.mjs`, line: 1, to: 'core/index.mjs' }] });
  const graph = { schema_version: 1, repository: { root: '.', revision: null, url: null, language: 'ts', adapter: 't' }, grouping: { depth: 2, packageBoundaries: true, groups: [] }, excluded: { roles: [], files: 0 }, modules, edges, unresolved: { external: 0, outside: 0, unknown: 0, opaque: 0 } };
  const { ir, folded } = toArchify(graph);
  assert.ok(ir.components.length <= 12);
  assert.equal(folded, 20, 'all twenty pkg/* children fold into pkg');
  assert.deepEqual(ir.components.map((c) => c.id).sort(), ['core', 'pkg']);
  assert.deepEqual(ir.connections.map((c) => [c.from, c.to, c.label]), [['pkg', 'core', '20 imports']]);
  const cols = ir.components.map((c) => c.col);
  assert.equal(new Set(cols).size, cols.length, 'one column per node');
  assert.equal(ir.layout.cols, ir.components.length);
});

test('bridge: Archify validates the fixture IR (standard profile, with and without evidence)', { skip: SKIP }, () => {
  const irPath = path.join(OUT, 'repo.architecture.json');
  const withRoot = archifyValidate(irPath, ARCHIFY_ROOT);
  assert.equal(withRoot.status, 0, withRoot.stderr || JSON.stringify(withRoot.json));
  assert.equal(withRoot.json.ok, true);
  const graph = JSON.parse(fs.readFileSync(path.join(OUT, 'module-graph.json'), 'utf8'));
  const sourceFree = toArchify({ ...graph, repository: { ...graph.repository, revision: null, url: null } }).ir;
  const sourceFreePath = path.join(OUT, 'source-free.architecture.json');
  fs.writeFileSync(sourceFreePath, JSON.stringify(sourceFree, null, 2));
  const plain = archifyValidate(sourceFreePath, null);
  assert.equal(plain.status, 0, plain.stderr || JSON.stringify(plain.json));
  assert.equal(plain.json.ok, true);
});

test('run + Archify: the archify/ package maps to bin → renderers/* → renderers/shared and validates', { skip: SKIP }, () => {
  const out = path.join(OUT, 'archify');
  const result = runCli(['run', ARCHIFY_PACKAGE, '--language', 'ts', '--out', out, '--json']);
  assert.equal(result.status, 0, result.stdout);
  const graph = JSON.parse(fs.readFileSync(path.join(out, 'module-graph.json'), 'utf8'));
  const byId = new Map(graph.modules.map((m) => [m.id, m]));
  assert.equal(byId.get('renderers-shared').fanOut, 0, 'shared depends on nothing inside the package');
  assert.ok(byId.get('renderers-shared').fanIn >= 6);
  for (const type of ['architecture', 'dataflow', 'lifecycle', 'sequence', 'workflow']) {
    assert.ok(graph.edges.some((e) => e.from === `renderers-${type}` && e.to === 'renderers-shared'), `renderers/${type} → shared`);
  }
  assert.ok(graph.edges.some((e) => e.from === 'bin' && e.to === 'renderers-shared'));
  // bin reaches the renderers through spawnSync and a computed import(): not a static edge, but counted.
  assert.ok(!graph.edges.some((e) => e.from === 'bin' && e.to.startsWith('renderers-') && e.to !== 'renderers-shared'));
  assert.ok(graph.unresolved.opaque >= 1);
  const validated = archifyValidate(path.join(out, 'repo.architecture.json'), ARCHIFY_ROOT);
  assert.equal(validated.status, 0, validated.stderr || JSON.stringify(validated.json));
  assert.equal(validated.json.ok, true);
});
