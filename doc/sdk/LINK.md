# Linking Lua from this tarball

Project: https://github.com/andy-emerson/lua.wasm — `PIN` names the
version and commit these bytes come from; `doc/` there holds the full
references this file points to.

This tarball is for a program with compiled code of its own — C, C++
or Rust built for wasm32 — that calls Lua's C API and so must link Lua
into the same module as that code. It holds the pieces `lua.wasm` is
linked from, already compiled, so what you link is the bytes the
release's witnesses ran on:

| path | what |
|---|---|
| `lib/liblua-wasm.a` | stock Lua 5.4.8 as one object (the C API, `lua.c`'s driver as `luaw_main`, the `luaw_*` host interface), the exception-handling unit, the OS layer, the in-memory filesystem, and every object of musl 1.2.6 |
| `lib/crt-reactor.o` | the C runtime entry: exports `_initialize`, which runs the libc's constructors; no `main`, no `_start` |
| `include/` | `lua.h`, `lauxlib.h`, `lualib.h`, `luaconf.h`, `lua.hpp`, and the libc's headers, laid out as a sysroot's include directory |
| `src/` | the sources the archive was built from (`onelua.c`, Lua's files, `port/`), a fallback for a build with unusual defines; not needed to link |
| `examples/embed/` | a C program linked this way, its build script, the smallest host, and what it prints |
| `PIN` | the version and commit these bytes come from |

Lua's behaviour in your module is stock Lua 5.4.8 on musl, bugs
included; the archive is the same file the project's `lua.wasm` is
linked from with nothing added, and the release checks that relink
byte for byte.

## The link line

C, with clang (any version for your own code; the archive was built
with clang 20 and needs nothing newer than that from you):

```sh
SDK=path/to/lua-wasm-sdk-<version>
clang --target=wasm32-freestanding -isystem $SDK/include -O2 -c app.c
clang --target=wasm32-freestanding -nostdlib \
      -Wl,--no-entry -Wl,-z,stack-size=8388608 \
      $SDK/lib/crt-reactor.o app.o -L$SDK/lib -llua-wasm \
      $(clang -print-resource-dir)/lib/wasi/libclang_rt.builtins-wasm32.a \
      -o app.wasm
```

Line by line:

- `-isystem $SDK/include`: Lua's headers and the libc's. Name it
  explicitly rather than through `--sysroot` alone; not every driver
  adds a sysroot include directory for a freestanding target.
- `-nostdlib`: the libc is in the archive; the driver must add none.
- `--no-entry`: a reactor. The host calls `_initialize` once, then your
  exports (`__attribute__((export_name("app_run")))`, or
  `-Wl,--export=name`).
- `stack-size`: Lua recurses on the C stack; the project links with
  8 MiB, and wasm-ld's default of 64 KiB overflows on a deep `pcall`.
- `crt-reactor.o` first, your objects, then `-llua-wasm`: the archive
  resolves lazily, so only what you reach is linked.
- the builtins archive last: musl's `printf` reaches 128-bit float
  helpers (`__multf3`, ...) that live in LLVM's compiler-rt builtins
  for wasm32. Distributions ship it as `libclang-rt-N-dev-wasm32`;
  `clang -print-resource-dir` names the directory it lives under (the
  path varies: `lib/wasi/`, `lib/wasm32-unknown-wasi/`, or `lib/`).
  **`zig cc`**: its bundled compiler-rt is one object whose weak
  symbols include a libm, and behind an archive the linker keeps that
  over musl's `exp`, `log`, `sin`; pass `-rtlib=none` and name LLVM's
  builtins archive as above. `examples/embed/build.sh` does both.

`examples/embed/build.sh $SDK` runs exactly this; `node
examples/embed/host.mjs app.wasm` runs the result and
`examples/embed/expect.txt` is what it prints. The release that
produced this tarball built and ran the example with clang 20 before
tagging; the project's deep witness repeats it with `zig cc` as the
consumer after the tag, and it has been run by hand with clang 18.

Rust (derived from the C line; not run by this project's CI):
target `wasm32-unknown-unknown`, `cargo:rustc-link-search=$SDK/lib`
and `cargo:rustc-link-lib=static=lua-wasm` from a build script,
`crt-reactor.o` and the builtins archive as `-C link-arg=`, the same
`--no-entry` and stack size, and the four imports declared under
`#[link(wasm_import_module = "luaw")]`.

Optimizing the module afterwards is yours: the project ships
`lua.wasm` through `wasm-opt -O3 --enable-exception-handling
--enable-bulk-memory --enable-nontrapping-float-to-int
--enable-sign-ext --enable-mutable-globals --enable-multivalue
--enable-reference-types`.

## What the host supplies

The module imports four functions in module `luaw`, whatever you
reach of the archive, because stdio, the clock and the bridge sit on
them. Signatures and the value encoding are in the repository's
`doc/wasm.md`; the minimum:

| import | the host's job |
|---|---|
| `write(fd, ptr, len)` | bytes for stdout (1) or stderr (2) |
| `now() -> f64` | milliseconds since the epoch |
| `read(ptr, maxlen) -> n` | stdin; 0 is end of input |
| `call(name, nlen, args, alen, out) -> status` | the bridge for the `js` library; a host with nothing to offer returns 2 (no such name) for every call |

`examples/embed/host.mjs` is these four in thirty lines, for Node.
The module runs where the standard wasm exception-handling encoding
runs: Chrome 137, Firefox 131, Safari 18.4, Node 24.15 and later.

Besides your exports, the module exports `memory`, `_initialize` and
`luaw_fs_*` (the in-memory filesystem's host side, pulled in with the
libc's `open`; harmless to ignore).

## What else the archive offers

- **`luaw_openlibs(lua_State *L)`**: the `js` library (`js.name(...)`
  to the host's `call`, tokens for promises) and the fetching
  `require` on a state of yours, after `luaL_openlibs`. Declare it
  yourself: `void luaw_openlibs(lua_State *L);` — no header declares
  it.
- **The `luaw_*` host interface** (`luaw_init`, `luaw_run`,
  `luaw_start`/`luaw_step`, `luaw_main`, the filesystem and
  environment calls; the README tabulates them): export what you want
  with `-Wl,--export=luaw_init` and so on. `lua.wasm` is this archive
  with `--export=luaw_init`, `--export-dynamic` and `--strip-all` (the
  `--no-entry` and stack size above), nothing else, then `wasm-opt`.
- **A real C++ runtime of your own** (a libc++abi built with wasm
  exceptions): compile `src/port/luaw-eh.cpp` yourself with
  `-fwasm-exceptions -mllvm -wasm-use-legacy-eh=false
  -DLUAW_EXTERNAL_EH` and put the object before `-llua-wasm`; its
  `luaw_throw`/`luaw_try` then replace the archive's, and the
  micro-runtime (`__cxa_*` for `catch(...)` only) stays out, so Lua's
  errors and your exceptions travel one exception domain. Witnessed by
  its consumer, not here.

## What it is not

Not a WASI module (no `_start`, no `wasi_snapshot_preview1`), not an
Emscripten build, not dynamically linkable: a finished `lua.wasm`
cannot take your code; you link the archive. The project's README has
the full list of what is out of scope and what would reopen each.
