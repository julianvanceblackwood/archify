import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import fs from 'node:fs';

export const BAUIFY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI = path.join(BAUIFY_ROOT, 'bin', 'analyze.mjs');

// The self-bootstrap tests analyze Archify's renderer package (archify/archify).
// Point BAUIFY_ARCHIFY_ROOT at a checkout of tt-a1i/archify; by default a sibling
// checkout at ../archify is used. Tests that need it skip when it is absent.
export const ARCHIFY_ROOT = process.env.BAUIFY_ARCHIFY_ROOT
  ? path.resolve(process.env.BAUIFY_ARCHIFY_ROOT)
  : path.resolve(BAUIFY_ROOT, '..', '..', '..');
export const ARCHIFY_PACKAGE = path.join(ARCHIFY_ROOT, 'archify');
export const ARCHIFY_AVAILABLE = fs.existsSync(path.join(ARCHIFY_PACKAGE, 'bin', 'archify.mjs'));

export function runCli(args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: BAUIFY_ROOT });
  return { ...result, json: safeJson(result.stdout) };
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}
