// Generate the PWA app icons FROM the real procedural mech art (no hand-drawn emblem).
//
// A PWA needs actual icon files, so this is the deliberate exception to the game's
// zero-asset ethos — but the pixels still come from the shipping art pipeline. We spin
// up a programmatic Vite dev server (so scripts/icon-render.html can ESM-import
// src/art/* and Phaser), open it headless with Playwright, and let the page composite
// the default player mech onto the dark UI background. We snapshot three PNGs:
//   icon-192.png, icon-512.png (standard, any) and icon-maskable-512.png (extra safe-
//   zone padding so the round maskable crop never clips the mech).
//
// Run: npm run icons   (commits the PNGs under public/icons/)

import { createServer } from 'vite';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const outDir = resolve(root, 'public/icons');

const TARGETS = [
  { file: 'icon-192.png', size: 192, maskable: false },
  { file: 'icon-512.png', size: 512, maskable: false },
  { file: 'icon-maskable-512.png', size: 512, maskable: true },
];

const server = await createServer({
  root,
  logLevel: 'error',
  server: { port: 0 },     // any free port; base is '/' in `serve` mode
});
await server.listen();
const port = server.config.server.port ?? server.httpServer.address().port;
const url = `http://localhost:${port}/scripts/icon-render.html`;

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

try {
  await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => window.__ready === true, { timeout: 30000 });
  if (errors.length) throw new Error('render page errors:\n' + errors.join('\n'));

  await mkdir(outDir, { recursive: true });
  for (const { file, size, maskable } of TARGETS) {
    const dataUrl = await page.evaluate(
      ({ size, maskable }) => window.__renderIcon(size, { maskable }),
      { size, maskable },
    );
    const png = Buffer.from(dataUrl.split(',')[1], 'base64');
    await writeFile(resolve(outDir, file), png);
    console.log(`wrote public/icons/${file}  (${size}x${size}, ${png.length} bytes)`);
  }
  if (errors.length) throw new Error('render page errors:\n' + errors.join('\n'));
  console.log('ICONS OK');
} finally {
  await browser.close();
  await server.close();
}
