import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(skillRoot, 'bin/archify.mjs');
const renderer = path.join(skillRoot, 'renderers/lifecycle/render-lifecycle.mjs');
const fixture = path.join(skillRoot, 'test/fixtures/lifecycle-planner/review-hub.lifecycle.json');

function validate(input) {
  const result = spawnSync(process.execPath, [cli, 'validate', 'lifecycle', input, '--quality', 'showcase', '--json'], { encoding: 'utf8' });
  return { status: result.status, receipt: JSON.parse(result.stdout) };
}

// Before the planner, this hub fan-out produced two edge-through-node, four
// micro-segment and several label-clearance diagnostics from a candidate that
// declared no route controls at all; the author had nothing to repair except
// hand-routing every transition.
test('lifecycle: a first draft without route controls validates for showcase', () => {
  const { status, receipt } = validate(fixture);
  assert.equal(status, 0, JSON.stringify(receipt.diagnostics, null, 2));
  assert.equal(receipt.ok, true);
  assert.equal(receipt.composition.summary.errors, 0);
  assert.equal(receipt.composition.metrics.viewportHeightIssues, 0, 'the renderer-sized canvas declares its Reader fit');
});

test('lifecycle: planner routes render as one semantic edge with a crossover mask, presets keep their own path', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-lifecycle-planner-'));
  try {
    const output = path.join(tmp, 'review-hub.html');
    execFileSync(process.execPath, [renderer, fixture, output]);
    const html = fs.readFileSync(output, 'utf8');
    assert.match(html, /<svg viewBox="0 0 980 660" data-reader-fit="intrinsic-height"/);
    const wrappers = html.match(/<g data-graph-role="automatic-crossover"/g) || [];
    assert.equal(wrappers.length, 7, 'every automatic transition is planner routed');
    assert.equal((html.match(/data-composition-crossover="halo"/g) || []).length, 7);
    assert.equal((html.match(/data-edge-from="review"/g) || []).length >= 4, true);

    const authored = JSON.parse(fs.readFileSync(fixture, 'utf8'));
    authored.meta.viewBox = [1100, 660];
    authored.transitions[0].route = 'drop';
    const authoredInput = path.join(tmp, 'authored.lifecycle.json');
    fs.writeFileSync(authoredInput, JSON.stringify(authored));
    const authoredOutput = path.join(tmp, 'authored.html');
    execFileSync(process.execPath, [renderer, authoredInput, authoredOutput]);
    const authoredHtml = fs.readFileSync(authoredOutput, 'utf8');
    assert.doesNotMatch(authoredHtml, /data-reader-fit=/, 'an authored viewBox keeps the authored fit contract');
    assert.equal((authoredHtml.match(/<g data-graph-role="automatic-crossover"/g) || []).length, 6, 'the drop preset is not planner routed');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
