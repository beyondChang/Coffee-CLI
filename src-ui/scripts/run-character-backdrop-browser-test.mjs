import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';

const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'coffee-backdrop-'));
const cssPath = join(directory, 'fixture.css');
await build({
  entryPoints: [`${project}/src/styles/global.css`],
  bundle: true,
  outfile: cssPath,
  loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' },
  external: ['/fonts/*', '/monogram.svg', '/backgrounds/*'],
});

// Minimal stand-in for the app shell. Only global.css decides the paint order,
// so the backdrop canvas can be verified without mounting React or Tauri.
const markup = `<!doctype html>
<html data-theme="oat" data-mode="dark" data-shape="carbon" data-background="characters">
<head><link rel="stylesheet" href="/fixture.css"></head>
<body style="margin:0;--bg-app:#181e28;--bg-panel:#20262e;--glass-blur:none">
<div id="root">
  <div class="character-background"><canvas></canvas></div>
  <div class="titlebar"></div>
  <div class="app-layout">
    <aside class="panel-left"></aside>
    <div class="panel-center"><div class="main-content"></div></div>
    <aside class="panel-right"></aside>
  </div>
</div>
</body></html>`;

const server = http.createServer(async (req, res) => {
  if (req.url === '/fixture.css') {
    res.setHeader('Content-Type', 'text/css; charset=utf-8');
    return res.end(await readFile(cssPath));
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(markup);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({
  headless: true,
  ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const colors = () => page.evaluate(() => {
    const read = selector => getComputedStyle(document.querySelector(selector)).backgroundColor;
    return {
      titlebar: read('.titlebar'),
      left: read('.panel-left'),
      right: read('.panel-right'),
      center: read('.panel-center'),
    };
  });
  const setShape = (shape, background) => page.evaluate(({ shape, background }) => {
    const html = document.documentElement;
    html.setAttribute('data-shape', shape);
    if (background) html.setAttribute('data-background', background);
    else html.removeAttribute('data-background');
  }, { shape, background });
  const transparent = 'rgba(0, 0, 0, 0)';

  // Character Flow and Basalt normalize data-shape to carbon. Their canvas /
  // image sits at z-index:-1, so any opaque chrome plate hides it everywhere
  // but the centre column. The generic #root .titlebar / .panel-* rule has id
  // specificity and used to outrank the shape's transparent-chrome overrides.
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.querySelector('.character-background')).zIndex),
    '-1',
    'the backdrop must stay behind the app shell',
  );
  for (const background of ['characters', 'basalt']) {
    await setShape('carbon', background);
    const actual = await colors();
    for (const [region, color] of Object.entries(actual)) {
      assert.equal(
        color, transparent,
        `${background}: ${region} must stay transparent so the backdrop covers the whole window (got ${color})`,
      );
    }
  }

  // Shapes without a backdrop keep their own lifted chrome surface; the fix
  // must not flatten the rest of the theme system.
  await setShape('soft', null);
  const soft = await colors();
  for (const region of ['titlebar', 'left', 'right']) {
    assert.notEqual(soft[region], transparent, `soft: ${region} must keep its own surface`);
  }

  console.log('OK: background shapes keep the whole-window chrome transparent; other shapes keep their surface');
} finally {
  await browser.close();
  server.close();
}
