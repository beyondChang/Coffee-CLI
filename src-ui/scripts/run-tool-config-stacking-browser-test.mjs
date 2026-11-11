// Stacking regression for the per-tool configuration modal (card gear).
//
// The config modal opens from a gear inside a host dialog — the launchpad's
// 应用配置 dialog (.tool-settings-overlay, z-index 900) or the settings
// modal (.settings-overlay, z-index 2000) — and must be the topmost surface
// in both cases. #root carries a clip-path (rounded window corners) which
// creates a stacking context, so a backdrop rendered inline inside #root can
// never paint above a body-level dialog portal: the config modal must mount
// at body level and clear the settings modal's z-index.
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const { chromium } = await import(process.env.COFFEE_PLAYWRIGHT_MODULE || 'playwright-core');
const project = fileURLToPath(new URL('..', import.meta.url));
const bundle = await build({
  stdin: { resolveDir: project, loader: 'tsx', contents: `
    import { useState } from 'react';import { createRoot } from 'react-dom/client';import { createPortal } from 'react-dom';
    import { ToolConfigModal } from './src/components/center/ToolConfigModal';
    import './src/styles/global.css';import './src/components/center/CenterPanel.css';import './src/components/common/SettingsModal.css';
    function Fixture() {
      const [dialog, setDialog] = useState(null);const [config, setConfig] = useState(false);
      return <>
        <button id="open-tools" onClick={() => setDialog('tools')}>open tools</button>
        <button id="open-settings" onClick={() => setDialog('settings')}>open settings</button>
        {dialog && createPortal(
          <div id="outer-dialog" className={dialog === 'tools' ? 'tool-settings-overlay' : 'settings-overlay'}
               onMouseDown={event => { if (event.target === event.currentTarget) setDialog(null); }}>
            <div className={dialog === 'tools' ? 'tool-settings-modal' : 'settings-modal'}>
              <button id="gear" onClick={() => setConfig(true)}>gear</button>
            </div>
          </div>, document.body)}
        {config && <ToolConfigModal toolKey="claude" toolLabel="Claude Code" onClose={() => setConfig(false)} />}
      </>;
    }
    createRoot(document.getElementById('root')).render(<Fixture/>);
  ` },
  bundle: true, write: false, outfile: 'fixture.js', jsx: 'automatic', external: ['/fonts/*', '/monogram.svg', '/backgrounds/*'],
  plugins: [{ name: 'isolated-config', setup(builder) {
    builder.onResolve({ filter: /store\/app-state$/ }, () => ({ path: 'language', namespace: 'fixture' }));
    builder.onResolve({ filter: /(^|\/)tauri$/ }, () => ({ path: 'config', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ loader: 'js', contents: args.path === 'language' ? `
      export function useAppLanguage(){return 'en'}
    ` : `
      const empty={command:'',extra_args:[],default_cwd:'',history_path:''};
      export const commands={async getToolConfig(){return structuredClone(empty)},async setToolConfig(){}};
    ` }));
  } }],
});
const files = Object.fromEntries(bundle.outputFiles.map(file => [file.path.endsWith('.css') ? '/fixture.css' : '/fixture.js', file.contents]));
const server = http.createServer((req, res) => {
  if (files[req.url]) return res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript').end(files[req.url]);
  if (req.url !== '/') return res.writeHead(404).end();
  res.setHeader('Content-Type', 'text/html').end('<!doctype html><html data-mode="dark" data-theme="obsidian" data-shape="soft"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.COFFEE_CHROMIUM_EXECUTABLE ? { executablePath: process.env.COFFEE_CHROMIUM_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 900, height: 680 } });
  const errors = [];page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForFunction(() => window.document.getElementById('open-tools'));

  // Hit-test the centre of the config modal: if it is not the topmost surface
  // there, the host dialog's backdrop is covering it and every click goes to
  // the wrong dialog.
  const topmost = async () => {
    const box = await page.locator('.tool-config-modal').boundingBox();
    return page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      if (el?.closest('.tool-config-backdrop')) return 'config';
      if (el?.closest('#outer-dialog')) return 'host';
      return el ? `${el.tagName}.${el.className}` : 'none';
    }, [box.x + box.width / 2, box.y + box.height / 2]);
  };

  for (const [name, opener, host] of [
    ['应用配置 dialog', 'open-tools', 'tool-settings-overlay'],
    ['settings modal', 'open-settings', 'settings-overlay'],
  ]) {
    await page.locator(`#${opener}`).click();
    const outer = page.locator('#outer-dialog');
    await outer.waitFor();
    assert.equal(await outer.evaluate((node, cls) => node.classList.contains(cls), host), true, `${name}: host dialog uses ${host}`);
    await page.locator('#gear').click();
    await page.locator('.tool-config-modal').waitFor();
    assert.equal(await topmost(), 'config', `${name}: the config modal stacks on top of ${host}`);
    // The click lands on the config modal's Cancel, not on the host dialog.
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.locator('.tool-config-modal').waitFor({ state: 'detached' });
    assert.equal(await outer.count(), 1, `${name}: the host dialog stays open behind the config modal`);
    await page.mouse.click(5, 5);
    await outer.waitFor({ state: 'detached' });
    console.log(`ok ${name}: config modal is the topmost surface and owns its clicks`);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser?.close();await new Promise(resolve => server.close(resolve));
}
