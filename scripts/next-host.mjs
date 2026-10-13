// next-host.mjs -- a host for the browser-native artifact, in plain
// JavaScript with no Node or browser dependency, so the Node witnesses and
// the browser page share it. It is also the reference for what any host
// has to provide: the three imports in module "luaw", and how the
// luaw_* exports are called (strings are copied into the module's memory
// with luaw_alloc; pointers returned by the module are read until NUL or
// to a length the module gives back).
//
//   const lua = await createLua(moduleOrBytes, { stdout, stderr, stdin, now });
//   lua.init(); lua.run('print(1)');
//
// Options: stdout(text), stderr(text) receive output as it is produced
// (decoded as a UTF-8 stream, so a multi-byte character split across two
// writes still decodes). stdin is a string or Uint8Array handed to Lua's
// reads until exhausted, then end of input. now() returns ms since the
// epoch (default: the sub-millisecond performance clock).

const enc = new TextEncoder();

export async function createLua(source, opts = {}) {
  const outDec = new TextDecoder(), errDec = new TextDecoder();
  let stdin = typeof opts.stdin === 'string' ? enc.encode(opts.stdin) : (opts.stdin ?? new Uint8Array());
  let memory;
  const imports = {
    luaw: {
      write: (fd, ptr, len) => {
        const bytes = new Uint8Array(memory.buffer, ptr, len);
        if (fd === 2) opts.stderr?.(errDec.decode(bytes, { stream: true }));
        else opts.stdout?.(outDec.decode(bytes, { stream: true }));
      },
      now: opts.now ?? (() => performance.timeOrigin + performance.now()),
      read: (ptr, maxlen) => {
        const n = Math.min(maxlen, stdin.length);
        new Uint8Array(memory.buffer, ptr, n).set(stdin.subarray(0, n));
        stdin = stdin.subarray(n);
        return n;
      },
    },
  };
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  const { exports: x } = await WebAssembly.instantiate(module, imports);
  memory = x.memory;
  x._initialize();

  const dec = new TextDecoder();
  const bytesOf = (s) => (typeof s === 'string' ? enc.encode(s) : s);
  const alloc = (bytes, nul = false) => {
    const p = x.luaw_alloc(bytes.length + (nul ? 1 : 0));
    const view = new Uint8Array(memory.buffer, p, bytes.length + (nul ? 1 : 0));
    view.set(bytes);
    if (nul) view[bytes.length] = 0;
    return p;
  };
  const withCString = (s, f) => { const p = alloc(enc.encode(s), true); try { return f(p); } finally { x.luaw_free(p); } };
  const withBytes = (b, f) => { const p = alloc(b); try { return f(p, b.length); } finally { x.luaw_free(p); } };
  const cstring = (p) => { if (!p) return null; const b = new Uint8Array(memory.buffer); let e = p; while (b[e]) e++; return dec.decode(b.subarray(p, e)); };
  const u32 = (p) => new DataView(memory.buffer).getUint32(p, true);

  const lua = {
    exports: x,
    memory,
    imports: WebAssembly.Module.imports(module).map(i => `${i.module}.${i.name}`).sort(),
    init: () => x.luaw_init(),
    lastError: () => cstring(x.luaw_last_error()),
    exitCode: () => x.luaw_exit_code(),
    /* run a chunk; returns the Lua status (0 ok); a trap (os.exit) propagates */
    run: (code, name = null) => withBytes(bytesOf(code), (p, n) =>
      name === null ? x.luaw_run(p, n, 0) : withCString(name, np => x.luaw_run(p, n, np))),
    start: (code, name = null) => withBytes(bytesOf(code), (p, n) =>
      name === null ? x.luaw_start(p, n, 0) : withCString(name, np => x.luaw_start(p, n, np))),
    /* one step of the resident program; msg (string/bytes) reaches its yield; returns the status */
    step: (msg = null) => msg === null ? x.luaw_step(0, 0) : withBytes(bytesOf(msg), (p, n) => x.luaw_step(p, n)),
    /* what the program yielded on the last step, as a string, or null */
    message: () => { const lp = x.luaw_alloc(4); try { const mp = x.luaw_message(lp); return mp ? dec.decode(new Uint8Array(memory.buffer, mp, u32(lp))) : null; } finally { x.luaw_free(lp); } },
    setenv: (name, value) => withCString(name, np => value == null ? x.luaw_setenv(np, 0) : withCString(value, vp => x.luaw_setenv(np, vp))),
    /* stock lua.c's main: main(['lua', '-e', 'print(1)']) -> exit status */
    main: (argv) => {
      const ptrs = argv.map(a => alloc(enc.encode(a), true));
      const arr = x.luaw_alloc(4 * (ptrs.length + 1));
      const dv = new DataView(memory.buffer);
      ptrs.forEach((p, i) => dv.setUint32(arr + 4 * i, p, true));
      dv.setUint32(arr + 4 * ptrs.length, 0, true);
      try { return x.luaw_main(ptrs.length, arr); }
      finally { x.luaw_free(arr); ptrs.forEach(p => x.luaw_free(p)); }
    },
    fs: {
      put: (path, data) => withCString(path, pp => withBytes(bytesOf(data), (dp, n) => x.luaw_fs_put(pp, dp, n))),
      get: (path) => withCString(path, pp => { const lp = x.luaw_alloc(4); try { const dp = x.luaw_fs_get(pp, lp); return dp ? new Uint8Array(memory.buffer, dp, u32(lp)).slice() : null; } finally { x.luaw_free(lp); } }),
      getText: (path) => { const b = lua.fs.get(path); return b ? dec.decode(b) : null; },
      remove: (path) => withCString(path, pp => x.luaw_fs_remove(pp)),
      mkdir: (path) => withCString(path, pp => x.luaw_fs_mkdir(pp)),
      list: () => { const p = x.luaw_fs_list(); const b = new Uint8Array(memory.buffer); const out = []; let i = p; while (b[i]) { let e = i; while (b[e]) e++; out.push(dec.decode(b.subarray(i, e))); i = e + 1; } return out; },
    },
  };
  return lua;
}
