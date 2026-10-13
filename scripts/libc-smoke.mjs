// libc-smoke.mjs -- host for port/test/libc-smoke.c: the three luaw
// imports, nothing else. Also the smallest complete example of what any
// host of the browser-native artifact provides.
//
//   node scripts/libc-smoke.mjs build/musl/libc-smoke.wasm
//
// Exits 0 only if the module imports exactly luaw.{write,now,read} and
// smoke() reports zero failed checks.
import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) { console.error('usage: node scripts/libc-smoke.mjs <libc-smoke.wasm>'); process.exit(2); }

let memory;
let stdin = Buffer.from('typed line\n');
const host = {
  write: (fd, ptr, len) =>
    (fd === 2 ? process.stderr : process.stdout).write(Buffer.from(memory.buffer, ptr, len).toString()),
  now: () => performance.timeOrigin + performance.now(),
  read: (ptr, maxlen) => {
    const n = Math.min(maxlen, stdin.length);
    new Uint8Array(memory.buffer, ptr, n).set(stdin.subarray(0, n));
    stdin = stdin.subarray(n);
    return n;
  },
};

const module = await WebAssembly.compile(readFileSync(file));
const imports = WebAssembly.Module.imports(module).map(i => `${i.module}.${i.name}`).sort();
const expected = ['luaw.now', 'luaw.read', 'luaw.write'];
if (imports.join() !== expected.join()) {
  console.error(`FAIL: imports are [${imports}], expected [${expected}]`);
  process.exit(1);
}
console.log(`imports: ${imports.join(' ')}`);

const { exports } = await WebAssembly.instantiate(module, { luaw: host });
memory = exports.memory;
exports._initialize();
const failed = exports.smoke();
process.exit(failed === 0 ? 0 : 1);
