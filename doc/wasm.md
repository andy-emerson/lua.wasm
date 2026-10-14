# Building and running lua.wasm

Operational reference for the `wasm` and `sdk` Makefile targets. The
README covers *what* the artifact is and where it stands; this file
covers *how* it is made, the host contract in full, how a program with
compiled code of its own links it in, how to run it and the official
suite, the witnesses, and the sharp edges. The design and its decisions are in
[`history/browser-native-2026-10-13.md`](history/browser-native-2026-10-13.md).

## What it is made of

- **Lua**: `src/` is verbatim PUC-Rio 5.4.8, sources, headers and
  build Makefile, and `tests/` is the official test suite, verbatim
  (`scripts/verify-stock.sh` holds both to the release tarballs);
  `src/onelua.c` compiles
  it as one translation unit of plain C. `LUAI_THROW`/`LUAI_TRY` route
  to `port/luaw-eh.cpp`, the one C++ unit, whose `luaw_throw`/`luaw_try`
  ride wasm exception handling with a `catch(...)`-only micro-runtime
  (`__cxa_*`) in place of libc++abi; the exception object lives in a
  static slot, so a caught error allocates nothing, as native Lua's
  `longjmp` allocates nothing. `onelua.c` also carries the `luaw_*`
  host interface (`-DMAKE_REACTOR`).
- **The C library**: `third_party/musl` is verbatim musl 1.2.6
  (`scripts/verify-musl.sh`), compiled for `wasm32-freestanding` by
  `port/musl.mk` with the arch in `port/wasm32` — six headers (every
  `__syscallN` goes to one dispatcher; single-thread atomics; a thread
  pointer in static memory; two, `crt_arch.h` and `kstat.h`, are
  placeholders that nothing compiled here includes — musl's arch
  directories carry them for `crt1.c` and the pre-`statx` stat path) and
  a `bits/` directory that is riscv32's
  32-bit tables verbatim, except that `alltypes.h.in` makes `_Addr` and
  `_Reg` `long`, as clang's wasm32 `size_t` and `intptr_t` are. Only
  the source directories Lua reaches are compiled; the archive resolves
  lazily.
- **The OS**: `port/luaw-sys.c` answers musl's Linux syscalls inside the
  module — stdio as a terminal on fds 0–2 over the `write` and `read`
  imports, a clock over `now` whose reads never repeat an instant,
  `mmap` over 4 KiB pages with reuse (`brk` never moves; the allocator is
  musl's mallocng), `exit` as a trap — and `port/luaw-fs.c` is the
  in-memory filesystem: directories as entries, `/` and `/tmp` from the
  start, Linux errno and semantics wherever Lua can observe them,
  file-backed `mmap` as a copy (musl memory-maps zone files).
- **The crt**: `port/luaw-crt.c` exports `_initialize`, which runs the
  constructors (the thread-pointer setup, `libc.page_size`). No `main`;
  the module is a reactor.

## Toolchain and build

**clang 20+** — the standard EH encoding (`try_table`/`exnref`,
`-wasm-use-legacy-eh=false`) needs LLVM 20 — with LLVM's wasm32
compiler-rt builtins, which the link names explicitly since `-nostdlib`
adds no runtime (musl's `printf` and `frexpl` reach `__multf3` and its
kin). No sysroot: the libc is built by the same `make`. The Makefile
defaults are llvm.org's packages, and CI and the release build with
them:

```bash
sudo apt-get install clang-20 lld-20 libclang-rt-20-dev-wasm32   # from apt.llvm.org
npm i binaryen@132.0.0
make wasm MUSL_AR=llvm-ar-20 WASM_OPT=node_modules/binaryen/bin/wasm-opt
```

`zig` 0.15.1 (`pip install ziglang==0.15.1`) is a self-contained clang
20.1.2 and builds the same artifact without an apt repository:

```bash
make wasm WASM_CC="python3 -m ziglang cc" MUSL_AR="python3 -m ziglang ar" \
          WASM_CLANGXX="python3 -m ziglang c++" \
          WASM_EXTRA="-Xclang -target-feature -Xclang +exception-handling" \
          MUSL_RTLIB=/usr/lib/llvm-18/lib/clang/18/lib/wasi/libclang_rt.builtins-wasm32.a \
          WASM_OPT=node_modules/binaryen/bin/wasm-opt
```

Two things in that recipe are zig's: the `-Xclang` pair enables the
wasm EH feature that `-fwasm-exceptions` implies under plain clang, and
`MUSL_RTLIB` names LLVM's builtins archive (any version's; here
Ubuntu's `libclang-rt-18-dev-wasm32`) because `port/musl.mk` excludes
zig's own compiler-rt from the link (`-rtlib=none`): it is one object
whose weak symbols include a libm, and behind the archive `lua.wasm`
is linked from, lld keeps that over musl's `exp`, `log` and `sin` —
caught by the differential corpus (last-bit differences, `-nan` for
`log(-1)`). A zig link without `MUSL_RTLIB` stops with that message.
`deep-witness.yml` runs this recipe on demand and on every release
tag. zig 0.16 (LLVM 21) miscompiles this build: its backend rejects
the micro-runtime's tag symbols. The native musl oracle for the
differential is compiled with zig in every arrangement.

The release form is stripped at link (`--strip-all`) and passed through
Binaryen's `wasm-opt -O3` (`WASM_OPT`; empty skips it). `make wasm` prints
the size. Every witness runs on that file.

## The host contract

**Imports**, all in module `luaw`:

| import | contract |
| - | - |
| `write(fd, ptr, len)` | bytes for fd 1 (stdout) or 2 (stderr); musl's stdio treats fds 0–2 as a terminal (line-buffered stdout) |
| `now() -> f64` | milliseconds since the Unix epoch, fractional; the OS layer never returns the same instant twice, so a host clock with millisecond resolution (Firefox) is fine |
| `read(ptr, maxlen) -> n` | stdin: fill up to `maxlen` bytes and return the count, 0 for end of input; called only when Lua reads stdin and musl's buffer is empty |
| `call(name, nlen, args, alen, out) -> status` | the bridge: Lua calls the host's function `name` with `args` (an encoded buffer, below). The host writes the result into memory it gets from `luaw_alloc` and stores its pointer and length at `out[0]`, `out[1]`; returns 0 (a result), 1 (an error value: Lua raises its message), 2 (no such name). The module frees the buffer. A host must not re-enter the VM from inside this import (`luaw_run`, `luaw_step`...); `luaw_alloc` and `luaw_free` are fine. A host that knows no names returns 2 for every call, which is the default and the sandbox |

**The bridge's encoding** (values cross by copy, never by reference —
the design record's D11). Little-endian; a tag byte first:

| tag | value |
|---|---|
| 0 / 1 / 2 | nil / false / true |
| 3 | integer, i64 |
| 4 | float, f64 |
| 5 | text: u32 length, UTF-8 bytes (a Lua string going out; a JavaScript string coming in) |
| 6 | bytes: u32 length, bytes (`js.bytes(s)` going out; a `Uint8Array` coming in; a Lua string either way) |
| 7 | table: u32 n, n values (the array part 1..n), u32 m, m key/value pairs (the rest) |
| 8 | error: u32 length, message (host to module only; status 1) |
| 9 | token: u32 id (host to module only): a promise the host holds. Its settlement arrives later as one element of the list the reserved name `"\0poll"` returns — `{id, ok, value}` tables — the one name the host answers itself |

The argument buffer is u32 count then the values; a result is one
value. Limits, each refused with a stated reason: 16 MiB per buffer,
64 levels of nesting (where a cycle ends up), and functions, userdata
and threads, which do not cross. The reference encoder and decoder are
in `src/onelua.c` (the module side) and `scripts/host.mjs` (the host
side; `encodeValue`/`decodeValue` are exported for other hosts).

**The reactor's Lua libraries.** `luaw_init` registers two things on
its state that stock `lua.c` under `luaw_main` does not have: the `js`
library (`js.call(name, ...)`, `js.bytes(s)`, the direct form
`js.name(...)`, tokens with `:await()`, `:when(fn)` and `:settled()`,
`js.poll()`), and a `require` that fetches by yield — a module not in
the filesystem makes the resident program yield `"\0luaw:fetch:" ..
name`; the host puts `name.lua` (dots as directories) into the
filesystem and resumes with `"ok"`, or with a reason that `require`'s
error carries. Both are Lua source embedded in `src/onelua.c` and
installed by `luaw_openlibs(L)`, which a link-in consumer calls on its
own state after `luaL_openlibs` (#68). `luaw_step` and `luaw_run`
deliver settlements (a `"\0poll"` call) before running Lua, only while
a token is pending, so a program that never touches a promise pays
nothing per step. [`lua-js.md`](lua-js.md) describes the Lua-side API
as a page author sees it.

**Exports**: `memory`, `_initialize` (call once, first), the
`__cpp_exception` tag (an artifact of the EH encoding; never caught by
the host), and the `luaw_*` functions the README tabulates — exactly
these, asserted by the interface witness; nothing of Lua's C API or of
the libc is exported. Strings are
passed by copying them into the module's memory with `luaw_alloc`;
pointers the module returns are read until NUL or to the length it gives
back. `luaw_step(msg, len)` passes a string to the resident program as
the result of its `coroutine.yield`, and `luaw_message(len_out)` returns
the first value the program yielded (a string or a number) — the message
channel each way. `luaw_fs_list` returns NUL-separated paths,
double-NUL terminated. The reference host adds two conveniences over
the imports: `setStdin(data)` replaces what `read` has left to give,
and `setPrompt(fn)` asks `fn` for a line whenever it is empty (how a
page serves `data-stdin` and `data-stdin="prompt"`). [`../scripts/host.mjs`](../scripts/host.mjs) is
the reference for all of it; [`../scripts/browser/lua-page.html`](../scripts/browser/lua-page.html)
drives it from a page.

**`os.exit`** flushes stdio, records the status (`luaw_exit_code`) and
traps: a `WebAssembly.RuntimeError` reaches the host from whichever entry
call was running. `pcall` cannot intercept it (it is not an error), and
every later call that would run Lua — `luaw_init`, `luaw_run`,
`luaw_start`, `luaw_step`, `luaw_main` — returns a failure status with
`luaw_last_error` reading "VM exited"; `luaw_message` reads null. The
libc underneath is intact, so `luaw_fs_*`, `luaw_setenv`, `luaw_alloc`
and `luaw_free` keep working: a host can still collect the files a
program wrote before exiting. An uncaught stack overflow or a Lua
`error` never traps; they return a status code with the message in
`luaw_last_error`. `abort()` from inside the C library (an internal musl
failure) traps with exit code 134.

**Environment, time, files.** The environment starts empty; `luaw_setenv`
fills it (`LUA_INIT`, `LUA_PATH`, `TZ`, `PATH`...). Local time is musl's
own: `TZ` as a POSIX rule or a zone name under `/usr/share/zoneinfo`, or
`/etc/localtime` as a zone file the host put there, else UTC. Files are
in memory inside the module and do not persist; `/` is the working
directory. `io.popen` and `os.execute` fail as on a machine with no shell.

## Embedding it in your own module

A program with compiled code of its own — C, C++ or Rust for wasm32 —
that calls Lua's C API links Lua into the same module as that code,
from the tarball `make sdk` builds (`lua-wasm-sdk-<version>.tar.gz`,
attached to every release): `lib/liblua-wasm.a`, the archive `lua.wasm`
itself is linked from (`onelua.o`, the EH unit, the OS layer, the
filesystem, every musl object, by an MRI script since `ar` cannot nest
archives), `lib/crt-reactor.o`, `include/` (Lua's headers and the
libc's, as a sysroot's include directory), `src/` (the sources, a
fallback for unusual defines), `examples/embed/` and `PIN`.
[`sdk/LINK.md`](sdk/LINK.md), copied into the tarball, is the consumer's
document: the link line, the builtins archive, the zig note, the host's
four imports, `luaw_openlibs`, the `luaw_*` exports, and
`-DLUAW_EXTERNAL_EH` for a consumer with a real C++ runtime.

`lua.wasm` is that archive linked with `crt-reactor.o`,
`--export=luaw_init` and `--export-dynamic`, nothing else; `make
sdk-check` relinks it from the tarball's `lib/` alone and compares
bytes. `make embed-check` unpacks the tarball just built, builds
`examples/embed/app.c` against it with `EMBED_CC` (default `clang-20`;
`zig cc` with `EMBED_RT` naming the builtins), runs it under
`examples/embed/host.mjs` and compares output and exit status with
`expect.txt`. Both run in CI; the release gates on both and attaches
the tarball named for the tag. The embedding principle — why an
archive, why one crt, what was rejected — is in the design record.

## Running it

In a web page, use `lua.js` ([`lua-js.md`](lua-js.md)): it carries this
module and drives it the way described here. The rest of this section
is the module on its own.

```bash
node scripts/lua.mjs lua.wasm -- -e 'print(1)'
node scripts/lua.mjs lua.wasm --dir mydir --env TZ=UTC -- script.lua arg1
```

`scripts/lua.mjs` is the `lua` command line under Node (`luaw_main`
with the process's stdout, stderr and exit status, and its stdin read
whole before Lua starts — piped or redirected input works; a terminal's
typed input is not forwarded, so `lua -i` sees end of input); `--dir`
mirrors a host directory into the in-memory filesystem at `/`, `--env`
sets variables, `--tz` installs a zone file at `/etc/localtime`. Node ≥
24.15 runs the artifact as is; 24.0–24.14 need `--experimental-wasm-exnref`
(no script here passes it).

Note the **attached** form `-e"_port=true"` (no space) when a following
argument itself begins with `--`: it is ambiguous to the standalone
interpreter's argument scan otherwise.

## The official test suite

The suite's portability switch, `_port=true`, skips the checks that need
a shell or dynamic libraries. It is **required** here:

```bash
node scripts/suite-witness.mjs lua.wasm tests                    # Node
node scripts/browser-witness.mjs lua.wasm --engine chromium      # firefox, webkit
```

Both runners copy `tests/*.lua` into the in-memory filesystem and run
`lua -e"_port=true" all.lua` through `luaw_main`, passing on exit 0 plus
"final OK !!!". Two **test-setup adaptations**, neither a product change:

- `LUA_INIT` carries a prelude (`LOCALE_PRELUDE` in `scripts/host.mjs`)
  that makes `os.setlocale("pt_BR")` report failure. musl answers it with
  `"pt_BR"` but implements no locale-specific numeric formatting, and
  `literals.lua` asserts the decimal point changed after a successful
  `setlocale` — native Lua 5.4.8 on musl fails the same assertion. The
  artifact's behaviour is unmodified musl.
- `PATH` is set, because `files.lua` asserts a process environment has one.

The browser witness serves the page with only a content-type header and
asserts `crossOriginIsolated === false`. `--engine` is required and never
defaults; three guards (no fallback engine, Playwright's launcher type,
the page's own user-agent fingerprint) make it refuse to report a pass
unless the page ran in the named engine. It needs `playwright-core`
resolvable and the browser installed (`npx playwright install <engine>`).

## The differential witness

The reference behaviour is **Lua 5.4.8 on musl Linux, bugs included**.
`make oracle` builds that interpreter natively for `x86_64-linux-musl`
(zig's bundled musl, `-DLUA_USE_LINUX`, static); `make differential` runs
every script in `port/test/diff` on it and on the artifact with the same
working directory, stdin, environment and argv, and requires
byte-identical stdout, stderr and exit status. The corpus must avoid what
no two processes share: addresses, `os.tmpname`'s random part, timing,
memory counts. Any other difference is a bug in the port.

## The other witnesses

`scripts/interface-witness.mjs lua.wasm` (105 checks): the import list,
the export list (exact), every export's behaviour, the exit path, the
message channel, the filesystem, and the adversarial battery (contained
stack overflow, mid-flight program death and replacement, a 50k-frame
pump, GC under allocation pressure, 200k caught errors leaving linear
memory flat).
`make libc-smoke` (`port/test/libc-smoke.c`: printf and strtod
exactness, errno, locale, stdin through the `read` import) and `make
libc-stress` (`port/test/alloc-stress.c`: 300,000 allocator operations
and eight 64 MB map/unmap rounds proving page reuse) exercise the libc
without Lua. `node scripts/eh-check.mjs lua.wasm` reads the shipped
module with Binaryen and asserts that no function among the twenty
largest contains a `try_table`, and that between one and twelve small
functions do: the interpreter loop carries no landing pads, and Lua's
catch stays in the protected-call entry points where
`port/luaw-eh.cpp` put it. CI runs it after the interface witness.
`make sdk-check` and `make embed-check` (above) witness the tarball.

## Sharp edges

- `setvbuf` after I/O has happened is undefined behaviour in C; musl
  drops the pending buffer. Call it first, as the manual says.
- **`os.clock` is wall time since the VM was created** (`luaw_init` or
  `luaw_main`), not CPU time: a browser has no CPU-time source for the
  thread running wasm, so the one import that could supply it (`cpu()`)
  would only ever be answerable in Node. This is the one knowing
  divergence from native musl, where `clock()` is CPU time; the
  differential corpus excludes timing on both sides. Reopen if a
  non-browser host where CPU accounting matters asks for it.
- A clock that only advances by a nanosecond per repeated read keeps
  `os.clock` and `os.time` monotone, but back-to-back `os.clock` reads on
  a host with a coarse timer measure that nanosecond, not real time.
- A syscall the OS layer does not implement fails with `ENOSYS` (musl
  takes its fallback or reports the errno) and prints
  `luaw: unsupported syscall N` once per number on stderr, straight to
  the `write` import. Native Linux answers every syscall musl makes, so
  the line marks a gap in the port; the suite witness asserts it never
  appears, and the differential would show it as a stderr difference.
- `brk` never moves, so musl's allocator is entirely on `mmap`; memory
  grows in 4 KiB pages and freed pages are reused but never returned to
  the engine (`memory.grow` only ever grows).
- A poll that delivers tens of thousands of settlements at once is the
  allocator's high-water case: the list is decoded while its buffer is
  live, and linear memory grows by a few hundred KB per such batch,
  decelerating over batches — not a leak (batches of 2,000 are flat
  after a warm-up; the interface witness checks) but a peak a program
  that fires 20,000 promises between steps will see.
- A file position is 64-bit but a file lives in 32-bit memory: a write
  that would end beyond 2 GiB fails with `EFBIG` ("File too large"),
  where Linux would extend a sparse file. The interface witness holds
  the edge (`f:seek("set", 2^32)` then a write).
- The clock origin `os.clock` counts from is one per module:
  `luaw_main` after `luaw_init` restarts it for both states.
