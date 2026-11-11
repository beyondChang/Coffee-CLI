// Prompt-optimization regression for the task note card (sparkles button).
//
// The button sits left of duplicate and rewrites the note through the
// built-in model: the result replaces the text only while the note is still
// unchanged since the click (a slow response must never clobber newer edits),
// failures keep the note intact and surface an alert, and the button is
// single-flight and disabled on empty notes.
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const bundle = await build({
  stdin: { resolveDir: project, loader: 'tsx', contents: `
    import { useState } from 'react';import { createRoot } from 'react-dom/client';
    import { TaskNoteView } from './src/components/right/TaskNoteView';
    window.calls = [];window.nextResult = null;window.nextError = null;window.holdOpt = false;
    window.transport = async (name, args = {}) => {
      window.calls.push({ name, ...args });
      if (name === 'optimize_task_prompt') {
        if (window.holdOpt) await new Promise(resolve => { window.finishOpt = resolve; });
        if (window.nextError) throw Error(window.nextError);
        return window.nextResult;
      }
      return {};
    };
    function Harness() {
      const [tasks, setTasks] = useState([{ id: 't1', title: 'Build a page', description: '', status: 'todo', createdAt: 1 }]);
      window.getTasks = () => tasks;
      return <TaskNoteView tasks={tasks} addingId={null} removingId={null} canSend={true}
        onSetStatus={() => {}} onUpdateTitle={(id, title) => setTasks(prev => prev.map(task => task.id === id ? { ...task, title } : task))}
        onSetHeight={() => {}} onRemove={() => {}} onDuplicate={() => {}} onSend={() => {}} onReorder={() => {}} onShowGuide={() => {}} />;
    }
    createRoot(document.getElementById('root')).render(<Harness/>);
  ` },
  bundle: true, write: false, outfile: 'fixture.js', jsx: 'automatic',
  plugins: [{ name: 'task-optimize', setup(b) {
    b.onResolve({ filter: /store\/app-state$/ }, () => ({ path: 'store', namespace: 'fixture' }));
    b.onResolve({ filter: /(?:\.\.\/tauri|^\.\.\/\.\.\/tauri)$/ }, () => ({ path: 'native', namespace: 'fixture' }));
    b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: {
      store: `export const useAppLanguage = () => 'en';export const useAppState = () => ({ state: {}, dispatch() {} });`,
      native: `export const isTauri = true, invoke = (name, args) => window.transport(name, args);export const commands = { optimizeTaskPrompt: async text => window.transport('optimize_task_prompt', { text }) };`,
    }[args.path] }));
  } }],
});
const files = Object.fromEntries(bundle.outputFiles.map(file => [file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js', file.contents]));
const server = http.createServer((req, res) => {
  if (files[req.url]) return res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript').end(files[req.url]);
  if (req.url !== '/') return res.writeHead(404).end();
  res.setHeader('Content-Type', 'text/html').end('<!doctype html><html><link rel="stylesheet" href="/fixture.css"><style>:root{--text-1:#ddd;--text-2:#aaa;--accent:#ccd;--danger:#d77;--bg-panel:#222}body{background:#171717;color:#ddd;margin:0}#root{width:400px}</style><div id="root"></div><script src="/fixture.js"></script></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 700, height: 800 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.locator('.task-note-body').waitFor();
  const optimize = page.locator('.task-note-optimize');
  const body = page.locator('.task-note-body');

  // The button leads the action row, left of duplicate / delete / send.
  const order = await page.locator('.task-note-actions button').evaluateAll(nodes => nodes.map(node =>
    node.classList.contains('task-note-optimize') ? 'optimize' : node.classList.contains('task-note-copy') ? 'copy'
    : node.classList.contains('task-note-delete') ? 'delete' : 'send'));
  assert.deepEqual(order, ['optimize', 'copy', 'delete', 'send'], 'the optimize button sits left of duplicate');

  // Empty notes cannot be optimized.
  await body.fill('');
  assert.equal(await optimize.isDisabled(), true, 'an empty note disables optimization');
  await body.fill('Build a page');

  // Success replaces the note with the optimized prompt, and the request
  // carries the text as it was when clicked.
  await page.evaluate(() => { window.holdOpt = true; window.nextResult = '  Build a responsive landing page with tests.  '; });
  await optimize.click();
  await page.waitForFunction(() => typeof window.finishOpt === 'function');
  assert.equal(await optimize.isDisabled(), true, 'optimizing disables the button');
  assert.equal(await optimize.evaluate(node => node.classList.contains('is-busy')), true, 'the busy button spins');
  const sent = await page.evaluate(() => window.calls.at(-1));
  assert.equal(sent.name, 'optimize_task_prompt', 'call the built-in model transport');
  assert.equal(sent.text, 'Build a page', 'send the note text as clicked');
  await page.evaluate(() => window.finishOpt());
  await page.waitForFunction(() => document.querySelector('.task-note-body')?.value === 'Build a responsive landing page with tests.');
  assert.equal(await page.locator('.task-note-optimize-error').count(), 0, 'success shows no alert');

  // A model failure keeps the note and surfaces the localized alert.
  await page.evaluate(() => { window.holdOpt = false; window.nextResult = null; window.nextError = 'model down'; });
  await optimize.click();
  await page.getByRole('alert').waitFor();
  assert.equal((await page.getByRole('alert').innerText()).trim(), 'Could not optimize the prompt. Try again.');
  assert.equal(await body.inputValue(), 'Build a responsive landing page with tests.', 'failures preserve the note');

  // An empty model reply is a failure too, never an emptied note.
  await page.evaluate(() => { window.nextError = null; window.nextResult = '   '; });
  await optimize.click();
  await page.getByRole('alert').waitFor();
  assert.equal(await body.inputValue(), 'Build a responsive landing page with tests.', 'an empty result preserves the note');

  // Edits made while the model is working win: the result is dropped with an
  // explanation instead of clobbering the newer text.
  await page.evaluate(() => { window.holdOpt = true; window.nextResult = 'Stale optimized text'; });
  await optimize.click();
  await page.waitForFunction(() => typeof window.finishOpt === 'function');
  await body.fill('Edited meanwhile');
  await page.evaluate(() => window.finishOpt());
  await page.getByRole('alert').waitFor();
  assert.equal((await page.getByRole('alert').innerText()).trim(), 'The note changed while optimizing; the result was not applied.');
  assert.equal(await body.inputValue(), 'Edited meanwhile', 'newer edits survive a stale optimization');
  assert.deepEqual(await page.evaluate(() => window.calls.filter(call => call.name === 'optimize_task_prompt').map(call => call.text)),
    ['Build a page', 'Build a responsive landing page with tests.', 'Build a responsive landing page with tests.', 'Build a responsive landing page with tests.'],
    'every request carries the note text as it was when clicked');
  assert.deepEqual(errors, []);
  console.log('OK: optimize button leads the note actions, rewrites through the built-in model, preserves the note on failure and drops stale results');
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
