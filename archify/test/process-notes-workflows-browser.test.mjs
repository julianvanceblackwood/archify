import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ChromeVisualBrowser, findChrome } from '../bin/visual-check.mjs';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chromeConfigured = Object.prototype.hasOwnProperty.call(process.env, 'ARCHIFY_CHROME');
const chrome = chromeConfigured ? findChrome() : null;
if (chromeConfigured && !chrome) {
  throw new Error(`ARCHIFY_CHROME does not resolve to an executable browser: ${process.env.ARCHIFY_CHROME}`);
}

test('process-note as-is and to-be examples remain readable in the real Viewer', {
  skip: chrome ? false : 'Set ARCHIFY_CHROME to run process-note browser checks.',
}, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-process-notes-browser-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

  const cases = {
    'as-is': 'equipment-loan-as-is.workflow.json',
    'to-be': 'equipment-loan-to-be.workflow.json',
  };
  const files = {};
  for (const [name, input] of Object.entries(cases)) {
    files[name] = path.join(scratch, name + '.html');
    execFileSync(process.execPath, [
      path.join(skillRoot, 'renderers/workflow/render-workflow.mjs'),
      path.join(skillRoot, 'examples', input),
      files[name],
    ]);
  }

  const browser = new ChromeVisualBrowser(chrome);
  t.after(() => browser.close());
  const session = await browser.sessionPromise;
  const send = (method, params = {}) => browser.cdp.send(method, params, session);

  async function run(expression) {
    const result = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
    return result.result?.value;
  }

  async function load(name, theme) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send('Emulation.setEmulatedMedia', {
      media: '',
      features: [
        { name: 'prefers-color-scheme', value: theme },
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ],
    });
    const loaded = browser.cdp.waitFor('Page.loadEventFired', session);
    await send('Page.navigate', { url: pathToFileURL(files[name]).href + '?theme=' + theme });
    await loaded;
    await run('document.fonts.ready');
    await run('Archify.readerLayout.whenStable()');
    await run('Archify.viewerChromeLayout.whenStable()');
  }

  for (const name of Object.keys(cases)) {
    for (const theme of ['dark', 'light']) {
      await load(name, theme);
      const state = await run(`(() => {
        const ids = [
          'submit_request',
          'review_request',
          'check_availability',
          'notify_unavailable',
          'manager_approval',
          'handover',
          'notify_rejected',
          'return_equipment',
          'record_return',
        ];
        const nodes = {};
        for (const id of ids) {
          const group = document.querySelector('[data-node-id="' + id + '"]');
          const box = group && group.querySelector('rect');
          const label = group && group.querySelector('[data-node-label]');
          if (!group || !box || !label) {
            nodes[id] = null;
            continue;
          }
          const b = box.getBoundingClientRect();
          const l = label.getBoundingClientRect();
          nodes[id] = {
            box: [b.left, b.top, b.right, b.bottom],
            label: [l.left, l.top, l.right, l.bottom],
          };
        }
        const unavailable = nodes.notify_unavailable && nodes.notify_unavailable.box;
        const rejected = nodes.notify_rejected && nodes.notify_rejected.box;
        const stackedOverlap = unavailable && rejected
          ? !(unavailable[2] <= rejected[0] || unavailable[0] >= rejected[2] ||
              unavailable[3] <= rejected[1] || unavailable[1] >= rejected[3])
          : null;
        return {
          nodes,
          stackedOverlap,
          horizontalOverflow: document.documentElement.scrollWidth - window.innerWidth,
          readerFit: document.querySelector('.diagram-container > svg')?.getAttribute('data-reader-fit'),
          proposalTag: document.body.textContent.includes('Proposed automation'),
          managerApproval: document.body.textContent.includes('Manager approval'),
        };
      })()`);

      assert.ok(state.managerApproval, name + ' ' + theme + ': manager approval is missing');
      assert.ok(state.horizontalOverflow <= 1, name + ' ' + theme + ': horizontal overflow ' + state.horizontalOverflow);
      assert.equal(state.readerFit, 'intrinsic-height', name + ' ' + theme + ': expected intrinsic-height fit');
      assert.equal(state.stackedOverlap, false, name + ' ' + theme + ': terminal outcomes overlap');
      assert.equal(state.proposalTag, name === 'to-be', name + ' ' + theme + ': proposal marker mismatch');

      for (const [id, node] of Object.entries(state.nodes)) {
        assert.ok(node, name + ' ' + theme + ': missing rendered node ' + id);
        assert.ok(node.label[0] >= node.box[0] - 1, name + ' ' + theme + ': ' + id + ' label starts outside node');
        assert.ok(node.label[2] <= node.box[2] + 1, name + ' ' + theme + ': ' + id + ' label ends outside node');
        assert.ok(node.label[1] >= node.box[1] - 1, name + ' ' + theme + ': ' + id + ' label starts above node');
        assert.ok(node.label[3] <= node.box[3] + 1, name + ' ' + theme + ': ' + id + ' label ends below node');
      }
    }
  }
});
