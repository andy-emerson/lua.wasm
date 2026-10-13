/* The C runtime entry for lua.wasm: a reactor, not a command. The host
** calls _initialize once after instantiation; it runs the constructors
** (musl's thread-pointer setup in luaw-sys.c among them) and returns.
** There is no main and no process exit path here -- see luaw-sys.c. */

void __wasm_call_ctors(void);

__attribute__((export_name("_initialize")))
void _initialize(void) {
  __wasm_call_ctors();
}
