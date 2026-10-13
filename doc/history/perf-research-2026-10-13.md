# Performance research and the optimization round (2026-10-13)

What was tried, what the literature says, and what landed, after the
first reproducible benchmark ([`../bench.md`](../bench.md), issue #54)
showed lua.wasm behind Wasmoon on pure interpretation in WebKit, on
error handling in Firefox, and on load-to-first-print in Chromium and
Firefox. Two columns, as the Human framed them: absolute gains for an
interpreter in wasm regardless of the peers, and gains where a peer was
ahead. The full literature report (five research threads, ~60 cited
sources, 2023–2026) is kept outside the repository; this is the record
of what it decided.

## What landed

| change | column | evidence |
|---|---|---|
| **The interpreter compiles as C; throw and catch live in one C++ unit** (`port/luaw-eh.cpp`; `onelua.c`'s `LUAI_THROW`/`LUAI_TRY` route to it) | absolute | the full 20-round run (`bench.md`, current tables): `fib` 0.77× → 0.87× of Wasmoon in Chromium and 0.81× → 0.88× in WebKit, still behind and now significant at p ≤ 0.01; a 10-round spike had shown 0.94× and 1.03×, so the run-to-run noise is of the size of the remaining gap; module −2.3 KB; every witness passes. Corroborated by SWI-Prolog's 2025 wasm port, which measured 35% for moving its `setjmp` out of the VM loop into a small wrapper, and by LLVM's wasm backend still treating calls inside EH-bearing functions as may-throw |
| **Load time**: month-boundary zone-file scan (36 `Intl` calls, not ~1,100), `Uint8Array.fromBase64`, `compileStreaming` from a `Response` on the inline bytes | relative | cold/warm, full run: Chromium 75/47 → 58/30 ms (Wasmoon 70/40); Firefox 137/112 → 114/93 (123/100); WebKit 103/53 → 57/37 (101/46): ahead of Wasmoon in every engine, from behind in two |
| `scripts/eh-check.mjs` | — | the witness that the first change holds in the shipped module |

## What was tried and not adopted

| what | result |
|---|---|
| `LUA_USE_JUMPTABLE=1` (computed-goto dispatch) | within noise, +3 KB. Clang lowers computed goto to one `br_table` anyway; a 2023 measurement found it 12% *slower* than `switch` under emcc. Off stays right |
| `wasm-opt -O4`, `--converge`, `-Os` | `-O4` crashes Binaryen 132 deterministically (`Flatten` has no `try_table` support — source, not an issue thread); `--converge` and `-Os` within noise, `-Os` 2 KB smaller. `-O3` is the ceiling |
| Binaryen inlining limits (`-fimfs=40 -ocimfs=30` and `-fimfs=10 -ocimfs=8` against the defaults) | neutral: Chromium, 10 rounds, work only — `fib` 0.90× and 0.87× of Wasmoon against 0.87× at the defaults, every other workload within noise, +1.8 KB and +0.5 KB. The one unswept lever the literature named (an FSE 2023 study found counter-intuitive inlining effects in half its programs); it does not move an interpreter whose hot loop is one function |
| Forbidding Binaryen from inlining the catch wrapper | neutral; the inlined copies land in the eight small protected-call entry points, never the VM loop, which the EH check asserts |

## What the literature settled without a trial

- **Tail-call dispatch**: measured +12% in a 2023 V8 micro-harness but 1.2× slower in Firefox 149 and 3.7× slower in Chrome 146 for a 2026 interpreter, attributed to the engines' 6/8-register argument ABI; CPython under Emscripten saw "no speedup, up to 2× slowdown". Not worth building.
- **Optimizer levels**: clang `-O2`/`-O3`/`-Os` within 1% for interpreter dispatch under emcc (2023); and zig hands clang `-O2` for every level (checked here, byte-identical objects).
- **Code caching**: no browser caches compiled code for a `Response` synthesised from bytes (Blink records it as having no cache handler; Firefox needs a network channel plus an eager full tier-2 compile that lazy tiering made dormant in 140+; JSC has no persistent wasm cache). V8's threshold is now ~1,000 bytes of *optimized* code, not 128 KB of wire bytes, and V8 and JSC compile lazily — so the inline form forfeits little, and the warm/cold gains above are HTTP and script caching, not wasm caches. Firefox is the structural exception: it baseline-compiles the whole module (~7–13 ms for 400 KB at its published 30–60 MB/s), which is why it starts slowest.
- **Base64**: `fromBase64` decodes at 2.6–9.4 GB/s across engines (2025) — ~0.1 ms here; Emscripten's own loop is the slow alternative.
- **Allocator**: no published measurement of musl's mallocng under wasm exists; Emscripten's guidance (many small objects favour dlmalloc over emmalloc, mimalloc pays only multithreaded) is asserted. Our own spike (design record §3) remains the only mallocng-on-wasm data.
- **Firefox's throw cost** (~27 µs per `error`/`pcall` round trip against ~0.6 µs in Chromium and WebKit): unreported upstream — no Bugzilla entry, no newsletter mention; by code reading, a throw allocates a GC object and unwinds through the generic JIT frame iterator. The action is a shell reproducer and a bug report, not a workaround; fengari's JavaScript exceptions beat both wasm engines there and will until it is fixed.
- **Branch hinting** (Chrome 137, Firefox 148, Safari 16 on by default): the only shipped proposal with an interpreter-relevant number (7–10%, on a JIT's output, not an interpreter); clang emits no hints from `__builtin_expect`, so nothing to try yet.

## Open

- The remaining `fib` gap to Wasmoon (0.87× Chromium, 0.88× WebKit). The interpreter is the same; the candidates left are the allocator (not exercised by `fib`), the link (Emscripten's `-O3` + `wasm-opt` pipeline against ours), and codegen differences between clang 20 under zig and Emscripten's clang, which a function-by-function diff of the two VM loops would settle.
- A reproducer and bug report for SpiderMonkey's throw cost.
- Per-phase start-up timing (decode, compile, instantiate, `_initialize`, the zone file, the first tag) — no published numbers exist for 300–600 KB modules; ours would be first.
- The allocator comparison the literature lacks, on our own harness, if a workload ever shows the allocator.
