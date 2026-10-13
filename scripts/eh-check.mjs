// eh-check.mjs -- witness that wasm exception handling stays out of the
// interpreter loop. Lua's catch lives in port/luaw-eh.cpp's luaw_try,
// called only from luaD_rawrunprotected; the interpreter compiles as
// plain C with no landing pads, which is what keeps the hot loop
// optimizable (doc/history/perf-research-2026-10-13.md). Binaryen's
// post-link inlining copies the catch into the protected-call entry
// points (eight small functions: pcall, resume, the parser guard...);
// measured neutral, so it is allowed. What must never happen is a
// landing pad inside the VM loop or another large function, and that is
// checked without names (the shipped module has none): no function that
// contains a try_table may be among the module's largest, and the count
// of such functions stays small.
//
//   node scripts/eh-check.mjs <lua.wasm>
//
// Needs binaryen (npm) resolvable: it parses the module and reads each
// function's body.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/eh-check.mjs <lua.wasm>'); process.exit(2); }
const require = createRequire(process.cwd() + '/noop.js');
const binaryen = (await import(pathToFileURL(require.resolve('binaryen')))).default;   // an ES module with top-level await

const module = binaryen.readBinary(readFileSync(file));
const sizes = [];                        // [text length, has try_table] per function
for (let i = 0; i < module.getNumFunctions(); i++) {
  const info = binaryen.getFunctionInfo(module.getFunctionByIndex(i));
  if (!info.body) continue;              // an import
  const text = binaryen.emitText(info.body);
  sizes.push([text.length, text.includes('try_table'), info.name]);
}
module.dispose();
sizes.sort((a, b) => b[0] - a[0]);
const withTry = sizes.filter(s => s[1]);
const rankOf = (s) => sizes.indexOf(s) + 1;
console.log(`${file}: ${sizes.length} functions, ${withTry.length} containing try_table (size ranks ${withTry.map(rankOf).join(', ')} of ${sizes.length}; the largest function is ${sizes[0][0]} chars of text, the largest with try_table ${withTry[0]?.[0] ?? 0})`);
const MAX_WITH_TRY = 12, TOP = 20;
const inTop = withTry.filter(s => rankOf(s) <= TOP);
if (withTry.length < 1 || withTry.length > MAX_WITH_TRY || inTop.length) {
  console.error(`FAIL: ${inTop.length ? `a function among the ${TOP} largest carries a try_table (the VM loop or another hot function has landing pads)` : `expected 1..${MAX_WITH_TRY} functions with try_table, found ${withTry.length}`}`);
  process.exit(1);
}
console.log('EH CHECK PASS: landing pads only in small protected-call entry points; the interpreter loop carries none');
