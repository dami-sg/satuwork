/* Report the kernel's Landlock ABI version, or why it is unavailable.
   dsh's sandbox needs ABI >= 1 (kernel 5.13+); ABI 3+ adds truncate control. */
#define _GNU_SOURCE
#include <stdio.h>
#include <errno.h>
#include <string.h>
#include <unistd.h>
#include <sys/syscall.h>

#ifndef SYS_landlock_create_ruleset
#define SYS_landlock_create_ruleset 444
#endif
#ifndef LANDLOCK_CREATE_RULESET_VERSION
#define LANDLOCK_CREATE_RULESET_VERSION (1U << 0)
#endif

int main(void) {
  long abi = syscall(SYS_landlock_create_ruleset, NULL, 0,
                     LANDLOCK_CREATE_RULESET_VERSION);
  if (abi < 0) {
    printf("UNAVAILABLE (errno %d: %s)\n", errno, strerror(errno));
    if (errno == ENOSYS) printf("  -> kernel has no Landlock support\n");
    if (errno == EOPNOTSUPP) printf("  -> Landlock built in but disabled at boot\n");
    return 1;
  }
  printf("ABI v%ld\n", abi);
  return 0;
}
