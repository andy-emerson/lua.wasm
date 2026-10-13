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
# The wasm atom: the whole interpreter as one translation unit, one artifact.
# Compiled as C++ so Lua's error handling rides the wasm exception-handling
# proposal (see src/onelua.c for why the C sjlj route is blocked today).
# Toolchain: clang 20+ with a wasm32-wasi sysroot (doc/wasm.md; zig c++
# recipe below for hosts without a packaged clang 20). Run under any WASI
# host with wasm EH support: node scripts/wasm-run.mjs lua.wasm script.lua
# (Node >= 24.15), or python3 scripts/wasmtime-run.py lua.wasm script.lua.

# WASM_CLANGXX / WASM_SYSROOT are override points: point them at a custom
# clang or a self-built wasi-libc sysroot on the make command line, e.g.
#   make wasm WASM_CLANGXX=clang++ WASM_SYSROOT=/opt/wasi-sysroot
# The default encoding (below) needs clang 20+; `zig c++` (a clang-20+
# driver with its own wasi sysroot) also works:
#   make wasm WASM_CLANGXX="python3 -m ziglang c++" WASM_SYSROOT= \
#     WASM_EXTRA="-Xclang -target-feature -Xclang +exception-handling"
WASM_CLANGXX= clang++-20
WASM_SYSROOT= /usr
WASM_STACK= 8388608
WASM_O= lua.wasm

# EH encoding on the wire. 'standard' (default) emits the standardized
# try_table/exnref instructions -- needs LLVM 20+ to build, and runs on
# V8 with default-on exnref (Node >= 24.15, current browsers) and on non-V8
# runtimes (wasmtime). 'legacy' emits the pre-standard try/catch
# encoding that clang 18/19 produce -- only V8 engines accept it, and
# V8 12.x host-crashes on the suite's <close>-in-coroutines patterns
# under it (doc/history/wasm-audit-2026-07-05.md, finding 1); kept only as a
# bridge for toolchains without clang 20.
WASM_EH_ENCODING= standard
ifeq ($(strip $(WASM_EH_ENCODING)),standard)
WASM_EH_ENC_FLAGS= -mllvm -wasm-use-legacy-eh=false
else
WASM_EH_ENC_FLAGS=
endif

# EH runtime. 'internal' (default) uses the self-contained catch(...)-only
# micro-runtime in src/onelua.c -- no libc++abi required, but catch(...)
# semantics only. 'external' suppresses it (-DLUAW_EXTERNAL_EH) so a real
# libc++abi, built with -fwasm-exceptions, owns exception dispatch: required
# by embedders whose host C++ needs *typed* catches, so Lua errors and host
# exceptions share one EH domain. Supply the runtime's link inputs in
# WASM_EH_LIBS and any extra -I/-L in WASM_EH_FLAGS, e.g.
#   make wasm WASM_EH=external \
#     WASM_EH_FLAGS="-L/path/to/rt/lib" \
#     WASM_EH_LIBS="-lc++ -lc++abi /path/to/libunwind_wasm.a"
# No distro ships a wasm-EH libc++abi; examples/embed/build-eh.sh builds
# one from zig's bundled LLVM runtime sources (and is the CI witness).
WASM_EH= internal
WASM_EH_FLAGS=
WASM_EH_LIBS=
ifeq ($(strip $(WASM_EH)),external)
WASM_EH_DEFS= -DLUAW_EXTERNAL_EH
else
WASM_EH_DEFS=
endif

# -fno-strict-aliasing: retained as cheap insurance against a witnessed
# TBAA miscompile class (issue #4). At import time, a clang-19-era -O2
# wasm build reordered the GC-stop flag store in lgc.c's GCTM across
# the finalizer call (surfaced by 5.4.8's gc reentrancy test; correct
# at -O1/-Os and with this flag). Probed 2026-07-06/07: the miscompile
# does NOT reproduce on the current tree under clang 19.1.1 nor under
# the pinned zig 0.15.1 (clang 20.1.2) -- the full suite passes without
# the flag on both -- so the flag is not demonstrably load-bearing
# today. It stays because the original failure was real and the cost is
# negligible (SQLite and the kernel ship the same flag); re-probe when
# the pinned toolchain moves.
# Split into compile-only and link-only halves so the archive target
# (liblua.a, below) can compile without the link inputs. WASM_FLAGS keeps
# its original expansion for the wasm/wasm-lib targets -- CFLAGS then LDFLAGS,
# byte-identical to before the split.
WASM_CFLAGS= --target=wasm32-wasi --sysroot=$(WASM_SYSROOT) -O2 -fno-strict-aliasing \
	  -fwasm-exceptions -nostdlib++ \
	  -Isrc/wasi -Isrc \
	  -D_WASI_EMULATED_SIGNAL -D_WASI_EMULATED_PROCESS_CLOCKS \
	  -DLUA_USE_JUMPTABLE=0 \
	  $(WASM_EH_ENC_FLAGS) $(WASM_EH_DEFS) $(WASM_EH_FLAGS)
WASM_LDFLAGS= -Wl,-z,stack-size=$(WASM_STACK) \
	  -lwasi-emulated-signal -lwasi-emulated-process-clocks
WASM_FLAGS= $(WASM_CFLAGS) $(WASM_LDFLAGS)

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

# The embeddable artifact: a wasm reactor (library, not command) whose
# host interface is WASI plus the luaw_* exports defined in onelua.c.
# The mode flags live in WASM_MODE (not WASM_EXTRA) so a command-line
# WASM_EXTRA -- which overrides target-specific values -- cannot silently
# strip the reactor's -DMAKE_LIB.
WASM_LIB_O= lua-lib.wasm
WASM_MODE=

wasm-lib: WASM_MODE= -DMAKE_LIB -DMAKE_REACTOR -mexec-model=reactor -Wl,--export-dynamic
wasm-lib: WASM_O= $(WASM_LIB_O)
wasm-lib: wasm

wasm:
	$(WASM_CLANGXX) $(WASM_FLAGS) $(WASM_MODE) $(WASM_EXTRA) -o $(WASM_O) -x c++ src/onelua.c $(WASM_EH_LIBS)
	@# External EH sanity gate (finding 4): -DLUAW_EXTERNAL_EH suppresses the
	@# bundled shim, but linking a real libc++abi produces no duplicate-symbol
	@# error if the archive is never pulled -- you silently fall back to nothing.
	@# Fingerprint the artifact so the flag can't fail quietly. Internal mode
	@# has no libc++abi by design, so the check only runs for WASM_EH=external.
	@if [ "$(strip $(WASM_EH))" = external ]; then \
	  if grep -aq "libc++abi" $(WASM_O); then \
	    echo "external EH confirmed: libc++abi fingerprint present in $(WASM_O)"; \
	  else \
	    echo "FAIL: WASM_EH=external but the libc++abi fingerprint is missing in $(WASM_O) -- the external runtime was not linked in (micro-shim suppressed, nothing put in its place)" >&2; \
	    exit 1; \
	  fi; \
	fi

# ── Embeddable archive: link Lua into a downstream wasm32-wasi artifact (#11) ──
# The second consumer shape. Not a host wrapping the finished lua.wasm, but a
# C/C++ project targeting wasm32-wasi that needs Lua *inside* its own module.
# Two paths, one contract (doc/embedding.md):
#   * recommended -- source drop: compile src/onelua.c -DMAKE_LIB in your own
#     build under the flag contract. Self-satisfying (one compiler, one flag
#     set, no prebuilt-ABI drift).
#   * convenience -- this prebuilt liblua.a + public headers, with
#     toolchain-version skew explicitly the consumer's risk.
# The luaw_* reactor glue is excluded (no -DMAKE_REACTOR): embedders drive the
# VM through lua.h. The exec model is the downstream's link-time choice, absent
# from the archive by design.
WASM_AR= llvm-ar
LUA_A= liblua.a
LUA_A_O= onelua-lib.o
LUA_INCDIR= include
LUA_PUB_HEADERS= src/lua.h src/luaconf.h src/lualib.h src/lauxlib.h src/lua.hpp

LUA_A_DEFS= -DMAKE_LIB

liblua.a:
	$(WASM_CLANGXX) $(WASM_CFLAGS) $(WASM_EXTRA) $(LUA_A_DEFS) \
	  -c -x c++ src/onelua.c -o $(LUA_A_O)
	$(WASM_AR) rcs $(LUA_A) $(LUA_A_O)
	@mkdir -p $(LUA_INCDIR)
	cp $(LUA_PUB_HEADERS) $(LUA_INCDIR)/
	@echo "built $(LUA_A) + public headers in $(LUA_INCDIR)/ for wasm32-wasi"

# ── The C library for the browser-native artifact: upstream musl ──────────
# Rules in port/musl.mk (vendored tree in third_party/musl, arch in
# port/wasm32, the OS under it in port/luaw-sys.c). `make musl-libc`
# builds build/musl/libc.a; the artifact targets that use it follow.
include port/musl.mk

# list targets that do not create files (but not all makes understand .PHONY)
.PHONY: all $(PLATS) clean test install uninstall local none dummy echo pc wasm liblua.a

# (end of Makefile)
