// Layout and behaviour regression for the settings modal's 应用 section.
//
// The section is a copy of the tool dialog's pinned-card grid, so the cards
// must render one switch per catalog tool, the counter must show how many are
// on, and toggling a card must persist the choice (the launchpad behind the
// dialog reads the same store).
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { build } from 'esbuild';
const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url)), directory = await mkdtemp(join(tmpdir(), 'coffee-agent-apps-'));
const fixtures = {
  'store/app-state': `export function useAppState(){return{state:{}}} export function useAppLanguage(){return 'zh-CN'}`,
  'tauri': `export const commands = { checkToolsInstalled: async () => ({}), listTools: async () => [] }; export const isTauri=true; export async function invoke(){return null}`,
  'lib/tool-info': `export function getToolDisplayName(id){return 'Tool '+id}`,
  // The real component pulls the icon map and the configurable-tool set from
  // the centre panel; a stub keeps the fixture small.
  'center/CenterPanel': `export const CONFIGURABLE_AGENT_TOOLS = new Set(['claude','codex']); export const getToolIcon = () => null;`,
  'center/ToolConfigModal': `export const ToolConfigModal = () => null;`,
  // The panels behind the other tabs are stubbed; the tab strip itself is the
  // real ToolSettingsPage, so the tab order and the switching are real too.
  'ToolMemoryPanel': `export const ToolMemoryPanel = () => null;`,
  'ToolOrchestrationPanel': `export const ToolOrchestrationPanel = () => null;`,
  'ToolSkillsPanel': `export const ToolSkillsPanel = () => null;`,
  'ToolControlPanel': `export const ToolControlPanel = () => null;`,
};
await build({ stdin: { loader: 'tsx', resolveDir: project, contents: `
import React from'react';import{createRoot}from'react-dom/client';import{AgentAppsSection}from'./src/components/common/AgentAppsSection';import'./src/styles/global.css';
localStorage.setItem('coffee_pinned_items', JSON.stringify(['agent:claude','agent:codex']));
createRoot(document.getElementById('root')).render(<div style={{width:520,padding:20}}><AgentAppsSection/></div>);
` }, bundle: true, outfile: join(directory, 'fixture.js'), jsx: 'automatic', define: { __IS_LINUX__: 'false' },
  loader: { '.woff2': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' }, external: ['/fonts/*', '/monogram.svg', '/backgrounds/*'],
  plugins: [{ name: 'agent-apps-fixtures', setup(b) {
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
  const page = await browser.newPage({ viewport: { width: 620, height: 900 } });
  page.on('console', message => { if (message.type() === 'error') console.log('[page console]', message.text()); });
  page.on('pageerror', error => console.log('[page error]', error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('.library-item').first().waitFor();

  const cards = page.locator('.library-item');
  const pinned = page.locator('.library-item.is-pinned');
  // One card per catalog tool, plus the two that are switched on.
  assert.equal(await cards.count(), 25, 'every catalog tool has a card');
  assert.equal(await pinned.count(), 2, 'the two stored pins are switched on');
  assert.equal((await page.locator('.settings-apps-count').innerText()).trim(), '2/6', 'the counter shows the stored selection');

  // The switched-on cards come first, like the tool dialog.
  const firstTwo = await cards.evaluateAll(nodes => nodes.slice(0, 2).map(node => node.getAttribute('aria-pressed')));
  assert.deepEqual(firstTwo, ['true', 'true'], 'switched-on cards lead the grid');

  // The gear only shows for tools that take a launch configuration.
  assert.equal(await page.locator('.library-gear-btn').count(), 2, 'the gear marks the configurable tools');

  // Switching a card on persists the choice and updates the counter.
  const next = page.locator('.library-item:not(.is-pinned)').first();
  const label = await next.getAttribute('aria-label');
  await next.click();
  await page.waitForFunction(() => document.querySelector('.settings-apps-count')?.textContent?.trim() === '3/6');
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('coffee_pinned_items')));
  assert.equal(stored.length, 3, 'the toggle is persisted');
  assert.ok(stored.includes(`agent:${label.replace('Tool ', '')}`), `the new pin is stored: ${JSON.stringify(stored)}`);
  assert.equal(await pinned.count(), 3, 'the new card is switched on');

  // Switching it off again removes it from the store.
  await page.locator('.library-item.is-pinned').last().click();
  await page.waitForFunction(() => document.querySelector('.settings-apps-count')?.textContent?.trim() === '2/6');
  assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('coffee_pinned_items')))).length, 2, 'the pin is removed again');

  await page.screenshot({ path: join(directory, 'apps-section.png') });

  // The other 应用配置 panels live in the same section, behind the same tabs.
  const tabs = page.locator('.tool-settings-tabs button');
  assert.equal(await tabs.count(), 6, '常用 plus the five other 应用配置 panels');
  const tabLabels = await tabs.allInnerTexts();
  assert.deepEqual(tabLabels.map(text => text.trim().split(/\s+/)[0]), ['常用', '主记忆', '多智能体编排', '技能', '电脑控制', '浏览器控制'], 'the tab strip mirrors 应用配置');
  await tabs.nth(1).click();
  await page.waitForFunction(() => document.querySelectorAll('.tool-settings-tabs button')[1]?.getAttribute('aria-selected') === 'true');
  assert.equal(await page.locator('.library-item').count(), 0, 'the cards belong to the 常用 tab');
  await tabs.nth(3).click();
  await page.waitForFunction(() => document.querySelectorAll('.tool-settings-tabs button')[3]?.getAttribute('aria-selected') === 'true');
  await page.screenshot({ path: join(directory, 'apps-section-skills.png') });

  console.log('OK: the settings 应用 section lists every tool, counts the selection, persists toggles and carries the 应用配置 panels');
  console.log(`Screenshots: ${directory}`);
} finally { await browser.close(); server.close(); }
