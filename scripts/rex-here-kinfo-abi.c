/* Independent SDK check for src/rex_here_darwin.zig's public LP64 ABI.
 * No runtime process access or production build dependency on the SDK.
 * On macOS run both:
 *   clang -arch arm64 -Wall -Werror -fsyntax-only scripts/rex-here-kinfo-abi.c
 *   clang -arch x86_64 -Wall -Werror -fsyntax-only scripts/rex-here-kinfo-abi.c
 */
#include <sys/types.h>
#include <sys/sysctl.h>
#include <stddef.h>
#define SIZE(T,N) _Static_assert(sizeof(T) == (N), "size: " #T)
#define OFFSET(T,F,N) _Static_assert(offsetof(T,F) == (N), "offset: " #T "." #F)
_Static_assert(sizeof(void *) == 8, "LP64 only");
_Static_assert(CTL_KERN == 1 && KERN_PROC == 14 && KERN_PROC_PID == 1, "sysctl MIB");
_Static_assert(SIDL == 1 && SRUN == 2 && SSLEEP == 3 && SSTOP == 4 && SZOMB == 5, "status");
_Static_assert(P_CONTROLT == 2, "controlling terminal flag");
_Static_assert(MAXCOMLEN == 16 && NGROUPS == 16 && WMESGLEN == 7 && COMAPT_MAXLOGNAME == 12, "array sizes");
SIZE(struct timeval, 16);
OFFSET(struct timeval, tv_sec, 0);
OFFSET(struct timeval, tv_usec, 8);
SIZE(struct extern_proc, 296);
OFFSET(struct extern_proc, p_starttime, 0);
OFFSET(struct extern_proc, p_flag, 32);
OFFSET(struct extern_proc, p_stat, 36);
OFFSET(struct extern_proc, p_pid, 40);
SIZE(struct _pcred, 104);
OFFSET(struct _pcred, p_ruid, 80);
OFFSET(struct _pcred, p_svuid, 84);
SIZE(struct _ucred, 76);
OFFSET(struct _ucred, cr_uid, 4);
SIZE(struct vmspace, 64);
SIZE(struct eproc, 352);
OFFSET(struct eproc, e_pcred, 16);
OFFSET(struct eproc, e_ucred, 120);
OFFSET(struct eproc, e_vm, 200);
OFFSET(struct eproc, e_ppid, 264);
OFFSET(struct eproc, e_pgid, 268);
OFFSET(struct eproc, e_tdev, 276);
OFFSET(struct eproc, e_tpgid, 280);
SIZE(struct kinfo_proc, 648);
OFFSET(struct kinfo_proc, kp_proc, 0);
OFFSET(struct kinfo_proc, kp_eproc, 296);
