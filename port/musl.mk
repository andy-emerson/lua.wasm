# port/musl.mk -- build upstream musl (third_party/musl, verbatim) for
# wasm32 as the C library under lua.wasm. Included by the top Makefile.
#
# What musl's own build does, mirrored here: generate the two derived
# headers (bits/alltypes.h, bits/syscall.h) with musl's sed tools from the
# arch's .in files, compile src/**/*.c with musl's C99 freestanding flags,
# archive. Our arch is port/wasm32 (five headers and a bits/ directory;
# bits/syscall.h.in and most of bits/ are riscv32's, verbatim -- the
# generic 32-bit tables), the OS underneath is port/luaw-sys.c (one
# syscall dispatcher over the three luaw imports), and the crt is
# port/luaw-crt.c (_initialize runs the constructors; no main).
#
# Only the source directories Lua's libc use reaches are compiled; the
# archive still resolves lazily, so an unused translation unit costs
# nothing in the artifact. thread/__unmapself.c is inline asm for a
# thread-exit path a single-threaded build never takes.
#
# Toolchain: a C compiler for wasm32 in WASM_CC (clang 20+; `python3 -m
# ziglang cc` works and is what CI uses, see the Makefile header) and its
# archiver in MUSL_AR. The target triple is wasm32-freestanding, the one
# spelling both clang and zig accept. Linking through the same driver
# with -nostdlib adds compiler-rt's builtins; nothing else is linked.

MUSL_DIR=   third_party/musl
MUSL_BUILD= build/musl
MUSL_ARCH=  port/wasm32
MUSL_A=     $(MUSL_BUILD)/libc.a

WASM_CC?= clang-20
MUSL_AR?= $(WASM_AR)

MUSL_SRCDIRS= string ctype math stdio stdlib time locale errno exit env \
  internal malloc malloc/mallocng fcntl unistd stat misc prng multibyte \
  signal thread mman dirent fenv ldso process temp
MUSL_EXCLUDE= $(MUSL_DIR)/src/thread/__unmapself.c
MUSL_SRCS= $(filter-out $(MUSL_EXCLUDE),\
  $(foreach d,$(MUSL_SRCDIRS),$(wildcard $(MUSL_DIR)/src/$(d)/*.c)))
MUSL_OBJS= $(patsubst $(MUSL_DIR)/src/%.c,$(MUSL_BUILD)/obj/%.o,$(MUSL_SRCS))

MUSL_GENH= $(MUSL_BUILD)/include/bits/alltypes.h \
           $(MUSL_BUILD)/include/bits/syscall.h \
           $(MUSL_BUILD)/src/internal/version.h

# musl's CFLAGS_C99FSE plus its own include order (arch, generic, generated
# internal, src/include, src/internal, generated public, public).
MUSL_CFLAGS= --target=wasm32-freestanding -std=c99 -nostdinc -ffreestanding \
  -fexcess-precision=standard -frounding-math -fno-strict-aliasing \
  -D_XOPEN_SOURCE=700 -O2 -w -Werror=implicit-function-declaration \
  -I$(MUSL_ARCH) -I$(MUSL_DIR)/arch/generic -I$(MUSL_BUILD)/src/internal \
  -I$(MUSL_DIR)/src/include -I$(MUSL_DIR)/src/internal \
  -I$(MUSL_BUILD)/include -I$(MUSL_DIR)/include

# What a consumer of this libc (onelua.c, the tests) compiles with: the
# public headers only, in the same order.
MUSL_SYSINC= -nostdinc -I$(MUSL_ARCH) -I$(MUSL_DIR)/arch/generic \
  -I$(MUSL_BUILD)/include -I$(MUSL_DIR)/include

# Link line for a reactor on this libc: no entry, exports kept, the
# stack size the artifact needs (deep Lua recursion), compiler-rt from the
# driver. Order: crt, OS layer, the program, libc.
MUSL_LDFLAGS= --target=wasm32-freestanding -nostdlib -Wl,--no-entry \
  -Wl,--export-dynamic -Wl,-z,stack-size=$(WASM_STACK)
MUSL_RT= $(MUSL_BUILD)/luaw-crt.o $(MUSL_BUILD)/luaw-sys.o $(MUSL_BUILD)/luaw-fs.o

$(MUSL_BUILD)/include/bits/alltypes.h: $(MUSL_ARCH)/bits/alltypes.h.in $(MUSL_DIR)/include/alltypes.h.in $(MUSL_DIR)/tools/mkalltypes.sed
	@mkdir -p $(@D)
	sed -f $(MUSL_DIR)/tools/mkalltypes.sed $(MUSL_ARCH)/bits/alltypes.h.in $(MUSL_DIR)/include/alltypes.h.in > $@

$(MUSL_BUILD)/include/bits/syscall.h: $(MUSL_ARCH)/bits/syscall.h.in
	@mkdir -p $(@D)
	cp $< $@
	sed -n -e s/__NR_/SYS_/p $< >> $@

$(MUSL_BUILD)/src/internal/version.h: $(MUSL_DIR)/VERSION
	@mkdir -p $(@D)
	printf '#define VERSION "%s"\n' "$$(cat $(MUSL_DIR)/VERSION)" > $@

$(MUSL_BUILD)/obj/%.o: $(MUSL_DIR)/src/%.c | $(MUSL_GENH)
	@mkdir -p $(@D)
	@$(WASM_CC) $(MUSL_CFLAGS) -c $< -o $@

$(MUSL_A): $(MUSL_OBJS)
	@rm -f $@
	@$(MUSL_AR) rcs $@ $(MUSL_OBJS)
	@echo "built $@ from musl $$(cat $(MUSL_DIR)/VERSION) ($(words $(MUSL_OBJS)) objects)"

# The OS layer compiles against musl's internal headers (the thread-pointer
# setup touches struct pthread), with musl's own flags.
$(MUSL_BUILD)/luaw-sys.o: port/luaw-sys.c port/luaw-sys.h $(MUSL_ARCH)/pthread_arch.h $(MUSL_ARCH)/syscall_arch.h | $(MUSL_GENH)
	@mkdir -p $(@D)
	$(WASM_CC) $(MUSL_CFLAGS) -Iport -Wall -c $< -o $@

# The filesystem needs only the public headers.
$(MUSL_BUILD)/luaw-fs.o: port/luaw-fs.c port/luaw-sys.h | $(MUSL_GENH)
	@mkdir -p $(@D)
	$(WASM_CC) --target=wasm32-freestanding $(MUSL_SYSINC) -Iport -std=c99 -D_GNU_SOURCE -O2 -Wall -c $< -o $@

$(MUSL_BUILD)/luaw-crt.o: port/luaw-crt.c
	@mkdir -p $(@D)
	$(WASM_CC) --target=wasm32-freestanding -std=c99 -nostdinc -ffreestanding -O2 -Wall -c $< -o $@

musl-libc: $(MUSL_RT) $(MUSL_A)

# The libc's own witness, no Lua involved: a C program on this libc,
# exercising what Lua leans on (printf/strtod exactness, malloc/realloc,
# libm, time, a missing file's errno, musl's locale answer, stderr,
# getenv, stdin through the read import), run by scripts/libc-smoke.mjs.
$(MUSL_BUILD)/libc-smoke.wasm: port/test/libc-smoke.c $(MUSL_RT) $(MUSL_A)
	$(WASM_CC) --target=wasm32-freestanding $(MUSL_SYSINC) -O2 -Wall -c $< -o $(MUSL_BUILD)/libc-smoke.o
	$(WASM_CC) $(MUSL_LDFLAGS) $(MUSL_RT) $(MUSL_BUILD)/libc-smoke.o $(MUSL_A) -o $@

libc-smoke: $(MUSL_BUILD)/libc-smoke.wasm
	node scripts/libc-smoke.mjs $<

.PHONY: musl-libc libc-smoke
