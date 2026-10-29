import {
  managedSettingsPolicyFields,
  type FleetManagedSettingsDocument,
  type ManagedSettingsPolicyField,
} from "@machdoch/fleet-protocol";
import {
  explicitManagedSettingsPolicy,
  managedSettingsFieldAccess,
} from "@machdoch/fleet-protocol/managed-settings";
import type {
  ManagedDefaults,
  ManagedSettingsDocument,
  SettingsProfile,
} from "./types";
import { optionalValue } from "./types";

export interface ProfileGeneralValues {
  name: string;
  description: string;
  defaults: { [Key in keyof ManagedDefaults]: string };
  agentLimits: {
    infinite: "" | "true" | "false";
    executorTurns: string;
    autopilotExecutorIterations: string;
  };
  /** Policy fields whose value always wins on devices. */
  enforced: string[];
}

export interface ProfileGeneralDraft {
  profileId: string;
  baseRevision: number;
  baseline: ProfileGeneralValues;
  values: ProfileGeneralValues;
}

export type ProfileDrafts = Readonly<Record<string, ProfileGeneralDraft>>;

export type ProfileDraftAction =
  | { type: "loaded" | "saved" | "reloaded"; profile: SettingsProfile }
  | {
      type: "changed";
      draft: ProfileGeneralDraft;
      values: ProfileGeneralValues;
    }
  | { type: "deleted"; profileId: string };

export async function receiveProfileResponse(
  response: Promise<{ profile: SettingsProfile }>,
  onProfile: (profile: SettingsProfile) => void,
  onDraftAccepted?: (profile: SettingsProfile) => void,
): Promise<void> {
  const { profile } = await response;
  onDraftAccepted?.(profile);
  onProfile(profile);
}

/** The profile policy with legacy "everything enforced" made explicit. */
export function profilePolicy(profile: SettingsProfile): string[] {
  return explicitManagedSettingsPolicy(
    profile.document as FleetManagedSettingsDocument,
    profile.secrets.map((secret) => secret.secretId),
  );
}

export function isProfileFieldSet(
  document: ManagedSettingsDocument,
  field: string,
): boolean {
  const access =
    managedSettingsFieldAccess[
      field as keyof typeof managedSettingsFieldAccess
    ];
  return Boolean(access?.isSet(document as FleetManagedSettingsDocument));
}

/** Whether the draft configures a policy field, so enforcing it has an effect. */
export function isDraftFieldSet(
  values: ProfileGeneralValues,
  field: ManagedSettingsPolicyField,
): boolean {
  if (field === "model") return Boolean(values.defaults.provider.trim());
  if (field in values.agentLimits)
    return Boolean(
      values.agentLimits[
        field as keyof ProfileGeneralValues["agentLimits"]
      ].trim(),
    );
  return Boolean(values.defaults[field as keyof ManagedDefaults].trim());
}

export function createProfileDraft(
  profile: SettingsProfile,
): ProfileGeneralDraft {
  const defaults = profile.document.defaults;
  const limits = profile.document.agentLimits;
  const values: ProfileGeneralValues = {
    name: profile.name,
    description: profile.description,
    defaults: {
      provider: defaults.provider ?? "",
      model: defaults.model ?? "",
      mode: defaults.mode ?? "",
      reasoning: defaults.reasoning ?? "",
      webSearchProvider: defaults.webSearchProvider ?? "",
      theme: defaults.theme ?? "",
      density: defaults.density ?? "",
      accent: defaults.accent ?? "",
    },
    agentLimits: {
      infinite:
        limits.infinite === null ? "" : limits.infinite ? "true" : "false",
      executorTurns: limits.executorTurns?.toString() ?? "",
      autopilotExecutorIterations:
        limits.autopilotExecutorIterations?.toString() ?? "",
    },
    enforced: profilePolicy(profile).filter((key) =>
      (managedSettingsPolicyFields as readonly string[]).includes(key),
    ),
  };
  return {
    profileId: profile.profileId,
    baseRevision: profile.revision,
    baseline: values,
    values,
  };
}

export function hasProfileDraftChanges(draft: ProfileGeneralDraft): boolean {
  const { values, baseline } = draft;
  return (
    values.name !== baseline.name ||
    values.description !== baseline.description ||
    Object.entries(baseline.defaults).some(
      ([key, value]) => values.defaults[key as keyof ManagedDefaults] !== value,
    ) ||
    Object.entries(baseline.agentLimits).some(
      ([key, value]) =>
        values.agentLimits[key as keyof ProfileGeneralValues["agentLimits"]] !==
        value,
    ) ||
    [...values.enforced].sort().join() !== [...baseline.enforced].sort().join()
  );
}

export function profileDraftsReducer(
  state: ProfileDrafts,
  action: ProfileDraftAction,
): ProfileDrafts {
  if (action.type === "deleted") {
    const next = { ...state };
    delete next[action.profileId];
    return next;
  }
  if (action.type === "changed") {
    return {
      ...state,
      [action.draft.profileId]: { ...action.draft, values: action.values },
    };
  }
  const current = state[action.profile.profileId];
  if (action.type === "loaded" && current && hasProfileDraftChanges(current))
    return state;
  return {
    ...state,
    [action.profile.profileId]: createProfileDraft(action.profile),
  };
}

export function prepareGeneralProfileSave(
  profile: SettingsProfile,
  draft: ProfileGeneralDraft,
) {
  if (
    draft.profileId !== profile.profileId ||
    draft.baseRevision !== profile.revision
  ) {
    throw new Error("This profile changed. Reload it before saving.");
  }
  const { values } = draft;
  const document = structuredClone(profile.document);
  document.defaults = {
    provider: optionalValue(values.defaults.provider),
    model: values.defaults.provider
      ? optionalValue(values.defaults.model)
      : null,
    mode: optionalValue(values.defaults.mode),
    reasoning: optionalValue(values.defaults.reasoning),
    webSearchProvider: optionalValue(values.defaults.webSearchProvider),
    theme: optionalValue(values.defaults.theme),
    density: optionalValue(values.defaults.density),
    accent: optionalValue(values.defaults.accent),
  };
  document.agentLimits = {
    infinite:
      values.agentLimits.infinite === ""
        ? null
        : values.agentLimits.infinite === "true",
    executorTurns: values.agentLimits.executorTurns.trim()
      ? Number(values.agentLimits.executorTurns)
      : null,
    autopilotExecutorIterations:
      values.agentLimits.autopilotExecutorIterations.trim()
        ? Number(values.agentLimits.autopilotExecutorIterations)
        : null,
  };
  document.policy = {
    enforced: [
      ...managedSettingsPolicyFields.filter(
        (field) =>
          values.enforced.includes(field) && isProfileFieldSet(document, field),
      ),
      ...profilePolicy(profile).filter((key) => key.startsWith("secret:")),
    ],
  };
  return {
    expectedRevision: draft.baseRevision,
    name: values.name,
    description: values.description,
    document,
    changeSummary: "Updated profile",
  };
}
