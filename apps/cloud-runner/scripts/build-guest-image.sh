#!/bin/sh
set -eu
if [ $# -ne 1 ]; then
  echo "usage: build-guest-image.sh <output directory>" >&2
  exit 2
fi
OUT=$1
BRANCH=v3.24
BASE=https://dl-cdn.alpinelinux.org/alpine/$BRANCH/releases/x86_64
WORK=$(mktemp -d)
trap 'umount "$WORK/rootfs/proc" 2>/dev/null || true; umount "$WORK/rootfs/dev" 2>/dev/null || true; rm -rf "$WORK"' EXIT
mkdir -p "$OUT/modules" "$WORK/dl" "$WORK/iso" "$WORK/rootfs" "$WORK/modules"
cd "$WORK/dl"
curl -fsSLO "$BASE/latest-releases.yaml"
VERSION=$(awk '$1=="version:" {print $2; exit}' latest-releases.yaml)
ISO="alpine-virt-$VERSION-x86_64.iso"
ROOTFS="alpine-minirootfs-$VERSION-x86_64.tar.gz"
for file in "$ISO" "$ROOTFS"; do
  curl -fsSLO "$BASE/$file"
  sum=$(awk -v f="$file" '$1=="file:" && $2==f {found=1} found && $1=="sha256:" {print $2; exit}' latest-releases.yaml)
  echo "$sum  $file" | sha256sum -c
done
bsdtar -xf "$ISO" -C "$WORK/iso" boot/vmlinuz-virt boot/initramfs-virt boot/modloop-virt
tar -xzf "$ROOTFS" -C "$WORK/rootfs"
cp /etc/resolv.conf "$WORK/rootfs/etc/resolv.conf"
mount --bind /dev "$WORK/rootfs/dev"
mount --bind /proc "$WORK/rootfs/proc"
chroot "$WORK/rootfs" /sbin/apk add --no-cache tini socat nodejs npm git bash python3 coreutils findutils grep sed diffutils patch chromium font-dejavu
chroot "$WORK/rootfs" /usr/bin/npm install --prefix /opt --omit=dev --no-audit --no-fund playwright-core@1.60.0
rm -rf "$WORK/rootfs/root/.npm"
chroot "$WORK/rootfs" /bin/sh -c 'addgroup -g 1000 machdoch && adduser -D -u 1000 -G machdoch -h /workspace -s /bin/bash machdoch'
umount "$WORK/rootfs/proc"
umount "$WORK/rootfs/dev"
rm -f "$WORK/rootfs/etc/resolv.conf"
rm -rf "$WORK/rootfs/var/cache/apk"/*
mkdir -p "$WORK/rootfs/workspace" "$WORK/rootfs/run" "$WORK/rootfs/opt/machdoch" "$WORK/rootfs/tmp"
chown 1000:1000 "$WORK/rootfs/workspace" "$WORK/rootfs/run"
chmod 1777 "$WORK/rootfs/tmp"
mkfs.ext4 -q -F -d "$WORK/rootfs" -L machdoch-root -O ^has_journal "$WORK/root.raw" 2048M
qemu-img convert -f raw -O qcow2 "$WORK/root.raw" "$OUT/root.qcow2"
unsquashfs -no-progress -d "$WORK/modules" "$WORK/iso/boot/modloop-virt" 'modules/*/kernel/drivers/char/hw_random/rng-core.ko' 'modules/*/kernel/drivers/char/hw_random/virtio-rng.ko' >/dev/null
for name in rng-core virtio-rng; do
  cp "$(find "$WORK/modules" -name "$name.ko")" "$OUT/modules/$name.ko"
done
cp "$WORK/iso/boot/vmlinuz-virt" "$OUT/vmlinuz-virt"
cp "$WORK/iso/boot/initramfs-virt" "$OUT/initramfs-virt"
echo "Alpine $VERSION guest artifacts written to $OUT"
