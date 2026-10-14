# lua.wasm

**Stock Lua 5.4 for the browser — the reference interpreter on musl, in one file.**

```html
<script src="lua.js"></script>
<script type="text/lua">
  print("Hello from " .. _VERSION)
</script>
```

That is a complete page: `lua.js` carries the interpreter, `print` lands on the page where the tag sits, `require` fetches modules beside the page, `coroutine.yield()` animates a frame at a time, and local time is the visitor's. Lua calls the page through one table:

```html
<script src="lua.js"></script>
<script>
  Lua.js.greet = (who) => `hello, ${who}`;                       // Lua: js.greet("page")
  Lua.js.fetchText = async (url) => (await fetch(url)).text();   // a promise: Lua awaits it
</script>
<script type="text/lua">
  print(js.greet("page"))
  local ok, text = js.fetchText("data.txt"):await()
  print(ok, text)
</script>
```

Values cross by copy — numbers, strings, bytes, tables — never by reference; a promise comes back as a token to `await` or watch with `:when(fn)`; an exception is a Lua error. Underneath is `lua.wasm`: [PUC-Rio Lua](https://www.lua.org) 5.4.8, verbatim, compiled on upstream [musl](https://musl.libc.org) 1.2.6, verbatim, into one WebAssembly module with four small imports — no WASI, no Emscripten, no special headers — for anyone embedding the real Lua in a web app or in Node: the two places it is witnessed.

## Why you'd want it

There is no LuaJIT for WebAssembly, and there can't be one as it stands: wasm forbids runtime code generation (no JIT), and LuaJIT's interpreter is hand-written per-architecture assembly with no wasm backend (no fallback). Every Lua-in-wasm is therefore interpreter-class. lua.wasm owns that and makes the stock interpreter a good citizen of the browser:

- **Not a dialect, not a port.** Lua is verbatim 5.4.8 and the C library under it is verbatim musl; the reference behaviour is *stock Lua 5.4.8 on musl Linux, bugs included*, and a differential witness holds the artifact to it byte for byte. Language changes are out of scope.
- **One artifact, four imports.** `lua.wasm` imports `luaw.write` (stdout/stderr), `luaw.now` (the clock), `luaw.read` (stdin) and `luaw.call` (the bridge: a name and arguments by copy, a result back), nothing else. The OS Lua expects — stdio, a clock, files, environment, `exit` — lives inside the module on the Linux syscall interface musl already speaks. No WASI emulation layer to copy into your page.
- **A boundary, not an object graph.** Lua reaches the page only through the functions the page registers, and values cross by copy: no proxies, no handles, no finalizers on either side, nothing a Lua program can hold that keeps a page object alive. A promise is a token the program awaits or watches; several can be in flight; a frame's worth of work crosses as one table. Isolation is the default, and a host that registers nothing has a Lua that cannot call out.
- **A plain page is enough.** No cross-origin isolation (no COOP/COEP headers), no SharedArrayBuffer, no workers, no Emscripten runtime, no build step. One `<script src="lua.js">` from a static server, a CDN or a file opened from disk; the witnesses assert `crossOriginIsolated === false`.
- **Errors stay inside.** Lua's error handling rides the standard WebAssembly exception-handling instructions — the interpreter compiles as plain C and reaches them through one small C++ unit — so `pcall` never round-trips through JavaScript, no setjmp/longjmp emulator is in the way, and a caught error allocates nothing.
- **The VM never blocks.** The host calls in and always gets control back. A long-lived program (a game's main loop) runs as a Lua coroutine the host resumes once per frame, exchanging a string message each way.

## Where it stands

lua.wasm is honest about maturity, so you can trust what it claims. Every claim below names its witness; the witnesses run on the release form of the file, so what is tested is what ships.

- **CI-enforced (re-witnessed on every change** by [`witness.yml`](.github/workflows/witness.yml)**):** `lua.js` passes its witness in **Chromium, Firefox and WebKit** (`scripts/lua-js-witness.mjs`: one page per promised behaviour — page output and errors, `src`, lazy `require` and `data-files`, one state per page, `data-stdin`, `os.exit`, per-frame yields, the `Lua` API, local time under three zones against `Intl`, and a page opened as `file://`); the vendored Lua core is verbatim stock 5.4.8, build Makefile and official test suite included (`scripts/verify-stock.sh`) and the vendored musl is the signed 1.2.6 release (`scripts/verify-musl.sh`); the native ltests-instrumented interpreter passes the **full** official suite with the C-API battery active (zero `testC` skips; the `pt_BR` decimal-point checks run where the runner has that locale); `lua.wasm` passes the host-interface witness (`scripts/interface-witness.mjs`: every import and export, the exit path, the message channel, and an adversarial battery — contained stack overflow, mid-flight program death and replacement, a 50k-frame pump, GC under allocation pressure, 200k caught errors leaving linear memory flat), the **full official suite in portable mode** through stock `lua.c` under Node 24 (`scripts/suite-witness.mjs`), the same full suite **in three real browser engines** — Chromium, Firefox and WebKit, from a plain page, driven via Playwright by `scripts/browser-witness.mjs`, which refuses to report a pass unless the page truly ran in the named engine — and the **differential witness** (`scripts/differential.sh`): a corpus of scripts run on the artifact and on native Lua 5.4.8 built for x86_64-linux-musl must produce byte-identical stdout, stderr and exit status. The libc alone passes a smoke witness (printf/strtod exactness, errno, locale, stdin) and a 300,000-operation allocator stress with memory reuse.
- **CI-enforced, the tarball:** `make sdk-check` relinks `lua.wasm` from the tarball's `lib/` alone and it is byte-identical, and `make embed-check` builds [`examples/embed`](examples/embed) from the unpacked tarball with plain clang-20, runs it under a twenty-line host, and compares its output with the expected text.
- **Witnessed on demand and on every release tag (**[`deep-witness.yml`](.github/workflows/deep-witness.yml)**):** the same artifact built under the zig recipe below (zig 0.15.1 as the compiler, LLVM's builtins named for the link) passes the interface, EH, suite and differential witnesses, relinks from the tarball byte-identical, and builds the example with `zig cc` as the consumer — the build is not tied to one compiler driver. The last green run in the previous arrangement (CI on zig, the deep witness on plain clang-20) is [run 38474596328](https://github.com/andy-emerson/lua.wasm/actions/runs/38474596328) (2026-10-13); the first in this one is the next release tag.
- **Stated, not yet witnessed:** the runtime floors. The artifact uses only the standard exception-handling encoding, which [webassembly.org's feature data](https://webassembly.org/features/) puts in Chrome 137, Firefox 131, Safari 18.4 and Node 24.15; CI runs current engines, not the floors. Sizes at this build (the zig recipe, binaryen 132, printed by `make`; the release's clang-20 build prints its own): `lua.wasm` 410,588 bytes (126,837 brotli); `lua.js` with the module inside 584,577 bytes (180,103 brotli) — one file costs about 40% more compressed.
- **Known and intended:** `os.setlocale("pt_BR")` returns `"pt_BR"` and keeps the `.` decimal point (musl implements no locale-specific numeric formatting; native Lua on musl does the same), so the official suite runs with a documented `LUA_INIT` prelude that reports the locale unavailable; `io.popen` and `os.execute` fail as on a machine with no shell; files live in memory inside the module and do not persist; `os.clock` is wall time since the VM was created, not CPU time (a browser has none to give — the one knowing divergence from native musl).

- **Measured against the alternatives** ([`doc/bench.md`](doc/bench.md), `make bench`; on demand, each table cites its run): against Wasmoon 1.16.0 in the same page and engine, lua.wasm is 8–31× faster when a frame's worth of data crosses the bridge and 1.1–1.3× on scalar calls out (0.6× in Firefox, whose wasm-to-JavaScript boundary is the costliest); 1.9–2.8× faster on error handling in Chromium and WebKit and 1.15–1.3× on a game-shaped frame in every engine; within 8% either way on allocation and strings; starts level cold (0.90–0.96×) and ahead warm; **behind on pure interpretation** (0.90× in Chromium and WebKit, [#63](https://github.com/andy-emerson/lua.wasm/issues/63)) and **behind on error handling in Firefox** (0.75×, where wasm exceptions are costly, [#64](https://github.com/andy-emerson/lua.wasm/issues/64)). fengari-web 0.1.4 (Lua 5.3 in JavaScript) is 4–15× behind on compute in Chromium and WebKit and 1.4–4× behind in Firefox, where it leads on error handling; it starts fastest everywhere and is fastest at calling into Lua (a direct function call against our resumed program).

## Not in scope

What this project does not do, each with what would reopen it (the reasoning is in the design record, [`doc/history/browser-native-2026-10-13.md`](doc/history/browser-native-2026-10-13.md)):

- **WASI and Emscripten.** No browser provides WASI, and Emscripten is a runtime to ship with the module; the OS Lua needs lives inside the module on four imports. Reopen if a browser ships WASI.
- **LuaJIT, or any JIT.** wasm forbids runtime code generation and LuaJIT has no wasm backend; every Lua-in-wasm is interpreter-class, and this one is the stock interpreter. Nothing reopens it short of the platform changing.
- **The command-line world.** No command crt (`_start`, `main`), no wasmtime or other non-JavaScript runtime witness (#53, closed): native Lua serves that world better, and the module would still need a host for its four imports. Reopen if a consumer asks.
- **Hosts beyond browsers and Node.** Those two are witnessed; a claim for any other is unearned. Reopen when a consumer brings one and a witness for it.
- **Objects by reference.** `js.document.body.style.color = "red"` is not the model: the page registers what Lua may call, and values cross by copy (D11). Reopen only on a consumer that cannot be served by copy plus the page's own registrations.
- **Language changes.** Lua is verbatim 5.4.8, bugs included, held by a differential against native Lua on musl. Nothing reopens it.
- **Threads, SharedArrayBuffer, workers.** A plain page is enough, and the per-frame coroutine model needs none of them. Reopen if a workload needs more than one thread of Lua and the isolation headers it costs.
- **npm.** Not a second build; deferred until the project's name is settled (#69). Reopens then.
- **Engines older than the standard exception-handling encoding** (Chrome 137, Firefox 131, Safari 18.4, Node 24.15). The artifact carries that encoding only; a second build for the legacy one would be a second product. Reopen if a consumer needs an engine below those floors.

## Use it

One build, three forms, each made from the one before: pick by what your program is.

- **A web page** puts `lua.js` beside it — from a [release](https://github.com/andy-emerson/lua.wasm/releases), or `make lua-js` — and writes Lua in `<script type="text/lua">` tags. [`doc/lua-js.md`](doc/lua-js.md) is the reference: every tag attribute (`src`, `data-files`, `data-stdin`, `data-output`), how `require` fetches modules, animation by `coroutine.yield()`, what `os.exit` does to a page, local time, the bridge (`Lua.js` on the page, `js` in Lua, tokens for promises, HTML from Lua through the page's own registrations), and the `Lua` global a page's own JavaScript gets — `Lua.run`, `Lua.start`/`step`, `Lua.files`, `Lua.env`, `Lua.on`.
- **A JavaScript application** (in a page or in Node) uses the same `lua.js` and its `Lua` global; the packaging round (#69) adds the DOM guard, `Lua.create()` and types.
- **A program with compiled code of its own** — C, C++ or Rust for wasm32 — that calls Lua's C API downloads the tarball `lua-wasm-sdk-<version>.tar.gz` from the release and links Lua into its own module: `lib/liblua-wasm.a` (the archive `lua.wasm` itself is linked from), `lib/crt-reactor.o`, the headers as a sysroot, the sources, and an example. [`doc/sdk/LINK.md`](doc/sdk/LINK.md), inside the tarball too, is the link line and the host's four imports.

`lua.wasm` on its own is attached to every release as the module the witnesses ran on; `lua.js` carries it, and the tarball is what it is linked from with nothing added.

## Build

Toolchain: **clang 20+** (the standard exception-handling encoding needs LLVM 20) with LLVM's wasm32 compiler-rt builtins, and Binaryen's `wasm-opt` for the release form. No sysroot: the libc is the vendored musl, built by the same `make`. The Makefile defaults are llvm.org's packages (`clang-20 lld-20 libclang-rt-20-dev-wasm32`), and that is what CI and the release build with:

```bash
npm i binaryen@132.0.0
make wasm MUSL_AR=llvm-ar-20 WASM_OPT=node_modules/binaryen/bin/wasm-opt   # -> lua.wasm
make lua-js                                                 # -> lua.js, with lua.wasm inside
make sdk                                                    # -> lua-wasm-sdk-<version>.tar.gz
node scripts/lua.mjs lua.wasm -- script.lua                 # the lua command line, under Node
```

Without an apt repository, `zig` 0.15.1 (`pip install ziglang==0.15.1`) is a self-contained clang 20.1.2 that builds the same artifact; its own compiler-rt stays out of the link because it carries a libm that would replace musl's behind the archive, so the builtins archive is named (the recipe is in the Makefile header; the deep witness runs it). Running the artifact needs a host with the standard wasm exception handling: a current browser, or **Node ≥ 24.15** (24.0–24.14 only with `--experimental-wasm-exnref`). The native musl oracle for the differential is compiled with zig either way.

The native toolchain works as usual: `make guess` builds `src/lua` and `src/luac`.

[`doc/wasm.md`](doc/wasm.md) is the operational reference: what the module is made of, the host contract in full, running the official suite, the witnesses, and the sharp edges.

## Embed

Two ways in. A program with compiled code of its own links the tarball (above; [`doc/sdk/LINK.md`](doc/sdk/LINK.md)) and uses Lua's C API as on any other platform; the host of that module supplies the same four imports described here. A host with no compiled code drives `lua.wasm` from outside: it instantiates it with four imports in module `luaw` (`write`, `now`, `read`, and `call` for the bridge — [`doc/wasm.md`](doc/wasm.md) has the contract and the value encoding) and drives it through these exports; every call returns, and no call blocks:

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

`os.exit` flushes stdio, records its status and traps — the one thing that unwinds into the host; `pcall` cannot intercept it, and every later call that would run Lua (`init`, `run`, `start`, `step`, `main`) refuses with "VM exited", while the filesystem exports keep working so the host can collect what the program wrote. [`scripts/host.mjs`](scripts/host.mjs) is a host in plain JavaScript — the inside of `lua.js`, shared with the Node witnesses — and the reference for calling all of this. In a page, the `Lua` global ([`doc/lua-js.md`](doc/lua-js.md)) is the same contract already wired up.

## Contributing

How work is planned, done, and reviewed here is the working agreement in [`AGENTS.md`](AGENTS.md) — vendored verbatim from [andy-emerson/working-agreement](https://github.com/andy-emerson/working-agreement) (CC BY 4.0; the version rides in its front matter, updated by replacing the file). Open work — todos, bugs, open decisions — lives in [GitHub Issues](https://github.com/andy-emerson/lua.wasm/issues).

The durable documents, each with one job and one primary reader:

| document | job | reader |
|---|---|---|
| this README | what the project is, where it stands, how to use, build and test it | anyone arriving |
| [`doc/lua-js.md`](doc/lua-js.md) | the reference for `lua.js`: tags, attributes, the `Lua` global, limits | the page author or web developer |
| [`doc/wasm.md`](doc/wasm.md) | the reference for `lua.wasm`: what it is made of, the host contract, the witnesses, the sharp edges | the embedder, and the developer of this repository |
| [`doc/bench.md`](doc/bench.md) | the latest benchmark run against Wasmoon and fengari-web, and what it says | anyone weighing the alternatives; the developer optimizing |
| [`doc/history/`](doc/history/) | dated design records: decisions with their options, rejected alternatives and reopen conditions; removal records | the developer deciding whether to revisit something |
| [`doc/sdk/LINK.md`](doc/sdk/LINK.md) | the tarball's notes, shipped inside it: what is in it, the link line, the host's four imports | the C, C++ or Rust developer linking Lua into their module |
| comments in `port/`, `src/onelua.c`, `scripts/`, `examples/` | why each piece is the way it is, at the piece | the developer changing it |

The vendored Lua — `src/` and the official test suite in `tests/` — is verbatim stock 5.4.8, enforced by [`scripts/verify-stock.sh`](scripts/verify-stock.sh); the vendored musl is verbatim 1.2.6, enforced by [`scripts/verify-musl.sh`](scripts/verify-musl.sh) — read their headers before touching `src/`, `tests/` or `third_party/musl/`. Everything of this project's own is in `port/` (the musl arch and the OS under it), `src/onelua.c` (the amalgamation and the `luaw_*` interface) and `scripts/`.

### Building

```bash
make guess       # native: src/lua, src/luac
make lua-debug   # the ltests-instrumented witness build
make wasm ...    # -> lua.wasm (toolchain variables as above; recipe in the Makefile header)
make sdk ...     # -> lua-wasm-sdk-<version>.tar.gz, the pieces lua.wasm is linked from
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
node scripts/interface-witness.mjs lua.wasm          # the host contract, 105 checks
node scripts/suite-witness.mjs lua.wasm tests        # full official suite, port mode, Node
node scripts/browser-witness.mjs lua.wasm --engine chromium   # and firefox, webkit (needs playwright)
make differential ...                                # byte-identical with native Lua on musl
make sdk-check embed-check ...                       # the tarball relinks lua.wasm byte-identical; its example builds and runs
make bench ...                                       # against Wasmoon and fengari (on demand; doc/bench.md)

# the page
make lua-js && node scripts/lua-js-witness.mjs lua.js lua.wasm --engine chromium   # and firefox, webkit
```

CI runs these: [`witness.yml`](.github/workflows/witness.yml) on every PR and push to `main`; [`deep-witness.yml`](.github/workflows/deep-witness.yml) on demand and on every release tag (the zig recipe). A red witness blocks the merge.

## Lineage

Built on [PUC-Rio's Lua](https://www.lua.org) and [musl](https://musl.libc.org). lua.wasm carries both verbatim toward a WebAssembly-targeting artifact — credited, not tracked: it defers to no living upstream and pins to no floating version (a weekly check flags a newer signed musl; updating is a deliberate commit).

Earlier generations were built for WASI — removed in the 2026-10 cutover to this design, because no browser provides WASI ([`doc/history/wasi-sunset-2026-10-13.md`](doc/history/wasi-sunset-2026-10-13.md)) — and carried [Hugo Musso Gualandi's lua-aot](https://github.com/hugomg/lua-aot-5.4), a research AOT compiler for Lua 5.4, removed in v0.2.0 when its wasm speedup measured marginal ([`doc/history/aot-sunset-2026-07-24.md`](doc/history/aot-sunset-2026-07-24.md)).
