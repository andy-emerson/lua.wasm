// bench-witness.mjs -- the benchmark (issue #54): lua.js against Wasmoon
// and fengari-web, pinned, in the same page under the same real engine.
//
//   node scripts/bench-witness.mjs <lua.js> <lua.wasm> --engine <chromium|firefox|webkit>
//        [--rounds N] [--json out.json] [--only work|load]
//
// Two measurements. Workloads (bench/*.lua, written for Lua 5.3 and 5.4
// so fengari runs the same source): each round runs every workload on
// every implementation in a rotated order, on a FRESH instance each time;
// N rounds (default 20); medians, the ratio of each peer's median to ours,
// and a two-sided Mann-Whitney U p-value for the difference. Every
// implementation's printed result must match ours, or the workload is
// reported as a mismatch rather than timed. Load-to-first-print: three
// pages written the way each project's README shows (bench/load-*.html),
// timed from navigation to the first print, cold (a fresh browser context,
// empty cache) and warm (the same context again), N/2 rounds each.
//
// The result is a Markdown table with the run cited (engine and version,
// date, commit). It is on demand and never CI-gating: runner timing is
// noise, and a number is only as good as its run. Peers are served from
// node_modules (make bench installs them); the engine launcher and its
// guards are scripts/browser/engine.mjs.
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENGINES, detectEngine, launch } from './browser/engine.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const argv = process.argv.slice(2);
let engine, rounds = 20, jsonOut = null, only = null;
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--engine') engine = argv[++i];
  else if (argv[i] === '--rounds') rounds = +argv[++i];
  else if (argv[i] === '--json') jsonOut = argv[++i];
  else if (argv[i] === '--only') only = argv[++i];
  else positional.push(argv[i]);
}
const [jsPath, wasmPath] = positional;
if (!jsPath || !wasmPath || !engine || !ENGINES.includes(engine)) {
  console.error('usage: node scripts/bench-witness.mjs <lua.js> <lua.wasm> --engine <chromium|firefox|webkit> [--rounds N] [--json out.json]');
  process.exit(2);
}

const IMPLS = ['luawasm', 'wasmoon', 'fengari'];
const LABEL = { luawasm: 'lua.wasm', wasmoon: 'Wasmoon', fengari: 'fengari' };
const versions = {
  luawasm: execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim(),
  wasmoon: JSON.parse(await readFile(join(root, 'node_modules/wasmoon/package.json'), 'utf8')).version,
  fengari: JSON.parse(await readFile(join(root, 'node_modules/fengari-web/package.json'), 'utf8')).version,
};

// --- the workloads --------------------------------------------------------------
const workloads = {};
for (const name of (await readdir(join(root, 'bench'))).filter(n => n.endsWith('.lua')).sort()) {
  workloads[name.replace(/\.lua$/, '')] = await readFile(join(root, 'bench', name), 'utf8');
}

// --- static server: our files, the peers from node_modules, the pages ----------
const files = {
  '/lua.js': [resolve(jsPath), 'text/javascript'],
  '/lua.wasm': [resolve(wasmPath), 'application/wasm'],
  '/host.mjs': [join(here, 'host.mjs'), 'text/javascript'],
  '/vendor/wasmoon/index.js': [join(root, 'node_modules/wasmoon/dist/index.js'), 'text/javascript'],
  '/vendor/wasmoon/glue.wasm': [join(root, 'node_modules/wasmoon/dist/glue.wasm'), 'application/wasm'],
  '/vendor/fengari-web.js': [join(root, 'node_modules/fengari-web/dist/fengari-web.js'), 'text/javascript'],
  '/bench-page.html': [join(root, 'bench/bench-page.html'), 'text/html'],
  '/load-luawasm.html': [join(root, 'bench/load-luawasm.html'), 'text/html'],
  '/load-wasmoon.html': [join(root, 'bench/load-wasmoon.html'), 'text/html'],
  '/load-fengari.html': [join(root, 'bench/load-fengari.html'), 'text/html'],
};
const server = createServer(async (req, res) => {
  const f = files[new URL(req.url, 'http://x').pathname];
  if (!f) { res.writeHead(404).end(); return; }
  try { res.writeHead(200, { 'content-type': f[1] }); res.end(await readFile(f[0])); }
  catch { res.writeHead(404).end(); }
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;

// --- statistics ---------------------------------------------------------------------
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function mannWhitneyP(a, b) {            // two-sided, normal approximation with tie correction
  const all = [...a.map(v => [v, 0]), ...b.map(v => [v, 1])].sort((x, y) => x[0] - y[0]);
  const ranks = new Array(all.length);
  let i = 0, tieTerm = 0;
  while (i < all.length) {
    let j = i; while (j < all.length && all[j][0] === all[i][0]) j++;
    const r = (i + j + 1) / 2; for (let k = i; k < j; k++) ranks[k] = r;
    const t = j - i; tieTerm += t * t * t - t; i = j;
  }
  const n1 = a.length, n2 = b.length, n = n1 + n2;
  const R1 = all.reduce((s, [, g], k) => s + (g === 0 ? ranks[k] : 0), 0);
  const U = R1 - n1 * (n1 + 1) / 2, mu = n1 * n2 / 2;
  const sd = Math.sqrt(n1 * n2 / 12 * ((n + 1) - tieTerm / (n * (n - 1))));
  if (sd === 0) return 1;
  const z = Math.abs(U - mu) / sd;
  const erf = (x) => { const t = 1 / (1 + 0.3275911 * x); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return y; };
  return 2 * (1 - 0.5 * (1 + erf(z / Math.SQRT2)));
}
const fmtP = (p) => p < 0.001 ? '< 0.001' : p.toFixed(3);

// --- run --------------------------------------------------------------------------------
const browser = await launch(engine, () => server.close());
const times = {};        // workload -> impl -> [ms]
const outputs = {};      // workload -> impl -> first output line seen
const load = { cold: {}, warm: {} };
let version = browser.version();
try {
  // one page per implementation, kept open; a fresh VM per run
  const pages = {};
  if (only !== 'load') {
  for (const impl of IMPLS) {
    const page = await browser.newPage();
    page.on('pageerror', e => console.error(`[${impl} pageerror] ${e.message}`));
    await page.goto(`${base}/bench-page.html?impl=${impl}`);
    await page.evaluate(() => window.__bench.ready);
    if (await page.evaluate(detectEngine) !== engine) { console.error(`page ran on the wrong engine`); process.exit(1); }
    pages[impl] = page;
  }
  const names = Object.keys(workloads);
  for (let r = 0; r < rounds; r++) {
    for (const name of names) {
      const order = IMPLS.map((_, i) => IMPLS[(i + r) % IMPLS.length]);   // rotate who goes first
      for (const impl of order) {
        const res = await pages[impl].evaluate(async (src) => {
          window.__out.length = 0;
          const vm = await window.__bench.newVM();
          try {
            /* a page-driven workload (bridge_in): the page hands Lua 50,000 ten-byte strings */
            const ms = src.startsWith('-- the bridge, the other way') ? await vm.drive(src, 50000, 'ten bytes!') : await vm.run(src);
            return { ms, out: window.__out.join('') };
          }
          catch (e) { return { error: e.message, out: window.__out.join('') }; }
          finally { vm.close(); }
        }, workloads[name]);
        (times[name] ??= {})[impl] ??= [];
        (outputs[name] ??= {})[impl] ??= res.error ? `error: ${res.error}` : res.out;
        if (!res.error) times[name][impl].push(res.ms);
      }
    }
    process.stderr.write(`\rround ${r + 1}/${rounds}`);
  }
  process.stderr.write('\n');
  for (const impl of IMPLS) await pages[impl].close();
  }

  // load-to-first-print: cold = fresh context (empty cache); warm = same context again
  const loadRounds = Math.max(3, rounds >> 1);
  for (let r = 0; r < (only === 'work' ? 0 : loadRounds); r++) {
    for (const impl of IMPLS.map((_, i) => IMPLS[(i + r) % IMPLS.length])) {
      const context = await browser.newContext();
      const page = await context.newPage();
      const once = async () => {
        await page.goto(`${base}/load-${impl}.html`);
        await page.waitForFunction(() => window.__load && window.__load.firstPrint, null, { timeout: 60_000 });
        return page.evaluate(() => window.__load.firstPrint);
      };
      (load.cold[impl] ??= []).push(await once());
      (load.warm[impl] ??= []).push(await once());
      await context.close();
    }
    process.stderr.write(`\rload round ${r + 1}/${loadRounds}`);
  }
  process.stderr.write('\n');
} finally {
  await browser.close();
  server.close();
}

// --- the table -------------------------------------------------------------------------
const date = new Date().toISOString().slice(0, 10);
const lines = [];
lines.push(`Run: ${engine} ${version}, ${date}, lua.wasm at ${versions.luawasm}, Wasmoon ${versions.wasmoon}, fengari-web ${versions.fengari}; ${rounds} rotated rounds per workload on fresh instances, medians in ms; ratio = peer / lua.wasm (above 1: lua.wasm is faster); p = two-sided Mann-Whitney U.`);
lines.push('');
lines.push('| workload | lua.wasm | Wasmoon | ratio | p | fengari | ratio | p |');
lines.push('|---|--:|--:|--:|--:|--:|--:|--:|');
const json = { run: { engine, version, date, versions, rounds }, workloads: {}, load: {} };
for (const name of Object.keys(times)) {
  const ours = times[name].luawasm;
  const cells = [name, ours.length ? median(ours).toFixed(1) : outputs[name].luawasm];
  for (const impl of ['wasmoon', 'fengari']) {
    const t = times[name][impl];
    if (outputs[name][impl] !== outputs[name].luawasm) { cells.push(`output mismatch`, '—', '—'); continue; }
    if (!t.length || !ours.length) { cells.push(outputs[name][impl], '—', '—'); continue; }
    cells.push(median(t).toFixed(1), (median(t) / median(ours)).toFixed(2) + '×', fmtP(mannWhitneyP(ours, t)));
  }
  lines.push(`| ${cells.join(' | ')} |`);
  json.workloads[name] = { times: times[name], outputs: outputs[name] };
}
lines.push('');
lines.push(`Load to first print (ms from navigation; cold = fresh context, warm = cached; ${Math.max(3, rounds >> 1)} rounds):`);
lines.push('');
lines.push('| | lua.wasm | Wasmoon | ratio | fengari | ratio |');
lines.push('|---|--:|--:|--:|--:|--:|');
for (const kind of ['cold', 'warm']) {
  if (!load[kind].luawasm) continue;
  const ours = median(load[kind].luawasm);
  lines.push(`| ${kind} | ${ours.toFixed(0)} | ${median(load[kind].wasmoon).toFixed(0)} | ${(median(load[kind].wasmoon) / ours).toFixed(2)}× | ${median(load[kind].fengari).toFixed(0)} | ${(median(load[kind].fengari) / ours).toFixed(2)}× |`);
  json.load[kind] = load[kind];
}
const mismatches = Object.keys(outputs).filter(n => IMPLS.some(i => outputs[n][i] !== outputs[n].luawasm));
if (mismatches.length) lines.push('', `Output mismatches (not timed): ${mismatches.map(n => `${n}: ${IMPLS.map(i => `${LABEL[i]}=${JSON.stringify(outputs[n][i])}`).join(', ')}`).join('; ')}`);
console.log(lines.join('\n'));
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(json, null, 1));
