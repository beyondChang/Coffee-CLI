import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const read = file => fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
function declaration(file, name) {
  const tree = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const node = tree.statements.find(item => ts.isFunctionDeclaration(item) && item.name?.text === name);
  assert.ok(node, `Missing ${name} in ${file}`);
  return node.getText(tree).replace(/^export\s+/, '');
}
const compile = code => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;

// Exercise the real predicate and reducer rather than detached copies.
const api = vm.runInNewContext(compile(
  `${declaration('store/app-state.tsx', 'isLaunchpadActive')}; ${declaration('store/app-state.tsx', 'reducer')}; ({ isLaunchpadActive, reducer });`,
), { localStorage: { setItem() {} } });

// The untouched "new session" chooser can remain the active terminal while a
// Coffee Agent / file / utility page owns the centre column. While it was
// still reported as "active", App.tsx unmounted the right panel, its edge
// handle was hidden and TOGGLE_RIGHT_PANEL was ignored: the panel could never
// be shown on those pages.
const chooser = {
  terminals: [{ id: 'chooser', tool: null }], activeTerminalId: 'chooser',
  agentPageActive: null, fileTabActive: false,
  usageOpen: false, toolSettingsOpen: false, automationsOpen: false, settingsOpen: false,
  rightPanelHidden: true,
};

assert.equal(api.isLaunchpadActive(chooser), true, 'the chooser tab owns the workspace');
assert.equal(api.isLaunchpadActive({ ...chooser, agentPageActive: 'agent' }), false, 'the Coffee Agent page is not the chooser');
assert.equal(api.isLaunchpadActive({ ...chooser, fileTabActive: true }), false, 'a file viewer is not the chooser');
assert.equal(api.isLaunchpadActive({ ...chooser, usageOpen: true }), false, 'a utility page is not the chooser');
assert.equal(api.isLaunchpadActive({ ...chooser, toolSettingsOpen: true }), false, 'tool settings is not the chooser');
assert.equal(api.isLaunchpadActive({ ...chooser, automationsOpen: true }), false, 'automations is not the chooser');
assert.equal(api.isLaunchpadActive({ ...chooser, terminals: [{ id: 'chooser', tool: 'claude' }] }), false, 'a real terminal is not the chooser');

assert.equal(api.reducer({ ...chooser, agentPageActive: 'agent' }, { type: 'TOGGLE_RIGHT_PANEL' }).rightPanelHidden, false,
  'the right panel must open while the Coffee Agent page is visible');
assert.equal(api.reducer(chooser, { type: 'TOGGLE_RIGHT_PANEL' }).rightPanelHidden, true,
  'the chooser still refuses a sidebar');

// Both the panel mount and its edge handle must keep consulting the same predicate.
assert.match(read('App.tsx'), /isLaunchpadActive\(state\)/);
assert.match(read('components/common/PanelEdgeHandle.tsx'), /isLaunchpadActive\(state\)/);
console.log('OK: right panel stays reachable on Agent / file / utility pages, chooser still suppresses it');
