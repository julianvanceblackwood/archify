#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { selectAdapter } from '../extract/index.mjs';
import { DiagnosticError, fail, receipt } from '../extract/shared/diagnostics.mjs';
import { schemaErrors } from '../extract/shared/schema.mjs';
import { buildModuleGraph } from '../graphs/module.mjs';
import { toArchify } from '../bridge/to-archify.mjs';
import { buildOverlay } from '../overlay/inject.mjs';
import { evaluate } from '../evaluate/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USAGE = `Usage:
  archify code-analysis run      <repo-root> --out <dir> [--language ts|py] [--config file.json] [--json]
  archify code-analysis extract  <repo-root> [--out raw-facts.json] [--language ts|py] [--config file.json] [--json]
  archify code-analysis graphs   raw-facts.json [--out module-graph.json] [--config file.json] [--json]
  archify code-analysis evaluate module-graph.json [--facts raw-facts.json] [--out findings.json] [--config file.json] [--json]
  archify code-analysis bridge   module-graph.json [--out repo.architecture.json] [--config file.json] [--json]
  archify code-analysis overlay  <archify.html> <ir.json> <module-graph.json> --out <analysis.html>
                  [--map overlay-map.json] [--source <analyzed dir>] [--facts raw-facts.json] [--findings findings.json] [--json]
  archify code-analysis analyze  <repo-root> --ir <architecture.json> --out <dir>
                  [--map overlay-map.json] [--language ts|py] [--archify <archify checkout>] [--quality standard|showcase] [--config file.json] [--json]

run     = extract -> graphs -> evaluate -> bridge into one directory.
analyze = run, then "archify deliver" on the hand-authored IR, then overlay: one command from repository to repo.analysis.html.
          Archify is found at --archify, $BAUIFY_ARCHIFY_ROOT, or the containing Archify repository.
overlay never modifies the delivered HTML; it writes a new file next to it.`;

function loadConfig(explicit) {
  const defaults = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'config', 'defaults.json'), 'utf8'));
  if (!explicit) return defaults;
  if (!fs.existsSync(explicit)) fail('cli/config-missing', `Config file not found: ${explicit}`, {
    subject: { option: '--config' }, evidence: { path: explicit }, supportedFixes: ['pass an existing JSON file'],
  });
  return { ...defaults, ...JSON.parse(fs.readFileSync(explicit, 'utf8')) };
}

function parse(argv) {
  const [command, ...rest] = argv;
  const opts = { json: false, positional: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--out' || arg === '--config' || arg === '--language' || arg === '--map' || arg === '--facts' || arg === '--findings' || arg === '--source' || arg === '--ir' || arg === '--archify' || arg === '--quality') {
      const value = rest[i + 1];
      if (!value || value.startsWith('--')) fail('cli/option-value-missing', `${arg} requires a value.`, {
        subject: { option: arg }, supportedFixes: [`provide one value after ${arg}`],
      });
      opts[arg.slice(2)] = value; i += 1;
    } else if (arg.startsWith('--')) fail('cli/option-unknown', `Unknown option ${arg}.`, {
      subject: { option: arg }, supportedFixes: ['see usage'],
    });
    else opts.positional.push(arg);
  }
  return { command, opts };
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function readJsonInput(file, what) {
  if (!file) fail('cli/input-missing', `${what} requires an input file argument.`, { supportedFixes: ['pass the JSON file path'] });
  if (!fs.existsSync(file)) fail('cli/input-invalid', `Not a file: ${file}`, { subject: { file }, supportedFixes: ['pass an existing JSON file'] });
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    fail('cli/input-not-json', `${file} is not valid JSON.`, { subject: { file }, evidence: { reason: error.message }, supportedFixes: ['regenerate the input with the previous step'] });
  }
}

function emit(value, opts) {
  const text = stableJson(value);
  if (opts.out) { fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true }); fs.writeFileSync(opts.out, text); }
  else if (!opts.json) process.stdout.write(text);
}

function runGraphs(opts) {
  const facts = readJsonInput(opts.positional[0], 'graphs');
  const factErrors = schemaErrors('raw-facts', facts);
  if (factErrors.length) fail('graphs/input-schema-invalid', 'Input does not conform to raw-facts.schema.json.', {
    subject: { file: opts.positional[0] }, evidence: { errors: factErrors.slice(0, 20) }, supportedFixes: ['regenerate it with `bauify extract`'],
  });
  const graph = buildModuleGraph(facts, loadConfig(opts.config));
  const errors = schemaErrors('module-graph', graph);
  if (errors.length) fail('graphs/schema-invalid', 'Module graph violates module-graph.schema.json.', {
    subject: {}, evidence: { errors: errors.slice(0, 20) }, supportedFixes: ['this is an analyzer bug; report it with the evidence'],
  });
  emit(graph, opts);
  return receipt('ok', {
    command: 'graphs', out: opts.out ? path.resolve(opts.out) : null,
    modules: graph.modules.length, edges: graph.edges.length, excludedFiles: graph.excluded.files, grouping: graph.grouping,
  });
}

function bridgeFromGraph(graph, config, opts) {
  const errors = schemaErrors('module-graph', graph);
  if (errors.length) fail('bridge/input-schema-invalid', 'Input does not conform to module-graph.schema.json.', {
    subject: {}, evidence: { errors: errors.slice(0, 20) }, supportedFixes: ['regenerate it with `bauify graphs`'],
  });
  const result = toArchify(graph, config);
  emit(result.ir, opts);
  return receipt('ok', {
    command: 'bridge', out: opts.out ? path.resolve(opts.out) : null,
    components: result.ir.components.length, connections: result.ir.connections.length,
    evidence: result.evidence, folded: result.folded, layers: result.layers, cols: result.cols,
  });
}

function evaluateGraph(graph, config, facts = null) {
  const findings = evaluate(graph, config, facts);
  const errors = schemaErrors('findings', findings);
  if (errors.length) fail('evaluate/schema-invalid', 'Findings violate findings.schema.json.', { evidence: { errors: errors.slice(0, 20) }, supportedFixes: ['this is an analyzer bug; report it with the evidence'] });
  return findings;
}

function validateFacts(graph, facts) {
  if (!facts) return;
  const errors = schemaErrors('raw-facts', facts);
  if (errors.length) fail('input/facts-incompatible', 'Raw facts violate the schema or reference invariants.', { evidence: { errors: errors.slice(0, 20) }, supportedFixes: ['regenerate raw-facts and module-graph together'] });
  for (const key of ['root', 'revision', 'language']) {
    if (graph.repository[key] !== undefined && graph.repository[key] !== facts.repository?.[key]) errors.push({ path: `/repository/${key}`, message: 'must match module-graph input' });
  }
  if (graph.fileModules && Array.isArray(facts.files)) {
    const roles = new Set(graph.excluded.roles);
    const files = new Set(facts.files.filter((f) => !roles.has(f.role)).map((f) => f.path));
    const ownership = Object.keys(graph.fileModules);
    // Reconcile dependency aggregates using the supplied, validated ownership map.
    // Evidence samples and ordering are deliberately not part of this comparison.
    const aggregates = new Map();
    for (const imp of facts.imports) {
      if (!imp.resolved) continue;
      const from = graph.fileModules[imp.from], to = graph.fileModules[imp.to];
      if (from === undefined || to === undefined || from === to) continue;
      const key = JSON.stringify([from, to]);
      if (!aggregates.has(key)) aggregates.set(key, { weight: 0, kinds: { eager: 0 } });
      const aggregate = aggregates.get(key);
      aggregate.weight += 1;
      for (const kind of [imp.kind, ...['lazy', 'conditional', 'typeOnly', 'implicit'].filter((flag) => imp[flag])]) {
        aggregate.kinds[kind] = (aggregate.kinds[kind] || 0) + 1;
      }
      if (!imp.lazy && !imp.conditional && !imp.typeOnly && !(facts.repository.language === 'ts' && imp.kind === 'dynamic')) aggregate.kinds.eager += 1;
    }
    const mismatch = graph.edges.length !== aggregates.size || graph.edges.some((edge) => {
      const expected = aggregates.get(JSON.stringify([edge.from, edge.to]));
      if (!expected || expected.weight !== edge.weight) return true;
      // Legacy graphs may omit eager; compare every other count and explicit eager counts.
      const keys = new Set([...Object.keys(expected.kinds), ...Object.keys(edge.kinds)]);
      return [...keys].some((key) => !(key === 'eager' && edge.kinds.eager === undefined)
        && (expected.kinds[key] || 0) !== (edge.kinds[key] || 0));
    });
    if (mismatch) errors.push({ path: '/edges', message: 'must match aggregated raw-facts imports' });
    if (ownership.length !== files.size || ownership.some((f) => !files.has(f))) errors.push({ path: '/files', message: 'must match module-graph file ownership' });
  }
  if (errors.length) fail('input/facts-incompatible', 'Raw facts are invalid or do not match the module graph.', { evidence: { errors: errors.slice(0, 20) }, supportedFixes: ['regenerate raw-facts and module-graph together'] });
}

function runEvaluate(opts) {
  const graph = readJsonInput(opts.positional[0], 'evaluate');
  const graphErrors = schemaErrors('module-graph', graph);
  if (graphErrors.length) fail('evaluate/input-schema-invalid', 'Input does not conform to module-graph.schema.json.', { evidence: { errors: graphErrors.slice(0, 20) }, supportedFixes: ['regenerate it with `bauify graphs`'] });
  const factsPath = opts.facts || path.join(path.dirname(path.resolve(opts.positional[0])), 'raw-facts.json');
  const facts = fs.existsSync(factsPath) ? readJsonInput(factsPath, 'evaluate --facts') : null;
  validateFacts(graph, facts);
  const findings = evaluateGraph(graph, loadConfig(opts.config), facts);
  emit(findings, opts);
  return receipt('ok', { command: 'evaluate', out: opts.out ? path.resolve(opts.out) : null, rules: findings.rules, fileFacts: Boolean(facts), summary: findings.summary });
}

function runBridge(opts) {
  return bridgeFromGraph(readJsonInput(opts.positional[0], 'bridge'), loadConfig(opts.config), opts);
}

function runPipeline(opts) {
  if (!opts.out) fail('cli/out-missing', 'run requires --out <directory>.', { supportedFixes: ['pass --out out/'] });
  const dir = path.resolve(opts.out);
  fs.mkdirSync(dir, { recursive: true });
  const config = loadConfig(opts.config);
  const extract = runExtract({ ...opts, out: path.join(dir, 'raw-facts.json'), json: true });
  const facts = JSON.parse(fs.readFileSync(extract.out, 'utf8'));
  const graph = buildModuleGraph(facts, config);
  const graphErrors = schemaErrors('module-graph', graph);
  if (graphErrors.length) fail('graphs/schema-invalid', 'Module graph violates module-graph.schema.json.', { evidence: { errors: graphErrors.slice(0, 20) }, supportedFixes: ['report it with the evidence'] });
  fs.writeFileSync(path.join(dir, 'module-graph.json'), stableJson(graph));
  const findings = evaluateGraph(graph, config, facts);
  fs.writeFileSync(path.join(dir, 'findings.json'), stableJson(findings));
  const bridge = bridgeFromGraph(graph, config, { ...opts, out: path.join(dir, 'repo.architecture.json'), json: true });
  return receipt('ok', {
    command: 'run', out: dir,
    extract: { adapter: extract.adapter, files: extract.files, imports: extract.imports, resolved: extract.resolved, unresolved: extract.unresolved, revision: extract.revision },
    graphs: { modules: graph.modules.length, edges: graph.edges.length, excludedFiles: graph.excluded.files },
    evaluate: findings.summary,
    bridge: { components: bridge.components, connections: bridge.connections, evidence: bridge.evidence, folded: bridge.folded, layers: bridge.layers },
    next: `node <archify>/bin/archify.mjs deliver architecture ${path.join(dir, 'repo.architecture.json')} ${path.join(dir, 'repo.html')} --quality showcase${bridge.evidence ? ' --repo-root <git-root>' : ''} --json`,
  });
}

function runOverlay(opts) {
  const [htmlPath, irPath, graphPath] = opts.positional;
  if (!htmlPath || !irPath || !graphPath) fail('cli/input-missing', 'overlay requires <archify.html> <ir.json> <module-graph.json>.', { supportedFixes: ['pass the three files in that order'] });
  if (!opts.out) fail('cli/out-missing', 'overlay requires --out <analysis.html>; the delivered artifact is never modified in place.', { supportedFixes: ['pass --out out/repo.analysis.html'] });
  if (path.resolve(opts.out) === path.resolve(htmlPath)) fail('cli/out-invalid', '--out must differ from the delivered HTML.', { supportedFixes: ['write to a new file such as repo.analysis.html'] });
  if (!fs.existsSync(htmlPath)) fail('cli/input-invalid', `Not a file: ${htmlPath}`, { subject: { file: htmlPath }, supportedFixes: ['run `archify deliver` first'] });
  const ir = readJsonInput(irPath, 'overlay');
  const graph = readJsonInput(graphPath, 'overlay');
  const graphErrors = schemaErrors('module-graph', graph);
  if (graphErrors.length) fail('overlay/input-schema-invalid', 'module-graph input does not conform to its schema.', { evidence: { errors: graphErrors.slice(0, 20) }, supportedFixes: ['regenerate it with `bauify graphs`'] });
  const map = opts.map ? readJsonInput(opts.map, 'overlay --map') : null;
  // raw-facts.json next to module-graph.json is picked up automatically for per-file detail.
  const factsPath = opts.facts || path.join(path.dirname(path.resolve(graphPath)), 'raw-facts.json');
  const facts = fs.existsSync(factsPath) ? readJsonInput(factsPath, 'overlay --facts') : null;
  validateFacts(graph, facts);
  const findingsPath = opts.findings || path.join(path.dirname(path.resolve(graphPath)), 'findings.json');
  const findingsDoc = fs.existsSync(findingsPath) ? readJsonInput(findingsPath, 'overlay --findings') : null;
  const findings = findingsDoc ? (Array.isArray(findingsDoc) ? findingsDoc : findingsDoc.diagnostics || []) : [];
  // --source <analyzed dir>: embed the lines each finding points at so the page can show the code itself.
  const sourceRoot = opts.source ? path.resolve(opts.source) : null;
  if (sourceRoot && !fs.existsSync(sourceRoot)) fail('cli/input-invalid', `Not a directory: ${opts.source}`, { subject: { dir: opts.source }, supportedFixes: ['pass the directory that was analyzed'] });
  const result = buildOverlay({ ir, graph, html: fs.readFileSync(htmlPath, 'utf8'), map, facts, findings, sourceRoot });
  fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
  fs.writeFileSync(opts.out, result.html);
  return receipt('ok', { command: 'overlay', out: path.resolve(opts.out), components: result.components, mapped: result.mapped, edges: result.edges, unmappedModules: result.unmapped, fileFacts: Boolean(facts), findings: findings.length, snippets: result.snippets });
}

function runExtract(opts) {
  const root = opts.positional[0];
  if (!root) fail('cli/root-missing', 'extract requires a <repo-root> argument.', { supportedFixes: ['pass a directory path'] });
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) fail('cli/root-invalid', `Not a directory: ${root}`, {
    subject: { root }, supportedFixes: ['pass an existing directory'],
  });
  const config = loadConfig(opts.config);
  const adapter = selectAdapter(root, config, opts.language);
  const facts = adapter.extract(root, config);
  const errors = schemaErrors('raw-facts', facts);
  if (errors.length) fail('extract/schema-invalid', 'Extractor output violates raw-facts.schema.json.', {
    subject: { adapter: adapter.id }, evidence: { errors: errors.slice(0, 20) }, supportedFixes: ['this is an analyzer bug; report it with the evidence'],
  });
  emit(facts, opts);
  return receipt('ok', {
    command: 'extract',
    adapter: adapter.id,
    out: opts.out ? path.resolve(opts.out) : null,
    files: facts.files.length,
    imports: facts.imports.length,
    resolved: facts.imports.filter((i) => i.resolved).length,
    unresolved: facts.unresolved,
    revision: facts.repository.revision,
  });
}

// analyze: the three-step workflow in one command. Archify stays a separate
// install; it is invoked through its CLI exactly as a person would, and its
// receipt is passed through on failure.
function findArchify(explicit) {
  // An explicit --archify is taken at its word; the fallbacks only apply when none was given.
  const candidates = (explicit ? [explicit] : [process.env.BAUIFY_ARCHIFY_ROOT, path.resolve(HERE, '..', '..', '..', '..')]).filter(Boolean).map((p) => path.resolve(p));
  for (const root of candidates) {
    for (const pkg of [root, path.join(root, 'archify')]) {
      const bin = path.join(pkg, 'bin', 'archify.mjs');
      if (fs.existsSync(bin)) return { root, bin };
    }
  }
  fail('cli/archify-missing', 'No Archify checkout found.', {
    evidence: { tried: candidates },
    supportedFixes: ['pass --archify <path to a tt-a1i/archify checkout>', 'set BAUIFY_ARCHIFY_ROOT', 'clone tt-a1i/archify next to this repository'],
  });
}

function runAnalyze(opts) {
  const repo = opts.positional[0];
  if (!repo) fail('cli/input-missing', 'analyze requires <repo-root>.', { supportedFixes: ['pass the directory to analyze'] });
  if (!opts.ir) fail('cli/input-missing', 'analyze requires --ir <architecture.json> (the hand-authored Archify diagram).', { supportedFixes: ['pass --ir examples/<repo>.manual.architecture.json'] });
  if (!opts.out) fail('cli/out-missing', 'analyze requires --out <directory>.', { supportedFixes: ['pass --out out/<repo>'] });
  if (!fs.existsSync(opts.ir)) fail('cli/input-invalid', `Not a file: ${opts.ir}`, { subject: { file: opts.ir }, supportedFixes: ['pass an existing architecture IR'] });
  const archify = findArchify(opts.archify);
  const dir = path.resolve(opts.out);
  const repoRoot = path.resolve(repo);

  const run = runPipeline({ ...opts, out: dir, json: true });

  // Evidence verification only when the IR pins a repository; Archify then wants the Git top level as --repo-root.
  const irDoc = readJsonInput(opts.ir, 'analyze --ir');
  const top = irDoc.meta && irDoc.meta.repository ? spawnSync('git', ['-C', repoRoot, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }) : null;
  const gitTop = top && top.status === 0 ? path.resolve(top.stdout.trim()) : null;
  const delivered = path.join(dir, 'repo.html');
  const args = [archify.bin, 'deliver', 'architecture', path.resolve(opts.ir), delivered, '--quality', opts.quality || 'standard', ...(gitTop ? ['--repo-root', gitTop] : []), '--json'];
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: path.dirname(archify.bin) });
  let deliverReceipt = null;
  try { deliverReceipt = JSON.parse(result.stdout); } catch { /* not JSON: reported below */ }
  if (result.status !== 0 || !deliverReceipt || deliverReceipt.ok === false) {
    fail('analyze/archify-deliver-failed', 'Archify refused the hand-authored diagram; fix the IR and rerun.', {
      subject: { ir: path.resolve(opts.ir) },
      evidence: { command: ['node', ...args].join(' '), exit: result.status, archify: deliverReceipt || (result.stderr || result.stdout || '').slice(0, 2000) },
      supportedFixes: ['read the diagnostics under evidence.archify and change only what they point at', 'run the deliver command by hand to iterate'],
    });
  }

  const overlay = runOverlay({
    ...opts, json: true,
    positional: [delivered, path.resolve(opts.ir), path.join(dir, 'module-graph.json')],
    out: path.join(dir, 'repo.analysis.html'),
    source: opts.source || repoRoot,
  });
  return receipt('ok', {
    command: 'analyze', out: dir,
    run: { extract: run.extract, graphs: run.graphs, evaluate: run.evaluate },
    deliver: { html: delivered, quality: opts.quality || 'standard', validation: deliverReceipt.validation || null, evidence: deliverReceipt.evidence || null, artifact: deliverReceipt.artifact || null },
    overlay: { html: overlay.out, components: overlay.components, mapped: overlay.mapped, findings: overlay.findings, snippets: overlay.snippets },
    open: overlay.out,
  });
}

function main() {
  const { command, opts } = parse(process.argv.slice(2));
  if (!command || command === '--help' || command === '-h') { process.stdout.write(`${USAGE}\n`); return; }
  const COMMANDS = { extract: runExtract, graphs: runGraphs, evaluate: runEvaluate, bridge: runBridge, run: runPipeline, overlay: runOverlay, analyze: runAnalyze };
  if (!COMMANDS[command]) fail('cli/command-unknown', `Unknown command "${command}".`, {
    subject: { command }, evidence: { supported: Object.keys(COMMANDS) }, supportedFixes: ['see usage'],
  });
  const result = COMMANDS[command](opts);
  if (opts.json) process.stdout.write(stableJson(result));
  else if (opts.out) process.stderr.write(`${command} ok → ${result.out}\n`);
}

try {
  main();
} catch (error) {
  const diagnostics = error instanceof DiagnosticError
    ? error.diagnostics
    : [{ code: 'internal/unclassified', severity: 'error', message: error.message, subject: {}, evidence: {}, supportedFixes: [] }];
  const wantsJson = process.argv.includes('--json');
  if (wantsJson) process.stdout.write(stableJson(receipt('failed', { diagnostics })));
  else for (const d of diagnostics) process.stderr.write(`${d.code}: ${d.message}\n${d.supportedFixes.length ? `  fixes: ${d.supportedFixes.join('; ')}\n` : ''}`);
  process.exitCode = 1;
}
