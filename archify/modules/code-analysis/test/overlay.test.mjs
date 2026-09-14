// overlay: mapping derivation, aggregation, and injection. A synthetic HTML
// with Archify's hooks (data-node-id, class="toolbar") is enough for the unit
// tests; the real-artifact test runs only when an Archify checkout is present.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { ARCHIFY_AVAILABLE, ARCHIFY_PACKAGE, ARCHIFY_ROOT, BAUIFY_ROOT, runCli } from './helpers.mjs';
import { buildOverlay } from '../overlay/inject.mjs';

const FAKE_HTML = '<html><body><div class="toolbar"></div><svg><g data-node-id="app"></g><g data-node-id="lib"></g></svg></body></html>';
const graph = {
  schema_version: 1,
  repository: { root: '.', revision: null, url: null, language: 'ts', adapter: 't' },
  grouping: { depth: 2, packageBoundaries: true, groups: [] },
  excluded: { roles: [], files: 0 },
  modules: [
    { id: 'src', label: 'src', path: 'src', files: 1, loc: 10, fanIn: 0, fanOut: 1, instability: 1, entry: ['src/index.mjs'] },
    { id: 'src-lib', label: 'src/lib', path: 'src/lib', files: 2, loc: 3, fanIn: 1, fanOut: 0, instability: 0, entry: ['src/lib/helper.mjs'] },
    { id: 'tools', label: 'tools', path: 'tools', files: 1, loc: 5, fanIn: 0, fanOut: 0, instability: null, entry: ['tools/x.mjs'] },
  ],
  edges: [{ from: 'src', to: 'src-lib', weight: 3, kinds: { static: 3 }, evidence: [{ file: 'src/index.mjs', line: 2, to: 'src/lib/helper.mjs' }] }],
  unresolved: { external: 0, outside: 0, unknown: 0, opaque: 0 },
};
const ir = {
  schema_version: 1, diagram_type: 'architecture', meta: { title: 't' },
  components: [
    { id: 'app', type: 'backend', label: 'App', sources: [{ path: 'src/index.mjs' }] },
    { id: 'lib', type: 'backend', label: 'Lib', sources: [{ path: 'src/lib/helper.mjs' }] },
  ],
  connections: [],
};

function payloadOf(html) {
  const m = html.match(/<script type="application\/json" id="bauify-analysis">([\s\S]*?)<\/script>/);
  return JSON.parse(m[1].replace(/<\\\//g, '</'));
}

test('overlay: components map to modules through their sources; descendants follow the parent', () => {
  const result = buildOverlay({ ir, graph, html: FAKE_HTML, map: null });
  const p = payloadOf(result.html);
  const app = p.components.find((c) => c.id === 'app');
  const lib = p.components.find((c) => c.id === 'lib');
  assert.deepEqual(app.modules.map((m) => m.id), ['src']);           // src/lib is claimed by "lib", so it does not fold into app
  assert.deepEqual(lib.modules.map((m) => m.id), ['src-lib']);
  assert.deepEqual(app.outgoing.map((e) => [e.component, e.weight]), [['lib', 3]]);
  assert.deepEqual(lib.incoming.map((e) => [e.component, e.weight]), [['app', 3]]);
  assert.deepEqual(p.edges, [{ from: 'app', to: 'lib', weight: 3, evidence: [{ file: 'src/index.mjs', line: 2, to: 'src/lib/helper.mjs' }] }]);
  assert.deepEqual(p.unmapped.map((m) => m.id), ['tools']);
  assert.equal(result.mapped, 2);
});

test('overlay: indicators are red for a proven load-time failure, amber for an eager cycle, blue for a lazy-closed or package-level one, green otherwise', () => {
  const facts = { schema_version: 1, repository: graph.repository, files: [{ path: 'src/index.mjs', loc: 1, role: 'source' }, { path: 'src/lib/helper.mjs', loc: 1, role: 'source' }], symbols: [], calls: [], imports: [], unresolved: { external: 0, outside: 0, unknown: 0, opaque: 0 } };
  const base = { id: 'COUP-0001', dimension: 'coupling', confidence: 1, message: 'm', supportedFixes: [] };
  const fileCycle = (kind, severity = kind === 'eager' ? 'warning' : 'info') => ({ ...base, code: 'coupling/import-cycle', severity, subject: { files: ['src/index.mjs', 'src/lib/helper.mjs'] }, evidence: { kind, risk: { loading: severity === 'error' ? 'proven-failure' : kind === 'eager' ? 'order-dependent' : 'none-at-import', coupling: 'present', loadingNote: 'n' }, path: [], imports: [], lazyImports: 0, totalImports: 2, threshold: null } });
  const pkgCycle = { ...base, code: 'coupling/cycle', severity: 'info', subject: { modules: ['src', 'src-lib'] }, evidence: { kind: 'eager', path: [], edges: [], imports: [], totalImports: 2, threshold: null } };
  const status = (findings) => payloadOf(buildOverlay({ ir, graph, html: FAKE_HTML, map: null, facts, findings }).html).components.find((c) => c.id === 'app').indicators;
  assert.equal(status([fileCycle('eager', 'error')]).status, 'red');
  assert.equal(status([fileCycle('eager')]).status, 'amber');
  assert.equal(status([fileCycle('lazy-closed')]).status, 'blue');
  const pkg = status([pkgCycle]);
  assert.equal(pkg.status, 'blue');
  assert.deepEqual(pkg.items[0].detail, ['component:lib']);
  assert.match(pkg.items[0].value, /package-level cycle/);
  const clean = status([]);
  assert.equal(clean.status, 'green');
  assert.equal(clean.items[0].value, 'none');
  assert.equal(payloadOf(buildOverlay({ ir, graph, html: FAKE_HTML, map: null, facts, findings: [fileCycle('eager')] }).html).components.find((c) => c.id === 'lib').findings.length, 1, 'file-level findings attach through file paths');
});

test('overlay: an explicit map wins and an unmapped component is reported, not invented', () => {
  const result = buildOverlay({ ir, graph, html: FAKE_HTML, map: { app: ['src', 'src-lib'], lib: [] } });
  const p = payloadOf(result.html);
  const app = p.components.find((c) => c.id === 'app');
  assert.equal(app.files, 3);
  assert.equal(app.internalImports, 3, 'src → src/lib is now internal to app');
  assert.deepEqual(app.outgoing, []);
  assert.deepEqual(p.components.find((c) => c.id === 'lib').modules, []);
  assert.equal(result.mapped, 1);
});

test('overlay: the delivered HTML is extended, never rewritten, and refuses non-Archify input', () => {
  const result = buildOverlay({ ir, graph, html: FAKE_HTML, map: null });
  assert.ok(result.html.startsWith(FAKE_HTML.slice(0, FAKE_HTML.indexOf('</body>'))), 'original bytes precede the injection');
  assert.ok(result.html.includes('id="btn-bauify"') || result.html.includes("btn.id = 'btn-bauify'"));
  assert.throws(() => buildOverlay({ ir, graph, html: '<html><body>plain</body></html>', map: null }), /not-archify-html|does not look like/);
});

test('overlay: CLI refuses to overwrite the delivered artifact', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bauify-overlay-'));
  const html = path.join(dir, 'repo.html'); fs.writeFileSync(html, FAKE_HTML);
  const irPath = path.join(dir, 'ir.json'); fs.writeFileSync(irPath, JSON.stringify(ir));
  const graphPath = path.join(dir, 'graph.json'); fs.writeFileSync(graphPath, JSON.stringify(graph));
  const same = runCli(['overlay', html, irPath, graphPath, '--out', html, '--json']);
  assert.equal(same.status, 1);
  assert.equal(same.json.diagnostics[0].code, 'cli/out-invalid');
  const ok = runCli(['overlay', html, irPath, graphPath, '--out', path.join(dir, 'repo.analysis.html'), '--json']);
  assert.equal(ok.status, 0, ok.stdout);
  assert.equal(ok.json.mapped, 2);
});

test('overlay: works on a real Archify-delivered artifact', { skip: ARCHIFY_AVAILABLE ? false : 'set BAUIFY_ARCHIFY_ROOT' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bauify-overlay-real-'));
  const run = runCli(['run', path.join(BAUIFY_ROOT, 'test', 'fixtures', 'ts-basic'), '--out', dir, '--json']);
  assert.equal(run.status, 0, run.stdout);
  const deliver = spawnSync(process.execPath, [path.join(ARCHIFY_PACKAGE, 'bin', 'archify.mjs'), 'deliver', 'architecture', path.join(dir, 'repo.architecture.json'), path.join(dir, 'repo.html'), '--quality', 'standard', '--repo-root', ARCHIFY_ROOT, '--json'], { encoding: 'utf8' });
  assert.equal(deliver.status, 0, deliver.stderr);
  const overlay = runCli(['overlay', path.join(dir, 'repo.html'), path.join(dir, 'repo.architecture.json'), path.join(dir, 'module-graph.json'), '--out', path.join(dir, 'repo.analysis.html'), '--json']);
  assert.equal(overlay.status, 0, overlay.stdout);
  assert.equal(overlay.json.mapped, 2);
  const html = fs.readFileSync(path.join(dir, 'repo.analysis.html'), 'utf8');
  assert.ok(html.includes('id="bauify-analysis"'));
  assert.ok(html.includes('data-node-id="src"'), 'authored nodes still present');
});

test('overlay: --source embeds the full text of every file a finding cites, nothing more', () => {
  const finding = { id: 'COUP-0001', code: 'coupling/import-cycle', dimension: 'coupling', severity: 'info', confidence: 1, message: 'm', subject: { files: ['src/index.mjs', 'src/lib/helper.mjs'] },
    evidence: { kind: 'lazy-closed', path: [], imports: [{ file: 'src/index.mjs', line: 2, to: 'src/lib/helper.mjs' }, { file: 'does/not/exist.mjs', line: 1, to: 'x' }], lazyImports: 1, totalImports: 2, threshold: null }, supportedFixes: [] };
  const sourceRoot = path.join(BAUIFY_ROOT, 'test', 'fixtures', 'ts-basic');
  const p = payloadOf(buildOverlay({ ir, graph, html: FAKE_HTML, map: null, findings: [finding], sourceRoot }).html);
  const snip = p.snippets['src/index.mjs'];
  assert.ok(snip, 'the cited file is embedded');
  const text = fs.readFileSync(path.join(sourceRoot, 'src/index.mjs'), 'utf8').split(/\r?\n/);
  if (text[text.length - 1] === '') text.pop();
  assert.deepEqual(snip.lines, text, 'whole file, line by line, without a phantom trailing line');
  assert.equal(snip.total, text.length);
  assert.ok(!('does/not/exist.mjs' in p.snippets), 'missing files are skipped, not fatal');
  assert.deepEqual(Object.keys(p.snippets), ['src/index.mjs'], 'only cited files are embedded');
  assert.deepEqual(payloadOf(buildOverlay({ ir, graph, html: FAKE_HTML, map: null, findings: [finding] }).html).snippets, {}, 'without --source nothing is embedded');
});

test('analyze: one command runs the pipeline, delivers the authored IR through Archify, and overlays', { skip: ARCHIFY_AVAILABLE ? false : 'needs an Archify checkout' }, () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'bauify-analyze-'));
  // A tiny hand-authored diagram for the py-basic fixture. No sources (Archify then insists on a pinned
  // meta.repository); the component-to-module mapping comes from --map instead.
  const ir = path.join(out, 'fixture.architecture.json');
  const map = path.join(out, 'map.json');
  fs.writeFileSync(map, JSON.stringify({ app: ['app'], util: ['app-util'] }));
  fs.writeFileSync(ir, JSON.stringify({
    schema_version: 1, diagram_type: 'architecture', meta: { title: 'py-basic', quality_profile: 'standard' },
    components: [
      { id: 'app', type: 'backend', label: 'App', pos: [40, 40], size: [170, 64] },
      { id: 'util', type: 'backend', label: 'Util', pos: [300, 40], size: [170, 64] },
    ],
    connections: [{ from: 'app', to: 'util', label: 'uses' }],
  }));
  const result = runCli(['analyze', path.join(BAUIFY_ROOT, 'test', 'fixtures', 'py-basic'), '--ir', ir, '--map', map, '--out', out, '--json']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.json.command, 'analyze');
  for (const f of ['raw-facts.json', 'module-graph.json', 'findings.json', 'repo.html', 'repo.analysis.html']) assert.ok(fs.existsSync(path.join(out, f)), f);
  assert.equal(result.json.deliver.validation.compositionStatus, 'pass');
  assert.equal(result.json.overlay.components, 2);
  assert.equal(result.json.overlay.mapped, 2);
  assert.ok(fs.readFileSync(path.join(out, 'repo.analysis.html'), 'utf8').includes('id="bauify-analysis"'));
  const missing = runCli(['analyze', path.join(BAUIFY_ROOT, 'test', 'fixtures', 'py-basic'), '--ir', ir, '--out', out, '--archify', path.join(out, 'nowhere'), '--json']);
  assert.equal(missing.status, 1);
  assert.equal(missing.json.diagnostics[0].code, 'cli/archify-missing');
});
