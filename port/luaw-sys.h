/* luaw-sys.h -- the seams between the OS layer's files (port/). Internal
** to the port; nothing here is part of the host contract. */
#ifndef LUAW_SYS_H
#define LUAW_SYS_H

#include <stddef.h>
#include <stdint.h>

/* luaw-sys.c: page-granular anonymous memory (mmap's answer), also used
   by the filesystem to back a file-backed mapping */
long luaw_map_anon(unsigned long len);
void luaw_unmap_anon(long addr, unsigned long len);

/* luaw-fs.c: the in-memory filesystem's syscall handlers. Each returns
   the syscall's result: >= 0, or -errno. */
long luaw_fs_openat(const char *path, int flags, unsigned mode);
long luaw_fs_read(int fd, void *buf, size_t n);
long luaw_fs_write(int fd, const void *buf, size_t n);
long luaw_fs_llseek(int fd, long long off, int whence, long long *result);
long luaw_fs_close(int fd);
long luaw_fs_fcntl(int fd, int cmd, long arg);
long luaw_fs_statx(int fd, const char *path, int flags, void *statx_out);
long luaw_fs_access(const char *path);
long luaw_fs_unlink(const char *path, int flags);
long luaw_fs_rename(const char *from, const char *to);
long luaw_fs_mmap(int fd, unsigned long len, long long off);
int  luaw_fs_is_open(int fd);

#endif
