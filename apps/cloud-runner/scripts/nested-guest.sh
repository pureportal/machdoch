#!/bin/sh
set -eu
/bin/busybox mkdir -p /proc /sys /dev
/bin/busybox mount -t proc proc /proc
/bin/busybox mount -t sysfs sysfs /sys
/bin/busybox mount -t devtmpfs devtmpfs /dev
echo MACHDOCH_NESTED_GUEST_READY
/bin/busybox poweroff -f
