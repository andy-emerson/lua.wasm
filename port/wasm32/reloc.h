/* musl arch header for wasm32 (lua.wasm port).
** Relocation types and the dynamic-linker entry jump are for ldso, which
** this static, single-module build never compiles; dynlink.h includes
** this file and supplies its own defaults when nothing is defined here. */
