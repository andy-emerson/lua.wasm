// next-suite.mjs -- the official Lua 5.4 test suite, in portable mode, on
// the browser-native artifact through luaw_main (stock lua.c), under Node.
//
//   node scripts/next-suite.mjs lua-next.wasm [tests-dir]
//
// The suite's files are copied into the module's in-memory filesystem
// (the suite loads them by relative name from the working directory,
// which is "/"), and run exactly as the CI command for the WASI artifact
// runs them: `lua -e"_port=true" all.lua`. all.lua prints "final OK !!!"
// when every file passed; the exit status is lua.c's.
//
// One test-setup adaptation, through LUA_INIT (which stock lua.c reads):
// musl claims os.setlocale("pt_BR") but keeps the '.' decimal point, and
// literals.lua asserts the decimal point changed, so the suite is told
// the locale is unavailable -- the same prelude scripts/suite-bundle.py
// documents. The artifact itself is unmodified musl behaviour.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createLua, LOCALE_PRELUDE } from './next-host.mjs';

const [file, dir = 'tests'] = process.argv.slice(2);
if (!file) { console.error('usage: node scripts/next-suite.mjs <lua.wasm> [tests-dir]'); process.exit(2); }

let sawFinalOK = false, tail = '';
const lua = await createLua(readFileSync(file), {
  stdout: s => { process.stdout.write(s); tail = (tail + s).slice(-200); if (tail.includes('final OK !!!')) sawFinalOK = true; },
  stderr: s => process.stderr.write(s),
});
const imports = lua.imports.join(',');
if (imports !== 'luaw.now,luaw.read,luaw.write') { console.error(`FAIL: imports are [${imports}]`); process.exit(1); }

let n = 0;
for (const name of readdirSync(dir)) {
  if (!name.endsWith('.lua')) continue;
  if (lua.fs.put('/' + name, readFileSync(join(dir, name))) !== 0) { console.error(`FAIL: could not put ${name}`); process.exit(1); }
  n++;
}
console.log(`[next-suite] ${n} suite files in the in-memory filesystem; running lua -e"_port=true" all.lua`);
lua.setenv('LUA_INIT', LOCALE_PRELUDE);
lua.setenv('PATH', '/usr/bin:/bin');   // files.lua asserts a process environment has one

const t = performance.now();
let status;
try { status = lua.main(['lua', '-e', '_port=true', 'all.lua']); }
catch (e) { console.error(`\nFAIL: the suite trapped: ${e.message} (exit code ${lua.exitCode()})`); process.exit(1); }
const ms = Math.round(performance.now() - t);
if (status !== 0 || !sawFinalOK) {
  console.error(`\nFAIL: lua exited ${status}${sawFinalOK ? '' : ', and "final OK !!!" was not printed'} (${ms} ms)`);
  process.exit(1);
}
console.log(`[next-suite] PASS: full official suite (_port mode) on ${file}, exit 0, "final OK !!!" seen (${ms} ms)`);
