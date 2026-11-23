import type {
  CodeAccessMode,
  LoopCapability,
  LoopPlacement,
} from "./cloud-loop-contract";

type ConcretePlacement = Exclude<LoopPlacement, "automatic">;

export const placementCapabilities: Record<
  ConcretePlacement,
  readonly LoopCapability[]
> = {
  sandbox: ["repository", "shell", "browser"],
  runner_pool: ["repository", "shell", "browser", "gpu"],
  client: ["repository", "shell", "browser", "desktop", "local_files"],
};

const automaticOrder: readonly ConcretePlacement[] = [
  "sandbox",
  "runner_pool",
  "client",
];

export const placementLabels: Record<LoopPlacement, string> = {
  automatic: "Automatic",
  sandbox: "Cloud sandbox",
  runner_pool: "Runner pool",
  client: "Linked client",
};

export const capabilityLabels: Record<LoopCapability, string> = {
  repository: "Repository",
  shell: "Shell",
  browser: "Browser",
  desktop: "Desktop",
  local_files: "Local files",
  gpu: "GPU",
};

export interface CodeAccess {
  mode: CodeAccessMode;
  repositoryIds: readonly string[];
}

export interface CapabilityRequest {
  placement: LoopPlacement;
  required: readonly LoopCapability[];
  repositoryIds: readonly string[];
  codeAccess: CodeAccess;
}

export type CapabilityCheck =
  | { available: true; placement: ConcretePlacement }
  | { available: false; reason: string };

export function blockedRepositoryIds(
  repositoryIds: readonly string[],
  access: CodeAccess,
): string[] {
  if (access.mode === "all") return [];
  return repositoryIds.filter((id) => !access.repositoryIds.includes(id));
}

function missingFor(
  placement: ConcretePlacement,
  required: readonly LoopCapability[],
): LoopCapability[] {
  return required.filter(
    (capability) => !placementCapabilities[placement].includes(capability),
  );
}

export function checkLoopCapabilities(
  request: CapabilityRequest,
): CapabilityCheck {
  const blocked = blockedRepositoryIds(
    request.repositoryIds,
    request.codeAccess,
  );
  if (blocked.length)
    return {
      available: false,
      reason: "Loops may not access this repository.",
    };
  if (
    request.required.includes("repository") &&
    request.codeAccess.mode === "selected" &&
    !request.codeAccess.repositoryIds.length
  )
    return { available: false, reason: "Loops may not access code." };
  if (request.placement !== "automatic") {
    const missing = missingFor(request.placement, request.required);
    return missing.length
      ? {
          available: false,
          reason: `${placementLabels[request.placement]} has no ${missing.map((capability) => capabilityLabels[capability].toLowerCase()).join(", ")}.`,
        }
      : { available: true, placement: request.placement };
  }
  const placement = automaticOrder.find(
    (candidate) => !missingFor(candidate, request.required).length,
  );
  return placement
    ? { available: true, placement }
    : {
        available: false,
        reason: "No executor offers all required capabilities.",
      };
}
