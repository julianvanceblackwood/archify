import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin/archify.mjs');
const moduleRoot = path.join(root, 'modules/code-analysis');
const run = args => spawnSync(process.execPath, [cli, 'code-analysis', ...args], { encoding: 'utf8' });
test('Code Analysis is discoverable and extracts through the Archify CLI', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /archify code-analysis/);
  const extracted = run(['extract', path.join(moduleRoot, 'test/fixtures/ts-basic'), '--language', 'ts']);
  assert.equal(extracted.status, 0, extracted.stderr);
  assert.ok(JSON.parse(extracted.stdout).imports.length > 0);
  const invalid = run(['extract', '--json']);
  assert.notEqual(invalid.status, 0);
  assert.ok(JSON.parse(invalid.stdout).diagnostics.length > 0);
});
test('Code Analysis regression suite', () => {
  const tests = fs.readdirSync(path.join(moduleRoot, 'test')).filter(f => f.endsWith('.test.mjs')).sort().map(f => path.join(moduleRoot, 'test', f));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', ...tests], { env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
});
