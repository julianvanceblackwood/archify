import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.join(here, '..');
const repoRoot = path.join(skillRoot, '..');
const examples = path.join(skillRoot, 'examples');

const notes = fs.readFileSync(path.join(examples, 'equipment-loan-process-notes.md'), 'utf8');
const worked = fs.readFileSync(path.join(examples, 'equipment-loan-process-worked-example.md'), 'utf8');
const guidance = fs.readFileSync(path.join(skillRoot, 'references', 'process-notes-workflows.md'), 'utf8');
const skill = fs.readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8');
const defaults = fs.readFileSync(path.join(skillRoot, 'references', 'authoring-defaults.md'), 'utf8');
const asIsPath = path.join(examples, 'equipment-loan-as-is.workflow.json');
const toBePath = path.join(examples, 'equipment-loan-to-be.workflow.json');
const asIs = JSON.parse(fs.readFileSync(asIsPath, 'utf8'));
const toBe = JSON.parse(fs.readFileSync(toBePath, 'utf8'));

function byId(items) {
  return new Map(items.map((item) => [item.id, item]));
}

test('process-note guidance keeps facts, proposals, assumptions, and questions separate', () => {
  for (const phrase of ['Documented fact', 'Assumption', 'Proposed improvement', 'Open question']) {
    assert.match(guidance, new RegExp(phrase, 'i'));
  }
  assert.match(guidance, /never render a proposal as current-state fact/i);
  assert.match(guidance, /reuse the same node ids and reader-facing labels/i);
  assert.match(guidance, /Preserve human approval/i);
  assert.match(guidance, /Do not invent integrations, APIs, databases, automation/i);
  assert.match(skill, /Process-note workflows/);
  assert.match(defaults, /documented facts, assumptions, proposed improvements, and unresolved questions/i);
});

test('fictional source states the bounded current process and the only proposed automation', () => {
  assert.match(notes, /synthetic/i);
  assert.match(notes, /Service Desk checks the equipment register/i);
  assert.match(notes, /manager decides whether to approve the loan/i);
  assert.match(notes, /Automate only the availability lookup/i);
  assert.match(notes, /Manager approval remains a human decision/i);
  assert.match(notes, /must not invent an API, vendor product, database engine/i);
  assert.match(worked, /No additional assumption is required/i);
});

test('as-is and to-be workflows preserve stable comparison identity', () => {
  assert.equal(asIs.schema_version, 2);
  assert.equal(toBe.schema_version, 2);
  assert.equal(asIs.diagram_type, 'workflow');
  assert.equal(toBe.diagram_type, 'workflow');

  const asNodes = byId(asIs.nodes);
  const toNodes = byId(toBe.nodes);
  assert.deepEqual([...asNodes.keys()].sort(), [...toNodes.keys()].sort());

  for (const id of asNodes.keys()) {
    assert.equal(toNodes.get(id).label, asNodes.get(id).label, id + ': label changed across the pair');
  }

  assert.deepEqual(toBe.edges, asIs.edges, 'proposal must not invent or remove process relationships');

  const asCheck = asNodes.get('check_availability');
  const toCheck = toNodes.get('check_availability');
  assert.equal(asCheck.lane, 'service_desk');
  assert.equal(asCheck.icon, 'briefcase');
  assert.equal(toCheck.lane, 'automation');
  assert.equal(toCheck.icon, 'database');
  assert.equal(toCheck.tag, 'Proposed automation');

  const asApproval = asNodes.get('manager_approval');
  const toApproval = toNodes.get('manager_approval');
  assert.deepEqual(
    { lane: toApproval.lane, type: toApproval.type, icon: toApproval.icon, label: toApproval.label },
    { lane: asApproval.lane, type: asApproval.type, icon: asApproval.icon, label: asApproval.label },
    'manager approval must remain a human decision'
  );

  for (const id of asNodes.keys()) {
    if (id === 'check_availability') continue;
    assert.deepEqual(toNodes.get(id), asNodes.get(id), id + ': unchanged step drifted');
  }

  assert.deepEqual(
    asIs.semanticChecks.allowedTerminals,
    ['notify_unavailable', 'notify_rejected', 'record_return']
  );
  assert.deepEqual(toBe.semanticChecks.allowedTerminals, asIs.semanticChecks.allowedTerminals);
});

test('open questions remain unanswered in both artifacts', () => {
  const currentQuestions = asIs.cards.find((card) => card.title === 'Open questions')?.items;
  const proposedQuestions = toBe.cards.find((card) => card.title === 'Open questions')?.items;
  assert.ok(currentQuestions);
  assert.deepEqual(proposedQuestions, currentQuestions);
  assert.equal(currentQuestions.length, 3);
  assert.match(currentQuestions.join(' '), /loan duration/i);
  assert.match(currentQuestions.join(' '), /Overdue and damaged-equipment/i);
  assert.match(currentQuestions.join(' '), /Approver variation/i);
});

test('both fictional workflows validate and render through public entrypoints', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-process-notes-'));
  try {
    for (const [name, input] of [['as-is', asIsPath], ['to-be', toBePath]]) {
      const validated = spawnSync(process.execPath, [
        path.join(skillRoot, 'bin', 'archify.mjs'),
        'validate',
        'workflow',
        input,
        '--quality',
        'showcase',
        '--json',
      ], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      assert.equal(validated.status, 0, name + ' validate failed: ' + (validated.stderr || validated.stdout));

      const output = path.join(dir, name + '.html');
      const rendered = spawnSync(process.execPath, [
        path.join(skillRoot, 'renderers', 'workflow', 'render-workflow.mjs'),
        input,
        output,
      ], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      assert.equal(rendered.status, 0, name + ' render failed: ' + rendered.stderr);
      const html = fs.readFileSync(output, 'utf8');
      assert.match(html, /data-node-id="check_availability"/);
      assert.match(html, /Manager approval/);
      assert.match(html, /Open questions/);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
