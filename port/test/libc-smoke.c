/* libc-smoke.c -- the musl-on-wasm32 libc's own witness, with no Lua in
** the module. Each check is something Lua's standard library leans on;
** the expected values are what musl gives on Linux. Prints what it sees,
** then SMOKE OK / SMOKE FAIL; returns the number of failed checks.
** Built and run by `make libc-smoke` (port/musl.mk, scripts/libc-smoke.mjs). */
#include <errno.h>
#include <locale.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static int fails = 0;
#define CHECK(cond) do { if (!(cond)) { fails++; printf("  FAILED: %s\n", #cond); } } while (0)

__attribute__((export_name("smoke")))
int smoke(void) {
  char buf[128];

  /* number formatting and parsing: Lua's tostring/tonumber/string.format */
  snprintf(buf, sizeof buf, "%.14g|%d|%a|%5.2f|%s", 3.14159265358979, 2147483647, 1.5, -0.0, "s");
  printf("fmt: %s\n", buf);
  CHECK(strcmp(buf, "3.1415926535898|2147483647|0x1.8p+0|-0.00|s") == 0);
  errno = 0;
  double d = strtod("  -1.5e300", NULL);
  printf("strtod: %g (errno %d)\n", d, errno);
  CHECK(d == -1.5e300 && errno == 0);

  /* the allocator, through a grow */
  char *p = malloc(100000);
  memset(p, 7, 100000);
  char *q = realloc(p, 300000);
  printf("malloc/realloc: %d\n", q[99999]);
  CHECK(q[99999] == 7);
  free(q);

  /* libm */
  printf("math: %.6f %.6f %g\n", sin(1.0), log(10.0), pow(2, 53));
  CHECK(fabs(sin(1.0) - 0.8414709848078965) < 1e-15);
  CHECK(pow(2, 53) == 9007199254740992.0);

  /* time: the host clock reaches time(); the CPU clock starts near zero */
  time_t t = time(NULL);
  struct tm *tm = gmtime(&t);
  printf("time: %ld -> %d-%02d-%02d, clock %ld\n", (long)t,
         tm->tm_year + 1900, tm->tm_mon + 1, tm->tm_mday, (long)clock());
  CHECK(tm->tm_year + 1900 >= 2026);
  CHECK(clock() < CLOCKS_PER_SEC);

  /* a missing file fails the way Linux fails it */
  errno = 0;
  FILE *f = fopen("nope.txt", "r");
  printf("fopen(missing): %s, errno %d (%s)\n", f ? "opened?!" : "NULL", errno, strerror(errno));
  CHECK(f == NULL && errno == ENOENT);

  /* musl's locale answer, unmodified: claims the locale, keeps '.' */
  const char *loc = setlocale(LC_ALL, "pt_BR");
  printf("setlocale(pt_BR) -> %s, decimal '%s'\n", loc ? loc : "NULL", localeconv()->decimal_point);
  CHECK(loc != NULL && strcmp(localeconv()->decimal_point, ".") == 0);

  /* stderr is fd 2; the environment starts empty */
  fprintf(stderr, "to stderr\n");
  printf("getenv(HOME) = %s\n", getenv("HOME") ? getenv("HOME") : "(null)");
  CHECK(getenv("HOME") == NULL);

  /* stdin comes from the read import; the host feeds "typed line\n" */
  char line[64];
  const char *got = fgets(line, sizeof line, stdin);
  printf("stdin: %s", got ? got : "(eof)\n");
  CHECK(got && strcmp(line, "typed line\n") == 0);
  CHECK(fgets(line, sizeof line, stdin) == NULL && feof(stdin));

  printf("SMOKE %s\n", fails ? "FAIL" : "OK");
  return fails;
}
