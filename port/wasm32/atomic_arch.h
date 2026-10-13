/* musl arch header for wasm32 (lua.wasm port).
**
** Single-threaded, so the atomics musl's locks and refcounts use reduce
** to plain memory operations. The wasm32 target here has no threads
** feature, so nothing could observe a torn update. */

#define a_cas a_cas
static inline int a_cas(volatile int *p, int t, int s)
{
	int old = *p;
	if (old == t) *p = s;
	return old;
}

#define a_cas_p a_cas_p
static inline void *a_cas_p(volatile void *p, void *t, void *s)
{
	void *old = *(void *volatile *)p;
	if (old == t) *(void *volatile *)p = s;
	return old;
}

#define a_barrier a_barrier
static inline void a_barrier(void)
{
}

#define a_crash a_crash
static inline void a_crash(void)
{
	__builtin_trap();
}
