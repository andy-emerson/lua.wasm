// browser-witness.mjs -- the browser witness:
// run the full official Lua test suite (portable mode) through stock lua.c
// inside lua.wasm, in a real browser engine -- Chromium (V8), Firefox
// (SpiderMonkey) or WebKit (JSC family) -- from a plain static page, and
// assert on the result.
//
//   node scripts/browser-witness.mjs <lua.wasm> --engine <chromium|firefox|webkit>
//        [--tests <dir>] [--argv '<json>'] [--expect TEXT]
//
// Defaults run the suite: the files of --tests (default tests/) are served
// as one JSON bundle, argv is ["lua","-e","_port=true","all.lua"], the
// environment carries the locale prelude in LUA_INIT and a PATH (see
// scripts/suite-witness.mjs for why), and the pass condition is exit 0 plus
// "final OK !!!" in the transcript. Any other script and argv can be given.
//
// The page is served with only a content-type header, and the witness
// asserts crossOriginIsolated is false in the page: no COOP/COEP, no
// SharedArrayBuffer, no workers are involved.
//
// --engine is REQUIRED and never defaults, with the three guards of
// scripts/browser/engine.mjs (no fallback engine, the launcher type, the
// page's own user-agent fingerprint).
import { createServer } from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';


import { LOCALE_PRELUDE } from './host.mjs';
import { ENGINES, launch } from './browser/engine.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// --- args ---------------------------------------------------------------------
const argv = process.argv.slice(2);
let engine, testsDir = 'tests', luaArgv = ['lua', '-e', '_port=true', 'all.lua'], expect = 'final OK !!!';
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--engine') engine = argv[++i];
  else if (argv[i] === '--tests') testsDir = argv[++i];
  else if (argv[i] === '--argv') luaArgv = JSON.parse(argv[++i]);
  else if (argv[i] === '--expect') expect = argv[++i];
  else positional.push(argv[i]);
}
const [wasmPath] = positional;
if (!wasmPath || !engine || !ENGINES.includes(engine)) {
  console.error('usage: node scripts/browser-witness.mjs <lua.wasm> --engine <chromium|firefox|webkit> [--tests <dir>] [--argv <json>] [--expect TEXT]');
  process.exit(2);
}

// --- the file bundle: every .lua in the tests directory, by name --------------
const files = {};
for (const name of await readdir(testsDir)) {
  if (name.endsWith('.lua')) files[name] = await readFile(join(testsDir, name), 'utf8');
}

// --- static server: fixed routes, zero special headers --------------------------
const routes = {
  '/lua-page.html': [() => readFile(resolve(here, 'browser/lua-page.html')), 'text/html'],
  '/host.mjs':  [() => readFile(resolve(here, 'host.mjs')), 'text/javascript'],
  '/lua.wasm':       [() => readFile(resolve(wasmPath)), 'application/wasm'],
  '/files.json':     [async () => JSON.stringify(files), 'application/json'],
};
const server = createServer(async (req, res) => {
  const route = routes[new URL(req.url, 'http://x').pathname];
  if (!route) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': route[1] });
  res.end(await route[0]());
});
await new Promise(ok => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;

// --- launch the REQUESTED engine, with no fallback (scripts/browser/engine.mjs)
const browser = await launch(engine, () => server.close());

try {
  {
    const page = await browser.newPage();
    page.on('pageerror', e => console.log(`[page error] ${e.message}`));
    const env = { LUA_INIT: LOCALE_PRELUDE, PATH: '/usr/bin:/bin' };
    const url = `${base}/lua-page.html?wasm=/lua.wasm&files=/files.json&argv=${encodeURIComponent(JSON.stringify(luaArgv))}&env=${encodeURIComponent(JSON.stringify(env))}`;
    await page.goto(url);
    await page.waitForFunction(() => window.__witness && window.__witness.done, null, { timeout: 300_000 });
    const r = await page.evaluate(() => window.__witness);
    console.log(r.transcript.split("\n").slice(r.exitCode === 0 ? -8 : -40).join("\n"));
    console.log(`(${engine} ${browser.version()}, detected-engine=${r.detected}, exit ${r.exitCode}, ${r.ms} ms, crossOriginIsolated=${r.coi}, imports=${(r.imports || []).join(',')})`);
    const engineOk = r.detected === engine;
    if (!engineOk) console.log(`ENGINE MISMATCH (runtime): requested ${engine}, page ran on ${r.detected} (ua: ${r.ua})`);
    const importsOk = (r.imports || []).join(',') === 'luaw.call,luaw.now,luaw.read,luaw.write';
    const pass = engineOk && r.exitCode === 0 && r.transcript.includes(expect) && r.coi === false && importsOk;
    console.log(pass ? `BROWSER WITNESS PASS (${engine})`
                     : `BROWSER WITNESS FAIL (${engine}: ${[!engineOk && 'wrong engine', r.exitCode !== 0 && `exit ${r.exitCode}`, !r.transcript.includes(expect) && `no "${expect}"`, r.coi !== false && 'crossOriginIsolated', !importsOk && 'imports'].filter(Boolean).join(', ')})`);
    process.exitCode = pass ? 0 : 1;
  }
} finally {
  await browser.close();
  server.close();
}
