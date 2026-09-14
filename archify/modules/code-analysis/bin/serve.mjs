import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
const execute = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const archify = path.resolve(here, '../../../bin/archify.mjs');

export async function startAnalysisView(argv) {
  const [repo, ...rest] = argv;
  if (!repo || repo.startsWith('-')) throw Error('serve requires <repo-root> --ir <architecture.json> --out <directory>');
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    if (!['--ir', '--out', '--language', '--config', '--map', '--quality'].includes(key) || !rest[i + 1] || rest[i + 1].startsWith('--')) throw Error(`Invalid option: ${key}`);
    options[key] = rest[i + 1];
  }
  if (!options['--ir'] || !options['--out']) throw Error('serve requires --ir and --out');
  const root = path.resolve(repo), ir = path.resolve(options['--ir']), out = path.resolve(options['--out']);
  fs.mkdirSync(out, { recursive: true });
  const initial = path.join(out, 'architecture.html');
  const doc = JSON.parse(fs.readFileSync(ir, 'utf8'));
  let evidenceArgs = [];
  if (doc.meta?.repository) {
    const top = await execute('git', ['-C', root, 'rev-parse', '--show-toplevel']);
    evidenceArgs = ['--repo-root', top.stdout.trim()];
  }
  await execute(process.execPath, [archify, 'deliver', 'architecture', ir, initial, '--quality', options['--quality'] || 'standard', ...evidenceArgs, '--json']);
  const token = randomBytes(24).toString('hex');
  const script = `(${client.toString()})(${JSON.stringify(token)})`;
  const html = fs.readFileSync(initial, 'utf8').replace('</body>', `<script>${script}</script></body>`);
  let pending, result, origin;
  const server = http.createServer(async (req, res) => {
    const send = (status, body, type = 'application/json') => { res.writeHead(status, {'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'}); res.end(body); };
    if (req.headers.host !== new URL(origin).host) return send(403, '{}');
    if (req.method === 'GET' && req.url === '/') return send(200, html, 'text/html; charset=utf-8');
    if (req.method !== 'POST' || req.url !== '/analyze') return send(404, '{}');
    if (req.headers.origin !== origin || req.headers['x-analysis-token'] !== token) return send(403, '{}');
    try {
      if (!pending && !result) {
        const args = ['analyze', root, '--ir', ir, '--out', path.join(out, 'analysis'), '--json'];
        for (const key of ['--language', '--config', '--map', '--quality']) if (options[key]) args.push(key, options[key]);
        pending = execute(process.execPath, [path.join(here, 'analyze.mjs'), ...args], { maxBuffer: 16 * 1024 * 1024 }).then(({stdout}) => {
          const receipt = JSON.parse(stdout);
          result = fs.readFileSync(receipt.overlay.html, 'utf8');
          return result;
        }).finally(() => { pending = null; });
      }
      send(200, result || await pending, 'text/html; charset=utf-8');
    } catch (error) {
      let message = error.message;
      try { message = JSON.parse(error.stdout).diagnostics.map(d => d.message).join('\n'); } catch {}
      send(500, JSON.stringify({ error: message }));
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { server, url: origin, token };
}

function client(token) {
  const toolbar = document.querySelector('.toolbar');
  if (!toolbar) return;
  const start = document.createElement('button');
  start.id = 'code-analysis-start'; start.type = 'button'; start.textContent = 'Code Analysis';
  toolbar.append(start);
  const toggle = document.createElement('button');
  toggle.id = 'analysis-view-toggle'; toggle.type = 'button'; toggle.textContent = '分析图切换';
  toggle.disabled = true; toggle.setAttribute('aria-pressed', 'false');
  toggle.style.cssText = 'position:fixed;right:20px;top:90px;z-index:70;padding:10px 14px;border-radius:8px;background:var(--panel,#0f172a);color:var(--text,#fff);border:1px solid var(--panel-border,#64748b);cursor:pointer';
  document.body.append(toggle);
  const status = document.createElement('div');
  status.setAttribute('role', 'status'); status.style.cssText = 'position:fixed;right:20px;top:140px;z-index:70;max-width:320px;background:var(--panel,#0f172a);color:var(--text,#fff);padding:8px;border-radius:6px';
  status.textContent = '点击 Code Analysis 开始分析'; document.body.append(status);
  start.onclick = async () => {
    start.disabled = true; start.textContent = '分析中…'; status.textContent = '正在分析代码，请稍候…';
    try {
      const response = await fetch('/analyze', {method:'POST', headers:{'X-Analysis-Token':token}});
      if (!response.ok) throw Error((await response.json()).error || '分析失败');
      const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
      for (const id of ['bauify-analysis', 'bauify-style', 'bauify-script']) {
        const original = parsed.getElementById(id);
        if (!original) throw Error('分析结果不完整');
      }
      for (const id of ['bauify-analysis', 'bauify-style', 'bauify-script']) {
        const original = parsed.getElementById(id), element = document.createElement(original.tagName);
        element.id = id; if (id === 'bauify-analysis') element.type = 'application/json';
        element.textContent = original.textContent; document.body.append(element);
      }
      start.textContent = 'Code Analysis ✓'; toggle.disabled = false;
      status.textContent = '分析完成，点击“分析图切换”查看结果';
    } catch (error) { start.disabled = false; start.textContent = 'Code Analysis'; status.textContent = '分析失败：' + error.message + '。点击重试。'; }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startAnalysisView(process.argv.slice(2)).then(({url}) => console.log(`Code Analysis: ${url}\nPress Ctrl+C to stop.`)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
