/* luaw-fs.c -- the filesystem under musl: in memory, inside the module.
**
** Design (D4, doc/history/browser-native-2026-10-13.md): a flat table of
** files keyed by normalised absolute path; directories exist only as
** path prefixes; "/" is the working directory; nothing persists past the
** instance. The host moves files in and out through the luaw_fs_*
** exports at the bottom; Lua reaches them through musl (io.open, dofile,
** require, os.remove, os.rename, os.tmpname, tmpfile), whose syscalls
** luaw-sys.c routes to the handlers here. Semantics follow Linux where
** Lua can observe them: errno values, O_APPEND/O_TRUNC/O_EXCL, seeking
** past the end then writing (a zero-filled gap), an unlinked file living
** on while it is open, rename replacing its target.
**
** Memory comes from musl's malloc; the OS layer's mmap never calls back
** into the filesystem, so there is no re-entrancy. A write that cannot
** get memory fails with ENOSPC, as a full disk would.
*/
#include "luaw-sys.h"
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

typedef struct File {
  char *path;                 /* normalised, absolute; NULL once unlinked */
  unsigned char *data;
  size_t size, cap;
  int opens;                  /* descriptors referring to it */
  unsigned ino;
} File;

typedef struct Fd {
  File *file;                 /* NULL: free slot, or a directory if is_dir */
  long long pos;
  int flags;                  /* O_ACCMODE bits and O_APPEND */
  int used, is_dir;
} Fd;

#define FD_BASE 3             /* 0-2 are the terminal, owned by luaw-sys.c */

static File **files;          /* every live file, linked or not */
static int nfiles, cap_files;
static Fd *fds;
static int nfds;
static unsigned next_ino = 1;

/* ── paths ───────────────────────────────────────────────────────── */

/* absolute, "." and ".." resolved, no duplicate or trailing slashes;
   "/" for the root. Caller frees. NULL on ENOMEM. */
static char *normalise(const char *path) {
  size_t n = strlen(path);
  char *out = malloc(n + 2);
  size_t len = 0;
  const char *p = path;
  if (!out) return NULL;
  out[len++] = '/';
  while (*p) {
    const char *seg;
    size_t seglen;
    while (*p == '/') p++;
    if (!*p) break;
    seg = p;
    while (*p && *p != '/') p++;
    seglen = (size_t)(p - seg);
    if (seglen == 1 && seg[0] == '.') continue;
    if (seglen == 2 && seg[0] == '.' && seg[1] == '.') {
      while (len > 1 && out[len - 1] != '/') len--;
      if (len > 1) len--;
      continue;
    }
    if (len > 1) out[len++] = '/';
    memcpy(out + len, seg, seglen);
    len += seglen;
  }
  out[len] = '\0';
  return out;
}

static File *find(const char *norm) {
  for (int i = 0; i < nfiles; i++)
    if (files[i]->path && strcmp(files[i]->path, norm) == 0) return files[i];
  return NULL;
}

/* a path is a directory when it is "/" or a proper prefix of some file */
static int is_dir(const char *norm) {
  size_t n = strlen(norm);
  if (n == 1) return 1;
  for (int i = 0; i < nfiles; i++) {
    const char *q = files[i]->path;
    if (q && strncmp(q, norm, n) == 0 && q[n] == '/') return 1;
  }
  return 0;
}

static File *create(char *norm) {       /* takes ownership of norm */
  File *f = calloc(1, sizeof *f);
  if (!f) return NULL;
  if (nfiles == cap_files) {
    int ncap = cap_files ? cap_files * 2 : 16;
    File **nf = realloc(files, (size_t)ncap * sizeof *nf);
    if (!nf) { free(f); return NULL; }
    files = nf; cap_files = ncap;
  }
  f->path = norm;
  f->ino = next_ino++;
  files[nfiles++] = f;
  return f;
}

static void release(File *f) {          /* drop once unlinked and closed */
  if (f->path || f->opens) return;
  for (int i = 0; i < nfiles; i++)
    if (files[i] == f) { files[i] = files[--nfiles]; break; }
  free(f->data);
  free(f);
}

static int reserve(File *f, size_t need) {
  if (need <= f->cap) return 1;
  size_t ncap = f->cap ? f->cap : 256;
  while (ncap < need) ncap *= 2;
  unsigned char *nd = realloc(f->data, ncap);
  if (!nd) return 0;
  f->data = nd; f->cap = ncap;
  return 1;
}

static int set_content(File *f, const void *data, size_t len) {
  if (!reserve(f, len)) return 0;
  if (len) memcpy(f->data, data, len);
  f->size = len;
  return 1;
}

/* ── descriptors ─────────────────────────────────────────────────── */

static Fd *fd_of(int fd) {
  int i = fd - FD_BASE;
  if (i < 0 || i >= nfds || !fds[i].used) return NULL;
  return &fds[i];
}

int luaw_fs_is_open(int fd) { return fd_of(fd) != NULL; }

static int alloc_fd(void) {
  for (int i = 0; i < nfds; i++)
    if (!fds[i].used) return i;
  int ncap = nfds ? nfds * 2 : 8;
  Fd *nf = realloc(fds, (size_t)ncap * sizeof *nf);
  if (!nf) return -1;
  memset(nf + nfds, 0, (size_t)(ncap - nfds) * sizeof *nf);
  fds = nf;
  int i = nfds;
  nfds = ncap;
  return i;
}

/* ── the syscalls ────────────────────────────────────────────────── */

long luaw_fs_openat(const char *path, int flags, unsigned mode) {
  (void)mode;
  char *norm = normalise(path);
  if (!norm) return -ENOMEM;
  int acc = flags & O_ACCMODE;
  File *f = find(norm);
  int dir = 0;
  if (!f) {
    if (is_dir(norm)) {
      if (acc != O_RDONLY || (flags & O_CREAT)) { free(norm); return -EISDIR; }
      dir = 1;
    } else if (!(flags & O_CREAT)) {
      free(norm); return -ENOENT;
    } else {
      f = create(norm);         /* owns norm */
      if (!f) { free(norm); return -ENOMEM; }
      norm = NULL;
    }
  } else if ((flags & O_CREAT) && (flags & O_EXCL)) {
    free(norm); return -EEXIST;
  }
  free(norm);
  int i = alloc_fd();
  if (i < 0) return -ENOMEM;
  if (f && (flags & O_TRUNC) && acc != O_RDONLY) f->size = 0;
  fds[i].file = f;
  fds[i].pos = 0;
  fds[i].flags = acc | (flags & O_APPEND);
  fds[i].used = 1;
  fds[i].is_dir = dir;
  if (f) f->opens++;
  return i + FD_BASE;
}

long luaw_fs_read(int fd, void *buf, size_t n) {
  Fd *d = fd_of(fd);
  if (!d) return -EBADF;
  if (d->is_dir) return -EISDIR;
  if ((d->flags & O_ACCMODE) == O_WRONLY) return -EBADF;
  File *f = d->file;
  if (d->pos >= (long long)f->size) return 0;
  size_t avail = f->size - (size_t)d->pos;
  if (n > avail) n = avail;
  memcpy(buf, f->data + d->pos, n);
  d->pos += (long long)n;
  return (long)n;
}

long luaw_fs_write(int fd, const void *buf, size_t n) {
  Fd *d = fd_of(fd);
  if (!d) return -EBADF;
  if (d->is_dir || (d->flags & O_ACCMODE) == O_RDONLY) return -EBADF;
  File *f = d->file;
  if (d->flags & O_APPEND) d->pos = (long long)f->size;
  size_t end = (size_t)d->pos + n;
  if (end < n) return -EFBIG;
  if (!reserve(f, end)) return -ENOSPC;
  if ((size_t)d->pos > f->size) memset(f->data + f->size, 0, (size_t)d->pos - f->size);
  memcpy(f->data + d->pos, buf, n);
  d->pos += (long long)n;
  if (end > f->size) f->size = end;
  return (long)n;
}

long luaw_fs_llseek(int fd, long long off, int whence, long long *result) {
  Fd *d = fd_of(fd);
  if (!d) return -EBADF;
  long long base;
  switch (whence) {
    case SEEK_SET: base = 0; break;
    case SEEK_CUR: base = d->pos; break;
    case SEEK_END: base = d->file ? (long long)d->file->size : 0; break;
    default: return -EINVAL;
  }
  if (base + off < 0) return -EINVAL;
  d->pos = base + off;
  *result = d->pos;
  return 0;
}

long luaw_fs_close(int fd) {
  Fd *d = fd_of(fd);
  if (!d) return -EBADF;
  File *f = d->file;
  d->used = 0; d->file = NULL; d->is_dir = 0;
  if (f) { f->opens--; release(f); }
  return 0;
}

long luaw_fs_fcntl(int fd, int cmd, long arg) {
  Fd *d = fd_of(fd);
  if (!d) return -EBADF;
  switch (cmd) {
    case F_GETFL: return d->flags;
    case F_SETFL: d->flags = (d->flags & O_ACCMODE) | ((int)arg & O_APPEND); return 0;
    case F_GETFD: case F_SETFD: return 0;
    default: return -EINVAL;
  }
}

static void fill_statx(struct statx *st, unsigned mode, unsigned ino, size_t size) {
  memset(st, 0, sizeof *st);
  st->stx_mask = STATX_BASIC_STATS;
  st->stx_blksize = 4096;
  st->stx_nlink = 1;
  st->stx_mode = (uint16_t)mode;
  st->stx_ino = ino;
  st->stx_size = size;
  st->stx_blocks = (size + 511) / 512;
}

long luaw_fs_statx(int fd, const char *path, int flags, void *out) {
  struct statx *st = out;
  if ((flags & AT_EMPTY_PATH) && path[0] == '\0') {
    if (fd >= 0 && fd < FD_BASE) { fill_statx(st, S_IFCHR | 0620, (unsigned)fd + 1, 0); return 0; }
    Fd *d = fd_of(fd);
    if (!d) return -EBADF;
    if (d->is_dir) fill_statx(st, S_IFDIR | 0755, 0, 0);
    else fill_statx(st, S_IFREG | 0644, d->file->ino, d->file->size);
    return 0;
  }
  char *norm = normalise(path);
  if (!norm) return -ENOMEM;
  File *f = find(norm);
  if (f) fill_statx(st, S_IFREG | 0644, f->ino, f->size);
  else if (is_dir(norm)) fill_statx(st, S_IFDIR | 0755, 0, 0);
  else { free(norm); return -ENOENT; }
  free(norm);
  return 0;
}

long luaw_fs_access(const char *path) {
  char *norm = normalise(path);
  if (!norm) return -ENOMEM;
  int ok = find(norm) != NULL || is_dir(norm);
  free(norm);
  return ok ? 0 : -ENOENT;
}

long luaw_fs_unlink(const char *path, int flags) {
  char *norm = normalise(path);
  if (!norm) return -ENOMEM;
  File *f = find(norm);
  long r;
  if (flags & AT_REMOVEDIR) {           /* rmdir: no directory is ever empty here */
    r = f ? -ENOTDIR : is_dir(norm) ? -ENOTEMPTY : -ENOENT;
  } else if (f) {
    free(f->path); f->path = NULL;      /* out of the namespace; data lives while open */
    release(f);
    r = 0;
  } else {
    r = is_dir(norm) ? -EISDIR : -ENOENT;
  }
  free(norm);
  return r;
}

long luaw_fs_rename(const char *from, const char *to) {
  char *nfrom = normalise(from), *nto = normalise(to);
  if (!nfrom || !nto) { free(nfrom); free(nto); return -ENOMEM; }
  File *f = find(nfrom);
  long r = 0;
  if (!f) r = is_dir(nfrom) ? -EISDIR : -ENOENT;
  else if (is_dir(nto)) r = -EISDIR;
  else if (strcmp(nfrom, nto) != 0) {
    File *victim = find(nto);
    if (victim) { free(victim->path); victim->path = NULL; release(victim); }
    free(f->path); f->path = nto; nto = NULL;
  }
  free(nfrom); free(nto);
  return r;
}

/* a read-only, private copy: what musl's __map_file (zone files) needs */
long luaw_fs_mmap(int fd, unsigned long len, long long off) {
  Fd *d = fd_of(fd);
  if (!d || d->is_dir) return -EBADF;
  long addr = luaw_map_anon(len);
  if (addr < 0) return addr;
  File *f = d->file;
  if (off < (long long)f->size) {
    size_t n = f->size - (size_t)off;
    if (n > len) n = len;
    memcpy((void *)(uintptr_t)addr, f->data + off, n);
  }
  return addr;
}

/* ── the host's side: the luaw_fs_* exports ──────────────────────── */
#define LUAW_EXPORT(name) __attribute__((export_name(name), used))

/* create or replace a file with these bytes; 0, or -errno */
LUAW_EXPORT("luaw_fs_put") int luaw_fs_put(const char *path, const void *data, size_t len) {
  char *norm = normalise(path);
  if (!norm) return -ENOMEM;
  if (is_dir(norm)) { free(norm); return -EISDIR; }
  File *f = find(norm);
  if (f) free(norm);
  else if (!(f = create(norm))) { free(norm); return -ENOMEM; }
  return set_content(f, data, len) ? 0 : -ENOSPC;
}

/* the file's bytes and length, valid until the file is next written,
   renamed or removed; NULL (length 0) if there is no such file */
LUAW_EXPORT("luaw_fs_get") const void *luaw_fs_get(const char *path, size_t *len) {
  char *norm = normalise(path);
  File *f = norm ? find(norm) : NULL;
  free(norm);
  if (!f) { if (len) *len = 0; return NULL; }
  if (len) *len = f->size;
  return f->size ? (const void *)f->data : (const void *)"";
}

/* remove a file (unlink semantics); 0, or -errno */
LUAW_EXPORT("luaw_fs_remove") int luaw_fs_remove(const char *path) {
  return (int)luaw_fs_unlink(path, 0);
}

/* every path in the namespace, each NUL-terminated, then an empty entry;
   the buffer is valid until the next call. "\0" when there are none. */
static char *listing;
LUAW_EXPORT("luaw_fs_list") const char *luaw_fs_list(void) {
  size_t total = 1;
  for (int i = 0; i < nfiles; i++)
    if (files[i]->path) total += strlen(files[i]->path) + 1;
  char *out = realloc(listing, total);
  if (!out) return NULL;
  listing = out;
  size_t at = 0;
  for (int i = 0; i < nfiles; i++) {
    if (!files[i]->path) continue;
    size_t n = strlen(files[i]->path) + 1;
    memcpy(out + at, files[i]->path, n);
    at += n;
  }
  out[at] = '\0';
  return out;
}
