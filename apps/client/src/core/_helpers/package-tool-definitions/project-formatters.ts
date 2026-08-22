import { DEPENDENCY_SECTIONS, type NodePackageProject, type NodeWorkspacePackage, type PackageLockfileInfo, type PackageManifest } from "./model.js";

export const dependencyCountLines = (manifest: PackageManifest): string[] => {
  return DEPENDENCY_SECTIONS.map((section) => {
    const count = Object.keys(manifest.dependencies[section]).length;
    return `${section}: ${count}`;
  });
};

export const formatManagerSource = (project: NodePackageProject): string => {
  switch (project.managerSource) {
    case "packageManager": {
      return project.managerVersion
        ? `packageManager (${project.managerVersion})`
        : "packageManager";
    }
    case "lockfile": {
      return "lockfile";
    }
    case "default": {
      return "default";
    }
  }
};

export const formatLockfile = (lockfile: PackageLockfileInfo): string => {
  return [
    `${lockfile.name} (${lockfile.manager})`,
    lockfile.lockfileVersion !== undefined
      ? `lockfileVersion=${lockfile.lockfileVersion}`
      : undefined,
    lockfile.packageCount !== undefined
      ? `packages=${lockfile.packageCount}`
      : undefined,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" - ");
};

export const formatWorkspacePackage = (
  workspacePackage: NodeWorkspacePackage,
): string => {
  return [
    `${workspacePackage.path}: ${workspacePackage.name ?? "(unnamed)"}`,
    workspacePackage.version ? `version=${workspacePackage.version}` : undefined,
    workspacePackage.private !== undefined
      ? `private=${workspacePackage.private ? "yes" : "no"}`
      : undefined,
    `scripts=${workspacePackage.scriptCount}`,
    `deps=${workspacePackage.dependencyCount}`,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" - ");
};

