# WASI sunset — what the cutover removed, and when to bring it back (2026-10-13)

This is the removal record merge 3 of the browser-native plan owes
([`browser-native-2026-10-13.md`](browser-native-2026-10-13.md), D6).
Everything below existed on `main` up to the cutover commit and remains
in git history; the reopen condition is the evidence that would justify
restoring it, not a promise to.

## Why

lua.wasm's stated point is stock Lua running in a plain web page. The
artifact was built for `wasm32-wasi` and imported 18 functions no browser
provides; running it in a page meant shipping a WASI emulation layer the
user had to write or copy. The replacement — Lua on verbatim musl with
three imports of its own — passed every witness the WASI build had, plus
the full official suite in three browsers from a plain page and a
differential against native Lua on musl, while built beside it (merge 2).
Keeping both would have meant two libcs, two sets of runners and two
sets of claims for one project.

## Removed

| what | was | reopen when |
| - | - | - |
| The WASI build (`wasm32-wasi`, wasi-libc sysroot, `WASM_SYSROOT`) | the only artifact until merge 2 | a host that provides WASI and not JavaScript matters to a user — then as a second libc under the same `port/` OS layer is **not** the shape; WASI would be the OS layer |
| `src/wasi/` | the wasi-libc patches: `tmpnam`, `tmpfile`, `fopen("")`, `setlocale`, `system` workarounds | never as such — the reference behaviour is now musl's own, bugs included |
| `lua-lib.wasm` as a separate artifact (`make wasm-lib`, `-DMAKE_REACTOR` apart from the interpreter) | the reactor without `lua.c` | one artifact now carries both `luaw_main` and the reactor exports; reopen if the size of `lua.c` in the artifact (a few KB) ever matters |
| `scripts/wasm-run.mjs`, `scripts/wasmtime-run.py`, `scripts/browser/wasi-stdio-shim.mjs` | the WASI runners | with the WASI build |
| `scripts/suite-bundle.py`, the suite-prefix bundle | a one-file prefix of the suite for engines that could not load files | the in-memory filesystem lets the browsers run the full suite from the real files |
| `scripts/embed-demo.mjs`, `scripts/reactor-stress.mjs` | the reactor's witnesses | folded into `scripts/interface-witness.mjs`, which runs the same adversarial battery |
| The link-Lua-in consumer shape: `liblua.a`, `examples/embed/`, `doc/embedding.md`, `WASM_EH=external`, `-DLUAW_EXTERNAL_EH` | a C/C++ downstream linking Lua into its own wasm32-wasi artifact (issue #11) | a downstream wants it against *this* libc — then the contract is "compile `src/onelua.c -DMAKE_LIB` as C++ with `-fwasm-exceptions` against `port/musl.mk`'s headers", and the external-EH question (a real libc++abi for typed catches) returns with it |
| The legacy EH encoding (`WASM_EH_ENCODING=legacy`, clang 18/19) | a bridge for toolchains below clang 20 and for V8 engines two years older | real users on devices below the D9 floors (Chrome 137, Firefox 131, Safari 18.4) |
| The C `setjmp`/`longjmp` route and `scripts/sjlj-probe.sh`, deep-witness's `sjlj-probe` job | a per-LLVM-minor probe of LLVM's `-wasm-enable-sjlj` lowering, red on every LLVM tried (18, 19.1.1, 21) | LLVM ships a working lowering **and** compiling Lua as C++ turns out to cost something — it has not |
| The wasmtime witness | the non-V8 cross-check of the WASI artifact | deferred, not rejected: issue #53 — "runs in any wasm host" is not claimed until a non-JavaScript host test exists |

## What the removal did not touch

Lua stays verbatim 5.4.8; error handling stays on the standard wasm EH
encoding, compiled as C++ with the bundled micro-runtime; the reactor
model (every call returns, no call blocks, a coroutine resumed per
frame) is unchanged and now carries a message each way. The findings of
[`wasm-audit-2026-07-05.md`](wasm-audit-2026-07-05.md) about old V8
(Node 22/23 host-crash the suite's to-be-closed region on both EH paths)
stand as the reason the Node floor is 24.15; they are a property of the
engine, not of either libc.
