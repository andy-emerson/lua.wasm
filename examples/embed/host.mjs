// host.mjs -- the smallest host for a module built from the tarball:
// the four imports of the host interface (doc/wasm.md), then the
// consumer's own entry point.
//
//   node host.mjs app.wasm      (exit status = app_run's result)
import { readFileSync } from 'node:fs';

const bytes = readFileSync(process.argv[2]);
let memory;                       // set once the module is instantiated
const text = new TextDecoder();
const imports = {
  luaw: {
    /* bytes for a file descriptor: 1 and 2 are stdout and stderr */
    write: (fd, ptr, len) => {
      const s = text.decode(new Uint8Array(memory.buffer, ptr, len));
      if (fd === 2) process.stderr.write(s); else process.stdout.write(s);
    },
    /* wall-clock milliseconds since the epoch (os.time, os.clock) */
    now: () => Date.now(),
    /* stdin: this host has none, so every read is end of file */
    read: (ptr, maxlen) => 0,
    /* the bridge to the page (the js library): this program does not
       register one, so every call is "no such name" (status 2) */
    call: (namePtr, nameLen, argsPtr, argsLen, outPtr) => 2,
  },
};
const { instance } = await WebAssembly.instantiate(bytes, imports);
memory = instance.exports.memory;
instance.exports._initialize();            // the reactor's libc setup
process.exitCode = instance.exports.app_run();
