#!/bin/sh
set -eu
/bin/busybox mkdir -p /proc /sys /dev /target
/bin/busybox mount -t proc proc /proc
/bin/busybox mount -t sysfs sysfs /sys
/bin/busybox mkdir -p /sys/fs/cgroup
/bin/busybox mount -t cgroup2 cgroup2 /sys/fs/cgroup
echo '+cpu +memory +pids' > /sys/fs/cgroup/cgroup.subtree_control
/bin/busybox mkdir /sys/fs/cgroup/agent
echo 536870912 > /sys/fs/cgroup/agent/memory.max
echo 0 > /sys/fs/cgroup/agent/memory.swap.max
echo 1 > /sys/fs/cgroup/agent/memory.oom.group
echo 128 > /sys/fs/cgroup/agent/pids.max
echo '100000 100000' > /sys/fs/cgroup/agent/cpu.max
/bin/busybox mount -t devtmpfs devtmpfs /dev
/bin/busybox ip link set lo up
/bin/busybox modprobe virtio_pci
/bin/busybox modprobe virtio_blk
/bin/busybox modprobe virtio_console
/bin/busybox insmod /cloud-modules/rng-core.ko
/bin/busybox insmod /cloud-modules/virtio-rng.ko
/bin/busybox modprobe ext4
channel=""
for port in /sys/class/virtio-ports/*; do
  if [ "$(/bin/busybox cat "$port/name")" = "org.machdoch.agent" ]; then
    channel="/dev/$(/bin/busybox basename "$port")"
  fi
done
[ -n "$channel" ]
/bin/busybox chmod 600 "$channel"
exec 3<>"$channel"
exec 0<&3 1>&3 2>&3
exec 3>&-
/bin/busybox mount -o ro /dev/vda /target
/bin/busybox mount -t tmpfs -o size=512m,uid=1000,gid=1000,mode=0700 workspace /target/workspace
/bin/busybox mount -t tmpfs -o size=128m,mode=1777 temporary /target/tmp
/bin/busybox mount -t tmpfs -o size=64m,uid=1000,gid=1000,mode=0700 state /target/run
/bin/busybox mount -t tmpfs -o size=16m,mode=0755 agent /target/opt/machdoch
/bin/busybox cp /cloud-agent/*.ts /target/opt/machdoch/
/bin/busybox cp /cloud-agent/package.json /target/opt/machdoch/
/bin/busybox cp /cloud-agent/*.py /target/opt/machdoch/
/bin/busybox cp /cloud-agent/shared-agent.cjs /target/opt/machdoch/
/bin/busybox mount -o remount,ro /target/opt/machdoch
/bin/busybox mount --move /proc /target/proc
/bin/busybox mount --move /sys /target/sys
/bin/busybox mount --move /dev /target/dev
ulimit -n 512
ulimit -u 256
exec /bin/busybox switch_root /target /sbin/tini -g -- /usr/bin/socat -b16384 STDIO,nonblock EXEC:"/usr/bin/node /opt/machdoch/agent.ts",pipes 2>/target/tmp/machdoch-transport.log
