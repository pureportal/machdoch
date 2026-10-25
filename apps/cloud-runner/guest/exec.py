import ctypes
import os
import sys

libc = ctypes.CDLL(None, use_errno=True)
with open("/sys/fs/cgroup/agent/cgroup.procs", "w") as group:
    group.write(str(os.getpid()))
PR_SET_NO_NEW_PRIVS = 38
if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), "Cannot restrict child privileges")
os.setgroups([])
os.setgid(1000)
os.setuid(1000)
os.execv(sys.argv[1], sys.argv[1:])
