# lua.wasm

**Embeddable Lua 5.4 for WebAssembly — the reference interpreter, in one artifact.**

lua.wasm is [PUC-Rio Lua](https://www.lua.org) 5.4.8 built to run inside a WebAssembly host: the stock interpreter in a single `.wasm` module you embed. If you have a wasm host and need a Lua VM in it, this is built for you.

## Why you'd want it

There is no LuaJIT for WebAssembly, and there can't be one as it stands: wasm forbids runtime code generation (no JIT), and LuaJIT's interpreter is hand-written per-architecture assembly with no wasm backend (no fallback). Every Lua-in-wasm is therefore interpreter-class. lua.wasm owns that instead of hiding it — the stock, well-maintained Lua 5.4 interpreter, in a wasm module built to be a good citizen of its host:

- **Interpreter for dynamic code.** Code that arrives at runtime runs on the stock, well-maintained Lua 5.4 interpreter.
- **One artifact.** One build produces one `.wasm` module, not a constellation of glue files.
- **Plain clang / WASI. No Emscripten.** Lua is portable C and needs no platform emulator. Error handling rides the WebAssembly exception-handling proposal — the artifact compiles as C++ to reach it — so there's no setjmp/longjmp emulator in the way.
- **The VM never blocks.** The host calls in and always gets control back. A long-lived program (a game's main loop) runs as a Lua coroutine that yields once per frame — no threads, no SharedArrayBuffer, no Asyncify.
- **Not a dialect.** It tracks Lua 5.4.8 and stays bit-compatible with upstream. Language changes are out of scope.

## Where it stands

lua.wasm is honest about maturity, so you can trust what it claims.

- **Solid today (verified here):** the native interpreter runs the **full official Lua 5.4 test suite** under the ltests-instrumented build — checked allocator, internal assertions, the C-API battery — passing cleanly.
- **CI-enforced (re-witnessed on every change** by [`.github/workflows/witness.yml`](.github/workflows/witness.yml)**):** the vendored core is verbatim stock 5.4.8 outside one declared file (`scripts/verify-stock.sh`); the native ltests-instrumented interpreter passes the **full** official suite — the C-API `testC` battery included, with `tests/libs` built and zero skips; the wasm interpreter passes the **full official suite on two engines** — wasmtime (the first non-V8 engine to run lua.wasm) and Node 24.15+ (V8, default-on exnref) — plus the suite-prefix witness **in three real browser engines** — Chromium (V8 as browsers ship it), Firefox 151 (SpiderMonkey), and WebKit 26.5 (JSC family) — driven via Playwright by `scripts/browser-witness.mjs`, which refuses to report a pass unless the page truly ran in the named engine; the embeddable reactor passes its host-interface witness (`scripts/embed-demo.mjs`) and a 12-check stress battery (`scripts/reactor-stress.mjs`: contained stack overflow, mid-flight program death and replacement, a 50k-frame pump, GC under allocation pressure); and the link-Lua-in consumer shape passes both its witnesses (`examples/embed/`) — a plain-C downstream driving embedded Lua and catching a Lua error across the wasm-EH boundary, plus a C++ downstream catching its own **typed** exception through a real wasm-EH libc++abi with the bundled shim suppressed (`WASM_EH=external`).
- **Witnessed on demand and on every release tag (**[`deep-witness.yml`](.github/workflows/deep-witness.yml)**):** the artifact builds and passes the full suite on both engines under plain llvm.org clang-20 with Makefile defaults. This re-runs when dispatched and on every release tag, not on every push — the heavy tier is deliberate, not continuous.
- **A host-crash on old V8, resolved by engine version:** an external bring-up audit (love-wasi, 2026-07-05, against pin `945f810`) found the suite's to-be-closed/coroutine region **segfaulting the host process** on Node 22. Cross-checking against wasmtime and Chromium 141 shows it to be a V8 12.x-era engine defect (both its EH paths), fixed in current V8: the same artifact and test pass clean there. The artifact was never at fault. Engines in that window (Node 22/23) remain exposed — current Node 22 LTS (22.22.2) now *compiles* the artifact and still crashes the same way (re-witnessed 2026-07-06). Separately, Node 24.0–24.14 refuse the standardized encoding without `--experimental-wasm-exnref`; 24.15 is the first to take it by default, so the floor is stated precisely as **Node ≥ 24.15**. Full triage in [`doc/history/wasm-audit-2026-07-05.md`](doc/history/wasm-audit-2026-07-05.md) and its 2026-07-06 addendum.

Every claimed path is witnessed: the interpreter paths (native, wasmtime, Node, browser, reactor) and the vendored-core provenance continuously on every change.

**In progress — a browser-native artifact.** The artifact above is built for WASI; a browser can only run it through a WASI emulation layer, which is the wrong interface for the stated purpose. The replacement runs stock Lua on upstream **musl** with three plain imports (`write`, `now`, `read`) and no Emscripten, and lands in four merges ([`doc/history/browser-native-2026-10-13.md`](doc/history/browser-native-2026-10-13.md) has the decisions, their options and the spike evidence). Two are in. [`third_party/musl`](third_party/musl) is verbatim signed **musl 1.2.6**, checked on every change by [`scripts/verify-musl.sh`](scripts/verify-musl.sh), with [`musl-upstream.yml`](.github/workflows/musl-upstream.yml) flagging a newer signed release weekly. And **`lua-next.wasm`** — stock Lua 5.4.8 on that musl, compiled for wasm32 by [`port/musl.mk`](port/musl.mk) with the OS under it in [`port/`](port/) — builds beside the WASI artifacts and is **CI-witnessed on every change** (`witness.yml`, jobs `next` and `next-browser`): it imports exactly `luaw.{write,now,read}`; passes the **full official suite** through stock `lua.c` under Node 24 and in **Chromium, Firefox and WebKit** from a plain page with no special headers; is **byte-identical to native Lua 5.4.8 on musl** across a differential corpus (stdout, stderr, exit status); and passes its host-interface witness and the libc's own smoke and allocator-stress witnesses. Release form 400,450 bytes (123,706 brotli), measured at build. It is not released and not yet `lua.wasm`: the cutover (merge 3) and the `lua.js` loader (merge 4) follow. [`doc/wasm.md`](doc/wasm.md#the-browser-native-artifact-lua-nextwasm-pre-cutover) has the contract and the witnesses.

## Build and run

Toolchain: **clang 20+** with a wasi-libc sysroot (the standardized wasm-EH encoding needs LLVM 20; `zig c++` works as a self-contained clang-20+ — recipe in the Makefile). clang 18/19 can still build the pre-standard encoding via `WASM_EH_ENCODING=legacy`, at the cost of every non-V8 runtime. Running the artifact needs a WASI host with wasm exception handling — **Node ≥ 24.15** (24.0–24.14 only with `--experimental-wasm-exnref`), a current browser, or **wasmtime** (`scripts/wasmtime-run.py`).

```bash
make wasm                                 # -> lua.wasm (the interpreter, as wasm)
node scripts/wasm-run.mjs lua.wasm script.lua
```

The native toolchain works as usual: `make guess` builds `src/lua` and `src/luac`.

[`doc/wasm.md`](doc/wasm.md) is the operational reference for the wasm build: the `WASM_EH` exception-handling runtime knob (internal shim vs. an external libc++abi for embedders needing typed catches), running the official test suite under wasm (`_port=true`), and the sharp edges.

## Embed

`make wasm-lib` builds `lua-lib.wasm`, a wasm *reactor*: the host instantiates it, calls in, and always gets control back. The interface is WASI (stdio arrives as `fd_write`; hook fds 1 and 2 to capture `print`) plus these exports:

| export | contract |
| - | - |
| `luaw_init()` | create the VM (stdlib); 0 on success |
| `luaw_alloc(n)` / `luaw_free(p)` | buffers for passing chunks in |
| `luaw_run(ptr, len, name)` | load + run a chunk to completion; returns a Lua status code (0 = ok) |
| `luaw_start(ptr, len, name)` | load a chunk as the resident program (a coroutine) |
| `luaw_step()` | resume it one step: `LUA_YIELD` (1) = alive, call again next frame; 0 = finished; else failed |
| `luaw_last_error()` | the last error message, or null; valid until the next entry call |

Errors never unwind into the host, and no call blocks. [`scripts/embed-demo.mjs`](scripts/embed-demo.mjs) is the reference host and the witness for the whole interface; [`scripts/reactor-stress.mjs`](scripts/reactor-stress.mjs) is its adversarial counterpart (contained stack overflow, mid-flight death and replacement, 50k-frame pump, GC pressure). Both run in CI.

That is one consumer shape — a host *wrapping* the finished module. The other is a **C/C++ project targeting wasm32-wasi that links Lua *in***, driving it through `lua.h` inside its own artifact (the shape love-wasm uses). [`doc/embedding.md`](doc/embedding.md) is the contract for it — the flag requirements, the source-drop and `make liblua.a` paths, and the internal-vs-external exception runtime. [`examples/embed/`](examples/embed/) is the worked, CI-run witness: a plain-C downstream that links Lua in, drives embedded Lua, and catches a Lua error across the boundary.

## Contributing

How work is planned, done, and reviewed here is the working agreement in [`AGENTS.md`](AGENTS.md) — vendored verbatim from [andy-emerson/working-agreement](https://github.com/andy-emerson/working-agreement) (CC BY 4.0; the version rides in its front matter, updated by replacing the file). Open work — todos, bugs, open decisions — lives in [GitHub Issues](https://github.com/andy-emerson/lua.wasm/issues); the design lives in [`doc/`](doc/) (`wasm.md`, `embedding.md`), with dated records under [`doc/history/`](doc/history/). The vendored Lua core is verbatim stock 5.4.8 except `luac.c`, enforced by [`scripts/verify-stock.sh`](scripts/verify-stock.sh) — read its header before touching `src/`. The vendored C library is verbatim signed musl 1.2.6, enforced by [`scripts/verify-musl.sh`](scripts/verify-musl.sh) — its header has the refresh steps.

### Building

```bash
make guess       # native: src/lua, src/luac
make lua-debug   # the ltests-instrumented witness build
make wasm        # -> lua.wasm  (needs clang 20+ / zig c++; recipe in the Makefile header)
```

### Testing — the witnesses

A change is done when the witnesses covering it are green, not when it compiles:

```bash
# deepest: full official suite on the ltests build
# (C-API battery needs tests/libs built; stdin must be non-seekable)
make -C tests/libs LUA_DIR=../../src
cd tests && : | ../lua-debug all.lua                              # expect 'final OK !!!', zero 'testC not active'

# the wasm artifact, both engines
cd tests && node ../scripts/wasm-run.mjs ../lua.wasm -e"_port=true" all.lua
cd tests && python3 ../scripts/wasmtime-run.py ../lua.wasm -e"_port=true" all.lua
```

CI runs these: [`witness.yml`](.github/workflows/witness.yml) on every PR and push to `main` (suite on native + two wasm engines + Chromium, the embed witnesses, provenance); [`deep-witness.yml`](.github/workflows/deep-witness.yml) on demand and on every release tag (plain clang-20). A red witness blocks the merge.

## Lineage

Built on [PUC-Rio's Lua](https://www.lua.org). lua.wasm carries that heritage toward a maintained, WebAssembly-targeting artifact — credited, not tracked: it defers to no living upstream and pins to no floating version.

An earlier generation also carried [Hugo Musso Gualandi's lua-aot](https://github.com/hugomg/lua-aot-5.4), a research AOT compiler for Lua 5.4 — removed in v0.2.0 when its wasm speedup measured marginal across browser engines (a net loss on one), not enough to justify its size and dependency ([`doc/history/aot-sunset-2026-07-24.md`](doc/history/aot-sunset-2026-07-24.md)). 
