import type { ProductShell } from "@machdoch/fleet-protocol";

type ParallelAgentMode = NonNullable<
  NonNullable<ProductShell["composer"]>["parallelAgentMode"]
>;

const PARALLEL_AGENT_OPTIONS = [
  { value: "disabled", label: "Disabled" },
  { value: "read-only", label: "Read Only" },
  { value: "machdoch", label: "Full Mode" },
  { value: "native", label: "Native" },
] as const;

export const GOAL_ADAPTIVE_CONTROLLER_DISABLED_REASON =
  "Unavailable while using Goal.";

export function getParallelAgentOptions(
  availableModes: readonly ParallelAgentMode[],
  specialKind?: string,
): {
  value: ParallelAgentMode;
  label: string;
  disabledReason: string | null;
}[] {
  return PARALLEL_AGENT_OPTIONS.map((option) => ({
    ...option,
    disabledReason:
      option.value === "disabled"
        ? null
        : specialKind === "pose" && option.value !== "native"
          ? "Unavailable in Pose chats."
          : availableModes.includes(option.value)
            ? null
            : "Unavailable for this provider and model.",
  }));
}
