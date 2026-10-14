// host.mjs -- a host for lua.wasm, in plain
// JavaScript with no Node or browser dependency, so the Node witnesses and
// the browser page share it. It is also the reference for what any host
// has to provide: the four imports in module "luaw", and how the
// luaw_* exports are called (strings are copied into the module's memory
// with luaw_alloc; pointers returned by the module are read until NUL or
// to a length the module gives back).
//
//   const lua = await createLua(moduleOrBytes, { stdout, stderr, stdin, now });
//   lua.init(); lua.run('print(1)');
//   lua.js.add = (a, b) => a + b;        // Lua: js.call("add", 1, 2) -> 3
//
// The bridge (D11): lua.js is the table of functions Lua may call by
// name through the luaw.call import, and nothing else on this side is
// reachable. Values cross by copy in the encoding src/onelua.c
// documents: nil, booleans, integers (Lua integer <-> JS number when it
// is a safe integer, BigInt beyond that), floats, text (Lua string <->
// JS string, UTF-8), bytes (js.bytes(s) in Lua <-> Uint8Array here),
// tables (a Lua sequence <-> an Array; other keys <-> a plain object with
// string keys, or a Map when a key is not a string). Functions, objects
// with identity and cycles do not cross. A function that throws is
// returned to Lua as an error with the exception's message.
//
// Options: stdout(text), stderr(text) receive output as it is produced,
// decoded as a UTF-8 stream (a multi-byte character split across two
// writes still decodes; bytes that are not UTF-8 become U+FFFD). A host
// that must pass bytes through unchanged -- a command line, a file --
// gives stdoutBytes(Uint8Array) / stderrBytes(Uint8Array) instead. stdin
// is a string or Uint8Array handed to Lua's reads until exhausted, then
// end of input. now() returns ms since the epoch (default: the
// sub-millisecond performance clock).

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── the bridge encoding (little-endian; tag byte first) ────────────
const T = { NIL: 0, FALSE: 1, TRUE: 2, INT: 3, FLOAT: 4, TEXT: 5, BYTES: 6, TABLE: 7, ERROR: 8 };
const MAX_DEPTH = 64, MAX_BYTES = 16 << 20;

class Writer {
  constructor() { this.buf = new Uint8Array(256); this.len = 0; }
  need(n) {
    if (this.len + n > MAX_BYTES) throw new RangeError(`value does not cross: more than ${MAX_BYTES} bytes`);
    if (this.len + n > this.buf.length) { const b = new Uint8Array(Math.max(this.buf.length * 2, this.len + n)); b.set(this.buf); this.buf = b; }
  }
  u8(v) { this.need(1); this.buf[this.len++] = v; }
  u32(v) { this.need(4); new DataView(this.buf.buffer).setUint32(this.len, v, true); this.len += 4; }
  i64(v) { this.need(8); new DataView(this.buf.buffer).setBigInt64(this.len, v, true); this.len += 8; }
  f64(v) { this.need(8); new DataView(this.buf.buffer).setFloat64(this.len, v, true); this.len += 8; }
  bytes(b) { this.need(b.length); this.buf.set(b, this.len); this.len += b.length; }
  value(v, depth = 0) {
    if (v === null || v === undefined) this.u8(T.NIL);
    else if (v === false) this.u8(T.FALSE);
    else if (v === true) this.u8(T.TRUE);
    else if (typeof v === 'number') {
      if (Number.isSafeInteger(v) && !Object.is(v, -0)) { this.u8(T.INT); this.i64(BigInt(v)); }
      else { this.u8(T.FLOAT); this.f64(v); }
    }
    else if (typeof v === 'bigint') { this.u8(T.INT); this.i64(BigInt.asIntN(64, v)); }
    else if (typeof v === 'string') { const b = enc.encode(v); this.u8(T.TEXT); this.u32(b.length); this.bytes(b); }
    else if (v instanceof Uint8Array) { this.u8(T.BYTES); this.u32(v.length); this.bytes(v); }
    else if (v instanceof ArrayBuffer) this.value(new Uint8Array(v), depth);
    else if (ArrayBuffer.isView(v)) this.value(new Uint8Array(v.buffer, v.byteOffset, v.byteLength), depth);
    else if (typeof v === 'object') {
      if (depth >= MAX_DEPTH) throw new RangeError(`value does not cross: nesting deeper than ${MAX_DEPTH} (a cycle?)`);
      this.u8(T.TABLE);
      if (Array.isArray(v)) {
        this.u32(v.length);
        for (const e of v) this.value(e, depth + 1);
        this.u32(0);
      } else if (v instanceof Map) {
        this.u32(0); this.u32(v.size);
        for (const [k, e] of v) { if (k === null || k === undefined) throw new TypeError('value does not cross: nil key'); this.value(k, depth + 1); this.value(e, depth + 1); }
      } else {
        const keys = Object.keys(v);
        this.u32(0); this.u32(keys.length);
        for (const k of keys) { this.value(k, depth + 1); this.value(v[k], depth + 1); }
      }
    }
    else throw new TypeError(`value does not cross: ${typeof v}`);
  }
  result() { return this.buf.subarray(0, this.len); }
}

class Reader {
  constructor(bytes) { this.b = bytes; this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.pos = 0; }
  need(n) { if (this.pos + n > this.b.length) throw new RangeError('malformed value from the module'); }
  u8() { this.need(1); return this.b[this.pos++]; }
  u32() { this.need(4); const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  value(depth = 0) {
    if (depth > MAX_DEPTH) throw new RangeError('malformed value from the module (too deep)');
    const tag = this.u8();
    switch (tag) {
      case T.NIL: return null;
      case T.FALSE: return false;
      case T.TRUE: return true;
      case T.INT: { this.need(8); const v = this.dv.getBigInt64(this.pos, true); this.pos += 8; return (v >= -9007199254740991n && v <= 9007199254740991n) ? Number(v) : v; }
      case T.FLOAT: { this.need(8); const v = this.dv.getFloat64(this.pos, true); this.pos += 8; return v; }
      case T.TEXT: { const n = this.u32(); this.need(n); const s = dec.decode(this.b.subarray(this.pos, this.pos + n)); this.pos += n; return s; }
      case T.BYTES: { const n = this.u32(); this.need(n); const s = this.b.slice(this.pos, this.pos + n); this.pos += n; return s; }
      case T.TABLE: {
        const n = this.u32(), arr = [];
        for (let i = 0; i < n; i++) arr.push(this.value(depth + 1));
        const m = this.u32();
        if (m === 0) return arr;
        /* a hash part: an object when every key is a string, else a Map; the
           array part, if any, joins under its 1-based keys */
        const pairs = [];
        let allStrings = n === 0;
        for (let i = 0; i < m; i++) { const k = this.value(depth + 1), v = this.value(depth + 1); if (typeof k !== 'string') allStrings = false; pairs.push([k, v]); }
        if (allStrings) return Object.fromEntries(pairs);
        const map = new Map();
        arr.forEach((v, i) => map.set(i + 1, v));
        for (const [k, v] of pairs) map.set(k, v);
        return map;
      }
      default: throw new RangeError(`malformed value from the module (tag ${tag})`);
    }
  }
}

export function encodeValue(v) { const w = new Writer(); w.value(v); return w.result(); }
export function decodeValue(bytes) { return new Reader(bytes).value(); }

// The one test-setup adaptation the official suite needs on musl, as Lua
// source for LUA_INIT (stock lua.c runs it before the script): musl answers
// os.setlocale("pt_BR") with "pt_BR" but implements no locale-specific
// numeric formatting, and literals.lua asserts the decimal point changed
// after a successful setlocale -- native Lua on musl fails that assert too.
// The prelude tells the suite the locale is unavailable; the artifact is
// unmodified musl behaviour. The suite and browser witnesses both use it.
export const LOCALE_PRELUDE =
  "do local sl = os.setlocale os.setlocale = function (l, c) " +
  "if l ~= nil and l ~= '' and l ~= 'C' and l ~= 'POSIX' then return nil end " +
  "return sl(l, c) end end";

export async function createLua(source, opts = {}) {
  const outDec = new TextDecoder(), errDec = new TextDecoder();
  let stdin = typeof opts.stdin === 'string' ? enc.encode(opts.stdin) : (opts.stdin ?? new Uint8Array());
  let prompt = opts.prompt ?? null;   // () => string | null, asked when stdin is empty
  let memory;
  const fns = Object.create(null);   // lua.js: what Lua may call, by name
  const imports = {
    luaw: {
      /* the bridge: decode the arguments, call the registered function,
         hand the result (or the error) back in a buffer the module frees.
         0 = result, 1 = error value, 2 = no such name */
      call: (namePtr, nameLen, argsPtr, argsLen, outPtr) => {
        const name = dec.decode(new Uint8Array(memory.buffer, namePtr, nameLen));
        const fn = fns[name];
        if (typeof fn !== 'function') return 2;
        let status = 0, out;
        try {
          const r = new Reader(new Uint8Array(memory.buffer, argsPtr, argsLen).slice());
          const n = r.u32(), args = [];
          for (let i = 0; i < n; i++) args.push(r.value());
          const result = fn(...args);
          if (result !== null && typeof result === 'object' && typeof result.then === 'function')
            throw new TypeError('a promise does not cross yet (tokens arrive with the js library)');
          out = encodeValue(result);
        } catch (e) {
          status = 1;
          const w = new Writer();
          const msg = e && e.message !== undefined ? String(e.message) : String(e);
          const b = enc.encode(msg);
          w.u8(T.ERROR); w.u32(b.length); w.bytes(b);
          out = w.result();
        }
        const p = x.luaw_alloc(out.length);
        new Uint8Array(memory.buffer, p, out.length).set(out);   // the buffer may have moved: fresh view
        const dv = new DataView(memory.buffer);
        dv.setUint32(outPtr, p, true);
        dv.setUint32(outPtr + 4, out.length, true);
        return status;
      },
      write: (fd, ptr, len) => {
        const bytes = new Uint8Array(memory.buffer, ptr, len);
        if (fd === 2) {
          if (opts.stderrBytes) opts.stderrBytes(bytes.slice());
          else opts.stderr?.(errDec.decode(bytes, { stream: true }));
        } else {
          if (opts.stdoutBytes) opts.stdoutBytes(bytes.slice());
          else opts.stdout?.(outDec.decode(bytes, { stream: true }));
        }
      },
      now: opts.now ?? (() => performance.timeOrigin + performance.now()),
      read: (ptr, maxlen) => {
        if (stdin.length === 0 && prompt) {           // interactive: ask for a line
          const line = prompt();
          if (line !== null) stdin = enc.encode(line + '\n');
        }
        const n = Math.min(maxlen, stdin.length);
        new Uint8Array(memory.buffer, ptr, n).set(stdin.subarray(0, n));
        stdin = stdin.subarray(n);
        return n;
      },
    },
  };
  const module = source instanceof WebAssembly.Module ? source : await WebAssembly.compile(source);
  let x;
  ({ exports: x } = await WebAssembly.instantiate(module, imports));
  memory = x.memory;
  x._initialize();

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
    /* the bridge's table: lua.js.name = fn makes js.call("name", ...) work in Lua */
    js: fns,
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
    /* replace what stdin has left to give (a string or bytes; '' = end of input) */
    setStdin: (data) => { stdin = bytesOf(data ?? ''); },
    /* a function asked for a line (string, or null for end of input) whenever stdin is empty; null to stop asking */
    setPrompt: (fn) => { prompt = fn ?? null; },
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
