/* musl arch header for wasm32 (lua.wasm port).
** No process entry point: the module is a reactor, entered through its
** exports after _initialize (port/luaw-sys.c) has run the constructors. */
