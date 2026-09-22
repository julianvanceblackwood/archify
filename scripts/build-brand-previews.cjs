#!/usr/bin/env node
// Maintainer-only asset builder: requires sharp (not a Skill runtime dependency).
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const assets = path.resolve(__dirname, '../docs/assets');

async function build() {
  // Use the exact README paths, never a generated approximation of the logo.
  const logo = await sharp(path.join(assets, 'archify-lockup-light.svg'))
    .resize({ width: 420 }).png().toBuffer();
  const diagram = await sharp(path.join(assets, 'archify-architecture.png'))
    .resize({ width: 820 }).png().toBuffer();
  const backdrop = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="810">
    <rect width="1440" height="810" fill="#f8fafc"/>
    <path d="M570 0V810" stroke="#e2e8f0"/>
    <g font-family="Arial, sans-serif" fill="#111827">
      <text x="60" y="335" font-size="40" font-weight="700">Interactive visuals.</text>
      <text x="60" y="390" font-size="40" font-weight="700">Made with Archify.</text>
      <text x="60" y="465" font-size="23" fill="#475569">Explore. Customize. Share.</text>
    </g>
  </svg>`);
  const hero = await sharp(backdrop).composite([
    { input: logo, left: 60, top: 140 },
    { input: diagram, left: 600, top: 175 },
  ]).png().toBuffer();
  fs.writeFileSync(path.join(assets, 'archify-readme-hero.png'), hero);
  await sharp(hero).resize(1200, 630, { fit: 'contain', background: '#f8fafc' })
    .png().toFile(path.join(assets, 'archify-social-preview.png'));
}
build().catch(error => { console.error(error); process.exitCode = 1; });
