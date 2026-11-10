import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const notes = readFileSync(new URL('../../install/release-notes-template.md', import.meta.url), 'utf8');
const version = readFileSync(new URL('../../Cargo.toml', import.meta.url), 'utf8').match(/^version = "([^"]+)"/m)[1];
const sections = [...notes.matchAll(/<summary><b>([^<]+)<\/b><\/summary>([\s\S]*?)<\/details>/g)]
  .map(([, label, body]) => ({ label, body: body.trim() }));

assert.equal(sections.length, 5, 'release notes carry the five published languages');
for (const label of ['简体中文', 'English', '繁體中文', '日本語', '한국어']) {
  assert.ok(sections.some(section => section.label === label), `${label} section exists`);
}
for (const { label, body } of sections) {
  const headers = body.match(/^### Coffee CLI .+$/gm) ?? [];
  assert.equal(headers.length, 1, `${label} documents one release instead of stacking older entries`);
  assert.ok(headers[0].startsWith(`### Coffee CLI v${version} · `), `${label} header matches the application version ${version}`);
  assert.ok(body.includes('\n- **'), `${label} release notes contain update details`);
}
console.log(`PASS: five locales, single release entry and headers match v${version}`);
