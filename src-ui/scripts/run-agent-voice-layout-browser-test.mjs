// Layout regression for the voice model form.
//
// The Unisound hint is a bare <p> inside the form's fieldset, which is a
// 4-column grid (label | control | label | control). Without an explicit
// `grid-column: 1 / -1` it took the first track of a fresh row and every field
// below it lost its label/control pairing: labels overlapping controls and the
// inputs collapsing to a few characters wide. Assert the grid still holds.
//
// Runs against a bundled fixture — no Tauri backend required.
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url)), directory = await mkdtemp(join(tmpdir(), 'coffee-agent-voice-'));
const fixtures = {
  'store/app-state': `export function useAppState(){return{state:{agentPageActive:'config'}}} export function useAppLanguage(){return 'zh-CN'}`,
  'tauri': `export const commands={}; export const isTauri=true; export async function invoke(name){ if(name==='agent_get_voice_model') return window.stored; return null }`,
  '/clipboard': 'export async function clipboardRead(){return ""} export async function clipboardWrite(){}',
  'lib/agent-client': `export const formatAgentError=e=>e; export const formatAgentActivity=()=>''; export const formatAgentMessage=()=>''; export const loadOlderAgentMessages=async()=>{}; export const refreshChannels=async()=>{}; export const sendAgentMessage=async()=>{}; export const startNewAgentConversation=async()=>{}; export const useAgentClient=()=>({})`,
  'center/Gambit': 'export const Gambit=()=>null;',
  'center/MarkdownContent': 'export const MarkdownContent=()=>null;',
};
await build({ stdin: { loader: 'tsx', resolveDir: project, contents: `
import React from'react';import{createRoot}from'react-dom/client';import{AgentModelSection}from'./src/components/agent/AgentPages';import'./src/styles/global.css';import'./src/components/center/TierTerminal.css';
// A Unisound base URL makes the async-workflow hint render above the key field.
window.stored={provider:'openai',baseUrl:'https://maas-api.unisound.com/v1',model:'',apiKey:'sk-voice'};
createRoot(document.getElementById('root')).render(<div className="agent-page-config"><div className="agent-settings-content" style={{width:720,padding:20}}><AgentModelSection kind="voice"/></div></div>);
` }, bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic', define: { __IS_LINUX__: 'false' },
  loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' }, external: ['/fonts/*', '/monogram.svg', '/backgrounds/*'],
  plugins: [{ name: 'agent-voice-fixtures', setup(b) {
    b.onLoad({ filter: /[/\\]AgentPages\.tsx$/ }, async args => ({ loader: 'tsx', contents: `${await readFile(args.path, 'utf8')}\nexport { AgentModelSection };` }));
    b.onResolve({ filter: new RegExp(`(?:${Object.keys(fixtures).map(name => name.replace('/', '\\/')).join('|')})$`) }, args => ({ path: Object.keys(fixtures).find(name => args.path.endsWith(name)), namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: fixtures[args.path] }));
  } }] });
const server = http.createServer(async (req, res) => {
  const name = req.url.slice(1);
  if (name === 'fixture.js' || name === 'fixture.css') return res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/css').end(await readFile(join(directory, name)));
  res.setHeader('Content-Type', 'text/html; charset=utf-8').end('<!doctype html><html data-theme="sakura" data-mode="dark" data-shape="soft"><link rel="stylesheet" href="/fixture.css"><body style="margin:0;background:var(--bg-terminal)"><div id="root"></div><script src="/fixture.js"></script></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
try {
  const page = await browser.newPage({ viewport: { width: 780, height: 460 } });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => { const box = document.querySelector('fieldset'); return box && !box.disabled; });

  const field = name => page.getByLabel(name, { exact: true });
  const hint = page.locator('.agent-field-hint');
  await hint.waitFor();

  // The hint owns a full row at the bottom of the form: it starts at the form's
  // left edge, reaches its right edge, and leaves the field grid above intact.
  const form = await page.locator('.agent-model-form fieldset').boundingBox();
  const hintBox = await hint.boundingBox();
  assert.ok(Math.abs(hintBox.x - form.x) <= 1, `hint starts at the form edge: ${hintBox.x} vs ${form.x}`);
  assert.ok(hintBox.width >= form.width - 1, `hint spans the form width: ${hintBox.width} of ${form.width}`);

  // Every field keeps its label immediately left of its control (no overlap),
  // and the control keeps a usable width.
  const rows = [];
  for (const name of ['服务类型', '服务地址', '模型 ID', 'API 密钥']) {
    const control = field(name);
    const label = page.locator('.agent-field', { has: control }).locator('> span').first();
    const [labelBox, controlBox] = await Promise.all([label.boundingBox(), control.boundingBox()]);
    assert.ok(labelBox.y + labelBox.height <= controlBox.y + controlBox.height + 1 && controlBox.y <= labelBox.y + labelBox.height,
      `${name} label shares the control's row`);
    assert.ok(labelBox.x + labelBox.width <= controlBox.x + 1, `${name} label does not overlap its control: ${labelBox.x + labelBox.width} vs ${controlBox.x}`);
    assert.ok(controlBox.width > 180, `${name} control keeps a usable width: ${controlBox.width}`);
    rows.push({ name, y: Math.round(controlBox.y), x: Math.round(controlBox.x) });
  }

  // Two fields per row, so the left column stacks below itself and the right
  // column keeps its own x — a shifted grid shows up as a third distinct x.
  const columns = [...new Set(rows.map(row => row.x))].sort((a, b) => a - b);
  assert.equal(columns.length, 2, `fields sit in two aligned columns: ${JSON.stringify(rows)}`);
  assert.equal(rows.filter(row => row.x === columns[0]).map(row => row.name).join(','), '服务类型,模型 ID');
  assert.equal(rows.filter(row => row.x === columns[1]).map(row => row.name).join(','), '服务地址,API 密钥');
  // The inputs keep the grid's original two rows; only the hint moves to the bottom.
  const providerBox = await field('服务类型').boundingBox();
  const urlBox = await field('服务地址').boundingBox();
  const modelBox = await field('模型 ID').boundingBox();
  const keyBox = await field('API 密钥').boundingBox();
  assert.equal(Math.round(urlBox.y), Math.round(providerBox.y), 'the URL stays on the provider row');
  assert.equal(Math.round(keyBox.y), Math.round(modelBox.y), 'the key stays on the model row');
  assert.ok(hintBox.y >= keyBox.y + keyBox.height, 'the hint sits below every field');

  await page.screenshot({ path: join(directory, 'voice-form.png') });

  // The narrow single-column fallback still pairs each label with its control.
  await page.setViewportSize({ width: 420, height: 620 });
  await page.evaluate(() => { document.querySelector('.agent-settings-content').style.width = '380px'; });
  for (const name of ['服务类型', '服务地址', '模型 ID', 'API 密钥']) {
    const control = field(name);
    const label = page.locator('.agent-field', { has: control }).locator('> span').first();
    const [labelBox, controlBox] = await Promise.all([label.boundingBox(), control.boundingBox()]);
    assert.ok(labelBox.x + labelBox.width <= controlBox.x + 1, `${name} label stays left of its control when narrow`);
    assert.ok(controlBox.width > 180, `${name} control stays usable when narrow: ${controlBox.width}`);
  }
  await page.screenshot({ path: join(directory, 'voice-form-narrow.png') });
  console.log('OK: the voice model form keeps its label/control grid with the Unisound hint, wide and narrow');
  console.log(`Screenshots: ${directory}`);
} finally { await browser.close(); server.close(); }
