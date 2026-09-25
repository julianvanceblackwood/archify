import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(skillRoot, 'bin', 'archify.mjs');
const fixture = path.join(skillRoot, 'test/fixtures/lifecycle-planner/approval.lifecycle.json');

test('lifecycle vertical overflow guidance does not recommend viewBox growth without browser verification', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-lifecycle-viewport-guidance-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const authored = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  const state = authored.states.find((entry) => entry.id === 'changes_requested');
  assert.ok(state, 'fixture keeps the held-state regression target');
  state.yOffset = 220;

  const input = path.join(directory, 'overflow.lifecycle.json');
  fs.writeFileSync(input, JSON.stringify(authored));

  const result = spawnSync(process.execPath, [
    cli, 'validate', 'lifecycle', input,
    '--quality', 'showcase',
    '--json',
  ], { encoding: 'utf8' });

  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  const receipt = JSON.parse(result.stdout);
  const diagnostics = JSON.stringify(receipt.diagnostics);

  assert.match(diagnostics, /exceeds the vertical lifecycle area/);
  assert.match(diagnostics, /Prefer adjusting yOffset or state placement first/);
  assert.match(diagnostics, /taller authored viewBox can fail showcase desktop containment\/readability/);
  assert.match(diagnostics, /rerun visual-check at the target viewport after any height increase/);
});
