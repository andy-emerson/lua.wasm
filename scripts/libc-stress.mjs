// libc-stress.mjs -- host for port/test/alloc-stress.c (see its header).
//
//   node scripts/libc-stress.mjs build/musl/alloc-stress.wasm
//
// Exits 0 only if stress() returns 0; a trap (out-of-bounds, unreachable)
// is a failure too.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/libc-stress.mjs <alloc-stress.wasm>'); process.exit(2); }

let memory;
const host = {
  write: (fd, ptr, len) =>
    (fd === 2 ? process.stderr : process.stdout).write(Buffer.from(memory.buffer, ptr, len).toString()),
  now: () => performance.timeOrigin + performance.now(),
  read: () => 0,
};
const { instance } = await WebAssembly.instantiate(readFileSync(file), { luaw: host });
memory = instance.exports.memory;
instance.exports._initialize();
const t = performance.now();
let rc;
try { rc = instance.exports.stress(); }
catch (e) { console.error(`TRAP: ${e.message}`); process.exit(1); }
console.log(`stress() -> ${rc} in ${Math.round(performance.now() - t)} ms`);
process.exit(rc === 0 ? 0 : 1);
