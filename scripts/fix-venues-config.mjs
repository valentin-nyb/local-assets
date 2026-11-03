// Repairs VENUES_CONFIG in Vercel (Production) once: the same repair the site does each time it reads it
// (api/_venues.js), saved back as clean JSON so it no longer depends on that.
//   node scripts/fix-venues-config.mjs           shows what would change (nothing is saved)
//   node scripts/fix-venues-config.mjs --apply   saves the repaired value, then reads it back to check
// Prints only account slugs, names and how many emails each has: never keys or tokens. The pulled settings
// live in a private temporary folder for a few seconds and are deleted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import JSON5 from 'json5';
import { repairJson } from '../api/_venues.js';

const apply = process.argv.includes('--apply');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function pullRaw() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'la-vc-'));
  const file = path.join(dir, '.env');
  try {
    execFileSync('vercel', ['env', 'pull', file, '--environment=production', '--yes'], { cwd: root, stdio: 'ignore' });
    const line = fs.readFileSync(file, 'utf8').split('\n').find(l => l.startsWith('VENUES_CONFIG='));
    if (!line) throw new Error('VENUES_CONFIG is not in Production (or is a Secret, which can\'t be read back)');
    const v = line.slice('VENUES_CONFIG='.length);
    return v.startsWith('"') ? JSON.parse(v) : v;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// The site's own order: as it is, + escaped, URL-decoded, then repaired
function parse(raw) {
  try { return { cfg: JSON.parse(raw), how: 'clean' }; } catch {}
  try { return { cfg: JSON.parse(raw.replace(/\+/g, '%2B')), how: '+ escaped' }; } catch {}
  try { return { cfg: JSON.parse(decodeURIComponent(raw)), how: 'URL-decoded' }; } catch {}
  return { cfg: JSON5.parse(repairJson(raw)), how: 'repaired' };
}

const summary = cfg => Object.entries(cfg).map(([slug, v]) => `  ${slug.padEnd(28)} ${String(v?.name || '').padEnd(28)} ${(Array.isArray(v?.emails) ? v.emails.length : v?.email ? 1 : 0)} email(s)`).join('\n');

const raw = pullRaw();
const { cfg, how } = parse(raw);
console.log(`VENUES_CONFIG reads as: ${how} · ${Object.keys(cfg).length} accounts`);
console.log(summary(cfg));
if (how === 'clean') { console.log('\nAlready clean JSON: nothing to do.'); process.exit(0); }

const value = JSON.stringify(cfg, null, 2);
if (!apply) { console.log('\nNothing saved. Run again with --apply to save the repaired value.'); process.exit(0); }

execFileSync('vercel', ['env', 'update', 'VENUES_CONFIG', 'production', '--yes'], { cwd: root, input: value, stdio: ['pipe', 'ignore', 'inherit'] });
const back = parse(pullRaw());
const same = back.how === 'clean' && JSON.stringify(back.cfg) === JSON.stringify(cfg);
console.log(same ? `\nSaved and checked: clean JSON, ${Object.keys(back.cfg).length} accounts, nothing lost. Redeploy for the site to use it.`
                 : '\nSaved, but reading it back did not match. Check VENUES_CONFIG in Vercel before redeploying.');
process.exit(same ? 0 : 1);
