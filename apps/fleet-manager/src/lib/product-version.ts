export type VersionStatus =
  | "current"
  | "outdated"
  | "newer"
  | "unknown"
  | "incompatible";

interface ProductVersion {
  release: bigint[];
  prerelease: string[];
}

function parseVersion(value: string): ProductVersion | null {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      value,
    );
  if (!match) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (
    prerelease.some(
      (part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"),
    )
  )
    return null;
  return {
    release: match.slice(1, 4).map((part) => BigInt(part!)),
    prerelease,
  };
}

export function productVersionStatus(
  productVersion: string,
  managerVersion: string,
  protocolVersion: number,
  managerProtocolVersion: number,
): VersionStatus {
  if (protocolVersion !== managerProtocolVersion) return "incompatible";
  const product = parseVersion(productVersion);
  const manager = parseVersion(managerVersion);
  if (!product || !manager) return "unknown";
  for (let index = 0; index < 3; index += 1) {
    if (product.release[index]! < manager.release[index]!) return "outdated";
    if (product.release[index]! > manager.release[index]!) return "newer";
  }
  if (!product.prerelease.length && manager.prerelease.length) return "newer";
  if (product.prerelease.length && !manager.prerelease.length)
    return "outdated";
  for (
    let index = 0;
    index < Math.max(product.prerelease.length, manager.prerelease.length);
    index += 1
  ) {
    const left = product.prerelease[index];
    const right = manager.prerelease[index];
    if (left === right) continue;
    if (left === undefined) return "outdated";
    if (right === undefined) return "newer";
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric)
      return BigInt(left) < BigInt(right) ? "outdated" : "newer";
    if (leftNumeric !== rightNumeric) return leftNumeric ? "outdated" : "newer";
    return left < right ? "outdated" : "newer";
  }
  return "current";
}

export function versionWarning(
  status: VersionStatus | undefined,
  managerVersion?: string,
): string | null {
  if (status === "outdated") return `Update this device to v${managerVersion}.`;
  if (status === "newer") return "Update Fleet Manager to match this device.";
  if (status === "incompatible")
    return "Update the device and Fleet Manager to matching versions.";
  if (status === "unknown") return "The device version could not be checked.";
  return null;
}
