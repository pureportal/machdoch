#!/bin/sh
set -eu
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export CARGO_TERM_COLOR=never
export CARGO_PROFILE_DEV_DEBUG=0
export CARGO_PROFILE_TEST_DEBUG=0
trap 'echo MACHDOCH_LINUX_FAILED; /bin/busybox poweroff -f' EXIT
mkdir -p /proc /sys /dev /tmp
mount -t proc proc /proc
mount -t sysfs sysfs /sys
mount -t devtmpfs devtmpfs /dev
mkdir -p /sys/fs/cgroup
mount -t cgroup2 cgroup2 /sys/fs/cgroup
modprobe virtio_pci
modprobe virtio_net
ip link set eth0 up
udhcpc -i eth0 -n -q -t 6 -T 3
apk add --no-cache --no-progress cargo build-base nodejs util-linux squashfs-tools
if [ -f /probe-kvm ]; then apk add --no-cache --no-progress qemu-system-x86_64; fi
cd /verify/apps/cloud-runner
mkdir -p native/target
mount -t tmpfs -o size=384m build-target native/target
cargo test --locked --manifest-path native/Cargo.toml
cargo build --locked --manifest-path native/Cargo.toml
adduser -D -u 1000 -h /verify/.tmp verifier
mkdir -p /verify/.tmp
chown 1000:1000 /verify/.tmp
echo '+cpu +memory +pids' > /sys/fs/cgroup/cgroup.subtree_control
mkdir /sys/fs/cgroup/machdoch-verification
echo '+cpu +memory +pids' > /sys/fs/cgroup/machdoch-verification/cgroup.subtree_control
mkdir /sys/fs/cgroup/machdoch-verification/manager /sys/fs/cgroup/machdoch-verification/vms
echo '+cpu +memory +pids' > /sys/fs/cgroup/machdoch-verification/vms/cgroup.subtree_control
chown 1000:1000 /sys/fs/cgroup/machdoch-verification /sys/fs/cgroup/machdoch-verification/cgroup.procs /sys/fs/cgroup/machdoch-verification/cgroup.threads /sys/fs/cgroup/machdoch-verification/cgroup.subtree_control /sys/fs/cgroup/machdoch-verification/manager/cgroup.procs /sys/fs/cgroup/machdoch-verification/vms /sys/fs/cgroup/machdoch-verification/vms/cgroup.procs /sys/fs/cgroup/machdoch-verification/vms/cgroup.threads /sys/fs/cgroup/machdoch-verification/vms/cgroup.subtree_control
echo $$ > /sys/fs/cgroup/machdoch-verification/manager/cgroup.procs
su verifier -s /bin/sh -c 'cd /verify/apps/cloud-runner && MACHDOCH_CLOUD_SUPERVISOR=/verify/apps/cloud-runner/native/target/debug/machdoch-cloud-supervisor MACHDOCH_TEST_CGROUP_ROOT=/sys/fs/cgroup/machdoch-verification/vms node --test --test-reporter=tap scripts/supervisor.test.mjs'
echo MACHDOCH_SUPERVISION_VERIFIED
sha256sum native/target/debug/machdoch-cloud-supervisor | awk '{print "MACHDOCH_LINUX_SUPERVISOR_SHA256:" $1}'
unsquashfs -no-progress -d /kernel-modules /cloud-modloop "modules/$(uname -r)/kernel/arch/x86/kvm" "modules/$(uname -r)/kernel/virt/lib"
cp -r /kernel-modules/modules/* /lib/modules/
depmod -a
if grep -q ' svm ' /proc/cpuinfo; then
  if modprobe kvm_amd; then echo MACHDOCH_KVM_MODULE_LOADED; else echo MACHDOCH_KVM_MODULE_REJECTED; fi
elif grep -q ' vmx ' /proc/cpuinfo; then
  if modprobe kvm_intel; then echo MACHDOCH_KVM_MODULE_LOADED; else echo MACHDOCH_KVM_MODULE_REJECTED; fi
fi
if [ -c /dev/kvm ]; then echo MACHDOCH_NESTED_KVM_PRESENT; else echo MACHDOCH_NESTED_KVM_ABSENT; fi
if [ -f /probe-kvm ]; then
  chmod 660 /dev/kvm
  chgrp verifier /dev/kvm
  su verifier -s /bin/sh -c 'cd /verify/apps/cloud-runner && MACHDOCH_CLOUD_SUPERVISOR=/verify/apps/cloud-runner/native/target/debug/machdoch-cloud-supervisor MACHDOCH_TEST_CGROUP_ROOT=/sys/fs/cgroup/machdoch-verification/vms MACHDOCH_TEST_NESTED_KERNEL=/nested-kernel MACHDOCH_TEST_NESTED_INITRAMFS=/nested-initramfs node --test --test-reporter=tap --test-name-pattern="KVM boots" scripts/supervisor.test.mjs'
fi
grep '^flags' /proc/cpuinfo | head -n 1
echo MACHDOCH_LINUX_COMPLETE
trap - EXIT
/bin/busybox poweroff -f
