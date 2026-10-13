# Browser-native lua.wasm — the design decisions and their evidence (2026-10-13)

This records why lua.wasm is moving off WASI onto upstream musl with an
interface of its own, the spikes that informed it, and every decision
taken with its options, choice and reopen condition. The work lands in
four merges (D10); this record lands with the first. Measurements below
are **observations** from a design session (2026-10-03 to 2026-10-13) on
a throwaway spike branch that was not merged: one machine, headless
Chromium 141, the methodology stated per table. They decided the design;
the claims that outlive it are re-earned by the tests the later merges
add, and the README states only what those tests show.

## Why the question came up

lua.wasm's stated point is stock Lua 5.4 running in a plain web page. The
artifact on `main` is built for `wasm32-wasi` and imports 18 functions
under `wasi_snapshot_preview1`. No browser provides those; the only
browser-side implementation was a test stand-in
(`scripts/browser/wasi-stdio-shim.mjs`), never shipped. So "runs in the
browser" was true only with a WASI emulation layer the user had to write
or copy — a server-side runtime's syscall ABI, re-implemented in the page.
That is the wrong interface for the stated purpose.

The constraint that stays: a wasm module in a browser can reach the
outside world only through the imports the page hands it. Zero imports is
not a goal (it would freeze the clock mid-call and buffer output until a
call returns, neither of which is stock behaviour). The goal is that the
imports are few, plain, and designed for the browser, with no
Emscripten and nothing that needs cross-origin isolation (COOP/COEP
headers, SharedArrayBuffer, workers).

## The spikes

### 1. Answering WASI inside the module (2026-10-03)

Defining wasi-libc's 18 `__imported_wasi_snapshot_preview1_*` functions
inside the module resolved them at link time; the reactor then imported
exactly two functions of ours (`write`, `now`) and ran the suite-prefix
bundle in Chromium 141 from a page with only a `content-type` header
(`crossOriginIsolated === false`). Stripped size 409,535 B (115,090 B
brotli) against 409,854 B (115,247 B) for the WASI build: the saving is
on the page side, not in the module. Two side findings: the shipped
artifacts carried ~1.9 MB of debug sections in a 2.3 MB file (stripping
is now part of the build), and this shape keeps all of WASI's machinery
inside the module, translated — the fast route, not the final one.

### 2. Which C library (2026-10-03)

Two candidates, both importing only `write` and `now`:

- **A** — wasi-libc's musl top half plus ~25 POSIX-level functions of
  ours linked ahead of it. 405,115 B (113,464 B brotli). Fragile: it works
  by shadowing wasi-libc's private symbol names (`__isatty`,
  `__wasilibc_fd_renumber`, ...), and keeps WASI's errno numbering
  (`io.open` on a missing file reports 44 where Linux reports 2).
- **B** — upstream musl compiled for `wasm32` with a five-header arch
  port (one syscall dispatcher; single-thread atomics and thread pointer;
  riscv32's public type layout with `_Addr = long`) plus our syscall
  layer. 420,896 B (119,306 B brotli). musl untouched; errno matches
  Linux; the layer sits on the Linux syscall interface rather than on
  another project's internals.

Both passed the suite-prefix bundle in Chromium 141. picolibc and LLVM's
libc were not compared (GitHub was unreachable from the session).
Candidate B's musl was zig 0.15.1's bundled copy of 1.2.5, which omits
`strlen`, `strcmp`, `strncmp` and `abs` in favour of zig's own — one
reason D1 vendors the official release.

### 3. The allocator (2026-10-12)

The first timing run showed mallocng 15–35% behind oldmalloc. It was
void: the syscall layer's `mmap` never reused freed pages and reported a
64 KiB page size, which penalised the mmap-based allocators. With 4 KiB
page reuse and `page_size = 4096` (the layer now in the design), two
independent batches of 20 rotated rounds each, fresh instance per
workload, Mann–Whitney two-sided:

| | suite-prefix median | alloc-heavy loop median | peak memory |
|---|--:|--:|--:|
| B1 mallocng (musl default) | 674 ms | 770 ms | 50.8 MB |
| B2 oldmalloc | 668 ms | 790 ms | 64.8 MB |
| B3 emmalloc + safe realloc | 662 ms | 718 ms | 63.4 MB |

B1 vs B2: no significant difference (suite p = 0.69; alloc-heavy p =
0.056, direction flipped between batches). B3 was 7–10% faster on the
synthetic alloc-heavy loop only (p < 0.001), and only after replacing its
`realloc`: the emmalloc in zig 0.15.1's wasi-libc corrupts data under
`realloc`, reproduced by a 300,000-step stress against **stock**
wasi-libc with its own `sbrk` (not an artifact of our layer). Decision:
mallocng — maintained default, lowest memory, no measured cost. Reopen if
a real allocation-heavy workload shows a gap; retest with Emscripten's
current emmalloc, which may have fixed `realloc`.

### 4. Against Wasmoon (2026-10-12)

Wasmoon 1.16.0 (npm; Emscripten `-O3`, emmalloc, 27 imports: Emscripten's
own plus WASI stdio) against the spike build (musl + mallocng, `-O3`,
Binaryen `wasm-opt -O3`), Chromium 141, plain static server, 20 rotated
rounds, fresh engine per workload:

| workload | lua.wasm (spike) | Wasmoon | ratio | p |
|---|--:|--:|--:|--:|
| suite-prefix bundle | 636 ms, pass 20/20 | 596 ms, **fail 20/20** | — | — |
| alloc-heavy loop | 698 ms | 880 ms | 1.26× | < 0.001 |
| 200,000 caught errors (`pcall`) | 113 ms | 240 ms | **2.13×** | < 0.001 |
| `fib(30)` | 70 ms | 70 ms | 0.99 | 0.61 |

Download: ours 372,672 B (115,486 B brotli), one `.wasm`; Wasmoon 271,581 B
wasm (94,930 B) + 151,652 B JS (33,976 B). Neither needs cross-origin
isolation — Emscripten only needs it for threaded builds, which Wasmoon
is not. The `pcall` gap is the `setjmp` question: Wasmoon's Lua errors
round-trip through JavaScript (`invoke_*`, `_emscripten_throw_longjmp`);
ours stay inside the module on wasm exception handling. Wasmoon's suite
failure is musl's locale behaviour (next section), not a Wasmoon bug;
without the guard this repo carried, we fail identically. Where Wasmoon
is ahead and stays ahead by choice: a full JavaScript ↔ Lua object
bridge, and browser floors two years older via the legacy EH encoding.

### 5. musl's locale behaviour

`os.setlocale("pt_BR")` on musl returns `"pt_BR"` and leaves the decimal
point as `.`; musl implements no locale-specific numeric formatting. Lua's
`literals.lua:298` assumes a successful `setlocale` changes the decimal
point and asserts. Stock Lua 5.4.8 built natively for
`x86_64-linux-musl` fails that assertion; so does Wasmoon; so do we
without the `setlocale` guard `onelua.c` carried. Under the reference
behaviour chosen below the guard goes, and the official suite is run with
a documented prelude that makes `os.setlocale("pt_BR")` report failure —
a test-setup adaptation, not a product change. An upstream report (to
lua-l, suggesting the test check `localeconv` rather than assume) waits
until there is a product to point at.

## Decisions

Conventions settled alongside, now design:

- **Reference behaviour: identical to stock Lua 5.4.8 on musl, bugs
  included.** No guards, no fixes of our own in the C library or in Lua.
  The oracle is native Lua 5.4.8 built against the same vendored musl;
  differences are bugs in our port.
- **Imports are justified, not forbidden.** Each new import needs a
  stated justification and an explicit decision; the answer is never
  assumed to be no.
- **Interop: utility, not parity.** Wasmoon owns the rich JavaScript ↔
  Lua bridge; lua.wasm offers enough to be useful (D2b) and competes on
  correctness, error-handling speed, portability and verification.

| # | decision | choice | rejected (reopen when) |
|---|---|---|---|
| **D1** | Source of musl | Vendor the most recent signed release (1.2.6) verbatim in `third_party/musl`; `scripts/verify-musl.sh` checks sha256, key fingerprint, signature and a two-way diff on every change; `musl-upstream.yml` opens an issue weekly when a newer signed release appears. Updating is a deliberate commit. | Download at build time (offline builds fail); zig's bundled copy (not verbatim, no provenance); partial vendoring (a file list to maintain). |
| **D2** | Imports | Three, in module `luaw`: `write(fd, ptr, len)` (fd 1/2), `now() -> f64` ms since the epoch, `read(ptr, maxlen) -> count` (0 = end of input; called only when Lua reads stdin and the buffer is empty). *Learned in merge 2:* the OS layer never lets two clock reads return the same instant (a repeat is advanced by a nanosecond) — Firefox rounds its timers to a millisecond and musl derives temporary-file names from the clock alone, which made `os.tmpname` fail there 2 runs in 8. | Zero imports (freezes the clock, buffers output); a time-zone import (would modify musl's time code). |
| **D2b** | Exports and interop | `luaw_init`, `luaw_run`, `luaw_last_error`, `luaw_alloc`/`luaw_free`, `luaw_start`, `luaw_step` (now carrying a message each way: the host passes a string in, receives what the program `coroutine.yield`s), `luaw_main(argc, argv)` (stock `lua.c`, public), `luaw_fs_put`/`luaw_fs_get`/`luaw_fs_remove`/`luaw_fs_list`, `luaw_setenv`, `luaw_exit_code`, `memory`, `_initialize`. | A synchronous `luaw.call` import (can't use async browser APIs; every host must implement it). Reopen if synchronous calls prove necessary. |
| **D3** | `os.exit` | Flush stdio, record the code (`luaw_exit_code`), trap. The one thing that unwinds into the host; every later `luaw_*` call refuses with "VM exited". | Exit as a thrown exception (Lua's catch-all would swallow it, so `pcall(os.exit)` would survive); disabling `os.exit` (not stock). |
| **D4** | Files | An in-memory filesystem inside the module (`/` is the working directory; no persistence), filled and drained through the `luaw_fs_*` exports. Pyodide and Wasmoon both keep files in memory. *Corrected in merge 2:* directories are entries, not path prefixes — the official suite requires `fopen("")` to fail and creating a file in a missing directory to fail with `ENOENT`, as Linux does; `/` and `/tmp` exist from the start, `luaw_fs_put` creates parents, `luaw_fs_mkdir` is the host's `mkdir -p`. | Host-backed folders through a file import — the one real use is a portable `lua` command reading real disk. Reopen if that use case appears. |
| **D5** | Local time, environment | musl's stock handling: `TZ` or `/etc/localtime`, else UTC. The environment starts empty; hosts add to it with `luaw_setenv`. `lua.js` will generate the visitor's zone file from the browser's own rules (merge 4); until then hosts supply `TZ` or a zone file. Needs file-backed `mmap` in the syscall layer (musl memory-maps zone files). | A time-zone import (modifies musl); shipping the tz database (size, upkeep). |
| **D6** | Removals | `lua-lib.wasm` as a separate artifact; the WASI build and runners; the link-Lua-in shape (`liblua.a`, `examples/embed/`, `doc/embedding.md`, `WASM_EH=external`); the unused C sjlj path; the `onelua.c` WASI workarounds (`tmpnam`, `tmpfile`, `fopen("")`, `setlocale`, `system`); the legacy EH encoding (per D9). Deep-witness is retargeted, not removed. | Each gets a removal record with its reopen condition when it goes (merge 3). |
| **D7** | stdin | The host plays the environment: the `read` import answers with typed text, piped data or end of input (0). Stock `io.read` throughout; stock interactive `lua` works under Node through `luaw_main`. | Always-empty stdin and pre-supplied-only stdin (each hard-wires one environment into the module). |
| **D8** | `lua.js` defaults | **Open** — decided before merge 4. | |
| **D9** | Supported runtimes | Standard EH encoding only. Floors (webassembly.org feature data, `exceptionsFinal`): Chrome 137, Firefox 131, Safari 18.4, Node 24.15, Deno 2.3.2, wasmtime 47. CI: current Chromium, Firefox, WebKit; Node ≥ 24.15. | Shipping the legacy encoding too (deprecated; a documented V8 12.x host crash; untestable old Safari). Reopen if real users turn up on older devices. |
| **D10** | How it lands | Four merges: (1) this record and vendored musl; (2) the new artifact built and tested beside today's; (3) the cutover and removals; (4) `lua.js`. | One or two large merges. |

Deferred, recorded as open work: a non-JavaScript host test (wasmtime)
— "runs in any wasm host" is not claimed until one exists; D8; a
reproducible benchmark against Wasmoon in the repo (the numbers above are
session observations).

## What this does not change

Lua stays verbatim 5.4.8 (`scripts/verify-stock.sh`). Error handling
stays on wasm exception handling, compiled as C++ with the bundled
micro-runtime. The VM never blocks; the per-frame coroutine model is
unchanged. No threads, no SharedArrayBuffer, no Asyncify, no Emscripten.
