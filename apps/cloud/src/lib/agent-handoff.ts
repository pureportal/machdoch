import { z } from "zod";
import {
  cloudApiProviders,
  type CloudProviderKind,
} from "@machdoch/fleet-protocol/cloud-providers";
import type { ClientAgent } from "@machdoch/fleet-protocol/cloud-execution";
import { cloudId } from "./cloud-contract";
import {
  loopHarnesses,
  loopPlacements,
  type LoopHarness,
  type LoopPlacement,
} from "./cloud-loop-contract";
import {
  automaticOrder,
  harnessLabels,
  placementLabels,
  type ConcretePlacement,
} from "./loop-capabilities";

export const agentHandoffInputSchema = z
  .strictObject({
    turnId: cloudId,
    placement: z.enum(loopPlacements),
    profileId: cloudId.nullable(),
    workerId: cloudId.nullable(),
    harness: z.enum(loopHarnesses),
    model: z.string().trim().min(1).max(160),
    instructions: z.string().trim().min(1).max(20_000),
  })
  .refine(
    (input) =>
      (input.workerId === null || input.placement === "client") &&
      (input.profileId === null ||
        ["sandbox", "runner_pool"].includes(input.placement)),
    { message: "Choose where to run this again.", path: ["placement"] },
  );
export type AgentHandoffInput = z.infer<typeof agentHandoffInputSchema>;
export type HandoffChoice = Omit<AgentHandoffInput, "turnId" | "instructions">;

export interface AgentHandoff {
  id: string;
  runId: string;
  placement: ConcretePlacement;
  harness: LoopHarness;
  model: string;
  deviceName: string | null;
  createdAt: string;
}

export const placementTargets = {
  sandbox: "cloud",
  runner_pool: "client-linux",
  client: "client",
} as const satisfies Record<ConcretePlacement, string>;
export type HandoffTarget = (typeof placementTargets)[ConcretePlacement];

export interface HandoffOptions {
  subject: { kind: "issue" | "project"; id: string; label: string } | null;
  profiles: { id: string; name: string; target: HandoffTarget }[];
  devices: { id: string; name: string; profileId: string }[];
  providers: {
    id: string;
    name: string;
    kind: CloudProviderKind;
    models: string[];
  }[];
  defaults: HandoffDefaults;
}

export interface HandoffDefaults {
  placement: LoopPlacement | null;
  harness: LoopHarness | null;
  model: string | null;
}

export function handoffWhere(
  placement: LoopPlacement | null,
  options: Pick<HandoffOptions, "profiles" | "devices">,
): string {
  if (placement === "client") {
    const device = options.devices[0];
    return device ? `device:${device.id}` : "automatic";
  }
  if (placement === "sandbox" || placement === "runner_pool") {
    const profile = options.profiles.find(
      (entry) => entry.target === placementTargets[placement],
    );
    return profile ? `profile:${profile.id}` : "automatic";
  }
  return "automatic";
}

export function handoffModel(
  preferred: string | null,
  models: string[],
  fallback: string,
): string {
  return preferred && models.includes(preferred)
    ? preferred
    : (models[0] ?? fallback);
}

export type HandoffResolution =
  | {
      available: true;
      placement: ConcretePlacement;
      profileId: string;
      workerId: string | null;
      providerId: string | null;
      agent: ClientAgent | null;
      model: string;
    }
  | { available: false; reason: string };

const clientAgentFor: Record<LoopHarness, ClientAgent | null> = {
  machdoch: "machdoch",
  codex: "codex-cli",
  claude: "claude-cli",
  copilot: null,
};

const harnessProviders: Record<LoopHarness, readonly CloudProviderKind[]> = {
  machdoch: cloudApiProviders,
  codex: ["codex-cli"],
  claude: ["claude-code-cli"],
  copilot: ["copilot-cli"],
};

export function handoffModels(
  harness: LoopHarness,
  options: Pick<HandoffOptions, "providers">,
): string[] {
  return [
    ...new Set(
      options.providers
        .filter((provider) => harnessProviders[harness].includes(provider.kind))
        .flatMap((provider) => provider.models),
    ),
  ];
}

function unavailable(reason: string): HandoffResolution {
  return { available: false, reason };
}

function resolveAt(
  placement: ConcretePlacement,
  choice: HandoffChoice,
  options: HandoffOptions,
): HandoffResolution {
  const profiles = options.profiles.filter(
    (profile) =>
      profile.target === placementTargets[placement] &&
      (choice.profileId === null || profile.id === choice.profileId),
  );
  if (placement === "client") {
    const agent = clientAgentFor[choice.harness];
    if (!agent)
      return unavailable(
        `${placementLabels.client} cannot run ${harnessLabels[choice.harness]}.`,
      );
    const device = options.devices.find(
      (entry) =>
        profiles.some((profile) => profile.id === entry.profileId) &&
        (choice.workerId === null || entry.id === choice.workerId),
    );
    if (!device) return unavailable("No linked client is online.");
    return {
      available: true,
      placement,
      profileId: device.profileId,
      workerId: device.id,
      providerId: null,
      agent,
      model: choice.model,
    };
  }
  const profile = profiles[0];
  if (!profile)
    return unavailable(
      `No ${placementLabels[placement].toLowerCase()} is set up for this project.`,
    );
  const provider = options.providers.find(
    (entry) =>
      harnessProviders[choice.harness].includes(entry.kind) &&
      entry.models.includes(choice.model),
  );
  if (!provider)
    return unavailable(
      `No ${harnessLabels[choice.harness]} provider offers ${choice.model}.`,
    );
  return {
    available: true,
    placement,
    profileId: profile.id,
    workerId: null,
    providerId: provider.id,
    agent: null,
    model: choice.model,
  };
}

export function resolveHandoff(
  choice: HandoffChoice,
  options: HandoffOptions,
): HandoffResolution {
  if (choice.placement !== "automatic")
    return resolveAt(choice.placement, choice, options);
  for (const placement of automaticOrder) {
    const resolution = resolveAt(
      placement,
      { ...choice, profileId: null, workerId: null },
      options,
    );
    if (resolution.available) return resolution;
  }
  return unavailable(
    `No executor can run ${harnessLabels[choice.harness]} with ${choice.model}.`,
  );
}
