# Makefile -- lua.wasm. The first part delegates the native build to
# src/Makefile, which is upstream's own (stock Lua 5.4.8, verbatim; see
# scripts/verify-stock.sh): `make guess` builds src/lua and src/luac for
# the host, `make clean` cleans there. Upstream's install targets are
# not carried; this repository ships lua.wasm and lua.js, not an
# installed Lua. Everything from the WASM line down is this project's.

PLATS= guess aix bsd c89 freebsd generic ios linux linux-readline macosx mingw posix solaris

$(PLATS) clean:
	cd src && $(MAKE) $@

# == WASM ======================================================================
# The artifact: stock Lua 5.4.8 as one translation unit (src/onelua.c),
# compiled as C, with its error handling routed to the one C++ unit
# port/luaw-eh.cpp, which rides wasm exception handling (a bundled
# catch(...)-only micro-runtime; no libc++abi), on upstream musl (third_party/musl, verbatim; built for wasm32 by
# port/musl.mk) with the OS under it in port/ (luaw-sys.c, luaw-fs.c).
# The module imports exactly four functions -- luaw.write, luaw.now,
# luaw.read, luaw.call -- and runs in any current browser from a plain page and in
# Node >= 24.15 (the two hosts that are witnessed; the target is Lua on
# the web, D9). Design: doc/history/browser-native-2026-10-13.md;
# contract and witnesses: doc/wasm.md.
#
# Toolchain: clang 20+ (the standard EH encoding) with its wasm32
# compiler-rt builtins. `zig c++` / `zig cc` is a self-contained clang
# 20.1.2 that brings those along, and is what CI uses:
#   make wasm WASM_CC="python3 -m ziglang cc" MUSL_AR="python3 -m ziglang ar" \
#             WASM_CLANGXX="python3 -m ziglang c++" \
#             WASM_EXTRA="-Xclang -target-feature -Xclang +exception-handling" \
#             WASM_OPT=node_modules/binaryen/bin/wasm-opt
# Plain clang 20: WASM_CC=clang-20 MUSL_AR=llvm-ar-20 WASM_CLANGXX=clang++-20
# (needs libclang-rt's wasm32 builtins installed). Run it:
#   node scripts/lua.mjs lua.wasm -- script.lua
WASM_CLANGXX= clang++-20
WASM_STACK= 8388608
WASM_O= lua.wasm
WASM_EXTRA=

# Lua's own flags. -fno-strict-aliasing: retained as cheap insurance
# against a witnessed TBAA miscompile class (issue #4; a clang-19-era -O2
# build reordered the GC-stop flag store in lgc.c's GCTM across the
# finalizer call -- not reproducible on the pinned toolchain, kept
# because the original failure was real and the cost is negligible).
# -DLUA_USE_LINUX so the libc feature set (POSIX popen/dlopen entry
# points, isatty) is the one the native musl oracle has; the standard EH
# encoding is selected explicitly (-wasm-use-legacy-eh=false). -O2: under
# zig c++ 0.15.1 every -O1/-O2/-O3 is handed to clang as -O2 (objects
# byte-identical, checked 2026-10-13; only -Os differs), so -O3 is not a
# choice this toolchain offers and plain clang-20 is kept at -O2 to match.
WASM_CFLAGS= --target=wasm32-freestanding $(MUSL_SYSINC) -O2 -fno-strict-aliasing \
	  -Isrc -DLUA_USE_LINUX -DLUA_USE_JUMPTABLE=0 \
	  -DMAKE_LUA -DMAKE_REACTOR $(WASM_EXTRA)
# the one C++ unit: Lua's throw/catch on the standard wasm EH encoding
WASM_EHFLAGS= --target=wasm32-freestanding $(MUSL_SYSINC) -O2 -fwasm-exceptions -nostdlib++ \
	  -mllvm -wasm-use-legacy-eh=false $(WASM_EXTRA)

# The deepest witness: a native debug interpreter with upstream's
# ltests instrumentation (checked allocator, internal assertions, the
# T library that unlocks the suite's C-API battery). Witness-only.
# Run: cd tests && ../lua-debug all.lua   (expect zero 'testC not
# active' skips and 'final OK !!!'). The full run needs the suite's
# C libraries built first (make -C tests/libs LUA_DIR=../../src, headers
# being in src/); CI builds them and runs this full mode. Without them,
# port mode (-e"_port=true") skips the shell-and-dynlib-dependent checks.
# Full mode needs non-seekable stdin (files.lua's invalid-seek test); the
# CI job pipes it (': |').
lua-debug:
	$(CC) -O1 -g -DLUA_USE_LINUX -DLUA_USE_READLINE \
	  -DLUA_LTESTS '-DLUA_USER_H="ltests.h"' -Itests/ltests -Isrc \
	  -o lua-debug src/onelua.c tests/ltests/ltests.c \
	  -Wl,-E -lm -ldl -lreadline

# ── The C library: upstream musl, built for wasm32 ─────────────────────────
# Rules in port/musl.mk (WASM_CC, MUSL_AR, the generated headers, libc.a,
# the OS layer objects, and the libc's own witnesses: libc-smoke,
# libc-stress).
include port/musl.mk

# ── The artifact ───────────────────────────────────────────────────────────
# Release form: debug sections stripped at link, then Binaryen's
# wasm-opt -O3 (what Emscripten runs after every link; measured in the
# design record: -10% size, +16% on a compute loop). WASM_OPT names the
# binary (CI installs binaryen from npm: node_modules/binaryen/bin/
# wasm-opt); WASM_OPT= empty skips the pass and ships the linked module.
# The witnesses run on this file, so what is tested is what ships.
WASM_OPT?= wasm-opt
WASM_OPT_FLAGS= -O3 --enable-exception-handling --enable-bulk-memory \
	  --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals \
	  --enable-multivalue --enable-reference-types

$(MUSL_BUILD)/onelua.o: src/onelua.c $(MUSL_GENH)
	$(WASM_CC) $(WASM_CFLAGS) -c $< -o $@

$(MUSL_BUILD)/luaw-eh.o: port/luaw-eh.cpp $(MUSL_GENH)
	$(WASM_CLANGXX) $(WASM_EHFLAGS) -c $< -o $@

$(MUSL_BUILD)/lua.linked.wasm: $(MUSL_BUILD)/onelua.o $(MUSL_BUILD)/luaw-eh.o $(MUSL_RT) $(MUSL_A)
	$(WASM_CLANGXX) $(MUSL_LDFLAGS) -Wl,--strip-all $(MUSL_RT) $(MUSL_BUILD)/onelua.o $(MUSL_BUILD)/luaw-eh.o $(MUSL_A) $(MUSL_RTLIB) -o $@

$(WASM_O): $(MUSL_BUILD)/lua.linked.wasm
	@if [ -n "$(WASM_OPT)" ]; then \
	  echo "$(WASM_OPT) $(WASM_OPT_FLAGS) $< -o $@"; \
	  $(WASM_OPT) $(WASM_OPT_FLAGS) $< -o $@; \
	else cp $< $@; fi
	@node -e 'const z=require("zlib"),b=require("fs").readFileSync(process.argv[1]);console.log(process.argv[1]+": "+b.length+" bytes ("+z.brotliCompressSync(b).length+" brotli, "+z.gzipSync(b,{level:9}).length+" gzip)")' $@

wasm: $(WASM_O)

# ── The loader: lua.js ─────────────────────────────────────────────────────
# One classic script a page includes to run <script type="text/lua"> tags
# and to reach the VM from JavaScript (D8 in the design record): host.mjs,
# scripts/loader.js and lua.wasm itself (base64) in one IIFE -- the one
# shipped form; the build prints its size against the module alone.
# Witness: scripts/lua-js-witness.mjs (three engines, and from file://).
LUA_JS= lua.js
$(LUA_JS): $(WASM_O) scripts/host.mjs scripts/loader.js scripts/build-lua-js.mjs
	node scripts/build-lua-js.mjs $@ $(WASM_O)
lua-js: $(LUA_JS)

# ── The benchmark (issue #54) ───────────────────────────────────────────────
# lua.js against Wasmoon and fengari-web, pinned, in the same page under a
# real engine: the workloads in bench/, 20 rotated rounds each on fresh
# instances, plus load-to-first-print cold and warm. On demand, never
# CI-gating (runner timing is noise); the table it prints is what
# doc/bench.md records, with its run cited. BENCH_ENGINE selects the engine.
BENCH_ENGINE?= chromium
BENCH_PEERS= wasmoon@1.16.0 fengari-web@0.1.4
bench: $(LUA_JS)
	@[ -d node_modules/wasmoon ] && [ -d node_modules/fengari-web ] || npm i --no-save $(BENCH_PEERS)
	node scripts/bench-witness.mjs $(LUA_JS) $(WASM_O) --engine $(BENCH_ENGINE)

# ── The oracle and the differential witness ────────────────────────────────
# Stock Lua 5.4.8 built natively for x86_64-linux-musl, statically, with
# the same feature set (-DLUA_USE_LINUX): the reference the artifact is
# compared against byte for byte (scripts/differential.sh, corpus in
# port/test/diff). zig's bundled x86_64 musl is this build's libc.
NATIVE_MUSL_CC?= python3 -m ziglang cc
NATIVE_MUSL_LUA= build/lua-musl
$(NATIVE_MUSL_LUA): src/onelua.c
	@mkdir -p $(@D)
	$(NATIVE_MUSL_CC) -target x86_64-linux-musl -static -O2 -DLUA_USE_LINUX -DMAKE_LUA -Isrc -o $@ src/onelua.c -lm
oracle: $(NATIVE_MUSL_LUA)

differential: $(WASM_O) $(NATIVE_MUSL_LUA)
	sh scripts/differential.sh $(WASM_O) $(NATIVE_MUSL_LUA)

# list targets that do not create files (but not all makes understand .PHONY)
.PHONY: $(PLATS) clean wasm lua-js bench lua-debug oracle differential
