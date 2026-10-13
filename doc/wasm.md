# Building and running the wasm artifact

Operational reference for the `wasm` / `wasm-lib` Makefile targets. The README
covers *what* the artifact is and where it stands; this file covers *how* to
build, run, and embed it, plus the sharp edges.

## Toolchain

**clang 20+** with a wasi-libc sysroot (the default EH encoding needs LLVM 20 —
see the encoding section below). `WASM_CLANGXX` and `WASM_SYSROOT` are override
points for a custom compiler or a self-built sysroot:

```bash
make wasm                                            # /usr sysroot, clang++-20
make wasm WASM_CLANGXX=clang++ WASM_SYSROOT=/opt/wasi-sysroot
```

On hosts without a packaged clang 20, `zig c++` is a self-contained clang-20+
driver with its own wasi sysroot (`pip install ziglang`), witnessed for this
exact build:

```bash
make wasm WASM_CLANGXX="python3 -m ziglang c++" WASM_SYSROOT= \
  WASM_EXTRA="-Xclang -target-feature -Xclang +exception-handling"
```

(The `-Xclang` pair works around zig's own CPU-feature mapping not enabling the
wasm EH feature that `-fwasm-exceptions` implies under plain clang.)

Running the artifact needs a WASI host with wasm exception-handling support —
Node ≥ 24.15, a current browser, or wasmtime via `scripts/wasmtime-run.py`
(see the encoding section for which hosts take which encoding; Node 24.0–24.14
compile the artifact only with `--experimental-wasm-exnref` — the sweep is in
the audit's 2026-07-06 addendum).

## Exception-handling runtime: `WASM_EH`

Lua's error handling lowers onto the wasm exception-handling proposal (the
artifact compiles as C++ so `LUAI_THROW`/`LUAI_TRY` become `throw`/`catch`).
Two modes select who owns exception dispatch:

| `WASM_EH` | what owns dispatch | semantics | libc++abi |
| - | - | - | - |
| `internal` (default) | the self-contained micro-runtime in `src/onelua.c` | `catch(...)` only — no type matching, no destructors | none needed |
| `external` | a real libc++abi built with `-fwasm-exceptions` | full typed catches | you supply it |

Use `external` when the host embedding Lua has **its own** C++ that needs
*typed* catches — Lua errors and the host's exceptions must then travel one
coherent EH domain, which the bundled `catch(...)`-only shim cannot provide.
It is gated behind `-DLUAW_EXTERNAL_EH`, which suppresses the shim so the
external runtime's `__cxa_*` symbols are the only ones present:

```bash
make wasm WASM_EH=external \
  WASM_EH_FLAGS="-L/path/to/rt/lib" \
  WASM_EH_LIBS="-lc++ -lc++abi /path/to/libunwind_wasm.a"
```

No distro ships a libc++abi built with wasm-EH (zig's bundled one included) —
`examples/embed/build-eh.sh` is the in-tree recipe that builds one from zig's
bundled LLVM runtime sources in seconds, and the CI witness that proves typed
catches work through it. `doc/embedding.md` covers when an embedder needs this
mode.

### Hazard: the micro-shim wins silently

Linking a real libc++abi **without** `WASM_EH=external` (i.e. without
`-DLUAW_EXTERNAL_EH`) produces **no** duplicate-symbol error. The bundled
shim's `__cxa_*` definitions satisfy every reference, so the archive members
are simply never pulled — you end up on `catch(...)`-only semantics without any
diagnostic. `WASM_EH=external` closes this two ways: it removes the shim so a
missing external runtime becomes a *link* error, and the target runs a
post-build fingerprint check (`grep` for the libc++abi terminate string in the
artifact) that fails the build if the external runtime was not actually linked.

## Running the official test suite under wasm

WASI has no shell, so `tests/main.lua`'s `assert(os.execute(...))` and the other
non-portable checks cannot pass under the wasm build. The suite's own
portability switch, `_port=true`, skips exactly those. It is **required** here,
not optional:

```bash
cd tests
node ../scripts/wasm-run.mjs ../lua.wasm -e"_port=true" all.lua
```

Note the **attached** form `-e"_port=true"` (no space). `-e <chunk>` also works,
but a following argument that itself begins with `--` (as some suite files and
ad-hoc chunks do) is ambiguous to the standalone interpreter's argument scan;
`-e<chunk>` avoids it. This matters most when driving the artifact purely
through `argv` — the natural path when there is no filesystem to load from.

The same suite runs under wasmtime — the non-V8 cross-check:

```bash
pip install wasmtime
cd tests
python3 ../scripts/wasmtime-run.py ../lua.wasm -e"_port=true" all.lua
# → final OK !!!
```

Two more witnesses ride the same artifacts, both CI-enforced: the browser leg
(`node scripts/browser-witness.mjs lua.wasm tests/suite-prefix-bundle.lua --engine <chromium|firefox|webkit>` —
regenerate the bundle first with `python3 scripts/suite-bundle.py`; needs
playwright-core + the requested browser) and the reactor battery
(`node scripts/reactor-stress.mjs lua-lib.wasm`). `--engine` is required and
the driver refuses to report a pass unless the page truly ran on that engine;
CI runs all three, with Chromium (V8) gating and Firefox/WebKit non-gating
until their wasm-EH support is confirmed (#42).

> **On old V8 (Node 22/23) the suite host-crashes.** The to-be-closed/coroutine
> region of `locals.lua` SIGSEGVs the *host* process there — a V8 12.x-era
> engine defect on both its EH paths, fixed in current V8 and absent on non-V8
> runtimes. Current Node 22 LTS (22.22.2) now *compiles* the standardized
> encoding by default and still crashes the same way (re-witnessed 2026-07-06).
> The full triage, and the portable one-file repro
> (`scripts/suite-bundle.py`), are in
> [`history/wasm-audit-2026-07-05.md`](history/wasm-audit-2026-07-05.md). It is why the Node
> floor is 24.15, not 22.

## EH encoding: `WASM_EH_ENCODING`

Wasm exception handling exists in two wire formats, and hosts differ on which
they accept. `WASM_EH_ENCODING` selects the one the artifact carries:

| `WASM_EH_ENCODING` | instructions | build needs | runs on |
| - | - | - | - |
| `standard` (default) | `try_table`/`exnref` (the standardized format) | LLVM 20+ | V8 with default-on exnref (Node ≥ 24.15, current browsers; Node 24.0–24.14 need `--experimental-wasm-exnref`), wasmtime and other non-V8 runtimes |
| `legacy` | `try`/`catch` (pre-standard) | clang 18/19 suffice | V8 engines only; wasmtime rejects it (`legacy_exceptions feature required`) |

Witnessed on this pin (zig c++ / clang 20.1.2; engines: wasmtime 36,
Chromium 141 = V8 14.1, Node 22 = V8 12.4):

- `standard`: full suite passes under wasmtime; suite-prefix witness passes in
  Chromium 141. On Node 22 (V8's *experimental* exnref, `--experimental-wasm-exnref`)
  it still host-crashes — that V8 generation is broken on both paths; use Node ≥ 24.15.
- `legacy`: rejected by wasmtime; passes the suite-prefix witness on
  Chromium 141; host-crashes old V8 (the audit's original finding).

`legacy` exists only as a bridge for toolchains stuck below clang 20 targeting
browsers/Node exclusively; there is no other reason to choose it.

## The browser-native artifact: `lua-next.wasm` (pre-cutover)

The artifacts above are built for WASI and need a WASI emulation layer in
a browser. Their replacement, built beside them until the cutover (merge
3 of the plan in [`history/browser-native-2026-10-13.md`](history/browser-native-2026-10-13.md)),
is stock Lua 5.4.8 on upstream musl with three plain imports and no
Emscripten; it will become `lua.wasm`. Until then it builds as
`lua-next.wasm` and is not released.

```bash
make wasm-next WASM_CC="python3 -m ziglang cc" MUSL_AR="python3 -m ziglang ar" \
     WASM_CLANGXX="python3 -m ziglang c++" \
     WASM_EXTRA="-Xclang -target-feature -Xclang +exception-handling" \
     WASM_OPT=node_modules/binaryen/bin/wasm-opt        # npm i binaryen@132.0.0
node scripts/next-run.mjs lua-next.wasm -- -e 'print("hello")'   # the lua command line
```

**What it is made of.** `third_party/musl` is verbatim musl 1.2.6
(`scripts/verify-musl.sh`), compiled for wasm32 by `port/musl.mk` with
the arch in `port/wasm32`. Under it, `port/luaw-sys.c` answers musl's
Linux syscalls inside the module (stdio as a terminal, a clock whose
reads never repeat, mmap over 4 KiB pages with reuse, exit as a trap)
and `port/luaw-fs.c` is the in-memory filesystem (directories as
entries, `/` and `/tmp` from the start, Linux errno and semantics
where Lua can observe them). Lua is compiled as C++ for wasm exception
handling, exactly as the WASI build is, with `-DLUA_USE_LINUX` and
`-DLUAW_MUSL` (musl's own `tmpnam`, `tmpfile`, `fopen`, `setlocale`,
`system`; none of the wasi-libc patches). The release form is stripped
and passed through Binaryen's `wasm-opt -O3`; the witnesses run on that
file.

**The host contract.** Three imports in module `luaw`:
`write(fd, ptr, len)` (fd 1 stdout, 2 stderr), `now() -> f64`
(milliseconds since the epoch), `read(ptr, maxlen) -> n` (stdin; 0 at end
of input). Exports: `memory`, `_initialize`; `luaw_init`, `luaw_run`,
`luaw_last_error`, `luaw_alloc`/`luaw_free`; `luaw_start` and
`luaw_step(msg, len)` with `luaw_message(len_out)` (the resident program's
`coroutine.yield` carries a string each way); `luaw_main(argc, argv)`
(stock `lua.c`); `luaw_fs_put`/`luaw_fs_get`/`luaw_fs_remove`/
`luaw_fs_list`/`luaw_fs_mkdir`; `luaw_setenv`; `luaw_exit_code`.
`os.exit` flushes stdio, records its status and traps -- the one thing
that unwinds into the host; `pcall` cannot intercept it, and every
entry refuses afterwards with "VM exited". [`scripts/next-host.mjs`](../scripts/next-host.mjs)
is a host in plain JavaScript (the Node witnesses and the browser page
share it) and the reference for calling all of this.

**Reference behaviour: Lua 5.4.8 on musl Linux, bugs included.** The
oracle is that interpreter built natively against the same musl
(`make lua-musl`); `make next-differential` runs the corpus in
`port/test/diff` on both and requires byte-identical stdout, stderr and
exit status. Two consequences worth knowing: `os.setlocale("pt_BR")`
returns `"pt_BR"` and keeps the `.` decimal point (musl implements no
locale-specific numeric formatting), and `io.popen`/`os.execute`
fail as on a machine with no shell. Local time is musl's: `TZ` (a POSIX
rule or a zone name under `/usr/share/zoneinfo`) or `/etc/localtime`
(a zone file the host puts in, which musl memory-maps), else UTC.

**Witnesses** (all in `witness.yml`'s `next` and `next-browser` jobs):
`make libc-smoke` and `make libc-stress` on the libc alone;
`scripts/next-interface.mjs` (every import and export, the exit path,
the message channel, the adversarial battery); `scripts/next-suite.mjs`
(the full official suite in portable mode through `luaw_main`, Node)
and `scripts/next-browser.mjs` (the same in Chromium, Firefox and
WebKit from a page with no special headers, `crossOriginIsolated`
asserted false); `make next-differential`. Two test-setup adaptations,
both documented in the runners and neither a product change: the suite
runs with a `LUA_INIT` prelude that makes `os.setlocale("pt_BR")`
report failure (`literals.lua` assumes a successful `setlocale` changed
the decimal point, which musl never does -- native Lua on musl fails the
same assertion), and with `PATH` set, because `files.lua` asserts a
process environment has one.

**Not yet:** the cutover (merge 3) renames it to `lua.wasm`, removes the
WASI artifacts and their runners, and rewrites the README for it; the
`lua.js` loader for `<script type="text/lua">` is merge 4 (issue #52).
