/* alloc-stress.c -- the allocator and the OS layer's memory under
** adversarial use, with no Lua in the module. Two claims:
**
**   1. no corruption: a deterministic random mix of malloc, realloc and
**      free over sizes from 1 byte to ~200 KB, every live block filled
**      with its own tag and checked before each operation;
**   2. no leak through the OS layer: after the mix, repeated rounds of
**      allocate-everything / free-everything must stop growing linear
**      memory -- freed pages come back through munmap and are reused by
**      the next mmap (port/luaw-sys.c), so the module's footprint settles.
**
** Returns 0 on success; prints what failed otherwise. Built and run by
** `make libc-stress` (port/musl.mk, scripts/libc-stress.mjs). */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define SLOTS 2000
#define STEPS 300000

static unsigned char *slot[SLOTS];
static size_t size[SLOTS];
static unsigned char tag[SLOTS];
static unsigned rng = 12345;
static unsigned rnd(void) { rng = rng * 1103515245u + 12345u; return rng >> 8; }

static size_t memory_bytes(void) { return (size_t)__builtin_wasm_memory_size(0) * 65536; }

__attribute__((export_name("stress")))
int stress(void) {
  /* 1. the random mix */
  for (int step = 0; step < STEPS; step++) {
    int i = (int)(rnd() % SLOTS);
    if (slot[i]) {
      for (size_t k = 0; k < size[i]; k++)
        if (slot[i][k] != tag[i]) { printf("CORRUPT at step %d slot %d byte %zu\n", step, i, k); return 1; }
    }
    unsigned op = rnd() % 3;
    size_t n = 1 + ((rnd() % 4 == 0) ? rnd() % 200000 : rnd() % 300);
    if (op == 0 && slot[i]) { free(slot[i]); slot[i] = NULL; continue; }
    unsigned char *q = slot[i] ? realloc(slot[i], n) : malloc(n);
    if (!q) { printf("OUT OF MEMORY at step %d (%zu bytes)\n", step, n); return 2; }
    slot[i] = q; size[i] = n; tag[i] = (unsigned char)rnd();
    memset(q, tag[i], n);
  }
  for (int i = 0; i < SLOTS; i++) { free(slot[i]); slot[i] = NULL; }
  size_t after_mix = memory_bytes();

  /* 2. the reuse rounds: 64 MB per round, all freed each time */
  size_t peak = 0, grew_after_round2 = 0;
  for (int round = 0; round < 8; round++) {
    void *big[64];
    for (int b = 0; b < 64; b++) { big[b] = malloc(1 << 20); if (!big[b]) { printf("OUT OF MEMORY in round %d\n", round); return 2; } memset(big[b], round, 1 << 20); }
    for (int b = 0; b < 64; b++) free(big[b]);
    size_t now = memory_bytes();
    if (round >= 2 && now > peak) grew_after_round2 += now - peak;
    if (now > peak) peak = now;
    printf("round %d: linear memory %zu MB\n", round, now >> 20);
  }
  printf("after mix %zu MB, peak %zu MB, growth after round 2: %zu bytes\n", after_mix >> 20, peak >> 20, grew_after_round2);
  if (grew_after_round2) { printf("LEAK: memory kept growing once the working set was stable\n"); return 3; }
  printf("STRESS OK\n");
  return 0;
}
