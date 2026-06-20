import {
  isPathInside,
  normalizeRalphWatchPath,
} from "./normalize-ralph-watch-path.helper.js";
import type {
  RalphWatchInput,
  RalphWatchPermissionProfile,
  RalphWatchRoot,
} from "../ralph-watches.js";

export const normalizeRalphWatchPermissionProfile = async (
  input: RalphWatchInput,
  roots: RalphWatchRoot[],
): Promise<RalphWatchPermissionProfile> => {
  const allowedRootsInput = input.permissions?.allowedRoots;
  const allowedRoots = await Promise.all(
    (allowedRootsInput && allowedRootsInput.length > 0
      ? allowedRootsInput
      : roots.map((root) => root.path)
    ).map((path) =>
      normalizeRalphWatchPath(
        path,
        "allowed root",
        input.allowDangerousRoots === true,
      ),
    ),
  );

  for (const allowedRoot of allowedRoots) {
    if (!roots.some((root) => isPathInside(root.path, allowedRoot))) {
      throw new Error(`Allowed root ${allowedRoot} is outside the watched roots.`);
    }
  }

  return {
    allowedRoots: Array.from(new Set(allowedRoots)),
    allowCommands: input.permissions?.allowCommands ?? false,
    allowWrites: input.permissions?.allowWrites ?? false,
    allowNetwork: input.permissions?.allowNetwork ?? false,
    allowMcpTools: input.permissions?.allowMcpTools ?? false,
  };
};
