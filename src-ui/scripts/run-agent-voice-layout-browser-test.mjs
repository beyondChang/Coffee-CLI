// [voice input disabled] // Layout regression for the voice model form.
// [voice input disabled] //
// [voice input disabled] // The Unisound hint is a bare <p> inside the form's fieldset, which is a
// [voice input disabled] // 4-column grid (label | control | label | control). Without an explicit
// [voice input disabled] // `grid-column: 1 / -1` it took the first track of a fresh row and every field
// [voice input disabled] // below it lost its label/control pairing: labels overlapping controls and the
// [voice input disabled] // inputs collapsing to a few characters wide. Assert the grid still holds.
// [voice input disabled] //
// [voice input disabled] // Runs against a bundled fixture — no Tauri backend required.
// [voice input disabled] import assert from 'node:assert/strict';
// [voice input disabled] import { mkdtemp, readFile } from 'node:fs/promises';
// [voice input disabled] import { tmpdir } from 'node:os';
// [voice input disabled] import { join } from 'node:path';
// [voice input disabled] import { fileURLToPath } from 'node:url';
// [voice input disabled] import http from 'node:http';
// [voice input disabled] import { build } from 'esbuild';
// [voice input disabled] const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
// [voice input disabled] const project = fileURLToPath(new URL('..', import.meta.url)), directory = await mkdtemp(join(tmpdir(), 'coffee-agent-voice-'));
// [voice input disabled] const fixtures = {
// [voice input disabled]   'store/app-state': `export function useAppState(){return{state:{agentPageActive:'config'}}} export function useAppLanguage(){return 'zh-CN'}`,
// [voice input disabled]   'tauri': `export const commands={}; export const isTauri=true; export async function invoke(name){ if(name==='agent_get_voice_model') return window.stored; return null }`,
// [voice input disabled]   '/clipboard': 'export async function clipboardRead(){return ""} export async function clipboardWrite(){}',
// [voice input disabled]   'lib/agent-client': `export const formatAgentError=e=>e; export const formatAgentActivity=()=>''; export const formatAgentMessage=()=>''; export const loadOlderAgentMessages=async()=>{}; export const refreshChannels=async()=>{}; export const sendAgentMessage=async()=>{}; export const startNewAgentConversation=async()=>{}; export const useAgentClient=()=>({})`,
// [voice input disabled]   'center/Gambit': 'export const Gambit=()=>null;',
// [voice input disabled]   'center/MarkdownContent': 'export const MarkdownContent=()=>null;',
// [voice input disabled] };
// [voice input disabled] await build({ stdin: { loader: 'tsx', resolveDir: project, contents: `
// [voice input disabled] import React from'react';import{createRoot}from'react-dom/client';import{AgentModelSection}from'./src/components/agent/AgentPages';import'./src/styles/global.css';import'./src/components/center/TierTerminal.css';
// [voice input disabled] // A Unisound base URL makes the async-workflow hint render above the key field.
// [voice input disabled] window.stored={provider:'openai',baseUrl:'https://maas-api.unisound.com/v1',model:'',apiKey:'sk-voice'};
// [voice input disabled] createRoot(document.getElementById('root')).render(<div className="agent-page-config"><div className="agent-settings-content" style={{width:720,padding:20}}><AgentModelSection kind="voice"/></div></div>);
// [voice input disabled] ` }, bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic', define: { __IS_LINUX__: 'false' },
// [voice input disabled]   loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' }, external: ['/fonts/*', '/monogram.svg', '/backgrounds/*'],
// [voice input disabled]   plugins: [{ name: 'agent-voice-fixtures', setup(b) {
// [voice input disabled]     b.onLoad({ filter: /[/\\]AgentPages\.tsx$/ }, async args => ({ loader: 'tsx', contents: `${await readFile(args.path, 'utf8')}\nexport { AgentModelSection };` }));
// [voice input disabled]     b.onResolve({ filter: new RegExp(`(?:${Object.keys(fixtures).map(name => name.replace('/', '\\/')).join('|')})$`) }, args => ({ path: Object.keys(fixtures).find(name => args.path.endsWith(name)), namespace: 'fixture' }));
// [voice input disabled]     b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: fixtures[args.path] }));
// [voice input disabled]   } }] });
// [voice input disabled] const server = http.createServer(async (req, res) => {
// [voice input disabled]   const name = req.url.slice(1);
// [voice input disabled]   if (name === 'fixture.js' || name === 'fixture.css') return res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : 'text/css').end(await readFile(join(directory, name)));
// [voice input disabled]   res.setHeader('Content-Type', 'text/html; charset=utf-8').end('<!doctype html><html data-theme="sakura" data-mode="dark" data-shape="soft"><link rel="stylesheet" href="/fixture.css"><body style="margin:0;background:var(--bg-terminal)"><div id="root"></div><script src="/fixture.js"></script></html>');
// [voice input disabled] });
// [voice input disabled] await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
// [voice input disabled] const browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
// [voice input disabled] try {
// [voice input disabled]   const page = await browser.newPage({ viewport: { width: 780, height: 460 } });
// [voice input disabled]   await page.goto(`http://127.0.0.1:${server.address().port}`);
// [voice input disabled]   await page.waitForFunction(() => { const box = document.querySelector('fieldset'); return box && !box.disabled; });
// [voice input disabled]
// [voice input disabled]   const field = name => page.getByLabel(name, { exact: true });
// [voice input disabled]   const hint = page.locator('.agent-field-hint');
// [voice input disabled]   await hint.waitFor();
// [voice input disabled]
// [voice input disabled]   // The hint owns a full row at the bottom of the form: it starts at the form's
// [voice input disabled]   // left edge, reaches its right edge, and leaves the field grid above intact.
// [voice input disabled]   const form = await page.locator('.agent-model-form fieldset').boundingBox();
// [voice input disabled]   const hintBox = await hint.boundingBox();
// [voice input disabled]   assert.ok(Math.abs(hintBox.x - form.x) <= 1, `hint starts at the form edge: ${hintBox.x} vs ${form.x}`);
// [voice input disabled]   assert.ok(hintBox.width >= form.width - 1, `hint spans the form width: ${hintBox.width} of ${form.width}`);
// [voice input disabled]
// [voice input disabled]   // Every field keeps its label immediately left of its control (no overlap),
// [voice input disabled]   // and the control keeps a usable width.
// [voice input disabled]   const rows = [];
// [voice input disabled]   for (const name of ['服务类型', '服务地址', '模型 ID', 'API 密钥']) {
// [voice input disabled]     const control = field(name);
// [voice input disabled]     const label = page.locator('.agent-field', { has: control }).locator('> span').first();
// [voice input disabled]     const [labelBox, controlBox] = await Promise.all([label.boundingBox(), control.boundingBox()]);
// [voice input disabled]     assert.ok(labelBox.y + labelBox.height <= controlBox.y + controlBox.height + 1 && controlBox.y <= labelBox.y + labelBox.height,
// [voice input disabled]       `${name} label shares the control's row`);
// [voice input disabled]     assert.ok(labelBox.x + labelBox.width <= controlBox.x + 1, `${name} label does not overlap its control: ${labelBox.x + labelBox.width} vs ${controlBox.x}`);
// [voice input disabled]     assert.ok(controlBox.width > 180, `${name} control keeps a usable width: ${controlBox.width}`);
// [voice input disabled]     rows.push({ name, y: Math.round(controlBox.y), x: Math.round(controlBox.x) });
// [voice input disabled]   }
// [voice input disabled]
// [voice input disabled]   // Two fields per row, so the left column stacks below itself and the right
// [voice input disabled]   // column keeps its own x — a shifted grid shows up as a third distinct x.
// [voice input disabled]   const columns = [...new Set(rows.map(row => row.x))].sort((a, b) => a - b);
// [voice input disabled]   assert.equal(columns.length, 2, `fields sit in two aligned columns: ${JSON.stringify(rows)}`);
// [voice input disabled]   assert.equal(rows.filter(row => row.x === columns[0]).map(row => row.name).join(','), '服务类型,模型 ID');
// [voice input disabled]   assert.equal(rows.filter(row => row.x === columns[1]).map(row => row.name).join(','), '服务地址,API 密钥');
// [voice input disabled]   // The inputs keep the grid's original two rows; only the hint moves to the bottom.
// [voice input disabled]   const providerBox = await field('服务类型').boundingBox();
// [voice input disabled]   const urlBox = await field('服务地址').boundingBox();
// [voice input disabled]   const modelBox = await field('模型 ID').boundingBox();
// [voice input disabled]   const keyBox = await field('API 密钥').boundingBox();
// [voice input disabled]   assert.equal(Math.round(urlBox.y), Math.round(providerBox.y), 'the URL stays on the provider row');
// [voice input disabled]   assert.equal(Math.round(keyBox.y), Math.round(modelBox.y), 'the key stays on the model row');
// [voice input disabled]   assert.ok(hintBox.y >= keyBox.y + keyBox.height, 'the hint sits below every field');
// [voice input disabled]
// [voice input disabled]   await page.screenshot({ path: join(directory, 'voice-form.png') });
// [voice input disabled]
// [voice input disabled]   // The narrow single-column fallback still pairs each label with its control.
// [voice input disabled]   await page.setViewportSize({ width: 420, height: 620 });
// [voice input disabled]   await page.evaluate(() => { document.querySelector('.agent-settings-content').style.width = '380px'; });
// [voice input disabled]   for (const name of ['服务类型', '服务地址', '模型 ID', 'API 密钥']) {
// [voice input disabled]     const control = field(name);
// [voice input disabled]     const label = page.locator('.agent-field', { has: control }).locator('> span').first();
// [voice input disabled]     const [labelBox, controlBox] = await Promise.all([label.boundingBox(), control.boundingBox()]);
// [voice input disabled]     assert.ok(labelBox.x + labelBox.width <= controlBox.x + 1, `${name} label stays left of its control when narrow`);
// [voice input disabled]     assert.ok(controlBox.width > 180, `${name} control stays usable when narrow: ${controlBox.width}`);
// [voice input disabled]   }
// [voice input disabled]   await page.screenshot({ path: join(directory, 'voice-form-narrow.png') });
// [voice input disabled]   console.log('OK: the voice model form keeps its label/control grid with the Unisound hint, wide and narrow');
// [voice input disabled]   console.log(`Screenshots: ${directory}`);
// [voice input disabled] } finally { await browser.close(); server.close(); }
