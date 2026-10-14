/* app.c -- a consumer with compiled code of its own, with Lua linked in.
**
** This is the tarball's example: a C program that holds a Lua state,
** registers a C function for Lua to call, runs a script, and catches a
** Lua error in C. Only stock Lua's API is used (lua.h, lauxlib.h,
** lualib.h): nothing here is specific to this build except the host
** interface its module imports (LINK.md; the repository's doc/wasm.md),
** which host.mjs supplies.
** Built by build.sh against the tarball's sysroot with plain clang;
** host.mjs runs it under Node and expect.txt is what it must print.
*/
#include <stdio.h>
#include <lua.h>
#include <lauxlib.h>
#include <lualib.h>

/* a C function Lua calls: square a number */
static int host_square (lua_State *L) {
  lua_Number n = luaL_checknumber(L, 1);
  lua_pushnumber(L, n * n);
  return 1;
}

static const char *const script =
  "print('Lua says: ' .. _VERSION)\n"
  "print('host.square(12) =', host.square(12))\n"
  "print(string.format('%.6f %d %s', math.pi, 2^31, ('%5.1f'):format(1/3)))\n"
  "local t = {} for i = 1, 5 do t[i] = i * i end\n"
  "print(table.concat(t, ' '), #t, select('#', table.unpack(t)))\n"
  "return host.square(3) + 1\n";

/* the module's one entry point: the host calls _initialize, then this.
   Returns the script's result, or -1 after a Lua error. */
__attribute__((export_name("app_run")))
int app_run (void) {
  lua_State *L = luaL_newstate();
  luaL_openlibs(L);
  lua_newtable(L);
  lua_pushcfunction(L, host_square);
  lua_setfield(L, -2, "square");
  lua_setglobal(L, "host");

  int result = -1;
  if (luaL_dostring(L, script) == LUA_OK) {
    result = (int)lua_tointeger(L, -1);
    printf("script returned %d\n", result);
  }
  else
    printf("script failed: %s\n", lua_tostring(L, -1));
  lua_pop(L, 1);

  /* a Lua error raised inside a protected call lands back in C: the
     non-local jump crosses this program's frames (the EH unit at work) */
  if (luaL_dostring(L, "error('raised in Lua', 0)") != LUA_OK)
    printf("caught in C: %s\n", lua_tostring(L, -1));
  lua_pop(L, 1);
  fflush(stdout);
  lua_close(L);
  return result;
}
