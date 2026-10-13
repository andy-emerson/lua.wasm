/* luaw-eh.cpp -- the one C++ translation unit: Lua's non-local jump.
**
** Raw wasm has neither setjmp/longjmp nor unwinding; Lua's error
** handling (LUAI_THROW/LUAI_TRY in ldo.c) needs one of them. This file
** gives it to the C-compiled interpreter as two functions -- luaw_throw
** raises, luaw_try runs a protected call and catches -- lowered by clang
** onto the wasm exception-handling proposal (standard try_table/exnref
** encoding; build with -fwasm-exceptions -mllvm
** -wasm-use-legacy-eh=false). A wasm throw unwinds every frame on the
** stack whatever language compiled it, and Lua's C frames hold nothing
** that needs destroying, so the interpreter itself compiles as plain C
** with no exception machinery of its own: that keeps the optimizer's
** hands free in the hot loop (measured in doc/bench.md).
**
** Lua throws exactly one pointer and catches with catch(...) -- no type
** matching, no destructors -- so instead of a libc++abi built with
** wasm EH (which no distro ships) the micro-runtime below provides the
** five __cxa entry points and dummy typeinfo vtables that catch(...)
** never inspects.
*/
#include <stddef.h>
#include <stdlib.h>

extern "C" {

/* ── the micro-runtime: what clang's throw/catch lower to ────────── */
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

/* ── Lua's non-local jump (ldo.c's LUAI_THROW / LUAI_TRY) ─────────── */
/* thrown as a pointer to a type of this unit's own, so clang emits its
   typeinfo here (a void* would need libc++abi's) */
struct luaw_jump { int unused; };

__attribute__((noreturn)) void luaw_throw (void *c) {
  throw (struct luaw_jump *)c;
}

/* run f(L, ud); 0 if it returned, 1 if it threw */
int luaw_try (void *L, void (*f)(void *, void *), void *ud) {
  try { f(L, ud); }
  catch (...) { return 1; }
  return 0;
}

}  /* extern "C" */
