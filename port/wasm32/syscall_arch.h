/* musl arch header for wasm32 (lua.wasm port).
**
** musl talks to its kernel through the __syscallN inlines defined by
** each arch. wasm has no kernel: every syscall lands in one in-module
** dispatcher, __luaw_syscall (port/luaw-sys.c), which answers the
** handful of Linux syscalls Lua's libc use reaches. Numbers come from
** bits/syscall.h.in, the generic 32-bit table (riscv32's, verbatim). */

#define __SYSCALL_LL_E(x) \
((union { long long ll; long l[2]; }){ .ll = x }).l[0], \
((union { long long ll; long l[2]; }){ .ll = x }).l[1]
#define __SYSCALL_LL_O(x) __SYSCALL_LL_E((x))

long __luaw_syscall(long n, long a, long b, long c, long d, long e, long f);

static inline long __syscall0(long n) { return __luaw_syscall(n, 0, 0, 0, 0, 0, 0); }
static inline long __syscall1(long n, long a) { return __luaw_syscall(n, a, 0, 0, 0, 0, 0); }
static inline long __syscall2(long n, long a, long b) { return __luaw_syscall(n, a, b, 0, 0, 0, 0); }
static inline long __syscall3(long n, long a, long b, long c) { return __luaw_syscall(n, a, b, c, 0, 0, 0); }
static inline long __syscall4(long n, long a, long b, long c, long d) { return __luaw_syscall(n, a, b, c, d, 0, 0); }
static inline long __syscall5(long n, long a, long b, long c, long d, long e) { return __luaw_syscall(n, a, b, c, d, e, 0); }
static inline long __syscall6(long n, long a, long b, long c, long d, long e, long f) { return __luaw_syscall(n, a, b, c, d, e, f); }

#define VDSO_USEFUL 0
#define IPC_64 0
