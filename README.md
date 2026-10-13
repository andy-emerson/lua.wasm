# lua.wasm

**Stock Lua 5.4 for the browser — the reference interpreter on musl, in one file.**

```html
<script src="lua.js"></script>
<script type="text/lua">
  print("Hello from " .. _VERSION)
</script>
```

That is a complete page: `lua.js` carries the interpreter, `print` lands on the page where the tag sits, `require` fetches modules beside the page, `coroutine.yield()` animates a frame at a time, and local time is the visitor's. Underneath is `lua.wasm`: [PUC-Rio Lua](https://www.lua.org) 5.4.8, verbatim, compiled on upstream [musl](https://musl.libc.org) 1.2.6, verbatim, into one WebAssembly module with three small imports — no WASI, no Emscripten, no special headers — for anyone embedding the real Lua in a web app, in Node, or in any host that can supply three functions.

## Why you'd want it

There is no LuaJIT for WebAssembly, and there can't be one as it stands: wasm forbids runtime code generation (no JIT), and LuaJIT's interpreter is hand-written per-architecture assembly with no wasm backend (no fallback). Every Lua-in-wasm is therefore interpreter-class. lua.wasm owns that and makes the stock interpreter a good citizen of the browser:

- **Not a dialect, not a port.** Lua is verbatim 5.4.8 and the C library under it is verbatim musl; the reference behaviour is *stock Lua 5.4.8 on musl Linux, bugs included*, and a differential witness holds the artifact to it byte for byte. Language changes are out of scope.
- **One artifact, three imports.** `lua.wasm` imports `luaw.write` (stdout/stderr), `luaw.now` (the clock) and `luaw.read` (stdin), nothing else. The OS Lua expects — stdio, a clock, files, environment, `exit` — lives inside the module on the Linux syscall interface musl already speaks. No WASI emulation layer to copy into your page.
- **A plain page is enough.** No cross-origin isolation (no COOP/COEP headers), no SharedArrayBuffer, no workers, no Emscripten runtime, no build step. One `<script src="lua.js">` from a static server, a CDN or a file opened from disk; the witnesses assert `crossOriginIsolated === false`.
- **Errors stay inside.** Lua's error handling rides the standard WebAssembly exception-handling instructions — the artifact compiles as C++ to reach them — so `pcall` never round-trips through JavaScript and no setjmp/longjmp emulator is in the way.
- **The VM never blocks.** The host calls in and always gets control back. A long-lived program (a game's main loop) runs as a Lua coroutine the host resumes once per frame, exchanging a string message each way.

## Where it stands

lua.wasm is honest about maturity, so you can trust what it claims. Every claim below names its witness; the witnesses run on the release form of the file, so what is tested is what ships.

- **CI-enforced (re-witnessed on every change** by [`witness.yml`](.github/workflows/witness.yml)**):** `lua.js` passes its witness in **Chromium, Firefox and WebKit** (`scripts/lua-js-witness.mjs`: one page per promised behaviour — page output and errors, `src`, lazy `require` and `data-files`, one state per page, `data-stdin`, `os.exit`, per-frame yields, the `Lua` API, local time under three zones against `Intl`, and a page opened as `file://`); the vendored Lua core is verbatim stock 5.4.8 outside one declared file (`scripts/verify-stock.sh`) and the vendored musl is the signed 1.2.6 release (`scripts/verify-musl.sh`); the native ltests-instrumented interpreter passes the **full** official suite, C-API battery included, with zero skips; `lua.wasm` passes the host-interface witness (`scripts/interface-witness.mjs`: every import and export, the exit path, the message channel, and an adversarial battery — contained stack overflow, mid-flight program death and replacement, a 50k-frame pump, GC under allocation pressure), the **full official suite in portable mode** through stock `lua.c` under Node 24 (`scripts/suite-witness.mjs`), the same full suite **in three real browser engines** — Chromium, Firefox and WebKit, from a plain page, driven via Playwright by `scripts/browser-witness.mjs`, which refuses to report a pass unless the page truly ran in the named engine — and the **differential witness** (`scripts/differential.sh`): a corpus of scripts run on the artifact and on native Lua 5.4.8 built for x86_64-linux-musl must produce byte-identical stdout, stderr and exit status. The libc alone passes a smoke witness (printf/strtod exactness, errno, locale, stdin) and a 300,000-operation allocator stress with memory reuse.
- **Witnessed on demand and on every release tag (**[`deep-witness.yml`](.github/workflows/deep-witness.yml)**):** the same artifact built under plain llvm.org clang-20 with the Makefile defaults passes the interface, suite and differential witnesses — the build is not tied to one compiler driver. Retargeted at the cutover and not yet run on the musl build; its first green is this claim's evidence.
- **Stated, not yet witnessed:** the runtime floors. The artifact uses only the standard exception-handling encoding, which [webassembly.org's feature data](https://webassembly.org/features/) puts in Chrome 137, Firefox 131, Safari 18.4 and Node 24.15; CI runs current engines, not the floors. Sizes at this build (zig 0.15.1, binaryen 132, printed by `make`): `lua.wasm` 400,903 bytes (123,786 brotli); `lua.js` with the module inside 561,610 bytes (173,739 brotli) — one file costs about 40% more compressed.
- **Known and intended:** `os.setlocale("pt_BR")` returns `"pt_BR"` and keeps the `.` decimal point (musl implements no locale-specific numeric formatting; native Lua on musl does the same), so the official suite runs with a documented `LUA_INIT` prelude that reports the locale unavailable; `io.popen` and `os.execute` fail as on a machine with no shell; files live in memory inside the module and do not persist; `os.clock` is wall time since the VM was created, not CPU time (a browser has none to give — the one knowing divergence from native musl).

Two things it does not do yet: call JavaScript from Lua or pass objects across (a program and the page exchange a string per frame; the bridge is the next milestone, [#58](https://github.com/andy-emerson/lua.wasm/issues/58)), and run on engines older than the standard encoding.

## Use it

Put `lua.js` beside your page — downloaded from a [release](https://github.com/andy-emerson/lua.wasm/releases), or built with `make lua-js` — and write Lua in `<script type="text/lua">` tags. [`doc/lua-js.md`](doc/lua-js.md) is the reference: every tag attribute (`src`, `data-files`, `data-stdin`, `data-output`), how `require` fetches modules, animation by `coroutine.yield()`, what `os.exit` does to a page, local time, and the `Lua` global a page's own JavaScript gets — `Lua.run`, `Lua.start`/`step`, `Lua.files`, `Lua.env`, `Lua.on`.

## Build

Toolchain: **clang 20+** (the standard exception-handling encoding needs LLVM 20) with its wasm32 compiler-rt builtins, and Binaryen's `wasm-opt` for the release form. No sysroot: the libc is the vendored musl, built by the same `make`. `zig` 0.15.1 is a self-contained clang 20.1.2 that brings the builtins along, and is what CI uses:

```bash
pip install ziglang==0.15.1 && npm i binaryen@132.0.0
make wasm WASM_CC="python3 -m ziglang cc" MUSL_AR="python3 -m ziglang ar" \
          WASM_CLANGXX="python3 -m ziglang c++" \
          WASM_EXTRA="-Xclang -target-feature -Xclang +exception-handling" \
          WASM_OPT=node_modules/binaryen/bin/wasm-opt      # -> lua.wasm
make lua-js                                                 # -> lua.js, with lua.wasm inside
node scripts/lua.mjs lua.wasm -- script.lua                 # the lua command line, under Node
```

Plain clang-20 builds with the Makefile defaults: `make wasm MUSL_AR=llvm-ar-20`. Running the artifact needs a host with the standard wasm exception handling: a current browser, or **Node ≥ 24.15** (24.0–24.14 only with `--experimental-wasm-exnref`).

The native toolchain works as usual: `make guess` builds `src/lua` and `src/luac`.

[`doc/wasm.md`](doc/wasm.md) is the operational reference: what the module is made of, the host contract in full, running the official suite, the witnesses, and the sharp edges.

## Embed

The host instantiates `lua.wasm` with three imports in module `luaw` and drives it through these exports; every call returns, and no call blocks:

| export | contract |
| - | - |
| `luaw_init()` | create the VM (stdlib); 0 on success |
| `luaw_alloc(n)` / `luaw_free(p)` | buffers for passing chunks and strings in |
| `luaw_run(ptr, len, name)` | load + run a chunk to completion; returns a Lua status code (0 = ok) |
| `luaw_start(ptr, len, name)` | load a chunk as the resident program (a coroutine) |
| `luaw_step(msg, len)` | resume it one step with a message; `LUA_YIELD` (1) = alive, call again next frame; 0 = finished; else failed |
| `luaw_message(len_out)` | what the program `coroutine.yield`ed last, or null |
| `luaw_last_error()` | the last error message, or null; valid until the next entry call |
| `luaw_main(argc, argv)` | stock `lua.c`: the whole `lua` command line, arguments and all |
| `luaw_setenv(name, value)` | set (or, with null, remove) an environment variable; the environment starts empty |
| `luaw_fs_put/get/remove/list/mkdir` | the in-memory filesystem: `/` is the working directory, `/tmp` exists; `put` creates parents |
| `luaw_exit_code()` | after `os.exit`: its status |

`os.exit` flushes stdio, records its status and traps — the one thing that unwinds into the host; `pcall` cannot intercept it, and every later entry call refuses with "VM exited". [`scripts/host.mjs`](scripts/host.mjs) is a host in plain JavaScript — the inside of `lua.js`, shared with the Node witnesses — and the reference for calling all of this. In a page, the `Lua` global ([`doc/lua-js.md`](doc/lua-js.md)) is the same contract already wired up.

## Contributing

How work is planned, done, and reviewed here is the working agreement in [`AGENTS.md`](AGENTS.md) — vendored verbatim from [andy-emerson/working-agreement](https://github.com/andy-emerson/working-agreement) (CC BY 4.0; the version rides in its front matter, updated by replacing the file). Open work — todos, bugs, open decisions — lives in [GitHub Issues](https://github.com/andy-emerson/lua.wasm/issues).

The durable documents, each with one job and one primary reader:

| document | job | reader |
|---|---|---|
| this README | what the project is, where it stands, how to use, build and test it | anyone arriving |
| [`doc/lua-js.md`](doc/lua-js.md) | the reference for `lua.js`: tags, attributes, the `Lua` global, limits | the page author or web developer |
| [`doc/wasm.md`](doc/wasm.md) | the reference for `lua.wasm`: what it is made of, the host contract, the witnesses, the sharp edges | the embedder, and the developer of this repository |
| [`doc/history/`](doc/history/) | dated design records: decisions with their options, rejected alternatives and reopen conditions; removal records | the developer deciding whether to revisit something |
| comments in `port/`, `src/onelua.c`, `scripts/` | why each piece is the way it is, at the piece | the developer changing it |

The vendored Lua core is verbatim stock 5.4.8 except `luac.c`, enforced by [`scripts/verify-stock.sh`](scripts/verify-stock.sh); the vendored musl is verbatim 1.2.6, enforced by [`scripts/verify-musl.sh`](scripts/verify-musl.sh) — read their headers before touching `src/` or `third_party/musl/`. Everything of this project's own is in `port/` (the musl arch and the OS under it), `src/onelua.c` (the amalgamation and the `luaw_*` interface) and `scripts/`.

### Building

```bash
make guess       # native: src/lua, src/luac
make lua-debug   # the ltests-instrumented witness build
make wasm ...    # -> lua.wasm (toolchain variables as above; recipe in the Makefile header)
make oracle      # -> build/lua-musl, native Lua 5.4.8 on musl, the differential's reference
```

### Testing — the witnesses

A change is done when the witnesses covering it are green, not when it compiles:

```bash
# deepest: full official suite on the ltests build
# (C-API battery needs tests/libs built; stdin must be non-seekable)
make -C tests/libs LUA_DIR=../../src
cd tests && : | ../lua-debug all.lua                 # expect 'final OK !!!', zero 'testC not active'

# the artifact
make libc-smoke libc-stress ...                      # the libc alone
node scripts/interface-witness.mjs lua.wasm          # the host contract, 74 checks
node scripts/suite-witness.mjs lua.wasm tests        # full official suite, port mode, Node
node scripts/browser-witness.mjs lua.wasm --engine chromium   # and firefox, webkit (needs playwright)
make differential ...                                # byte-identical with native Lua on musl

# the page
make lua-js && node scripts/lua-js-witness.mjs lua.js lua.wasm --engine chromium   # and firefox, webkit
```

CI runs these: [`witness.yml`](.github/workflows/witness.yml) on every PR and push to `main`; [`deep-witness.yml`](.github/workflows/deep-witness.yml) on demand and on every release tag (plain clang-20). A red witness blocks the merge.

## Lineage

Built on [PUC-Rio's Lua](https://www.lua.org) and [musl](https://musl.libc.org). lua.wasm carries both verbatim toward a WebAssembly-targeting artifact — credited, not tracked: it defers to no living upstream and pins to no floating version (a weekly check flags a newer signed musl; updating is a deliberate commit).

Earlier generations were built for WASI — removed in the 2026-10 cutover to this design, because no browser provides WASI ([`doc/history/wasi-sunset-2026-10-13.md`](doc/history/wasi-sunset-2026-10-13.md)) — and carried [Hugo Musso Gualandi's lua-aot](https://github.com/hugomg/lua-aot-5.4), a research AOT compiler for Lua 5.4, removed in v0.2.0 when its wasm speedup measured marginal ([`doc/history/aot-sunset-2026-07-24.md`](doc/history/aot-sunset-2026-07-24.md)).
