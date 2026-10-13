/* luaw-fs.c -- the filesystem under musl: in memory, inside the module.
**
** Design (D4, doc/history/browser-native-2026-10-13.md): files keyed by
** normalised absolute path, with directories as entries of their own so
** the rules Lua can observe are Linux's: "/" and "/tmp" exist from the
** start (what every Linux process can count on; os.tmpname needs the
** latter), the host's luaw_fs_put creates the parents of what it puts,
** mkdir creates one, and creating a file in a directory that does not
** exist fails with ENOENT. Nothing persists past the instance. The host
** moves files in and out through the luaw_fs_* exports at the bottom;
** Lua reaches them through musl (io.open, dofile, require, os.remove,
** os.rename, os.tmpname, tmpfile), whose syscalls luaw-sys.c routes to
** the handlers here. Other Linux semantics kept where Lua can see them:
** errno values, O_APPEND/O_TRUNC/O_EXCL, seeking past the end then
** writing (a zero-filled gap), an unlinked file living on while it is
** open, rename replacing its target, an empty path being no name at all.
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
  File *file;                 /* NULL for a directory or a free slot */
  long long pos;
  int flags;                  /* O_ACCMODE bits and O_APPEND */
  int used, is_dir;
} Fd;

#define FD_BASE 3             /* 0-2 are the terminal, owned by luaw-sys.c */

static File **files;          /* every live file, linked or not */
static int nfiles, cap_files;
static char **dirs;           /* every directory but "/", normalised */
static int ndirs, cap_dirs;
static Fd *fds;
static int nfds;
static unsigned next_ino = 1;

/* ── paths ───────────────────────────────────────────────────────── */

/* The empty path is not a name on Linux (open("") is ENOENT); every
   path syscall checks it before normalising. */
#define REJECT_EMPTY(path) do { if ((path)[0] == '\0') return -ENOENT; } while (0)

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

/* the parent's length within a normalised path ("/a/b" -> 2, "/a" -> 1) */
static size_t parent_len(const char *norm) {
  const char *slash = strrchr(norm, '/');
  return slash == norm ? 1 : (size_t)(slash - norm);
}

static File *find(const char *norm) {
  for (int i = 0; i < nfiles; i++)
    if (files[i]->path && strcmp(files[i]->path, norm) == 0) return files[i];
  return NULL;
}

static int dir_index(const char *norm) {
  for (int i = 0; i < ndirs; i++)
    if (strcmp(dirs[i], norm) == 0) return i;
  return -1;
}

static void seed_dirs(void) {
  if (ndirs == 0 && !dirs) {
    dirs = malloc(8 * sizeof *dirs);
    if (!dirs) return;
    cap_dirs = 8;
    dirs[ndirs++] = strdup("/tmp");
  }
}

static int is_dir(const char *norm) {
  seed_dirs();
  return norm[1] == '\0' || dir_index(norm) >= 0;
}

static int parent_is_dir(const char *norm) {
  size_t n = parent_len(norm);
  char saved = ((char *)norm)[n];
  int r;
  ((char *)norm)[n] = '\0';
  r = is_dir(n == 1 ? "/" : norm);
  ((char *)norm)[n] = saved;
  return r;
}

/* add one directory (parent assumed to exist); 0, -EEXIST, -ENOMEM */
static int add_dir(const char *norm) {
  seed_dirs();
  if (dir_index(norm) >= 0) return -EEXIST;
  if (ndirs == cap_dirs) {
    int ncap = cap_dirs ? cap_dirs * 2 : 8;
    char **nd = realloc(dirs, (size_t)ncap * sizeof *nd);
    if (!nd) return -ENOMEM;
    dirs = nd; cap_dirs = ncap;
  }
  dirs[ndirs] = strdup(norm);
  if (!dirs[ndirs]) return -ENOMEM;
  ndirs++;
  return 0;
}

/* create every missing ancestor of a normalised path (mkdir -p) */
static int ensure_parents(char *norm) {
  for (char *p = norm + 1; *p; p++) {
    if (*p != '/') continue;
    *p = '\0';
    if (!is_dir(norm)) { int r = add_dir(norm); if (r < 0 && r != -EEXIST) { *p = '/'; return r; } }
    *p = '/';
  }
  return 0;
}

/* does anything live under this directory? */
static int dir_in_use(const char *norm) {
  size_t n = strlen(norm);
  for (int i = 0; i < nfiles; i++)
    if (files[i]->path && strncmp(files[i]->path, norm, n) == 0 && files[i]->path[n] == '/') return 1;
  for (int i = 0; i < ndirs; i++)
    if (strncmp(dirs[i], norm, n) == 0 && dirs[i][n] == '/') return 1;
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
  REJECT_EMPTY(path);
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
    } else if (!parent_is_dir(norm)) {
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
  REJECT_EMPTY(path);
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
  REJECT_EMPTY(path);
  char *norm = normalise(path);
  if (!norm) return -ENOMEM;
  int ok = find(norm) != NULL || is_dir(norm);
  free(norm);
  return ok ? 0 : -ENOENT;
}

long luaw_fs_mkdir(const char *path) {
  REJECT_EMPTY(path);
  char *norm = normalise(path);
  if (!norm) return -ENOMEM;
  long r;
  if (find(norm) || is_dir(norm)) r = -EEXIST;
  else if (!parent_is_dir(norm)) r = -ENOENT;
  else r = add_dir(norm);
  free(norm);
  return r;
}

long luaw_fs_unlink(const char *path, int flags) {
  REJECT_EMPTY(path);
  char *norm = normalise(path);
  if (!norm) return -ENOMEM;
  File *f = find(norm);
  long r = 0;
  if (flags & AT_REMOVEDIR) {           /* rmdir */
    int di;
    if (f) r = -ENOTDIR;
    else if (norm[1] == '\0') r = -EBUSY;
    else if ((di = dir_index(norm)) < 0) r = -ENOENT;
    else if (dir_in_use(norm)) r = -ENOTEMPTY;
    else { free(dirs[di]); dirs[di] = dirs[--ndirs]; }
  } else if (f) {
    free(f->path); f->path = NULL;      /* out of the namespace; data lives while open */
    release(f);
  } else {
    r = is_dir(norm) ? -EISDIR : -ENOENT;
  }
  free(norm);
  return r;
}

/* rename a file, or a directory with everything under it */
static int reprefix(char **path, size_t oldlen, const char *newp, size_t newlen) {
  char *np = malloc(strlen(*path) - oldlen + newlen + 1);
  if (!np) return 0;
  memcpy(np, newp, newlen);
  strcpy(np + newlen, *path + oldlen);
  free(*path); *path = np;
  return 1;
}

long luaw_fs_rename(const char *from, const char *to) {
  REJECT_EMPTY(from);
  REJECT_EMPTY(to);
  char *nfrom = normalise(from), *nto = normalise(to);
  if (!nfrom || !nto) { free(nfrom); free(nto); return -ENOMEM; }
  File *f = find(nfrom);
  long r = 0;
  if (strcmp(nfrom, nto) == 0) { /* nothing to do */ }
  else if (f) {
    if (is_dir(nto)) r = -EISDIR;
    else if (!parent_is_dir(nto)) r = -ENOENT;
    else {
      File *victim = find(nto);
      if (victim) { free(victim->path); victim->path = NULL; release(victim); }
      free(f->path); f->path = nto; nto = NULL;
    }
  } else if (is_dir(nfrom)) {
    size_t fl = strlen(nfrom), tl = strlen(nto);
    int di = dir_index(nfrom);
    if (nfrom[1] == '\0' || di < 0) r = -EBUSY;
    else if (find(nto)) r = -ENOTDIR;
    else if (is_dir(nto) && dir_in_use(nto)) r = -ENOTEMPTY;
    else if (strncmp(nto, nfrom, fl) == 0 && nto[fl] == '/') r = -EINVAL;
    else if (!parent_is_dir(nto)) r = -ENOENT;
    else {
      int tdi = dir_index(nto);
      if (tdi >= 0) { free(dirs[tdi]); dirs[tdi] = dirs[--ndirs]; di = dir_index(nfrom); }
      for (int i = 0; i < nfiles; i++)
        if (files[i]->path && strncmp(files[i]->path, nfrom, fl) == 0 && files[i]->path[fl] == '/')
          if (!reprefix(&files[i]->path, fl, nto, tl)) r = -ENOMEM;
      for (int i = 0; i < ndirs; i++)
        if (i != di && strncmp(dirs[i], nfrom, fl) == 0 && dirs[i][fl] == '/')
          if (!reprefix(&dirs[i], fl, nto, tl)) r = -ENOMEM;
      free(dirs[di]); dirs[di] = nto; nto = NULL;
    }
  } else r = -ENOENT;
  free(nfrom); free(nto);
  return r;
}

/* dup3: make newfd refer to oldfd's file (freopen uses it to put the
   reopened file on the stream's original descriptor). Position is per
   descriptor here, not shared as on Linux -- freopen does not care, and
   nothing in Lua's library dups a descriptor it then keeps using. */
long luaw_fs_dup3(int oldfd, int newfd) {
  if (!fd_of(oldfd)) return -EBADF;
  if (newfd == oldfd) return -EINVAL;
  if (newfd < FD_BASE) return -EBADF;   /* the terminal's descriptors stay */
  int i = newfd - FD_BASE;
  if (i >= nfds) {
    int ncap = nfds ? nfds : 8;
    while (ncap <= i) ncap *= 2;
    Fd *nf = realloc(fds, (size_t)ncap * sizeof *nf);
    if (!nf) return -ENOMEM;
    memset(nf + nfds, 0, (size_t)(ncap - nfds) * sizeof *nf);
    fds = nf; nfds = ncap;
  }
  if (fds[i].used) luaw_fs_close(newfd);
  fds[i] = *fd_of(oldfd);
  if (fds[i].file) fds[i].file->opens++;
  return newfd;
}

/* the host's mkdir -p: create a directory and any missing parents;
   0, -EEXIST for an existing file at that path, or -errno */
__attribute__((export_name("luaw_fs_mkdir"), used))
int luaw_fs_mkdir_p(const char *path) {
  if (path[0] == '\0') return -ENOENT;
  char *norm = normalise(path);
  if (!norm) return -ENOMEM;
  int r = 0;
  if (find(norm)) r = -EEXIST;
  else if (!is_dir(norm)) {
    r = ensure_parents(norm);
    if (r == 0) r = add_dir(norm);
  }
  free(norm);
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

/* create or replace a file with these bytes, creating its directories;
   0, or -errno */
LUAW_EXPORT("luaw_fs_put") int luaw_fs_put(const char *path, const void *data, size_t len) {
  if (path[0] == '\0') return -ENOENT;
  char *norm = normalise(path);
  if (!norm) return -ENOMEM;
  if (is_dir(norm)) { free(norm); return -EISDIR; }
  File *f = find(norm);
  if (f) free(norm);
  else {
    int r = ensure_parents(norm);
    if (r < 0) { free(norm); return r; }
    if (!(f = create(norm))) { free(norm); return -ENOMEM; }
  }
  if (!reserve(f, len)) return -ENOSPC;
  if (len) memcpy(f->data, data, len);
  f->size = len;
  return 0;
}

/* the file's bytes and length, valid until the file is next written,
   renamed or removed; NULL (length 0) if there is no such file */
LUAW_EXPORT("luaw_fs_get") const void *luaw_fs_get(const char *path, size_t *len) {
  char *norm = path[0] ? normalise(path) : NULL;
  File *f = norm ? find(norm) : NULL;
  free(norm);
  if (!f) { if (len) *len = 0; return NULL; }
  if (len) *len = f->size;
  return f->size ? (const void *)f->data : (const void *)"";
}

/* remove a file (unlink semantics; a directory is EISDIR); 0, or -errno */
LUAW_EXPORT("luaw_fs_remove") int luaw_fs_remove(const char *path) {
  return (int)luaw_fs_unlink(path, 0);
}

/* every file path, each NUL-terminated, then an empty entry; the buffer
   is valid until the next call. "\0" when there are none. */
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
