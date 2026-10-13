// lua-js-witness.mjs -- the witness for lua.js, the script-tag loader:
// one page per D8 row (scripts/browser/pages/*.html) opened in a real
// browser engine from a plain static server (no special headers), with
// assertions on what the page author would see -- the output elements,
// the error elements, the console -- for each default the design record
// promises.
//
//   node scripts/lua-js-witness.mjs <lua.js> <lua.wasm> --engine <chromium|firefox|webkit>
//
// --engine is required and never defaults; the three guards are in
// scripts/browser/engine.mjs. Exits 0 only if every case passes.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENGINES, detectEngine, launch } from './browser/engine.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
let engine;
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--engine') engine = argv[++i];
  else positional.push(argv[i]);
}
const [jsPath, wasmPath] = positional;
if (!jsPath || !wasmPath || !engine || !ENGINES.includes(engine)) {
  console.error('usage: node scripts/lua-js-witness.mjs <lua.js> <lua.wasm> --engine <chromium|firefox|webkit>');
  process.exit(2);
}

// --- static server: the loader, the module, the pages; no special headers ----
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname;
  try {
    let body, type;
    if (path === '/lua.js') { body = await readFile(resolve(jsPath)); type = 'text/javascript'; }
    else if (path === '/lua.wasm') { body = await readFile(resolve(wasmPath)); type = 'application/wasm'; }
    else if (/^\/pages\/[\w./-]+$/.test(path) && !path.includes('..')) {
      body = await readFile(join(here, 'browser', path));
      type = path.endsWith('.html') ? 'text/html' : path.endsWith('.json') ? 'application/json' : 'text/plain';
    }
    else { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  } catch { res.writeHead(404).end(); }
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;

// --- the cases: page, then assertions on what the page shows --------------------
// outputs(): the text of every .lua-output in document order; errors(): every
// .lua-error; console: the messages the page logged, by level.
const cases = [
  ['hello', async (p) => {
    eq('print lands on the page where the tag sits, in document order; the head tag prints at the end of the body',
      await p.outputs(), ['hello from Lua 5.4\n', '42\n', 'from head\n']);
    eq('one Lua state: x from the first tag is read by the second (no errors)', await p.errors(), []);
  }],
  ['error', async (p) => {
    eq('output before the error stays; the next tag runs in the same state', await p.outputs(), ['before\n', 'after\t7\n']);
    const errs = await p.errors();
    check('the error is on the page, named by the tag id and line', errs.length === 1 && errs[0].startsWith('first:4: boom'), errs);
    check('and in the console', p.console.error.some(m => m.includes('first:4: boom')), p.console.error);
  }],
  ['stdin', async (p) => {
    eq('data-stdin is what io.read sees, then end of input; no attribute is end of input at once',
      await p.outputs(), ['7\n\nrest of line\nnil\n', 'nil\ttrue\n']);
  }],
  ['exit', async (p) => {
    eq('os.exit flushes, shows its status; the next tag refuses', await p.outputs(), ['a\nunflushed[exit 3]\n']);
    const errs = await p.errors();
    check('the refusal names the status', errs.length === 1 && errs[0].startsWith('VM exited (status 3)'), errs);
    eq('Lua.exitCode', await p.page.evaluate(() => Lua.exitCode), 3);
  }],
  ['output', async (p) => {
    eq('data-output="#id" prints into that element', await p.page.evaluate(() => document.getElementById('target').textContent), 'to target\n');
    check('data-output="console" prints to the console only', p.console.log.includes('to console'), p.console.log);
    eq('and nothing else is on the page', await p.outputs(), ['to page\n']);
  }],
  ['files', async (p) => {
    const out = await p.outputs();
    eq('src runs the file; its require fetches util.lua, whose own require fetches deep/helper.lua; data-files is readable',
      out[0], 'main:\thello page (deep)\nlevels:\t[1,2,3]\nsecond require is the same table:\ttrue\n');
    eq('a loaded module is returned without a fetch, as require\'s one result; a require inside a C callback fails with the stock message plus the hint; a missing module fails',
      out[1].split('\n').slice(0, 2).join('\n'), 'true\t1\nfalse\ttrue\ttrue');
    check('the missing module\'s message is stock, with the fetch result appended', /^false\tmodule 'missing' not found:/.test(out[1].split('\n')[2]) && out[1].includes('HTTP 404'), out[1]);
    const errs = await p.errors();
    check('a src that does not exist reports on the page', errs.length === 1 && errs[0].includes('nowhere.lua: HTTP 404'), errs);
  }],
  ['time', async (p) => {
    /* the page is opened once per zone (see the loop below); the oracle is
       Intl itself, formatting the same instants in the same zone */
    const want = await p.page.evaluate((tz) => {
      const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
      const off = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longOffset' });
      const offAt = (t) => off.formatToParts(new Date(t * 1000)).find(x => x.type === 'timeZoneName').value;
      const jan = offAt(Date.UTC(2026, 0, 1) / 1000), jul = offAt(Date.UTC(2026, 6, 1) / 1000);
      return [1783000000, 1767000000, 1798000000, 2000000000].map(t => {
        const q = Object.fromEntries(fmt.formatToParts(new Date(t * 1000)).map(x => [x.type, x.value]));
        const isdst = offAt(t) !== (parseFloat(jan.replace('GMT', '').replace(':', '.')) <= parseFloat(jul.replace('GMT', '').replace(':', '.')) ? jan : jul);
        /* lua.js keeps a lettered abbreviation and writes +HHMM where Intl has none */
        const o = offAt(t), m = /GMT([+-])(\d\d):(\d\d)/.exec(o);
        const abbr = /^[A-Za-z]{3,6}$/.test(q.timeZoneName) ? q.timeZoneName : m ? `${m[1]}${m[2]}${m[3]}` : '+0000';
        return `${t}\t${q.year}-${q.month}-${q.day} ${q.hour}:${q.minute}:${q.second} ${abbr}\t${isdst}\ttrue\n`;
      }).join('');
    }, p.zone);
    eq(`os.date/os.time under ${p.zone} agree with Intl (summer, winter, southern summer, beyond the window)`, (await p.outputs())[0], want);
  }],
  ['jsapi', async (p) => {
    await p.page.waitForFunction(() => window.__api && window.__api.done, null, { timeout: 60_000 });
    const r = await p.page.evaluate(() => window.__api);
    check('the page script ran to the end', !r.error, r.error);
    check('Lua.run from JavaScript prints to the console and sees the tags\' state', p.console.log.includes('to the console\tset by the tag'), p.console.log);
    eq('Lua.run throws with the Lua message', r.thrown, 'mine:1: from js');
    eq('Lua.on(\'print\') redirects, null restores', r.redirected.join(''), 'ab\n');
    eq('files: put, read by Lua, written by Lua, get, list', [r.fileRound, r.listed], ['HELLO FILE', ['/data/in.txt', '/out.txt']]);
    eq('env reaches os.getenv', r.envseen, 'hi\n');
    eq('start/step: a lazy require is served, a message each way, finish', r.steps, [[1, 'ready hello js (deep)'], [1, 'got reply'], [0, null]]);
    eq('os.exit through Lua.run throws, records, and later calls refuse', [r.exit, r.afterExit], [['VM exited (status 9)', 9], 'VM exited (status 9)']);
  }],
  ['yield', async (p) => {
    eq('a yielding tag resumes each frame and finishes; the next tag waits', await p.outputs(), ['frame 1\nframe 2\nframe 3\nframe 4\nframe 5\ndone\n', 'second tag ran after\n']);
    const frames = await p.page.evaluate(() => window.__raf);
    check(`the yields spanned animation frames (${frames} requestAnimationFrame calls)`, frames >= 5, frames);
  }],
];

let failed = 0, passed = 0;
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; console.log(`  FAIL ${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`); }
}
function eq(name, got, want) { check(name, JSON.stringify(got) === JSON.stringify(want), { got, want }); }

const browser = await launch(engine, () => server.close());
try {
  const ZONES = ['America/New_York', 'Asia/Kolkata', 'Australia/Sydney'];
  for (const [name, assertions, zone] of cases.flatMap(c => c[0] === 'time' ? ZONES.map(z => [c[0], c[1], z]) : [c])) {
    console.log(`${name}.html${zone ? ` (${zone})` : ''}`);
    const context = await browser.newContext(zone ? { timezoneId: zone } : {});
    const page = await context.newPage();
    const con = { log: [], error: [], warning: [] };
    page.on('console', m => { (con[m.type()] ?? (con[m.type()] = [])).push(m.text()); });
    page.on('pageerror', e => con.error.push('[pageerror] ' + e.message));
    await page.addInitScript(() => { window.__raf = 0; const r = window.requestAnimationFrame; window.requestAnimationFrame = (f) => { window.__raf++; return r.call(window, f); }; });
    await page.goto(`${base}/pages/${name}.html`);
    await page.evaluate(() => Lua.ready.catch(() => {}));
    const detected = await page.evaluate(detectEngine);
    if (detected !== engine) { check(`page ran on ${engine}`, false, `ran on ${detected}`); await context.close(); continue; }
    const coi = await page.evaluate(() => self.crossOriginIsolated);
    check('crossOriginIsolated is false', coi === false, coi);
    const p = {
      page, console: con, zone,
      outputs: () => page.evaluate(() => Array.from(document.querySelectorAll('.lua-output')).map(e => e.textContent)),
      errors: () => page.evaluate(() => Array.from(document.querySelectorAll('.lua-error')).map(e => e.textContent)),
    };
    try { await assertions(p); }
    catch (e) { check(`${name}: assertions ran`, false, e.message); }
    await context.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`${passed} passed, ${failed} failed (${engine})`);
console.log(failed ? `LUA.JS WITNESS FAIL (${engine})` : `LUA.JS WITNESS PASS (${engine})`);
process.exit(failed ? 1 : 0);
