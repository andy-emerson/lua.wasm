// lua.mjs -- the `lua` command line on lua.wasm,
// under Node: stock lua.c (luaw_main) with the process's stdin, stdout,
// stderr and exit status, and a host directory mirrored into the
// in-memory filesystem.
//
//   node scripts/lua.mjs <lua.wasm> [--dir <host-dir>] [--env K=V]... \
//        [--tz <zone-file>] -- <lua args...>
//
//   node scripts/lua.mjs lua.wasm -- -e 'print(1)'
//   node scripts/lua.mjs lua.wasm --dir tests -- -e"_port=true" all.lua
//
// --dir copies every file under <host-dir> to the same relative path under
// "/", which is the module's working directory, so relative names in Lua
// work as they would with that directory as cwd. --env sets variables
// (LUA_INIT, LUA_PATH, TZ, ...). --tz puts a zone file at /etc/localtime.
// stdin is read whole before Lua starts (the read import answers from it;
// a terminal's typed input is not forwarded). The differential test
// (scripts/differential.sh) uses this as the wasm side.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createLua } from './host.mjs';

const argv = process.argv.slice(2);
const file = argv.shift();
let dir = null, tz = null;
const env = [];
while (argv.length && argv[0] !== '--') {
  const a = argv.shift();
  if (a === '--dir') dir = argv.shift();
  else if (a === '--env') env.push(argv.shift());
  else if (a === '--tz') tz = argv.shift();
  else { console.error(`unknown option ${a}`); process.exit(2); }
}
if (argv[0] === '--') argv.shift();
if (!file) { console.error('usage: node scripts/lua.mjs <lua.wasm> [--dir d] [--env K=V] [--tz zonefile] -- <lua args>'); process.exit(2); }

let stdin = new Uint8Array();
try { if (!process.stdin.isTTY) stdin = readFileSync(0); } catch { /* no stdin */ }

const lua = await createLua(readFileSync(file), {
  stdoutBytes: b => process.stdout.write(b),   /* bytes, untouched: Lua strings are bytes */
  stderrBytes: b => process.stderr.write(b),
  stdin,
});

if (dir) {
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) { lua.fs.mkdir('/' + relative(dir, p)); walk(p); }
      else lua.fs.put('/' + relative(dir, p), readFileSync(p));
    }
  };
  walk(dir);
}
if (tz) lua.fs.put('/etc/localtime', readFileSync(tz));
for (const kv of env) { const i = kv.indexOf('='); lua.setenv(kv.slice(0, i), kv.slice(i + 1)); }

let status;
try { status = lua.main(['lua', ...argv]); }
catch (e) {
  if (lua.lastError() === 'VM exited') status = lua.exitCode();   // os.exit: the trap carries the status
  else { console.error(`trap: ${e.message}`); status = 70; }
}
process.exitCode = status;
