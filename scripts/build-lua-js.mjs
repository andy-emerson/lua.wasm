// build-lua-js.mjs -- assemble lua.js, the one classic script a page
// includes: host.mjs (the module's JavaScript side, with its `export`s
// dropped) and loader.js (the script-tag loader) wrapped in one IIFE.
//
//   node scripts/build-lua-js.mjs <out.js> [--inline <lua.wasm>]
//
// Without --inline the loader fetches lua.wasm from beside lua.js. With it
// the module's bytes are carried inside lua.js as base64 (D8 row 12: one
// file) and nothing is fetched.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const out = argv.shift();
let inline = null;
while (argv.length) { const a = argv.shift(); if (a === '--inline') inline = argv.shift(); else { console.error(`unknown option ${a}`); process.exit(2); } }
if (!out) { console.error('usage: node scripts/build-lua-js.mjs <out.js> [--inline <lua.wasm>]'); process.exit(2); }

const host = readFileSync(join(here, 'host.mjs'), 'utf8').replace(/^export /gm, '');
const loader = readFileSync(join(here, 'loader.js'), 'utf8');
let prelude = '';
if (inline) {
  const b64 = readFileSync(inline).toString('base64');
  prelude = `const LUA_WASM_INLINE = () => { const s = atob(${JSON.stringify(b64)}); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; };\n`;
}
const js = `/* lua.js -- stock Lua 5.4 in a web page: <script src="lua.js"></script> then <script type="text/lua">. ${inline ? 'lua.wasm is carried inside this file.' : 'Loads lua.wasm from beside this file.'} https://github.com/andy-emerson/lua.wasm */\n` +
  `(() => {\n${prelude}${host}\n${loader}\n})();\n`;
writeFileSync(out, js);
console.log(`${out}: ${js.length} bytes${inline ? ' (lua.wasm inlined)' : ''}`);
