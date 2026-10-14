/*
** onelua.c -- Lua core, libraries, and interpreter as a single
** translation unit. This is the monolith: the whole program compiles
** as one file, `static` is the encapsulation boundary, and the
** artifact's export list is the API. Follows the one.c/onelua.c
** pattern that upstream Lua itself ships.
**
** Build modes (default is the full `lua` interpreter):
**   -DMAKE_LIB   just the core + libraries (no lua.c). No build in this
**                repository uses it; it is the shape the link-Lua-in
**                reopen contract names (doc/history/wasi-sunset-2026-10-13.md)
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
** ── The wasm build: non-local jumps ─────────────────────────────────
** Raw wasm has neither setjmp/longjmp nor unwinding. Lua's error
** handling (LUAI_THROW/LUAI_TRY, ldo.c) is routed to port/luaw-eh.cpp,
** the one C++ translation unit, which raises and catches on the wasm
** exception-handling proposal; the interpreter itself compiles as plain
** C. LUAI_TRY is expanded only inside luaD_rawrunprotected, whose
** parameters are named f and ud -- the macro leans on that, since its
** own arguments carry the call only as text. (A C route exists on
** paper -- clang's -wasm-enable-sjlj pass rewrites setjmp/longjmp onto
** wasm EH -- but every LLVM available miscompiled it when tried: 18
** segfaults, 19.1.1 emits structurally invalid catch placement, 21
** rejects its own tag symbols; doc/history has the record.)
**
** Everything else Lua needs from a C runtime is musl's own, unmodified
** (third_party/musl, port/musl.mk), with the OS under it in
** port/luaw-sys.c and port/luaw-fs.c.
*/
#if defined(__wasm__)
extern void luaw_throw (void *c) __attribute__((noreturn));
extern int luaw_try (void *L, void (*f)(void *, void *), void *ud);
#define LUAI_THROW(L,c)   luaw_throw(c)
#define LUAI_TRY(L,c,a) \
  if (luaw_try((L), (void (*)(void *, void *))f, ud)) { if ((c)->status == 0) (c)->status = -1; }
#define luai_jmpbuf       int  /* unused */
#endif /* __wasm__ */

/* If ever compiled as C++, keep C linkage throughout: the exports, the
** libc and the OS layer in port/ must agree on symbol names. No build
** here compiles this file as C++ any more (the wasm build did until the
** optimization round moved the throw and catch into port/luaw-eh.cpp);
** this and the LUAI_DDEC branch above are dormant, kept with -DMAKE_LIB
** as the link-Lua-in reopen contract. */
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
** ── The bridge (D11): one import, values by copy ──────────────────
** Lua calls the host through one import, luaw.call(name, args): the
** module knows no names -- the host owns the table, and a host that
** registers nothing has a module that cannot call out. Values cross by
** copy, never by reference, in a binary encoding laid out in linear
** memory (little-endian; tag byte first):
**
**   0 nil   1 false   2 true   3 integer (i64)   4 float (f64)
**   5 text (u32 length, UTF-8 bytes)   6 bytes (u32 length, bytes)
**   7 table (u32 n, n values = the array part 1..n; u32 m, m key/value
**     pairs = the rest)   8 error (u32 length, message; host -> module)
**   9 token (u32 id; host -> module): a promise the host holds. It
**     arrives as a table {id = n} with the js.Token metatable; the host
**     delivers its settlement later, as one element of the list the
**     reserved name "\0poll" returns ({id, ok, value}), and nothing is
**     ever held by reference on either side.
**
** The argument buffer is u32 count then the values; the result is one
** value. Functions, userdata, threads and a nesting deeper than
** LUAW_MAX_DEPTH (which is where a cycle ends up) do not cross and are
** rejected here with an error; a buffer above LUAW_MAX_BYTES is too.
** A string going out is text (5); the js library's bytes() marks the
** ones that are bytes. Text and bytes coming in are both Lua strings.
**
** The import: luaw.call(name, nlen, args, alen, out) returns 0 with the
** result at out[0] (pointer, from luaw_alloc; the module frees it) and
** out[1] (length); 1 with an error value there instead; 2 if the host
** knows no such name. A host must not re-enter the VM from inside the
** import (no luaw_run, luaw_step...); luaw_alloc and luaw_free are fine.
**
** js.call(name, ...) is the one primitive; the Lua-side library (the
** source below: tokens with await and when, js.poll, the direct-call
** form js.name(...)) sits on it. luaw_openlibs registers the library on
** any state: luaw_init calls it, and a link-in consumer (-DMAKE_LIB)
** calls it on its own state after luaL_openlibs. Names beginning with
** NUL are the bridge's own protocol ("\0poll"), answered by the host
** itself, not by its table.
**
** Delivery: luaw_step and luaw_run call js.poll before running Lua, so
** a when continuation runs on the step that receives its settlement
** and an await resumes on the step after; the module never runs on its
** own, so nothing is delivered between steps. An error inside a when
** continuation is reported on stderr and does not stop the program.
*/
#if defined(__wasm__)

#include <stdint.h>
#include <stdarg.h>

#define LUAW_MAX_DEPTH 64
#define LUAW_MAX_BYTES (16u << 20)

__attribute__((import_module("luaw"), import_name("call")))
extern int luaw_call (const char *name, size_t nlen, const unsigned char *args, size_t alen, uint32_t *out);

static const char luaw_bytes_tag = 0;   /* the key js.bytes() marks with */

/* a bridge error: the message as is, no position (the position would be
   the js library's own line when called as js.name(...)), as stock's
   C-searcher errors are */
static int luaw_bridge_error (lua_State *L, const char *fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  lua_pushvfstring(L, fmt, ap);
  va_end(ap);
  return lua_error(L);
}

enum { LUAW_T_NIL, LUAW_T_FALSE, LUAW_T_TRUE, LUAW_T_INT, LUAW_T_FLOAT,
       LUAW_T_TEXT, LUAW_T_BYTES, LUAW_T_TABLE, LUAW_T_ERROR, LUAW_T_TOKEN };

static const char *const LUAW_TOKEN_MT = "js.Token";
static const char *const LUAW_DISPATCH = "luaw.dispatch";

typedef struct { unsigned char *data; size_t len, cap; lua_State *L; } luaw_buf;

static void luaw_enc_raw (luaw_buf *b, const void *p, size_t n) {
  if (b->len + n > b->cap) {
    size_t ncap = b->cap ? b->cap : 256;
    while (ncap < b->len + n) ncap *= 2;
    if (ncap > LUAW_MAX_BYTES) ncap = LUAW_MAX_BYTES;
    if (b->len + n > ncap)
      luaw_bridge_error(b->L, "value does not cross: more than %d bytes", (int)LUAW_MAX_BYTES);
    {
      unsigned char *nd = realloc(b->data, ncap);
      if (nd == NULL) luaL_error(b->L, "not enough memory");
      b->data = nd; b->cap = ncap;
    }
  }
  memcpy(b->data + b->len, p, n);
  b->len += n;
}

static void luaw_enc_u8 (luaw_buf *b, unsigned char v) { luaw_enc_raw(b, &v, 1); }
static void luaw_enc_u32 (luaw_buf *b, uint32_t v) { luaw_enc_raw(b, &v, 4); }

static void luaw_enc_value (lua_State *L, int idx, luaw_buf *b, int depth);

/* the array part is 1..rawlen; everything else is a pair */
static void luaw_enc_table (lua_State *L, int idx, luaw_buf *b, int depth) {
  lua_Unsigned n = lua_rawlen(L, idx), i;
  uint32_t m = 0;
  size_t mpos;
  if (depth > LUAW_MAX_DEPTH)
    luaw_bridge_error(L, "value does not cross: table nesting deeper than %d (a cycle?)", LUAW_MAX_DEPTH);
  luaL_checkstack(L, 4, "value to the host");
  luaw_enc_u8(b, LUAW_T_TABLE);
  luaw_enc_u32(b, (uint32_t)n);
  for (i = 1; i <= n; i++) {
    lua_rawgeti(L, idx, (lua_Integer)i);
    luaw_enc_value(L, lua_gettop(L), b, depth);
    lua_pop(L, 1);
  }
  mpos = b->len;
  luaw_enc_u32(b, 0);                 /* patched below */
  lua_pushnil(L);
  while (lua_next(L, idx) != 0) {
    int skip = lua_isinteger(L, -2) && lua_tointeger(L, -2) >= 1 && (lua_Unsigned)lua_tointeger(L, -2) <= n;
    if (!skip) {
      luaw_enc_value(L, lua_gettop(L) - 1, b, depth);
      luaw_enc_value(L, lua_gettop(L), b, depth);
      m++;
    }
    lua_pop(L, 1);
  }
  memcpy(b->data + mpos, &m, 4);
}

static void luaw_enc_value (lua_State *L, int idx, luaw_buf *b, int depth) {
  switch (lua_type(L, idx)) {
    case LUA_TNIL: luaw_enc_u8(b, LUAW_T_NIL); break;
    case LUA_TBOOLEAN: luaw_enc_u8(b, lua_toboolean(L, idx) ? LUAW_T_TRUE : LUAW_T_FALSE); break;
    case LUA_TNUMBER:
      if (lua_isinteger(L, idx)) {
        int64_t v = (int64_t)lua_tointeger(L, idx);
        luaw_enc_u8(b, LUAW_T_INT);
        luaw_enc_raw(b, &v, 8);
      }
      else {
        double v = (double)lua_tonumber(L, idx);
        luaw_enc_u8(b, LUAW_T_FLOAT);
        luaw_enc_raw(b, &v, 8);
      }
      break;
    case LUA_TSTRING: {
      size_t len;
      const char *s = lua_tolstring(L, idx, &len);
      luaw_enc_u8(b, LUAW_T_TEXT);
      luaw_enc_u32(b, (uint32_t)len);
      luaw_enc_raw(b, s, len);
      break;
    }
    case LUA_TTABLE: {
      /* js.bytes(s) marks a string as bytes: a table holding it under a
         light-userdata key no program can forge */
      lua_rawgetp(L, idx, &luaw_bytes_tag);
      if (lua_type(L, -1) == LUA_TSTRING) {
        size_t len;
        const char *s = lua_tolstring(L, -1, &len);
        luaw_enc_u8(b, LUAW_T_BYTES);
        luaw_enc_u32(b, (uint32_t)len);
        luaw_enc_raw(b, s, len);
        lua_pop(L, 1);
        break;
      }
      lua_pop(L, 1);
      luaw_enc_table(L, idx, b, depth + 1);
      break;
    }
    default:
      luaw_bridge_error(L, "value does not cross: %s", luaL_typename(L, idx));
  }
}

/* decode one value from [*p, end) onto the stack; errors are the
   host's fault (a malformed buffer) and say so */
static void luaw_dec_value (lua_State *L, const unsigned char **p, const unsigned char *end, int depth);

static uint32_t luaw_dec_u32 (lua_State *L, const unsigned char **p, const unsigned char *end) {
  uint32_t v;
  if (end - *p < 4) luaL_error(L, "malformed value from the host");
  memcpy(&v, *p, 4); *p += 4;
  return v;
}

static void luaw_dec_value (lua_State *L, const unsigned char **p, const unsigned char *end, int depth) {
  unsigned char tag;
  if (depth > LUAW_MAX_DEPTH) luaL_error(L, "malformed value from the host (too deep)");
  if (*p >= end) luaL_error(L, "malformed value from the host");
  luaL_checkstack(L, 4, "value from the host");
  tag = *(*p)++;
  switch (tag) {
    case LUAW_T_NIL: lua_pushnil(L); break;
    case LUAW_T_FALSE: lua_pushboolean(L, 0); break;
    case LUAW_T_TRUE: lua_pushboolean(L, 1); break;
    case LUAW_T_INT: {
      int64_t v;
      if (end - *p < 8) luaL_error(L, "malformed value from the host");
      memcpy(&v, *p, 8); *p += 8;
      lua_pushinteger(L, (lua_Integer)v);
      break;
    }
    case LUAW_T_FLOAT: {
      double v;
      if (end - *p < 8) luaL_error(L, "malformed value from the host");
      memcpy(&v, *p, 8); *p += 8;
      lua_pushnumber(L, (lua_Number)v);
      break;
    }
    case LUAW_T_TEXT: case LUAW_T_BYTES: case LUAW_T_ERROR: {
      uint32_t len = luaw_dec_u32(L, p, end);
      if ((size_t)(end - *p) < len) luaL_error(L, "malformed value from the host");
      lua_pushlstring(L, (const char *)*p, len); *p += len;
      break;
    }
    case LUAW_T_TABLE: {
      uint32_t n = luaw_dec_u32(L, p, end), m, i;
      lua_createtable(L, (int)(n < 1024 ? n : 1024), 0);
      for (i = 1; i <= n; i++) {
        luaw_dec_value(L, p, end, depth + 1);
        lua_rawseti(L, -2, (lua_Integer)i);
      }
      m = luaw_dec_u32(L, p, end);
      for (i = 0; i < m; i++) {
        luaw_dec_value(L, p, end, depth + 1);   /* key */
        luaw_dec_value(L, p, end, depth + 1);   /* value */
        if (lua_isnil(L, -2)) luaL_error(L, "malformed value from the host (nil key)");
        lua_rawset(L, -3);
      }
      break;
    }
    case LUAW_T_TOKEN: {
      uint32_t id = luaw_dec_u32(L, p, end);
      lua_createtable(L, 0, 1);
      lua_pushinteger(L, (lua_Integer)id);
      lua_setfield(L, -2, "id");
      luaL_setmetatable(L, LUAW_TOKEN_MT);
      break;
    }
    default: luaL_error(L, "malformed value from the host (tag %d)", (int)tag);
  }
}

static int luaw_dec_entry (lua_State *L) {
  const unsigned char *p = (const unsigned char *)lua_touserdata(L, 1);
  const unsigned char *end = (const unsigned char *)lua_touserdata(L, 2);
  lua_settop(L, 0);
  luaw_dec_value(L, &p, end, 0);
  return 1;
}

/* js.call(name, ...): the primitive. Returns the host's one result, or
   raises the host's error as a Lua error with its message. */
/* encode the arguments at stack 2..top into the buffer at 1 (a
   lightuserdata); runs under lua_pcall so an error frees the buffer */
static int luaw_enc_entry (lua_State *L) {
  luaw_buf *b = (luaw_buf *)lua_touserdata(L, 1);
  int nargs = lua_gettop(L) - 1, i;
  luaw_enc_u32(b, (uint32_t)nargs);
  for (i = 2; i <= nargs + 1; i++) luaw_enc_value(L, i, b, 0);
  return 0;
}

static int luaw_js_call (lua_State *L) {
  size_t nlen;
  const char *name = luaL_checklstring(L, 1, &nlen);
  int nargs = lua_gettop(L) - 1, i, status, rc;
  uint32_t out[2] = {0, 0};
  const unsigned char *p, *end;
  luaw_buf b = {NULL, 0, 0, L};
  luaL_checkstack(L, nargs + 3, "arguments to the host");
  lua_pushcfunction(L, luaw_enc_entry);
  lua_pushlightuserdata(L, &b);
  for (i = 2; i <= nargs + 1; i++) lua_pushvalue(L, i);
  rc = lua_pcall(L, nargs + 1, 0, 0);
  if (rc != LUA_OK) { free(b.data); return lua_error(L); }
  status = luaw_call(name, nlen, b.data, b.len, out);
  free(b.data);
  if (status == 2) {
    if (out[0]) free((void *)(uintptr_t)out[0]);
    return luaw_bridge_error(L, "no such function '%s' (the host registered none by that name)", name);
  }
  p = (const unsigned char *)(uintptr_t)out[0];
  end = p + out[1];
  if (p == NULL) { lua_pushnil(L); return 1; }
  if (status != 0 && status != 1) { free((void *)p); return luaw_bridge_error(L, "the host returned status %d", status); }
  /* decode under a protected call so the host's buffer is freed either way */
  lua_pushcfunction(L, luaw_dec_entry);
  lua_pushlightuserdata(L, (void *)p);
  lua_pushlightuserdata(L, (void *)end);
  rc = lua_pcall(L, 2, 1, 0);
  free((void *)(uintptr_t)out[0]);
  if (rc != LUA_OK || status == 1) return lua_error(L);   /* a decode error, or the host's error value as the message */
  return 1;
}

/* js.bytes(s): mark a string so it crosses as bytes, not text */
static int luaw_js_bytes (lua_State *L) {
  luaL_checkstring(L, 1);
  lua_createtable(L, 0, 1);
  lua_pushvalue(L, 1);
  lua_rawsetp(L, -2, &luaw_bytes_tag);
  return 1;
}

/* the library, in Lua: it receives the table holding the primitives
   (call, bytes) and the Token metatable, and fills in the rest */
static const char luaw_js_source[] =
  "local js, Token = ...\n"
  "local call = js.call\n"
  "local pending = {}          -- id -> {done, ok, value, when = {fns}}\n"
  "local function entry(id)\n"
  "  local e = pending[id]\n"
  "  if not e then e = {when = {}} pending[id] = e end\n"
  "  return e\n"
  "end\n"
  "-- settlements since the last poll, delivered: an await sees its entry\n"
  "-- done, a when continuation runs here, in order of settlement\n"
  "function js.poll()\n"
  "  local list = call('\\0poll')\n"
  "  for _, s in ipairs(list) do\n"
  "    local e = entry(s.id)\n"
  "    e.done, e.ok, e.value = true, s.ok, s.value\n"
  "    local fns = e.when\n"
  "    e.when = {}\n"
  "    if #fns > 0 then pending[s.id] = nil end\n"
  "    for _, f in ipairs(fns) do f(s.ok, s.value) end\n"
  "  end\n"
  "  return list\n"
  "end\n"
  "Token.__index = Token\n"
  "Token.__name = 'js.Token'\n"
  "-- yield to the host until this token settles; returns ok, value\n"
  "function Token:await()\n"
  "  local e = entry(self.id)\n"
  "  while not e.done do\n"
  "    if not coroutine.isyieldable() then\n"
  "      error('await: only the resident program can wait for a token (use :when or js.poll)', 2)\n"
  "    end\n"
  "    coroutine.yield()\n"
  "    js.poll()\n"
  "  end\n"
  "  pending[self.id] = nil\n"
  "  return e.ok, e.value\n"
  "end\n"
  "-- run f(ok, value) when this token settles (at once if it has)\n"
  "function Token:when(f)\n"
  "  local e = entry(self.id)\n"
  "  if e.done then pending[self.id] = nil f(e.ok, e.value)\n"
  "  else e.when[#e.when + 1] = f end\n"
  "  return self\n"
  "end\n"
  "function Token:settled() return entry(self.id).done == true end\n"
  "function Token.__tostring(t) return 'js.Token(' .. t.id .. ')' end\n"
  "-- js.name(...) is js.call('name', ...): the closure is made once\n"
  "setmetatable(js, {__index = function(t, name)\n"
  "  if type(name) ~= 'string' then return nil end\n"
  "  local f = function(...) return call(name, ...) end\n"
  "  rawset(t, name, f)\n"
  "  return f\n"
  "end})\n"
  "return js\n";

static int luaw_open_js (lua_State *L) {
  static const luaL_Reg funcs[] = {
    {"call", luaw_js_call},
    {"bytes", luaw_js_bytes},
    {NULL, NULL}
  };
  luaL_newlib(L, funcs);
  luaL_newmetatable(L, LUAW_TOKEN_MT);
  lua_pushvalue(L, -1);
  lua_setfield(L, -3, "Token");
  if (luaL_loadbuffer(L, luaw_js_source, sizeof(luaw_js_source) - 1, "=js") != LUA_OK)
    return lua_error(L);
  lua_pushvalue(L, -3);   /* js */
  lua_pushvalue(L, -3);   /* Token */
  lua_call(L, 2, 1);      /* returns js */
  /* keep js.poll where luaw_step and luaw_run can reach it */
  lua_getfield(L, -1, "poll");
  lua_setfield(L, LUA_REGISTRYINDEX, LUAW_DISPATCH);
  return 1;
}

/* deliver settlements before running Lua: js.poll under a protected
   call; an error in a when continuation is reported, not raised */
static void luaw_dispatch (lua_State *L) {
  lua_getfield(L, LUA_REGISTRYINDEX, LUAW_DISPATCH);
  if (lua_isfunction(L, -1)) {
    if (lua_pcall(L, 0, 0, 0) != LUA_OK) {
      const char *msg = lua_tostring(L, -1);
      lua_writestringerror("js: error in a when continuation: %s\n", msg ? msg : "(not a string)");
      lua_pop(L, 1);
    }
  }
  else lua_pop(L, 1);
}

/* require for a reactor host (D8 row 4): a module that is not in the
   filesystem is fetched by yielding to the host -- the resident program
   yields "\0luaw:fetch:" .. name, the host puts name.lua (dots as
   directories) into the filesystem and resumes with "ok" or with a
   reason, which the error carries in parentheses. The search and the
   load are done in Lua rather than through the C require, whose
   lua_call boundary would stop a module's own require from yielding.
   What a program sees is require's contract: package.preload,
   package.path, one load per name, package.loaded, the loader's two
   results, and stock's error texts byte for byte (asserted against
   native lua by lua.js's files page). Installed on the reactor state
   only: stock lua.c under luaw_main keeps stock require. */
static const char luaw_require_source[] =
  "local loaded, preload, searchpath = package.loaded, package.preload, package.searchpath\n"
  "local function load_from(name, path)\n"
  "  local f, err = loadfile(path)\n"
  "  -- level 0: stock raises this from inside the C searcher, so it carries no position\n"
  "  if not f then error(\"error loading module '\" .. name .. \"' from file '\" .. path .. \"':\\n\\t\" .. err, 0) end\n"
  "  local r = f(name, path)\n"
  "  if r ~= nil then loaded[name] = r end\n"
  "  if loaded[name] == nil then loaded[name] = true end\n"
  "  return loaded[name], path\n"
  "end\n"
  "-- the \"no file\" lines stock require lists after the preload field,\n"
  "-- each searcher's list behind its own newline and tab: package.path,\n"
  "-- then package.cpath, then (for a dotted name) the all-in-one\n"
  "-- loader's search of cpath for the root name\n"
  "local function notfound(name)\n"
  "  local _, err = searchpath(name, package.path)\n"
  "  local _, cerr = searchpath(name, package.cpath)\n"
  "  local msg = \"module '\" .. name .. \"' not found:\\n\\tno field package.preload['\" .. name .. \"']\\n\\t\" .. err .. \"\\n\\t\" .. cerr\n"
  "  local root = name:match(\"^([^.]+)%.\")\n"
  "  if root then msg = msg .. \"\\n\\t\" .. select(2, searchpath(root, package.cpath)) end\n"
  "  return msg\n"
  "end\n"
  "function require(...)\n"
  "  local name = ...\n"
  "  local t = type(name)\n"
  "  if t == \"number\" then name = tostring(name)\n"
  "  elseif t ~= \"string\" then\n"
  "    error(\"bad argument #1 to 'require' (string expected, got \" .. (select(\"#\", ...) == 0 and \"no value\" or t) .. \")\", 2)\n"
  "  end\n"
  "  local v = loaded[name]\n"
  "  if v then return v end\n"
  "  local pre = preload[name]\n"
  "  if pre then\n"
  "    local r = pre(name, \":preload:\")\n"
  "    if r ~= nil then loaded[name] = r end\n"
  "    if loaded[name] == nil then loaded[name] = true end\n"
  "    return loaded[name], \":preload:\"\n"
  "  end\n"
  "  local path, err = searchpath(name, package.path)\n"
  "  if path then return load_from(name, path) end\n"
  "  local msg = notfound(name)\n"
  "  if not coroutine.isyieldable() then\n"
  "    error(msg .. \"\\n\\t(cannot fetch from here: only the resident program can; put the module in the filesystem first)\", 2)\n"
  "  end\n"
  "  local answer = coroutine.yield(\"\\0luaw:fetch:\" .. name)\n"
  "  if answer ~= \"ok\" then error(msg .. \"\\n\\t(\" .. tostring(answer) .. \")\", 2) end\n"
  "  path = searchpath(name, package.path)\n"
  "  if not path then error(msg, 2) end\n"
  "  return load_from(name, path)\n"
  "end\n";

/* register the js library and the reactor's require on any state:
   luaw_init calls this; a link-in consumer calls it on its own state
   after luaL_openlibs */
void luaw_openlibs (lua_State *L) {
  luaL_getsubtable(L, LUA_REGISTRYINDEX, LUA_PRELOAD_TABLE);
  lua_pushcfunction(L, luaw_open_js);
  lua_setfield(L, -2, "js");
  lua_pop(L, 1);
  /* and make it a global, as the standard libraries are */
  luaL_requiref(L, "js", luaw_open_js, 1);
  lua_pop(L, 1);
  /* the reactor's require (fetch by yield) */
  if (luaL_loadbuffer(L, luaw_require_source, sizeof(luaw_require_source) - 1, "=require") != LUA_OK
      || lua_pcall(L, 0, 0, 0) != LUA_OK) {
    lua_writestringerror("luaw: the require shim did not install: %s\n", lua_tostring(L, -1));
    lua_pop(L, 1);
  }
}

#endif /* __wasm__ */

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
   the VM is finished: every entry below that runs Lua refuses from then
   on. The filesystem exports, luaw_setenv and the buffers keep working
   (the libc is intact), so a host can still collect what the program
   wrote before it exited. */
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
  luaw_openlibs(luaw_L);
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
  luaw_dispatch(luaw_L);
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
  luaw_dispatch(luaw_L);
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
  if (luaw_exited || luaw_L == NULL) { if (len) *len = 0; return NULL; }
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
