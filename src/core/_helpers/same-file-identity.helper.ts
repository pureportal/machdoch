export interface FileObjectIdentity {
  dev: number | bigint;
  ino: number | bigint;
}

export interface FileSnapshotIdentity extends FileObjectIdentity {
  size: number | bigint;
  mtimeMs: number | bigint;
}

const isZeroDevice = (device: number | bigint): boolean =>
  device === 0 || device === 0n;

const sameDevice = (
  left: number | bigint,
  right: number | bigint,
  platform: NodeJS.Platform,
): boolean =>
  left === right ||
  (platform === "win32" && (isZeroDevice(left) || isZeroDevice(right)));

/**
 * Node 22 on Windows reports `dev = 0` for path metadata but the real volume
 * serial for metadata read from an open handle. The inode remains the same
 * Windows file ID, and the path cannot cross volumes without becoming a link,
 * which callers reject before and after reading.
 */
export const sameFileObjectIdentity = (
  left: FileObjectIdentity,
  right: FileObjectIdentity,
  platform: NodeJS.Platform = process.platform,
): boolean =>
  sameDevice(left.dev, right.dev, platform) && left.ino === right.ino;

export const sameFileSnapshotIdentity = (
  left: FileSnapshotIdentity,
  right: FileSnapshotIdentity,
  platform: NodeJS.Platform = process.platform,
): boolean =>
  sameFileObjectIdentity(left, right, platform) &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs;
