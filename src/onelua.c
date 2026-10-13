/*
** onelua.c -- Lua core, libraries, and interpreter as a single
** translation unit. This is the monolith: the whole program compiles
** as one file, `static` is the encapsulation boundary, and the
** artifact's export list is the API. Follows the one.c/onelua.c
** pattern that upstream Lua itself ships.
**
** Build modes (default is the full `lua` interpreter):
**   -DMAKE_LIB   just the core + libraries (no lua.c)
**   -DMAKE_LUA   the standalone interpreter (default); the wasm artifact
**                adds -DMAKE_REACTOR for the luaw_* embedding interface
*/

#ifndef MAKE_LIB
#ifndef MAKE_LUA
#define MAKE_LUA
#endif
#endif

/* setup for luaconf.h */
#define LUA_CORE
#define LUA_LIB
#define ltable_c
#define lvm_c
#include "luaconf.h"

/* Do not export internal symbols -- unless this build links the ltests
** debug library (-DLUA_LTESTS). ltests.c pokes VM internals by design,
** so that build leaves LUAI_FUNC at luaconf.h's plain extern. Hidden
** visibility still keeps everything out of the artifact's export list. */
#if !defined(LUA_LTESTS)
#undef LUAI_FUNC
#undef LUAI_DDEC
#undef LUAI_DDEF
#if defined(__cplusplus)
/* C++ reads an uninitialized static-const declaration as a definition,
   so const data can't be forward-declared static; extern + hidden
   visibility keeps it internal instead */
#define LUAI_FUNC	static
#define LUAI_DDEC(dec)	extern dec
#define LUAI_DDEF	/* empty */
#else
#define LUAI_FUNC	static
#define LUAI_DDEC(dec)	static dec
#define LUAI_DDEF	static
#endif
#endif /* !LUA_LTESTS */

/*
** ── The wasm runtime: non-local jumps ───────────────────────────────
** Raw wasm has neither setjmp/longjmp nor unwinding; Lua's error
** handling (LUAI_THROW/LUAI_TRY) needs one of them. Compiled as C++,
** Lua natively switches to throw/catch, which clang lowers onto the
** wasm exception-handling proposal (standard try_table/exnref
** encoding, -mllvm -wasm-use-legacy-eh=false). Lua throws exactly one
** pointer and catches with catch(...) -- no type matching, no
** destructors -- so instead of a libc++abi built with wasm EH (which no
** distro ships) this micro-runtime provides the five __cxa entry points
** and dummy typeinfo vtables that catch(...) never inspects. Build with
** -fwasm-exceptions. (A C route exists on paper -- clang's
** -wasm-enable-sjlj pass rewrites setjmp/longjmp onto wasm EH -- but
** every LLVM available miscompiled it when tried: 18 segfaults, 19.1.1
** emits structurally invalid catch placement, 21 rejects its own tag
** symbols. Removed in the cutover to musl; doc/history has the record.)
**
** Everything else Lua needs from a C runtime is musl's own, unmodified
** (third_party/musl, port/musl.mk), with the OS under it in
** port/luaw-sys.c and port/luaw-fs.c.
*/
#if defined(__wasm__)

#include <stdint.h>
#include <stddef.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <string.h>

#if defined(__cplusplus)
extern "C" {

struct __luawasm_eh_header {
  void *typeinfo;
  void (*dtor)(void *);
};

void *__cxa_allocate_exception (size_t size) {
  char *p = (char *)malloc(sizeof(struct __luawasm_eh_header) + size);
  return p + sizeof(struct __luawasm_eh_header);
}

void __cxa_free_exception (void *obj) {
  free((char *)obj - sizeof(struct __luawasm_eh_header));
}

void __cxa_throw (void *obj, void *tinfo, void (*dtor)(void *)) {
  struct __luawasm_eh_header *h =
    (struct __luawasm_eh_header *)((char *)obj - sizeof(struct __luawasm_eh_header));
  h->typeinfo = tinfo;
  h->dtor = dtor;
  __builtin_wasm_throw(0, obj);  /* tag 0: __cpp_exception */
}

void *__cxa_begin_catch (void *obj) { return obj; }

void __cxa_end_catch (void) {}

void __gxx_wasm_personality_v0 (void) {}

/* catch(...) never inspects type_info; these exist only as symbols for
   the throw site's weak typeinfo objects */
char __luawasm_ptr_ti_vtable[32] __asm__("_ZTVN10__cxxabiv119__pointer_type_infoE");
char __luawasm_class_ti_vtable[32] __asm__("_ZTVN10__cxxabiv117__class_type_infoE");

void __luawasm_terminate (void) __asm__("_ZSt9terminatev");
void __luawasm_terminate (void) { abort(); }

}  /* extern "C" */
#else
#error "the wasm build is C++ only: Lua's error handling rides wasm exception handling through throw/catch (see above)"
#endif

#endif /* __wasm__ */

/* When compiled as C++, keep C linkage throughout: the exports, the
** libc underneath (musl, C) and the OS layer in port/ must agree on
** symbol names. Linkage only -- inside these braces the code still
** compiles as C++ (which is how LUAI_THROW becomes a real throw). */
#if defined(__cplusplus)
extern "C" {
#endif

/* core */
#include "lzio.c"
#include "lctype.c"
#include "lopcodes.c"
#include "lmem.c"
#include "lundump.c"
#include "ldump.c"
#include "lstate.c"
#include "lgc.c"
#include "llex.c"
#undef next  /* llex.c's file-local macro; hostile to libstdc++ headers
                that C++ hosted builds may pull in after this point */
#include "lcode.c"
#include "lparser.c"
#include "ldebug.c"
#include "lfunc.c"
#include "lobject.c"
#include "ltm.c"
#include "lstring.c"
#include "ltable.c"
#include "ldo.c"
#include "lvm.c"
#include "lapi.c"

/* auxiliary library */
#include "lauxlib.c"

/* standard libraries */
#include "lbaselib.c"
#include "lcorolib.c"
#include "ldblib.c"
#include "liolib.c"
#include "lmathlib.c"
#include "loadlib.c"
#include "loslib.c"
#include "lstrlib.c"
#include "ltablib.c"
#include "lutf8lib.c"
#include "linit.c"

/* The witness debug build (-DLUA_LTESTS): vendored upstream ltests
** (tests/ltests/) instruments the VM -- checked allocator, internal
** assertions, and the T library that unlocks the suite's C-API
** battery. ltests.c compiles as its own translation unit (it clashes
** with lstrlib.c's namespace inside one TU), so build with
**   -DLUA_LTESTS '-DLUA_USER_H="ltests.h"' -Itests/ltests -Isrc \
**   src/onelua.c tests/ltests/ltests.c
** Witness-only; never the shipped artifact.
**
** ltests.h gates its own luaL_newstate/luaL_openlibs wrappers on
** lua.c's 'lua_c' macro, which an amalgamation cannot set TU-wide
** without clobbering lauxlib.c's real definitions -- so the same two
** wrappers are applied here, scoped to the interpreter below. */
#if defined(LUA_LTESTS)
static lua_State *luaw_ltests_newstate (void) {
  return lua_newstate(debug_realloc, &l_memcontrol);
}
static void luaw_ltests_openlibs (lua_State *L) {
  luaL_openlibs(L);
  luaL_requiref(L, "T", luaB_opentests, 1);
  lua_pop(L, 1);
}
#define luaL_newstate	luaw_ltests_newstate
#define luaL_openlibs	luaw_ltests_openlibs
#endif

/* interpreter */
#ifdef MAKE_LUA
#include "lua.c"
#endif

/*
** ── The embedding interface ─────────────────────────────────────────
** MAKE_REACTOR wasm builds are reactors: the host calls in, the VM
** returns. The host interface is the exports below plus the three
** imports the libc underneath makes (port/luaw-sys.c: luaw.write,
** luaw.now, luaw.read), and nothing else.
**
** This glue is opt-in (-DMAKE_REACTOR, set by the Makefile's wasm
** target), NOT implied by MAKE_LIB: the luaw_* exports and their
** reactor coroutine model are a property of this project's finished
** artifact, not of the Lua core, so the reactor belongs to the artifact
** build alone.
**
** The contract: no call here ever blocks. A
** long-lived program (a game's main loop) runs as a coroutine --
** luaw_start loads it, and the host pumps luaw_step once per frame;
** each yield returns control to the host. No threads, no
** SharedArrayBuffer, no Asyncify, ever.
**
** Errors never unwind into the host: every entry point traps them and
** returns a Lua status code (LUA_OK == 0); the message is held in the
** registry (so the pointer stays valid) until the next entry call.
*/
#if defined(__wasm__) && defined(MAKE_REACTOR)

#define LUAW_API __attribute__((used, visibility("default")))

static lua_State *luaw_L = NULL;

static const char *const LUAW_ERRKEY = "luaw.error";
static const char *const LUAW_COKEY  = "luaw.coroutine";
static const char *const LUAW_MSGKEY = "luaw.message";

/* os.exit (D3): musl flushes stdio, the OS layer (port/luaw-sys.c)
   records the status and traps. Nothing inside can intercept it, and
   the instance is finished: every entry below refuses from then on. */
extern int luaw_exited;
extern int luaw_exit_status;
#define LUAW_ENTRY_GUARD(ret) \
  do { if (luaw_exited) return (ret); } while (0)

/* os.clock counts from the VM's creation (port/luaw-sys.c) */
extern void luaw_clock_start(void);

/* stash the error at the top of 'from's stack; keep it alive in the
   registry of the main state so the returned pointer stays valid */
static void luaw_seterror (lua_State *from) {
  const char *msg = lua_tostring(from, -1);
  lua_pushstring(luaw_L, msg ? msg : "(error object is not a string)");
  lua_setfield(luaw_L, LUA_REGISTRYINDEX, LUAW_ERRKEY);
  lua_pop(from, 1);
}

static void luaw_clearerror (void) {
  lua_pushnil(luaw_L);
  lua_setfield(luaw_L, LUA_REGISTRYINDEX, LUAW_ERRKEY);
}

/* create the VM: standard libraries; returns 0 on success */
LUAW_API int luaw_init (void) {
  LUAW_ENTRY_GUARD(LUA_ERRRUN);
  if (luaw_L != NULL) return 0;
  luaw_clock_start();
  luaw_L = luaL_newstate();
  if (luaw_L == NULL) return LUA_ERRMEM;
  luaL_openlibs(luaw_L);
  return 0;
}

/* buffer management for passing chunks in from the host */
LUAW_API void *luaw_alloc (size_t n) { return malloc(n); }
LUAW_API void luaw_free (void *p) { free(p); }

/* the last error message (NUL-terminated), or NULL if the last entry
   call succeeded; valid until the next entry call */
LUAW_API const char *luaw_last_error (void) {
  const char *msg;
  if (luaw_exited) return "VM exited";
  if (luaw_L == NULL) return "luaw_init has not been called";
  lua_getfield(luaw_L, LUA_REGISTRYINDEX, LUAW_ERRKEY);
  msg = lua_tostring(luaw_L, -1);
  lua_pop(luaw_L, 1);
  return msg;   /* string stays alive via the registry reference */
}

/* the status os.exit (or lua.c's main) ended the instance with; valid
   once an entry call has trapped and luaw_last_error says "VM exited" */
LUAW_API int luaw_exit_code (void) {
  return luaw_exit_status;
}

/* set (or, with a NULL value, remove) an environment variable before
   Lua reads it: TZ for local time, LUA_PATH, LUA_INIT, anything
   os.getenv is asked for. The environment starts empty. 0 on success. */
LUAW_API int luaw_setenv (const char *name, const char *value) {
  return value ? setenv(name, value, 1) : unsetenv(name);
}

/* load and run a chunk to completion; returns a Lua status code */
LUAW_API int luaw_run (const char *chunk, size_t len, const char *name) {
  int status;
  LUAW_ENTRY_GUARD(LUA_ERRRUN);
  if (luaw_L == NULL) return LUA_ERRRUN;
  luaw_clearerror();
  status = luaL_loadbuffer(luaw_L, chunk, len, name ? name : "=(embedded)");
  if (status == LUA_OK)
    status = lua_pcall(luaw_L, 0, 0, 0);
  if (status != LUA_OK)
    luaw_seterror(luaw_L);
  return status;
}

/* load a chunk as the resident program (a coroutine); the host then
   pumps luaw_step. Replaces any previous resident program. */
LUAW_API int luaw_start (const char *chunk, size_t len, const char *name) {
  int status;
  lua_State *co;
  LUAW_ENTRY_GUARD(LUA_ERRRUN);
  if (luaw_L == NULL) return LUA_ERRRUN;
  luaw_clearerror();
  co = lua_newthread(luaw_L);
  status = luaL_loadbuffer(co, chunk, len, name ? name : "=(program)");
  if (status != LUA_OK) {
    luaw_seterror(co);
    lua_pop(luaw_L, 1);  /* drop the thread */
    return status;
  }
  lua_setfield(luaw_L, LUA_REGISTRYINDEX, LUAW_COKEY);
  lua_pushnil(luaw_L);
  lua_setfield(luaw_L, LUA_REGISTRYINDEX, LUAW_MSGKEY);
  return LUA_OK;
}

/* resume the resident program for one step. LUA_YIELD: it yielded and
   is still alive -- call again next frame. LUA_OK: it finished. Any
   other status: it failed; the message is in luaw_last_error().

   The message channel (D2b): the program's first yield value, if it is
   a string or a number, is kept for luaw_message(); what the host
   passes here (msg, or NULL for none) becomes the value its
   coroutine.yield() returns. A program that wants nothing from the
   host yields nothing and ignores yield's result; the first resume
   delivers msg as the chunk's argument (...). */
LUAW_API int luaw_step (const char *msg, size_t len) {
  int status, nres, nargs = 0;
  lua_State *co;
  LUAW_ENTRY_GUARD(LUA_ERRRUN);
  if (luaw_L == NULL) return LUA_ERRRUN;
  luaw_clearerror();
  lua_getfield(luaw_L, LUA_REGISTRYINDEX, LUAW_COKEY);
  co = lua_tothread(luaw_L, -1);
  lua_pop(luaw_L, 1);
  if (co == NULL) {
    lua_pushliteral(luaw_L, "no resident program (luaw_start first)");
    lua_setfield(luaw_L, LUA_REGISTRYINDEX, LUAW_ERRKEY);
    return LUA_ERRRUN;
  }
  if (msg != NULL) {
    lua_pushlstring(co, msg, len);
    nargs = 1;
  }
  status = lua_resume(co, luaw_L, nargs, &nres);
  if (status == LUA_YIELD) {
    if (nres >= 1 && lua_isstring(co, -nres)) {
      lua_pushvalue(co, -nres);
      lua_xmove(co, luaw_L, 1);
    }
    else lua_pushnil(luaw_L);
    lua_setfield(luaw_L, LUA_REGISTRYINDEX, LUAW_MSGKEY);
    lua_pop(co, nres);
    return LUA_YIELD;
  }
  if (status != LUA_OK)
    luaw_seterror(co);
  else
    lua_pop(co, nres);   /* return values at the end are not messages */
  /* finished or failed either way: release the program, and the message
     of its last yield (this step yielded nothing) */
  lua_pushnil(luaw_L);
  lua_setfield(luaw_L, LUA_REGISTRYINDEX, LUAW_COKEY);
  lua_pushnil(luaw_L);
  lua_setfield(luaw_L, LUA_REGISTRYINDEX, LUAW_MSGKEY);
  return status;
}

/* what the resident program yielded on the last luaw_step (bytes and
   length; may contain NULs), or NULL if it yielded nothing usable;
   valid until the next entry call */
LUAW_API const char *luaw_message (size_t *len) {
  const char *s;
  size_t n = 0;
  if (luaw_L == NULL) { if (len) *len = 0; return NULL; }
  lua_getfield(luaw_L, LUA_REGISTRYINDEX, LUAW_MSGKEY);
  s = lua_tolstring(luaw_L, -1, &n);
  lua_pop(luaw_L, 1);
  if (len) *len = s ? n : 0;
  return s;   /* alive via the registry reference */
}

#if defined(MAKE_LUA)
/* the stock standalone interpreter, lua.c's main, with its own state:
   `lua [options] [script [args]]` exactly as the command line, argv[0]
   the program name. Returns its exit status; os.exit inside it traps
   like anywhere else (luaw_exit_code then holds the status). */
LUAW_API int luaw_main (int argc, char **argv) {
  LUAW_ENTRY_GUARD(1);
  luaw_clock_start();
  return main(argc, argv);
}
#endif

#endif /* __wasm__ && MAKE_REACTOR */

#if defined(__cplusplus)
}  /* extern "C" */
#endif
