// Every page: its scripts parse, its buttons call functions that exist; every server file's local imports
// resolve; files that aren't part of the website are never served.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const pages = fs.readdirSync('.').filter(f => f.endsWith('.html'));
const shared = ['nav-component.js', 'la-dialogs.js', 'la-select.js', 'footer-component.js', 'la-djframe.js', 'la-native.js']
  .filter(f => fs.existsSync(f)).map(f => fs.readFileSync(f, 'utf8')).join('\n');
const inlineScripts = s => [...s.matchAll(/<script(?![^>]*src)([^>]*)>([\s\S]*?)<\/script>/g)].filter(x => !/module|json|speculation/.test(x[1])).map(x => x[2]);
const BUILTIN = new Set(['if', 'window', 'document', 'this', 'event', 'alert', 'confirm', 'setTimeout', 'location', 'history', 'navigator', 'fetch', 'var', 'return', 'encodeURIComponent', 'URL']);

for (const f of pages) {
  test(`${f}: scripts parse and buttons call real functions`, () => {
    const s = fs.readFileSync(f, 'utf8');
    inlineScripts(s).forEach((code, i) => { assert.doesNotThrow(() => new Function(code), `script ${i}`); });
    const code = inlineScripts(s).join('\n') + shared;
    const calls = new Set();
    for (const m of s.matchAll(/on(?:click|change|input|submit|keydown|load|error|mouseenter|mouseleave)=\\?["']([^"']*)/g))
      for (const c of m[1].matchAll(/(?:^|[;\s(!])([A-Za-z_$][\w$]*)\s*\(/g)) calls.add(c[1]);
    const missing = [...calls].filter(n => !BUILTIN.has(n) && !new RegExp(`(function\\s+${n}\\b|\\b${n}\\s*=\\s*(async\\s*)?(function|\\()|window\\.${n}\\s*=)`).test(code));
    assert.deepEqual(missing, []);
  });
}

test('every local import in api/ resolves to something exported', () => {
  const bad = [];
  for (const f of fs.readdirSync('api').filter(f => f.endsWith('.js'))) {
    const s = fs.readFileSync('api/' + f, 'utf8');
    for (const m of s.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(\.\/[^']+)'/g)) {
      const target = 'api/' + m[2].slice(2);
      if (!fs.existsSync(target)) { bad.push(`${f}: ${target} missing`); continue; }
      const t = fs.readFileSync(target, 'utf8');
      for (const n of m[1].split(',').map(x => x.trim().split(/\s+as\s+/)[0]).filter(Boolean))
        if (!new RegExp(`export\\s+(async\\s+)?(function|const|let|class)\\s+${n}\\b`).test(t) && !new RegExp(`export\\s*\\{[^}]*\\b${n}\\b`).test(t)) bad.push(`${f}: ${n} not exported by ${target}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('source, worker and app folders are never served by the website', () => {
  const ignored = fs.readFileSync('.vercelignore', 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  for (const p of ['server', 'scripts', 'db', 'electron-app', 'ios-app', 'index.js', 'cors.json', 'render.yaml', 'railway.json', 'README.md', 'tests'])
    if (fs.existsSync(p)) assert.ok(ignored.includes(p), `${p} would be public`);
});

test('the manifest\'s icons exist', () => {
  const m = JSON.parse(fs.readFileSync('favicon/site.webmanifest', 'utf8'));
  // A ?v=… on the address only makes browsers fetch the icon again
  for (const i of m.icons) assert.ok(fs.existsSync('.' + i.src.split('?')[0]), i.src);
});
