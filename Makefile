# Makefile for installing Lua
# See README.md for installation and customization instructions.

# == CHANGE THE SETTINGS BELOW TO SUIT YOUR ENVIRONMENT =======================

# Your platform. See PLATS for possible values.
PLAT= none

# Where to install. The installation starts in the src and doc directories,
# so take care if INSTALL_TOP is not an absolute path. See the local target.
# You may want to make INSTALL_LMOD and INSTALL_CMOD consistent with
# LUA_ROOT, LUA_LDIR, and LUA_CDIR in luaconf.h.
INSTALL_TOP= /usr/local
INSTALL_BIN= $(INSTALL_TOP)/bin
INSTALL_INC= $(INSTALL_TOP)/include
INSTALL_LIB= $(INSTALL_TOP)/lib
INSTALL_LMOD= $(INSTALL_TOP)/share/lua/$V
INSTALL_CMOD= $(INSTALL_TOP)/lib/lua/$V

# How to install. If your install program does not support "-p", then
# you may have to run ranlib on the installed liblua.a.
INSTALL= install -p
INSTALL_EXEC= $(INSTALL) -m 0755
INSTALL_DATA= $(INSTALL) -m 0644
#
# If you don't have "install" you can use "cp" instead.
# INSTALL= cp -p
# INSTALL_EXEC= $(INSTALL)
# INSTALL_DATA= $(INSTALL)

# Other utilities.
MKDIR= mkdir -p
RM= rm -f

# == END OF USER SETTINGS -- NO NEED TO CHANGE ANYTHING BELOW THIS LINE =======

# Convenience platforms targets.
PLATS= aix bsd c89 freebsd generic guess linux linux-readline macosx mingw posix solaris

# What to install.
TO_BIN= lua luac
TO_INC= lua.h luaconf.h lualib.h lauxlib.h lua.hpp
TO_LIB= liblua.a

# Lua version and release.
V= 5.4
R= $V.0

# Targets start here.
all:	$(PLAT)

$(PLATS) clean:
	cd src && $(MAKE) $@

test:	dummy
	src/lua -v

install: dummy
	cd src && $(MKDIR) $(INSTALL_BIN) $(INSTALL_INC) $(INSTALL_LIB) $(INSTALL_LMOD) $(INSTALL_CMOD)
	cd src && $(INSTALL_EXEC) $(TO_BIN) $(INSTALL_BIN)
	cd src && $(INSTALL_DATA) $(TO_INC) $(INSTALL_INC)
	cd src && $(INSTALL_DATA) $(TO_LIB) $(INSTALL_LIB)

uninstall:
	cd src && cd $(INSTALL_BIN) && $(RM) $(TO_BIN)
	cd src && cd $(INSTALL_INC) && $(RM) $(TO_INC)
	cd src && cd $(INSTALL_LIB) && $(RM) $(TO_LIB)

local:
	$(MAKE) install INSTALL_TOP=../install

none:
	@echo "Please do 'make PLATFORM' where PLATFORM is one of these:"
	@echo "   $(PLATS)"
	@echo "See README.md for complete instructions."

# make may get confused with test/ and install/
dummy:

# echo config parameters
echo:
	@cd src && $(MAKE) -s echo
	@echo "PLAT= $(PLAT)"
	@echo "V= $V"
	@echo "R= $R"
	@echo "TO_BIN= $(TO_BIN)"
	@echo "TO_INC= $(TO_INC)"
	@echo "TO_LIB= $(TO_LIB)"
	@echo "INSTALL_TOP= $(INSTALL_TOP)"
	@echo "INSTALL_BIN= $(INSTALL_BIN)"
	@echo "INSTALL_INC= $(INSTALL_INC)"
	@echo "INSTALL_LIB= $(INSTALL_LIB)"
	@echo "INSTALL_LMOD= $(INSTALL_LMOD)"
	@echo "INSTALL_CMOD= $(INSTALL_CMOD)"
	@echo "INSTALL_EXEC= $(INSTALL_EXEC)"
	@echo "INSTALL_DATA= $(INSTALL_DATA)"

# echo pkg-config data
pc:
	@echo "version=$R"
	@echo "prefix=$(INSTALL_TOP)"
	@echo "libdir=$(INSTALL_LIB)"
	@echo "includedir=$(INSTALL_INC)"

# == WASM ======================================================================
# The artifact: stock Lua 5.4.8 as one translation unit (src/onelua.c),
# compiled as C++ so Lua's error handling rides wasm exception handling
# (the bundled catch(...)-only micro-runtime in onelua.c; no libc++abi),
# on upstream musl (third_party/musl, verbatim; built for wasm32 by
# port/musl.mk) with the OS under it in port/ (luaw-sys.c, luaw-fs.c).
# The module imports exactly three functions -- luaw.write, luaw.now,
# luaw.read -- and runs in any current browser from a plain page, in
# Node >= 24.15, or in any wasm runtime with the standard exception-
# handling encoding. Design: doc/history/browser-native-2026-10-13.md;
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
	  -fwasm-exceptions -nostdlib++ -Isrc \
	  -DLUA_USE_LINUX -DLUA_USE_JUMPTABLE=0 \
	  -DMAKE_LUA -DMAKE_REACTOR \
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
WASM_AR= llvm-ar
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
	$(WASM_CLANGXX) $(WASM_CFLAGS) -c -x c++ $< -o $@

$(MUSL_BUILD)/lua.linked.wasm: $(MUSL_BUILD)/onelua.o $(MUSL_RT) $(MUSL_A)
	$(WASM_CLANGXX) $(MUSL_LDFLAGS) -Wl,--strip-all $(MUSL_RT) $(MUSL_BUILD)/onelua.o $(MUSL_A) -o $@

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
.PHONY: all $(PLATS) clean test install uninstall local none dummy echo pc wasm lua-js bench lua-debug oracle differential
