/* musl arch header for wasm32 (lua.wasm port).
**
** One thread, ever. musl keeps per-thread state (errno, locale, the
** stdio lock owner) behind a thread pointer; here it points into a
** static area that port/luaw-sys.c initialises at startup, with the
** struct pthread laid out below it (TLS_ABOVE_TP, as riscv). */

extern unsigned char __luaw_tp_area[];

static inline uintptr_t __get_tp(void)
{
	return (uintptr_t)(__luaw_tp_area + 1024);
}

#define TLS_ABOVE_TP
#define GAP_ABOVE_TP 0

#define DTP_OFFSET 0x800

#define MC_PC __gregs[0]
