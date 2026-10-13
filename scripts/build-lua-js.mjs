// build-lua-js.mjs -- assemble lua.js, the one file a page includes:
// host.mjs (the module's JavaScript side, with its `export`s dropped),
// loader.js (the script-tag loader and the Lua global) and lua.wasm
// itself, carried as base64, in one classic-script IIFE. Nothing is
// fetched at run time (D8 row 12: one file, works from file://).
//
//   node scripts/build-lua-js.mjs <out.js> <lua.wasm>
//
// Prints the result's size raw and compressed, since the inline form's
// cost over the module alone is a claim the README makes.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const [out, wasm] = process.argv.slice(2);
if (!out || !wasm) { console.error('usage: node scripts/build-lua-js.mjs <out.js> <lua.wasm>'); process.exit(2); }

const host = readFileSync(join(here, 'host.mjs'), 'utf8').replace(/^export /gm, '');
const loader = readFileSync(join(here, 'loader.js'), 'utf8');
const bytes = readFileSync(wasm);
const b64 = bytes.toString('base64');
const inline = `const LUA_WASM_INLINE = () => { const s = atob(${JSON.stringify(b64)}); const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; };\n`;
const js = `/* lua.js -- stock Lua 5.4 in a web page: <script src="lua.js"></script> then <script type="text/lua">. lua.wasm (${bytes.length} bytes) is carried inside this file. https://github.com/andy-emerson/lua.wasm */\n` +
  `(() => {\n${inline}${host}\n${loader}\n})();\n`;
writeFileSync(out, js);
const buf = Buffer.from(js);
const size = (b) => `${b.length} bytes (${brotliCompressSync(b).length} brotli, ${gzipSync(b, { level: 9 }).length} gzip)`;
console.log(`${out}: ${size(buf)}; lua.wasm alone: ${size(bytes)}`);
