#!/bin/bash
# Capability probe for hosting the dsh agent engine.
# Checks the kernel features dsh's sandbox / subprocess / terminal packages need.
# Each check prints PASS / FAIL / WARN so the transcript can be read at a glance.

pass() { echo "  PASS  $*"; }
fail() { echo "  FAIL  $*"; }
warn() { echo "  WARN  $*"; }
sect() { echo; echo "── $* ────────────────────────────────────"; }

echo "════════════════════════════════════════════════════"
echo " dsh host capability probe"
echo " $(date -u '+%Y-%m-%d %H:%M:%SZ')"
echo "════════════════════════════════════════════════════"

sect "Host"
echo "  kernel        $(uname -r)"
echo "  arch          $(uname -m)"
echo "  cpus          $(nproc)"
echo "  memory        $(awk '/MemTotal/ {printf "%.1f GB", $2/1048576}' /proc/meminfo)"
echo "  uid           $(id -u) ($(id -un))"
[ -f /proc/1/comm ] && echo "  pid1          $(cat /proc/1/comm)"

sect "1. Landlock (dsh sandbox: filesystem confinement)"
if out=$(landlock-abi 2>&1); then
  pass "landlock $out"
else
  fail "landlock $out"
fi
if [ -r /sys/kernel/security/lsm ]; then
  lsm=$(cat /sys/kernel/security/lsm)
  echo "  active LSMs   $lsm"
  case "$lsm" in *landlock*) pass "landlock is in the active LSM list";;
                 *)          warn "landlock absent from the LSM list";; esac
else
  warn "/sys/kernel/security/lsm unreadable (securityfs not mounted)"
fi

sect "2. User namespaces (bubblewrap prerequisite)"
echo "  max_user_namespaces  $(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo '?')"
if [ -r /proc/sys/kernel/unprivileged_userns_clone ]; then
  echo "  unprivileged_userns_clone  $(cat /proc/sys/kernel/unprivileged_userns_clone)"
fi
if unshare -Un true 2>/dev/null; then pass "unshare -Un as root"; else fail "unshare -Un as root"; fi
if setpriv --reuid=10001 --regid=10001 --clear-groups unshare -Un true 2>/dev/null; then
  pass "unshare -Un as unprivileged uid 10001"
else
  fail "unshare -Un as unprivileged uid 10001  <-- bubblewrap's real path"
fi

sect "3. bubblewrap (dsh sandbox: process confinement)"
if bwrap --ro-bind / / --dev /dev --unshare-all --die-with-parent true 2>/dev/null; then
  pass "bwrap full unshare as root"
else
  fail "bwrap full unshare as root: $(bwrap --ro-bind / / --dev /dev --unshare-all true 2>&1 | head -1)"
fi
if setpriv --reuid=10001 --regid=10001 --clear-groups \
     bwrap --ro-bind / / --dev /dev --unshare-all --die-with-parent true 2>/dev/null; then
  pass "bwrap full unshare as unprivileged uid 10001"
else
  msg=$(setpriv --reuid=10001 --regid=10001 --clear-groups \
          bwrap --ro-bind / / --dev /dev --unshare-all true 2>&1 | head -1)
  fail "bwrap unprivileged: ${msg:-unknown error}"
fi

sect "4. seccomp (syscall filtering)"
sec=$(grep -E '^Seccomp' /proc/self/status 2>/dev/null | head -1)
echo "  ${sec:-Seccomp: unknown}"
grep -q CONFIG_SECCOMP_FILTER /boot/config-* 2>/dev/null && echo "  CONFIG_SECCOMP_FILTER present"

sect "5. PTY (dsh terminal package)"
if [ -e /dev/ptmx ] && [ -d /dev/pts ]; then
  pass "/dev/ptmx and /dev/pts present"
else
  fail "no /dev/ptmx or /dev/pts  <-- dsh terminal/PTY tools will not work"
fi

sect "6. Process tree (dsh subprocess: killing a whole group)"
setsid sleep 30 </dev/null >/dev/null 2>&1 &
sid=$!
sleep 0.3
if kill -0 "$sid" 2>/dev/null && kill -- -"$sid" 2>/dev/null; then
  pass "setsid + process-group kill"
else
  warn "could not signal the process group (pid $sid)"
fi

sect "7. Writable persistent path (SQLite + LanceDB)"
for p in /data /tmp; do
  if [ -d "$p" ] && touch "$p/.probe" 2>/dev/null; then
    free=$(df -h "$p" | awk 'NR==2 {print $4}')
    pass "$p writable, $free free"
    rm -f "$p/.probe"
  else
    warn "$p not writable (volume not mounted?)"
  fi
done

echo
echo "════════════════════════════════════════════════════"
echo " probe complete — holding the machine open for logs"
echo "════════════════════════════════════════════════════"
sleep 3600
