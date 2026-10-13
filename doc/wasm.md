# Building and running lua.wasm

Operational reference for the `wasm` Makefile target. The README covers
*what* the artifact is and where it stands; this file covers *how* it is
made, the host contract in full, how to run it and the official suite,
the witnesses, and the sharp edges. The design and its decisions are in
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
`-wasm-use-legacy-eh=false`) needs LLVM 20 — with the wasm32 compiler-rt
builtins the driver links with `-nostdlib`. No sysroot: the libc is built
by the same `make`. `zig` 0.15.1 is a self-contained clang 20.1.2 that
carries the builtins, and is what CI uses:

```bash
pip install ziglang==0.15.1 && npm i binaryen@132.0.0
make wasm WASM_CC="python3 -m ziglang cc" MUSL_AR="python3 -m ziglang ar" \
          WASM_CLANGXX="python3 -m ziglang c++" \
          WASM_EXTRA="-Xclang -target-feature -Xclang +exception-handling" \
          WASM_OPT=node_modules/binaryen/bin/wasm-opt
```

(The `-Xclang` pair works around zig's own CPU-feature mapping not
enabling the wasm EH feature that `-fwasm-exceptions` implies under plain
clang.) Plain llvm.org clang-20 (`clang-20 lld-20 libclang-rt-20-dev-wasm32`)
builds with the Makefile defaults — `make wasm MUSL_AR=llvm-ar-20` —
and `deep-witness.yml` runs that build on demand and on every release tag. zig 0.16 (LLVM 21) miscompiles
this build: its backend rejects the micro-runtime's tag symbols.

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

`scripts/interface-witness.mjs lua.wasm` (77 checks): the import list,
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
- A file position is 64-bit but a file lives in 32-bit memory: a write
  that would end beyond 2 GiB fails with `EFBIG` ("File too large"),
  where Linux would extend a sparse file. The interface witness holds
  the edge (`f:seek("set", 2^32)` then a write).
- The clock origin `os.clock` counts from is one per module:
  `luaw_main` after `luaw_init` restarts it for both states.
