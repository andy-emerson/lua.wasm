/* luaw-sys.c -- the operating system under musl, inside the module.
**
** musl is compiled unmodified for wasm32 (port/wasm32, port/musl.mk) and
** issues Linux syscalls as it would on Linux; port/wasm32/syscall_arch.h
** routes every one of them to __luaw_syscall below. This file answers
** them. The outside world is reached only through three imports in the
** "luaw" module, the whole host contract of lua.wasm:
**
**   write(fd, ptr, len)        bytes for stdout (1) or stderr (2)
**   now() -> f64               wall clock, milliseconds since the epoch
**   read(ptr, maxlen) -> n     stdin bytes, 0 at end of input
**
** Everything else is answered here the way Linux answers a process that
** has an in-memory filesystem (luaw-fs.c), no other processes and one
** thread: the same errno values, so Lua on lua.wasm behaves as Lua 5.4.8
** on musl Linux does on such a machine. Design:
** doc/history/browser-native-2026-10-13.md.
*/
#include "pthread_impl.h"
#include "libc.h"
#include "ksigaction.h"
#include "luaw-sys.h"
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <time.h>

#define LUAW_IMPORT(name) __attribute__((import_module("luaw"), import_name(name)))
LUAW_IMPORT("write") void luaw_host_write(int fd, const void *ptr, int len);
LUAW_IMPORT("now")   double luaw_host_now(void);
LUAW_IMPORT("read")  int luaw_host_read(void *ptr, int maxlen);

/* ── the one thread ─────────────────────────────────────────────────
** musl keeps errno, the locale and lock owners behind a thread pointer
** (pthread_arch.h); the struct pthread sits just below it. */
unsigned char __luaw_tp_area[2048] __attribute__((aligned(16)));

__attribute__((constructor(101)))
static void luaw_sys_init(void) {
  struct pthread *self = (struct pthread *)(__luaw_tp_area + 1024) - 1;
  self->self = self;
  self->tid = 1;
  self->detach_state = DT_JOINABLE;
  self->locale = &libc.global_locale;
  self->robust_list.head = &self->robust_list.head;
  libc.page_size = 4096;              /* Linux's page, what musl expects */
}

/* ── exit ───────────────────────────────────────────────────────────
** There is no process to end. exit() flushes stdio (musl's own code),
** then reaches SYS_exit_group here: the status is recorded for the
** luaw_exit_code export and the module traps -- the one event that
** unwinds into the host, and the only way nothing inside (pcall
** included) can intercept it. Every later entry refuses (luaw_exited). */
int luaw_exited = 0;
int luaw_exit_status = 0;

/* ── memory ─────────────────────────────────────────────────────────
** musl's allocator asks for memory with brk and anonymous mmap. brk
** never moves (so it can't collide with mmap); mmap hands out 4 KiB
** pages tracked in a bitmap over linear memory, reusing freed runs
** before growing. Pages handed out again are zeroed, as mmap promises;
** fresh memory from memory.grow is already zero. */
extern unsigned char __heap_base;
static uintptr_t heap_top;              /* first address never handed out */

static int grow_to(uintptr_t end) {
  uintptr_t have = (uintptr_t)__builtin_wasm_memory_size(0) * 65536;
  if (end <= have) return 1;
  return __builtin_wasm_memory_grow(0, (end - have + 65535) / 65536) != (size_t)-1;
}

#define PG 4096u
#define NPG (1u << 20)                  /* 4 GiB / 4 KiB */
static uint32_t pg_bits[NPG / 32];      /* 1 = in use or not ours */
static uint32_t pg_managed;             /* pages [0, pg_managed) are tracked */
static uint32_t pg_hint;

static int pg_used(uint32_t i) { return (pg_bits[i >> 5] >> (i & 31)) & 1; }
static void pg_mark(uint32_t i, uint32_t n, int v) {
  for (; n; n--, i++) {
    if (v) pg_bits[i >> 5] |= 1u << (i & 31);
    else   pg_bits[i >> 5] &= ~(1u << (i & 31));
  }
}

long luaw_map_anon(unsigned long len) {
  if (!heap_top) heap_top = (uintptr_t)&__heap_base;
  if (len == 0 || len > 0x7fff0000ul) return -ENOMEM;
  uint32_t n = (uint32_t)((len + PG - 1) / PG);
  if (!pg_managed) {                    /* everything below the heap is taken */
    pg_managed = (uint32_t)((heap_top + PG - 1) / PG);
    pg_mark(0, pg_managed, 1);
  }
  for (int pass = 0; pass < 2; pass++) {  /* first fit from the hint, then from 0 */
    uint32_t i = pass ? 0 : pg_hint, end = pass ? pg_hint : pg_managed;
    while (i + n <= end) {
      uint32_t run = 0;
      while (run < n && !pg_used(i + run)) run++;
      if (run == n) {
        pg_mark(i, n, 1);
        pg_hint = i + n;
        memset((void *)(uintptr_t)(i * PG), 0, (size_t)n * PG);
        return (long)(i * PG);
      }
      i += run + 1;
    }
  }
  uint32_t i = pg_managed;              /* no free run: extend, reusing a free tail */
  while (i > 0 && !pg_used(i - 1)) i--;
  /* the cap is counted in pages: the byte count (i + n) * PG wraps at 4 GiB */
  if (i + n > NPG - 16 || !grow_to((uintptr_t)(i + n) * PG))
    return -ENOMEM;
  if (i < pg_managed) memset((void *)(uintptr_t)(i * PG), 0, (size_t)(pg_managed - i) * PG);
  pg_mark(i, n, 1);
  if (i + n > pg_managed) pg_managed = i + n;
  if ((uintptr_t)pg_managed * PG > heap_top) heap_top = (uintptr_t)pg_managed * PG;
  pg_hint = i + n;
  return (long)(i * PG);
}

void luaw_unmap_anon(long addr, unsigned long len) {
  uint32_t i = (uint32_t)addr / PG, n = (uint32_t)((len + PG - 1) / PG);
  if (i + n <= pg_managed) pg_mark(i, n, 0);
}

/* ── time ───────────────────────────────────────────────────────────
** One clock from the host. CLOCK_REALTIME is it; the monotonic and
** CPU-time clocks count from luaw_clock_start, which the VM calls when
** it is created (luaw_init, luaw_main), so os.clock starts near zero
** and only goes up, as on a fresh process. It is WALL time since then,
** not CPU time: a browser has no CPU-time source for the thread
** running wasm, and a cpu import would only ever be answerable
** elsewhere (the one knowing divergence from native musl; doc/wasm.md).
** A clock read before any start counts from that read.
**
** No two reads return the same instant: a kernel clock has nanosecond
** resolution and musl relies on that (its temporary-file names are
** derived from the clock alone; mkstemp retries on collision), but a
** host clock can be coarse -- Firefox rounds its timers to a
** millisecond -- so a read that would repeat the previous one is
** advanced by a nanosecond instead. */
static long long clock_origin = -1;
static long long last_ns = -1;

static long long now_ns(void) {
  /* integer nanoseconds: ms since the epoch is ~1.7e12, so ms * 1e6 as a
     double would lose the low nanoseconds; split first */
  double ms = luaw_host_now();
  long long sec = (long long)(ms / 1000.0);
  long long ns = sec * 1000000000LL + (long long)((ms - (double)sec * 1000.0) * 1e6);
  if (ns <= last_ns) ns = last_ns + 1;
  last_ns = ns;
  return ns;
}

void luaw_clock_start(void) { clock_origin = now_ns(); }

static void fill_timespec(long clk, void *out) {
  struct timespec *ts = out;            /* musl passes its own struct to clock_gettime64 */
  long long ns = now_ns();
  if (clk != CLOCK_REALTIME) {
    if (clock_origin < 0) clock_origin = ns;
    ns -= clock_origin;
  }
  ts->tv_sec = ns / 1000000000LL;
  ts->tv_nsec = (long)(ns % 1000000000LL);
}

/* ── the dispatcher ─────────────────────────────────────────────── */
static int is_tty(long fd) { return fd >= 0 && fd <= 2; }

/* A syscall the layer does not implement fails with ENOSYS, as on a
** kernel without it -- musl then takes its fallback or reports the
** errno -- and says so once per syscall number on stderr, straight to
** the host (not through stdio, which may be what is calling). Native
** Linux answers every syscall musl makes, so this line never appears
** on a path the differential witness compares; where it does appear it
** marks a gap in the port worth knowing about. The suite witness
** asserts it stays silent. */
static void report_unsupported(long n) {
  static unsigned char seen[64];              /* syscall numbers < 512 */
  char msg[40], *p = msg + sizeof msg;
  unsigned long u = n < 0 ? 0 : (unsigned long)n;
  if (u < 512) {
    if (seen[u >> 3] & (1u << (u & 7))) return;
    seen[u >> 3] |= (unsigned char)(1u << (u & 7));
  }
  *--p = '\n';
  do { *--p = (char)('0' + u % 10); u /= 10; } while (u);
  p -= 26; memcpy(p, "luaw: unsupported syscall ", 26);
  luaw_host_write(2, p, (int)(msg + sizeof msg - p));
}

static long tty_write(long fd, const void *buf, size_t n) {
  if (fd != 1 && fd != 2) return -EBADF;
  if (n) luaw_host_write((int)fd, buf, (int)n);
  return (long)n;
}

static long tty_read(long fd, void *buf, size_t n) {
  if (fd != 0) return -EBADF;
  return n ? luaw_host_read(buf, (int)n) : 0;
}

long __luaw_syscall(long n, long a, long b, long c, long d, long e, long f) {
  (void)f;
  switch (n) {

  /* descriptors: 0, 1, 2 are a terminal (line-buffered stdout, in order
     with stderr); 3 and up are the filesystem's */
  case SYS_write:
    return is_tty(a) ? tty_write(a, (const void *)b, (size_t)c)
                     : luaw_fs_write((int)a, (const void *)b, (size_t)c);
  case SYS_read:
    return is_tty(a) ? tty_read(a, (void *)b, (size_t)c)
                     : luaw_fs_read((int)a, (void *)b, (size_t)c);
  case SYS_writev: case SYS_readv: {
    const struct iovec *v = (const struct iovec *)b;
    long total = 0;
    for (long i = 0; i < c; i++) {
      long r;
      if (!v[i].iov_len) continue;
      if (n == SYS_writev)
        r = is_tty(a) ? tty_write(a, v[i].iov_base, v[i].iov_len)
                      : luaw_fs_write((int)a, v[i].iov_base, v[i].iov_len);
      else
        r = is_tty(a) ? tty_read(a, v[i].iov_base, v[i].iov_len)
                      : luaw_fs_read((int)a, v[i].iov_base, v[i].iov_len);
      if (r < 0) return total ? total : r;
      total += r;
      if ((size_t)r < v[i].iov_len) break;
    }
    return total;
  }
  case SYS_ioctl:
    if (!is_tty(a)) return luaw_fs_is_open((int)a) ? -ENOTTY : -EBADF;
    if (b == TIOCGWINSZ) {              /* what isatty asks */
      struct winsize *w = (struct winsize *)c;
      w->ws_row = 24; w->ws_col = 80; w->ws_xpixel = w->ws_ypixel = 0;
      return 0;
    }
    return -ENOTTY;
  case SYS__llseek: {                   /* (fd, off_hi, off_lo, result*, whence) */
    long long off = ((long long)(unsigned long)b << 32) | (unsigned long)c;
    if (is_tty(a)) return -ESPIPE;
    return luaw_fs_llseek((int)a, off, (int)e, (long long *)d);
  }
  case SYS_fcntl64:
    return is_tty(a) ? 0 : luaw_fs_fcntl((int)a, (int)b, c);
  case SYS_close:
    return is_tty(a) ? 0 : luaw_fs_close((int)a);
  case SYS_dup3:                        /* freopen: the new file onto the old fd */
    return is_tty(a) ? -EBADF : luaw_fs_dup3((int)a, (int)b);

  /* paths (dirfd is always AT_FDCWD: the working directory is "/") */
  case SYS_openat:
    return luaw_fs_openat((const char *)b, (int)c, (unsigned)d);
  case SYS_faccessat: case SYS_faccessat2:
    return luaw_fs_access((const char *)b);
  case SYS_unlinkat:
    return luaw_fs_unlink((const char *)b, (int)c);
  case SYS_mkdirat:
    return luaw_fs_mkdir((const char *)b);
  case SYS_renameat2:
    return luaw_fs_rename((const char *)b, (const char *)d);
  case SYS_statx:                       /* (dirfd, path, flags, mask, buf) */
    return luaw_fs_statx((int)a, (const char *)b, (int)c, (void *)e);

  /* time */
  case SYS_clock_gettime64:
    fill_timespec(a, (void *)b);
    return 0;

  /* memory */
  case SYS_brk:
    if (!heap_top) heap_top = (uintptr_t)&__heap_base;
    return (long)heap_top;              /* never moves: musl falls back to mmap */
  case SYS_mmap2:                       /* (addr, len, prot, flags, fd, pgoff) */
    if (d & MAP_ANONYMOUS) return luaw_map_anon((unsigned long)b);
    return luaw_fs_mmap((int)e, (unsigned long)b, (long long)f * 4096);
  case SYS_munmap:
    luaw_unmap_anon(a, (unsigned long)b);
    return 0;
  case SYS_madvise:
    return 0;
  case SYS_mremap:
    return -ENOMEM;

  /* process: one of it */
  case SYS_getpid: case SYS_gettid:
    return 1;
  case SYS_rt_sigprocmask:
    return 0;
  case SYS_rt_sigaction:              /* signals are never delivered: accept
                                         the handler, report SIG_DFL before */
    if (c) memset((void *)c, 0, sizeof(struct k_sigaction));
    return 0;
  case SYS_mprotect:                  /* all memory is read-write */
    return 0;
  case SYS_exit: case SYS_exit_group:
    luaw_exit_status = (int)a;
    luaw_exited = 1;
    __builtin_trap();
  case SYS_tkill: case SYS_tgkill:      /* abort(): SIGABRT to self */
    luaw_exit_status = 134;
    luaw_exited = 1;
    __builtin_trap();
  }
  report_unsupported(n);
  return -ENOSYS;
}
