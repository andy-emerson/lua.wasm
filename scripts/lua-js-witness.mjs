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
    else if (/^\/pages\/[\w-]+\.html$/.test(path)) { body = await readFile(join(here, 'browser', path)); type = 'text/html'; }
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
  for (const [name, assertions] of cases) {
    console.log(`${name}.html`);
    const page = await browser.newPage();
    const con = { log: [], error: [], warning: [] };
    page.on('console', m => { (con[m.type()] ?? (con[m.type()] = [])).push(m.text()); });
    page.on('pageerror', e => con.error.push('[pageerror] ' + e.message));
    await page.addInitScript(() => { window.__raf = 0; const r = window.requestAnimationFrame; window.requestAnimationFrame = (f) => { window.__raf++; return r.call(window, f); }; });
    await page.goto(`${base}/pages/${name}.html`);
    await page.evaluate(() => Lua.ready.catch(() => {}));
    const detected = await page.evaluate(detectEngine);
    if (detected !== engine) { check(`page ran on ${engine}`, false, `ran on ${detected}`); await page.close(); continue; }
    const coi = await page.evaluate(() => self.crossOriginIsolated);
    check('crossOriginIsolated is false', coi === false, coi);
    const p = {
      page, console: con,
      outputs: () => page.evaluate(() => Array.from(document.querySelectorAll('.lua-output')).map(e => e.textContent)),
      errors: () => page.evaluate(() => Array.from(document.querySelectorAll('.lua-error')).map(e => e.textContent)),
    };
    try { await assertions(p); }
    catch (e) { check(`${name}: assertions ran`, false, e.message); }
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(`${passed} passed, ${failed} failed (${engine})`);
console.log(failed ? `LUA.JS WITNESS FAIL (${engine})` : `LUA.JS WITNESS PASS (${engine})`);
process.exit(failed ? 1 : 0);
