import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ChromeVisualBrowser, findChrome } from '../bin/visual-check.mjs';

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = process.env.ARCHIFY_CHROME ? findChrome() : null;

test('Monitoring and alert icons remain readable and export-safe', {
  skip: chrome ? false : 'Set ARCHIFY_CHROME to run role-icon browser checks.',
}, async (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'archify-role-icons-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

  const source = path.join(skillRoot, 'examples', 'monitoring-alerts.dataflow.json');
  const output = path.join(scratch, 'monitoring-alerts.html');
  execFileSync(process.execPath, [
    path.join(skillRoot, 'renderers/dataflow/render-dataflow.mjs'),
    source,
    output,
  ]);

  const browser = new ChromeVisualBrowser(chrome);
  t.after(() => browser.close());
  const session = await browser.sessionPromise;
  const send = (method, params = {}) => browser.cdp.send(method, params, session);
  await browser.cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' });

  async function evaluate(expression, awaitPromise = false) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
    assert.equal(result.exceptionDetails, undefined, result.exceptionDetails?.exception?.description);
    return result.result?.value;
  }

  async function load(theme) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await send('Emulation.setEmulatedMedia', {
      features: [
        { name: 'prefers-color-scheme', value: theme },
        { name: 'prefers-reduced-motion', value: 'reduce' },
      ],
    });
    const loaded = browser.cdp.waitFor('Page.loadEventFired', session);
    const result = await send('Page.navigate', { url: pathToFileURL(output).href + '?theme=' + theme });
    assert.equal(result.errorText, undefined);
    await loaded;
    await evaluate(
      '(async () => { await document.fonts.ready; await Archify.readerLayout.whenStable(); await Archify.viewerChromeLayout.whenStable(); })()',
      true,
    );
  }

  for (const theme of ['dark', 'light']) {
    await load(theme);
    const geometry = await evaluate(`(() => {
      function inspect(id, icon) {
        const node = document.querySelector('[data-node-id="' + id + '"]');
        const sigil = node && node.querySelector('[data-semantic-sigil="' + icon + '"]');
        const label = node && node.querySelector('[data-node-label]');
        if (!node || !sigil || !label) return null;
        const nodeRect = node.getBoundingClientRect();
        const iconRect = sigil.getBoundingClientRect();
        const labelRect = label.getBoundingClientRect();
        const shape = sigil.querySelector('path, rect, circle, ellipse');
        const style = shape ? getComputedStyle(shape) : null;
        const overlap = !(
          iconRect.right <= labelRect.left ||
          iconRect.left >= labelRect.right ||
          iconRect.bottom <= labelRect.top ||
          iconRect.top >= labelRect.bottom
        );
        return {
          node: [nodeRect.left, nodeRect.top, nodeRect.right, nodeRect.bottom],
          icon: [iconRect.left, iconRect.top, iconRect.right, iconRect.bottom],
          width: iconRect.width,
          height: iconRect.height,
          overlap,
          stroke: style && style.stroke,
          strokeWidth: style && style.strokeWidth,
        };
      }
      return {
        monitor: inspect('monitor', 'monitor'),
        alert: inspect('alert', 'alert'),
      };
    })()`);

    for (const [role, item] of Object.entries(geometry)) {
      assert.ok(item, theme + ': missing ' + role + ' icon');
      assert.ok(item.width >= 6, theme + ': ' + role + ' icon is too narrow');
      assert.ok(item.height >= 6, theme + ': ' + role + ' icon is too short');
      assert.equal(item.overlap, false, theme + ': ' + role + ' icon overlaps its label');
      assert.ok(item.icon[0] >= item.node[0] && item.icon[1] >= item.node[1], theme + ': icon begins outside node');
      assert.ok(item.icon[2] <= item.node[2] && item.icon[3] <= item.node[3], theme + ': icon extends outside node');
      assert.notEqual(item.stroke, 'none', theme + ': ' + role + ' icon has no visible stroke');
      assert.notEqual(item.stroke, 'rgba(0, 0, 0, 0)', theme + ': ' + role + ' icon stroke is transparent');
      assert.notEqual(item.strokeWidth, '0px', theme + ': ' + role + ' icon stroke width is zero');
    }
  }

  await load('dark');
  const exported = await evaluate(`(async () => {
    const original = URL.createObjectURL;
    const blobs = {};
    URL.createObjectURL = function (value) {
      if (value && value.type) blobs[value.type] = value;
      return original.call(URL, value);
    };
    try {
      await Archify.exportMenu.run('svg');
      await Archify.exportMenu.run('png');
    } finally {
      URL.createObjectURL = original;
    }
    const svgBlob = blobs['image/svg+xml;charset=utf-8'] || blobs['image/svg+xml'];
    const pngBlob = blobs['image/png'];
    if (!svgBlob || !pngBlob) throw new Error('Expected SVG and PNG exports');
    const svgText = await svgBlob.text();
    const bitmap = await createImageBitmap(pngBlob);
    const dimensions = [bitmap.width, bitmap.height];
    bitmap.close();
    return { svgText, pngSize: pngBlob.size, dimensions };
  })()`, true);

  assert.match(exported.svgText, /data-semantic-sigil="monitor"/);
  assert.match(exported.svgText, /data-semantic-sigil="alert"/);
  assert.ok(exported.pngSize > 1000, 'PNG export is unexpectedly empty');
  assert.deepEqual(exported.dimensions, [940 * 4, 520 * 4]);
});
